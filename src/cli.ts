import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globalConfigPath, writeGlobalConfig } from './agent/llm.js';
import type { Report } from './agent/report.js';
import { encodeFrame, LineDecoder, type Frame, type Request, type ResultFrame } from './shared/protocol.js';
import { sessionsDir, socketPath, validateSessionName } from './shared/paths.js';

const USAGE = `browser-pilot — agent-in-the-loop Playwright CLI

Usage:
  browser-pilot do "<instruction>" [--json] [--max-turns N] [--timeout S] [--turn-timeout S] [--provider P] [--model M]
                                   [--fallback-model M | --no-escalate]
  browser-pilot open <url>
  browser-pilot brief <file.md> [--append]
  browser-pilot note "<text>"
  browser-pilot reset                       # clear the LLM conversation only (browser/cookies/briefing/notes kept)
  browser-pilot peek [--selector <sel>] [--interactive]
  browser-pilot script [out.spec.ts] [--title T] [--clear]   # emit a Playwright spec from the recorded actions
  browser-pilot screenshot [path]
  browser-pilot session list
  browser-pilot stop [--all]
  browser-pilot config                      # show resolved provider/model/paths
  browser-pilot config set <key> <value>    # persist a default (provider, model, fallbackModel, baseUrl, apiKey)

Sizing an instruction:
  One \`do\` = one logical, verifiable step: a goal plus the check that it worked
  ("create a project named X, fill any required fields, submit, and report the row
  that appears"). Several UI actions inside one instruction is normal — that is the
  point of the tool.
  Too big:   several unrelated goals or assertions in one string. The agent stalls on
             planning and burns --max-turns. If a result comes back "blocked", split
             it and retry the halves.
  Too small: one click, one fill, one read. You pay for a whole agent loop to do what
             \`peek\` gives you for free.
  Do not drive the page by repeated \`peek\`/\`config\` polling. \`peek\` is for orienting
  ONCE when a \`do\` reports something you did not expect. If you are about to issue the
  same read a second time, issue a \`do\` instead.

Escalation:
  When the routine model reports an instruction "blocked", it is retried once on a
  stronger fallback model, on the same live browser and history (told to verify state
  before repeating anything). Verified "failure" results are NOT retried. Disable with
  --no-escalate, or set the fallback model to "none".

Global flags:
  --session <name>   session name (default "default"; one daemon+browser per session)
  --verbose          stream the internal agent's actions + token accounting while it works
  --progress         stream the agent's actions to stderr (composes with --json)
  --headed           launch the browser with a visible window (first call only)
  --record           record the session to webm, one file per tab; paths are printed
                     on stop, which is when Playwright writes them (first call only)
  --script           record every action as a replayable Playwright step (first call
                     only); write the spec out later with "browser-pilot script"
  --json             machine-readable output

Providers (presets; each field overridable by flag > env > config file):
  zhipu (default)    glm-5.2 @ api.z.ai            key: GLM_API_KEY / ZHIPU_API_KEY
  novita             deepseek/deepseek-v4-flash @ novita.ai   key: NOVITA_API_KEY
                     escalates to zai-org/glm-5.3 when blocked
  openrouter         z-ai/glm-5.2 @ openrouter.ai  key: OPENROUTER_API_KEY
  openai             gpt-5-mini @ api.openai.com   key: OPENAI_API_KEY
  anthropic          claude-sonnet-5 @ api.anthropic.com (native Messages API, not
                     OpenAI-compatible — its own adapter)   key: ANTHROPIC_API_KEY

Environment:
  BROWSER_PILOT_PROVIDER        provider preset name
  BROWSER_PILOT_MODEL           model id override
  BROWSER_PILOT_FALLBACK_MODEL  escalation model for blocked instructions ("none" disables)
  BROWSER_PILOT_BASE_URL        any OpenAI-compatible base URL
  BROWSER_PILOT_API_KEY         API key (works with any provider)
  BROWSER_PILOT_CHANNEL         browser channel (default chrome, falls back to msedge)
  BROWSER_PILOT_HEADED=1        headed browser
  BROWSER_PILOT_RECORD=1        record session video to <session dir>/video
  BROWSER_PILOT_SCRIPT=1        record actions as a Playwright script (see the script command)

Exit codes: 0 instruction succeeded · 1 failed/blocked · 2 infra error`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const valueFlags = new Set([
    'session',
    'max-turns',
    'timeout',
    'turn-timeout',
    'provider',
    'model',
    'fallback-model',
    'base-url',
    'selector',
    'title',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        flags.set(name, argv[++i] ?? '');
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  const command = positional.shift() ?? '';
  return { command, positional, flags };
}

// --- daemon connection ---

function connect(sock: string, timeoutMs = 1000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sock);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    conn.once('connect', () => {
      clearTimeout(timer);
      resolve(conn);
    });
    conn.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Connect and prove the daemon is alive with a ping round-trip (a pipe can
 * still accept connections while its daemon is shutting down). */
async function connectValidated(sock: string): Promise<net.Socket> {
  const conn = await connect(sock);
  try {
    await request(conn, 'ping', {}, undefined, 5_000);
    return conn;
  } catch (err) {
    conn.destroy();
    throw err;
  }
}

async function connectOrSpawn(
  session: string,
  opts: { headed: boolean; record: boolean; script: boolean },
): Promise<net.Socket> {
  const sock = socketPath(session);
  try {
    return await connectValidated(sock);
  } catch {
    // not running — spawn the daemon detached and wait for the pipe
  }
  const serverPath = fileURLToPath(new URL('./daemon/server.js', import.meta.url));
  const args = [serverPath, '--session', session];
  if (opts.headed) args.push('--headed');
  if (opts.record) args.push('--record');
  if (opts.script) args.push('--script');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectValidated(sock);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`daemon did not come up for session "${session}": ${(lastErr as Error)?.message}`);
}

