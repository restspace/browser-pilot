import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AnthropicProvider, OpenAICompatProvider, resolveProviderConfig, type Provider } from '../agent/llm.js';
import { runInstruction } from '../agent/loop.js';
import { generateScript } from './codegen.js';
import { snapshot } from './refs.js';
import { ScriptRecorder } from './recorder.js';
import { encodeFrame, LineDecoder, type CommandName, type Frame, type Request } from '../shared/protocol.js';
import { ensureSessionDir, socketPath, validateSessionName } from '../shared/paths.js';
import { BrowserSession } from './browser.js';
import { SessionState } from './state.js';

interface DaemonOptions {
  session: string;
  headed?: boolean;
  record?: boolean;
  script?: boolean;
}

/**
 * Served immediately instead of queued behind the command in flight. These are
 * exactly the commands an operator needs *while* a `do` is misbehaving — if
 * they queue, observing and killing a stuck run is impossible precisely when
 * it matters. All of them are read-only w.r.t. the agent's history; `screenshot`
 * touches the page, which Playwright already serialises internally.
 */
const UNQUEUED_COMMANDS = new Set<CommandName>(['ping', 'config', 'screenshot', 'stop']);

/** How long `stop` lets an aborted instruction unwind before tearing down. */
const STOP_DRAIN_MS = 3_000;

export class Daemon {
  private browser: BrowserSession;
  private state: SessionState;
  private server: net.Server | null = null;
  /** Serialise commands: the browser and the history are single-threaded resources. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Aborts the instruction currently running, so `stop` can preempt it. */
  private inflight: AbortController | null = null;

  constructor(private opts: DaemonOptions) {
    this.browser = new BrowserSession({
      session: opts.session,
      headed: opts.headed,
      record: opts.record,
      script: opts.script,
    });
    this.state = new SessionState(opts.session);
  }

  private provider(overrides: { provider?: string; model?: string; baseUrl?: string } = {}): Provider {
    const config = resolveProviderConfig(overrides);
    return config.provider === 'anthropic' ? new AnthropicProvider(config) : new OpenAICompatProvider(config);
  }