/**
 * `timeoutMs` guards the control commands (ping/stop): a daemon that is wedged
 * — rather than merely busy — must not hang the CLI indefinitely. `do` passes
 * no timeout; the daemon enforces its own instruction deadline.
 */
function request(
  conn: net.Socket,
  command: Request['command'],
  args: Record<string, unknown>,
  onProgress?: (m: string) => void,
  timeoutMs?: number,
): Promise<ResultFrame> {
  return new Promise((resolve, reject) => {
    const req: Request = { id: Date.now() % 1_000_000, command, args };
    const decoder = new LineDecoder<Frame>();
    const timer = timeoutMs
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`${command} timed out after ${timeoutMs}ms — daemon not responding`));
        }, timeoutMs)
      : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      conn.removeListener('data', onData);
      conn.removeListener('error', onError);
      conn.removeListener('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        cleanup();
        return reject(err);
      }
      for (const frame of frames) {
        if (frame.type === 'progress') onProgress?.(frame.message);
        else {
          cleanup();
          resolve(frame);
        }
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('connection closed before result'));
    };
    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('close', onClose);
    conn.write(encodeFrame(req));
  });
}

// --- output helpers ---

function fail(message: string, code: 1 | 2 = 2): never {
  console.error(`browser-pilot: ${message}`);
  process.exit(code);
}

function printResult(res: ResultFrame, json: boolean): unknown {
  if (!res.ok) fail(res.error ?? 'unknown error', res.errorKind === 'infra' ? 2 : 1);
  if (json) console.log(JSON.stringify(res.data, null, 2));
  return res.data;
}

// --- main ---

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgv(process.argv.slice(2));
  if (!command || flags.has('help') || command === 'help') {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }

  const session = validateSessionName(String(flags.get('session') ?? 'default'));
  const json = flags.has('json');
  const verbose = flags.has('verbose');
  // --progress streams the agent's actions to stderr without the full --verbose
  // token accounting, so it composes with --json (JSON stays clean on stdout).
  const onProgress = verbose || flags.has('progress') ? (m: string) => console.error(`  · ${m}`) : undefined;

  // Commands that don't need (or must not start) a daemon:
  if (command === 'config' && positional[0] === 'set') {
    const [, key, value] = positional;
    if (!key || value === undefined) fail('usage: config set <provider|model|fallbackModel|baseUrl|apiKey> <value>', 2);
    const merged = writeGlobalConfig({ [key]: value });
    const shown = { ...merged, ...(merged.apiKey ? { apiKey: '***' } : {}) };
    console.log(`${globalConfigPath()}: ${JSON.stringify(shown)}`);
    console.log('applies to the next instruction — running daemons re-read this file per call');
    return;
  }
  if (command === 'session') {
    if (positional[0] !== 'list') fail(`unknown subcommand "session ${positional[0] ?? ''}" (try: session list)`);
    await listSessions(json);
    return;
  }
  if (command === 'stop') {
    const names = flags.has('all') ? allSessionNames() : [session];
    for (const name of names) {
      let conn: net.Socket;
      try {
        conn = await connect(socketPath(name));
      } catch {
        if (!flags.has('all')) console.log(`not running: ${name}`);
        continue;
      }
      try {
        // Generous: the daemon aborts any in-flight instruction and lets it
        // unwind before closing the browser. Reachable-but-unresponsive is a
        // real failure worth reporting, not a silent "not running".
        const res = await request(conn, 'stop', {}, undefined, 20_000);
        const data = res.data as { preempted?: boolean; videos?: string[] } | undefined;
        console.log(`stopped: ${name}${data?.preempted ? ' (interrupted a running instruction)' : ''}`);
        for (const video of data?.videos ?? []) console.log(`  video: ${video}`);
      } catch (err) {
        console.error(`browser-pilot: could not stop ${name}: ${(err as Error).message}`);
      } finally {
        conn.destroy();
      }
    }
    return;
  }

  const conn = await connectOrSpawn(session, {
    headed: flags.has('headed'),
    record: flags.has('record'),
    script: flags.has('script'),
  }).catch((err) => fail(err.message));

  try {
    switch (command) {
      case 'do': {
        const instruction = positional.join(' ').trim();
        if (!instruction) fail('do requires an instruction', 2);
        const res = await request(
          conn,
          'do',
          {
            instruction,
            maxTurns: flags.has('max-turns') ? Number(flags.get('max-turns')) : undefined,
            timeoutS: flags.has('timeout') ? Number(flags.get('timeout')) : undefined,
            turnTimeoutS: flags.has('turn-timeout') ? Number(flags.get('turn-timeout')) : undefined,
            provider: flags.get('provider') || undefined,
            model: flags.get('model') || undefined,
            baseUrl: flags.get('base-url') || undefined,
            fallbackModel: flags.get('fallback-model') || undefined,
            escalate: flags.has('no-escalate') ? false : undefined,
          },
          onProgress,
        );
        if (!res.ok) fail(res.error ?? 'unknown error', res.errorKind === 'infra' ? 2 : 1);
        const data = res.data as {
          report: Report;
          turns: number;
          usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
          transcriptTail?: string[];
          actions?: { tool: string; args: string; ok: boolean }[];
          finalState?: { url: string; title?: string };
          screenshots: string[];
          model: string;
          fallbackModel?: string;
          escalation?: {
            from: string;
            to: string;
            reason: string;
            firstAttempt: {
              status: string;
              turns: number;
              usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
            };
            rescued: boolean;
          };
        };
        if (json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const mark = data.report.status === 'success' ? 'OK' : data.report.status.toUpperCase();
          console.log(`[${mark}] ${data.report.summary}`);
          if (data.escalation) {
            const e = data.escalation;
            console.log(
              `  escalated: ${e.from} blocked after ${e.firstAttempt.turns} turns → retried on ${e.to} (${e.rescued ? 'rescued' : 'still not resolved'})`,
            );
            console.log(`    blocked because: ${e.reason}`);
          }
          if (data.report.details) console.log(data.report.details);
          if (data.report.evidence?.values) {
            for (const [k, v] of Object.entries(data.report.evidence.values)) console.log(`  ${k}: ${v}`);
          }
          if (data.report.evidence?.capturedDialogs?.length) {
            console.log(`  dialogs: ${data.report.evidence.capturedDialogs.join(' | ')}`);
          }
          if (data.screenshots.length) {
            console.log(`  screenshots: ${data.screenshots.length}`);
            for (const s of data.screenshots) console.log(`    ${s}`);
          }
          if (data.actions?.length) {
            // On bail-out: the state-changing actions that ran, so you can verify
            // before resuming rather than blindly repeating them.
            console.log('--- actions taken (verify before resuming) ---');
            for (const a of data.actions) console.log(`  ${a.ok ? '✓' : '✗'} ${a.tool} ${a.args}`);
          }
          if (data.transcriptTail?.length && !data.actions?.length) {
            // Nothing ran — the agent's own reasoning is the only evidence there is.
            console.log('--- transcript tail (no tool calls ran) ---');
            for (const line of data.transcriptTail) console.log(`  ${line}`);
          }
          if (data.finalState) {
            console.log(`--- browser left at: ${data.finalState.url}${data.finalState.title ? ` — "${data.finalState.title}"` : ''}`);
          }
        }
        if (verbose) {
          const u = data.usage;
          const fresh = u.promptTokens - u.cachedTokens;
          const hit = u.promptTokens ? Math.round((u.cachedTokens / u.promptTokens) * 100) : 0;
          const models = data.escalation ? `${data.escalation.from} → ${data.escalation.to}` : data.model;
          console.error(
            `  · ${data.turns} turns, ${u.promptTokens} prompt (${u.cachedTokens} cached / ${fresh} fresh, ${hit}% hit) + ${u.completionTokens} completion tokens (${models})`,
          );
        }
        process.exit(data.report.status === 'success' ? 0 : 1);
        break;
      }

      case 'open': {
        if (!positional[0]) fail('open requires a URL', 2);
        const data = printResult(await request(conn, 'open', { url: positional[0] }, onProgress), json) as {
          url: string;
          title: string;
        };
        if (!json) console.log(`${data.title} — ${data.url}`);
        break;
      }

      case 'brief': {
        const file = positional[0];
        if (!file || !fs.existsSync(file)) fail(`brief requires an existing file (got: ${file ?? 'nothing'})`, 2);
        const text = fs.readFileSync(path.resolve(file), 'utf8');
        const data = printResult(await request(conn, 'brief', { text, append: flags.has('append') }), json) as {
          briefingChars: number;
        };
        if (!json) console.log(`briefing loaded (${data.briefingChars} chars)`);
        break;
      }

      case 'note': {
        const text = positional.join(' ').trim();
        if (!text) fail('note requires text', 2);
        const data = printResult(await request(conn, 'note', { text }), json) as { notes: number };
        if (!json) console.log(`noted (${data.notes} notes in session)`);
        break;
      }

      case 'reset': {
        const data = printResult(await request(conn, 'reset', {}), json) as { clearedMessages: number };
        if (!json) console.log(`conversation reset (${data.clearedMessages} message(s) cleared; browser, briefing, and notes kept)`);
        break;
      }

      case 'peek': {
        const data = printResult(
          await request(conn, 'peek', {
            selector: flags.get('selector') || undefined,
            interactiveOnly: flags.has('interactive'),
          }),
          json,
        ) as { url: string; title: string; snapshot: string };
        if (!json) {
          console.log(`${data.title} — ${data.url}`);
          console.log(data.snapshot);
        }
        break;
      }

      case 'script': {
        const data = printResult(
          await request(conn, 'script', {
            path: positional[0],
            title: flags.get('title') || undefined,
            clear: flags.has('clear'),
          }),
          json,
        ) as { path?: string; steps: number; instructions?: number; recording?: boolean; cleared?: boolean };
        if (!json) {
          if (data.path) {
            console.log(`${data.path} (${data.steps} action(s), ${data.instructions ?? 0} instruction(s))`);
            if (data.cleared) console.log('recording cleared');
            if (!data.recording) {
              console.log('note: this session is not recording — generated from previously recorded actions');
            }
          } else {
            console.log(`recording cleared (${data.steps} action(s) discarded)`);
          }
        }
        break;
      }

      case 'screenshot': {
        const data = printResult(
          await request(conn, 'screenshot', { path: positional[0], fullPage: flags.has('full-page') }),
          json,
        ) as { path: string };
        if (!json) console.log(data.path);
        break;
      }

      case 'config': {
        const data = printResult(await request(conn, 'config', {}), true);
        void data;
        break;
      }

      default:
        fail(`unknown command "${command}"\n\n${USAGE}`, 2);
    }
  } finally {
    conn.destroy();
  }
  process.exit(0);
}

function allSessionNames(): string[] {
  try {
    return fs
      .readdirSync(sessionsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

async function listSessions(json: boolean): Promise<void> {
  const names = allSessionNames();
  const rows: { session: string; running: boolean; pid?: number }[] = [];
  for (const name of names) {
    try {
      const conn = await connect(socketPath(name), 500);
      const res = await request(conn, 'ping', {}, undefined, 5_000);
      conn.destroy();
      const data = res.data as { pid: number };
      rows.push({ session: name, running: true, pid: data.pid });
    } catch {
      rows.push({ session: name, running: false });
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log('no sessions');
  else for (const r of rows) console.log(`${r.session}  ${r.running ? `running (pid ${r.pid})` : 'stopped'}`);
}

main().catch((err) => fail(err?.message ?? String(err)));