  async listen(): Promise<void> {
    const sock = socketPath(this.opts.session);
    if (process.platform !== 'win32' && fs.existsSync(sock)) fs.unlinkSync(sock);
    this.server = net.createServer((conn) => this.handleConnection(conn));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(sock, resolve);
    });
  }

  private handleConnection(conn: net.Socket): void {
    const decoder = new LineDecoder<Request>();
    conn.on('data', (chunk) => {
      let requests: Request[];
      try {
        requests = decoder.push(chunk);
      } catch (err) {
        conn.write(encodeFrame({ id: -1, type: 'result', ok: false, errorKind: 'infra', error: `bad request: ${err}` }));
        return;
      }
      for (const req of requests) {
        if (UNQUEUED_COMMANDS.has(req.command)) void this.serve(conn, req).catch(() => {});
        else this.queue = this.queue.then(() => this.serve(conn, req)).catch(() => {});
      }
    });
    conn.on('error', () => {});
  }

  private send(conn: net.Socket, frame: Frame): void {
    if (!conn.destroyed) conn.write(encodeFrame(frame));
  }

  private async serve(conn: net.Socket, req: Request): Promise<void> {
    try {
      const data = await this.execute(req, (message) => this.send(conn, { id: req.id, type: 'progress', message }));
      this.send(conn, { id: req.id, type: 'result', ok: true, data });
      if (req.command === 'stop') {
        conn.end();
        await this.shutdown();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const infra = /no API key|could not launch|LLM HTTP|LLM request failed/.test(message);
      this.send(conn, {
        id: req.id,
        type: 'result',
        ok: false,
        error: message,
        errorKind: infra ? 'infra' : 'command',
      });
    }
  }

  private async execute(req: Request, progress: (m: string) => void): Promise<unknown> {
    const a = req.args ?? {};
    switch (req.command) {
      case 'ping':
        return { pid: process.pid, session: this.opts.session };

      case 'open': {
        const page = await this.browser.getPage();
        await page.goto(String(a.url), { waitUntil: 'load', timeout: 30_000 });
        // `open` drives the page directly rather than through a tool call, so
        // it has to record its own navigation or a recorded script would start
        // wherever the first instruction happened to find the browser.
        const recorder = this.browser.script;
        if (recorder) recorder.commit(await recorder.prepare(page, 'goto', { url: String(a.url) }), 'ok');
        return { url: page.url(), title: await page.title() };
      }

      case 'peek': {
        const page = await this.browser.getPage();
        return {
          url: page.url(),
          title: await page.title(),
          snapshot: await snapshot(page, {
            selector: a.selector ? String(a.selector) : undefined,
            interactiveOnly: Boolean(a.interactiveOnly),
          }),
        };
      }

      case 'screenshot': {
        const page = await this.browser.getPage();
        const file = a.path
          ? path.resolve(String(a.path))
          : path.join(ensureSessionDir(this.opts.session), 'screenshots', `shot-${Date.now()}.jpg`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, type: 'jpeg', fullPage: Boolean(a.fullPage) });
        return { path: file };
      }

      case 'brief':
        this.state.setBriefing(String(a.text ?? ''), Boolean(a.append));
        return { briefingChars: this.state.briefing.length };

      case 'note':
        this.state.addNote(String(a.text ?? ''));
        return { notes: this.state.notes.length };

      case 'reset': {
        // Clears the LLM conversation only — browser page, cookies, briefing,
        // and notes are untouched. Lets a caller that tracks its own compact
        // progress summary (e.g. via `note`) avoid resending the full raw
        // tool-call history on every subsequent `do`, without losing login
        // state or restarting the browser.
        const before = this.state.messages.length;
        this.state.messages = [];
        return { clearedMessages: before };
      }

      case 'do': {
        const provider = this.provider({
          provider: a.provider ? String(a.provider) : undefined,
          model: a.model ? String(a.model) : undefined,
          baseUrl: a.baseUrl ? String(a.baseUrl) : undefined,
        });
        const controller = new AbortController();
        this.inflight = controller;
        try {
          const result = await runInstruction(provider, this.browser, this.state, String(a.instruction), {
            maxTurns: typeof a.maxTurns === 'number' ? a.maxTurns : 30,
            timeoutMs: (typeof a.timeoutS === 'number' ? a.timeoutS : 300) * 1000,
            ...(typeof a.turnTimeoutS === 'number' ? { turnTimeoutMs: a.turnTimeoutS * 1000 } : {}),
            screenshotDir: path.join(ensureSessionDir(this.opts.session), 'screenshots'),
            signal: controller.signal,
            onProgress: progress,
          });
          return { ...result, model: provider.model };
        } finally {
          if (this.inflight === controller) this.inflight = null;
        }
      }

      case 'script': {
        // Fall back to a disk-backed recorder so a session that recorded and
        // then restarted (or that is being read by a second CLI call) can still
        // generate — script.jsonl is the source of truth, not process memory.
        const recorder = this.browser.script ?? new ScriptRecorder(this.opts.session);
        const steps = recorder.entries.filter((e) => e.k === 'step').length;
        if (a.clear && !a.path) {
          recorder.clear();
          return { cleared: true, steps };
        }
        if (!steps) {
          throw new Error(
            'nothing recorded for this session — start it with --script (or BROWSER_PILOT_SCRIPT=1) before running instructions',
          );
        }
        const file = a.path
          ? path.resolve(String(a.path))
          : path.join(ensureSessionDir(this.opts.session), 'recorded.spec.ts');
        const source = generateScript(recorder.entries, {
          session: this.opts.session,
          title: a.title ? String(a.title) : undefined,
        });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
        if (a.clear) recorder.clear();
        return {
          path: file,
          steps,
          instructions: recorder.entries.filter((e) => e.k === 'instruction').length,
          recording: Boolean(this.browser.script),
          cleared: Boolean(a.clear),
        };
      }

      case 'config': {
        const cfg = resolveProviderConfig();
        return {
          session: this.opts.session,
          pid: process.pid,
          provider: cfg.provider,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          apiKeySet: Boolean(cfg.apiKey),
          apiKeyEnvVars: cfg.keyEnvVars,
          sessionDir: ensureSessionDir(this.opts.session),
          briefingChars: this.state.briefing.length,
          recording: this.browser.recording,
          scriptRecording: Boolean(this.browser.script),
          scriptSteps: this.browser.script?.entries.filter((e) => e.k === 'step').length ?? 0,
          notes: this.state.notes,
          usage: this.state.usage,
          historyMessages: this.state.messages.length,
        };
      }

      case 'stop': {
        // Preempt rather than wait: an operator reaching for `stop` wants the
        // run dead now. The aborted instruction still returns a blocked report
        // (with its actions log) to whoever asked for it.
        const preempted = Boolean(this.inflight);
        this.inflight?.abort();
        if (preempted) {
          await Promise.race([this.queue.catch(() => {}), delay(STOP_DRAIN_MS)]);
        }
        // Close the browser here rather than leaving it to shutdown(): a
        // recorded video is only written out when the context closes, so the
        // files must exist before this result frame goes out. close() is
        // idempotent, so shutdown()'s call becomes a no-op.
        const videos = await this.browser.close();
        return { stopping: true, preempted, videos };
      }

      default:
        throw new Error(`unknown command: ${(req as Request).command}`);
    }
  }

  private async shutdown(): Promise<void> {
    await this.browser.close();
    this.server?.close();
    // give the result frame time to flush before exiting
    await new Promise((r) => setTimeout(r, 150));
    process.exit(0);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- entrypoint: node dist/daemon/server.js --session <name> [--headed] ---
const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const argv = process.argv.slice(2);
  const sessionIdx = argv.indexOf('--session');
  const session = validateSessionName(sessionIdx >= 0 ? argv[sessionIdx + 1] : 'default');
  const daemon = new Daemon({
    session,
    headed: argv.includes('--headed'),
    record: argv.includes('--record'),
    script: argv.includes('--script'),
  });
  daemon
    .listen()
    .then(() => {
      // parent (CLI) reads this line to know the pipe is ready when not detached
      process.stdout.write(`browser-pilot daemon listening (session=${session}, pid=${process.pid})\n`);
    })
    .catch((err) => {
      process.stderr.write(`daemon failed to start: ${err?.message || err}\n`);
      process.exit(2);
    });
}
