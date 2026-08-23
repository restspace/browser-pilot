import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AnthropicProvider, OpenAICompatProvider, resolveProviderConfig, type Provider } from '../agent/llm.js';
import { runEscalatingInstruction, type InstructionResult, type SkillRecord } from '../agent/loop.js';
import { executeTool } from '../agent/tools.js';
import { urlPattern as compiledUrlPattern } from '../skills/compile.js';
import type { DriftTicket } from '../skills/repair.js';
import { bindSkill, learnFromInstruction, matchTemplate, selectCandidates, synthesizeReport } from '../skills/learn.js';
import { buildFlow, listFlows, loadFlow, resolveInstruction, resolveStepParams, softResolveInstruction, saveFlow } from '../skills/flow.js';
import { renderReplay } from '../skills/replay.js';
import { originOf } from '../skills/store.js';
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
  learn?: boolean;
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

/**
 * How many stored candidates a flow step may actually replay (attempts that
 * ran at least one step) before giving up and recovering on the model.
 * Refusals (wrong page, unbindable params) are free and do not count.
 */
const MAX_CANDIDATE_ATTEMPTS = 3;


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
      learn: opts.learn,
    });
    this.state = new SessionState(opts.session);
  }

  private provider(overrides: { provider?: string; model?: string; baseUrl?: string } = {}): Provider {
    return build(resolveProviderConfig(overrides));
  }

  /**
   * The escalation tier for a `do`, or null when disabled or when it would
   * resolve to the same model as the routine one (retrying a blocked
   * instruction on the model that just blocked buys nothing).
   */
  private fallbackProvider(
    overrides: { provider?: string; model?: string; baseUrl?: string; fallbackModel?: string } = {},
    primary?: Provider,
  ): Provider | null {
    const config = resolveProviderConfig(overrides);
    if (!config.fallbackModel || config.fallbackModel === primary?.model) return null;
    return build({ ...config, model: config.fallbackModel });
  }

  /**
   * The model flow recovery uses. Unlike the escalation fallback this is NOT
   * gated by whether per-step escalation is enabled — recovering a drifted
   * flow step is a deliberate, hard task, so it goes to the strongest model
   * available: an explicit override, else the configured fallback model, else
   * the routine model (when none is configured).
   */
  private recoveryProvider(overrideModel?: string): Provider {
    const config = resolveProviderConfig();
    const model = overrideModel || (config.fallbackModel && config.fallbackModel !== 'none' ? config.fallbackModel : config.model);
    return build({ ...config, model });
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
        const overrides = {
          provider: a.provider ? String(a.provider) : undefined,
          model: a.model ? String(a.model) : undefined,
          baseUrl: a.baseUrl ? String(a.baseUrl) : undefined,
          fallbackModel: a.fallbackModel ? String(a.fallbackModel) : undefined,
        };
        const provider = this.provider(overrides);
        const fallback = a.escalate === false ? null : this.fallbackProvider(overrides, provider);
        const controller = new AbortController();
        this.inflight = controller;
        const instruction = String(a.instruction);
        const screenshotDir = path.join(ensureSessionDir(this.opts.session), 'screenshots');
        const loopOpts = {
          maxTurns: typeof a.maxTurns === 'number' ? a.maxTurns : 30,
          timeoutMs: (typeof a.timeoutS === 'number' ? a.timeoutS : 300) * 1000,
          ...(typeof a.turnTimeoutS === 'number' ? { turnTimeoutMs: a.turnTimeoutS * 1000 } : {}),
          screenshotDir,
          signal: controller.signal,
          onProgress: progress,
        };
        // Where this instruction's recording starts, so learning can read back
        // exactly what it did (and nothing from earlier instructions).
        const mark = this.browser.script?.mark() ?? 0;
        try {
          // Zero-model path: a validated skill whose template matches this
          // instruction word for word replays without any LLM call. If it
          // stops part-way the agent takes over with the partial result in
          // hand, exactly as it would after calling run_skill itself.
          const direct = await this.replayDirect(instruction, screenshotDir, controller.signal, progress);
          let result: InstructionResult;
          if (direct.done) {
            result = direct.done;
          } else {
            result = await runEscalatingInstruction(
              provider,
              fallback,
              this.browser,
              this.state,
              direct.prelude ? `${instruction}\n\n${direct.prelude}` : instruction,
              loopOpts,
            );
            if (direct.partial && result.skill) result.skill = { ...result.skill, ...direct.partial, listed: result.skill.listed };
          }
          const learned = this.browser.learn
            ? learnFromInstruction(this.browser.learn, {
                result,
                instruction,
                entries: this.browser.script?.entriesSince(mark) ?? [],
                session: this.opts.session,
                model: provider.model,
              })
            : null;
          if (learned) progress(`[learn] ${describeLearned(learned)}`);
          const pinned = learned?.compiled ?? learned?.merged ?? result.skill?.invoked;
          if (pinned) this.browser.script?.pinSkill(pinned);
          if (result.skill) this.state.recordSkill(result.skill, learned);
          return {
            ...result,
            model: provider.model,
            ...(fallback ? { fallbackModel: fallback.model } : {}),
            ...(learned ? { learned } : {}),
          };
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
          fallbackModel: cfg.fallbackModel ?? null,
          baseUrl: cfg.baseUrl,
          apiKeySet: Boolean(cfg.apiKey),
          apiKeyEnvVars: cfg.keyEnvVars,
          sessionDir: ensureSessionDir(this.opts.session),
          briefingChars: this.state.briefing.length,
          recording: this.browser.recording,
          scriptRecording: Boolean(this.browser.script),
          scriptSteps: this.browser.script?.entries.filter((e) => e.k === 'step').length ?? 0,
          learning: Boolean(this.browser.learn),
          skillsDir: this.browser.learn?.dir ?? null,
          skills: this.browser.learn ? this.state.skills : null,
          notes: this.state.notes,
          usage: this.state.usage,
          usageByModel: this.state.usageByModel,
          historyMessages: this.state.messages.length,
        };
      }

      case 'var': {
        const name = String(a.name ?? '').trim();
        if (!name) throw new Error('var requires a name (e.g. `var runid=k7`)');
        this.state.setVar(name, String(a.value ?? ''));
        return { vars: this.state.vars };
      }

      case 'flow': {
        // Read-only flow inspection served from disk; the daemon holds no flow state.
        if (a.op === 'list') return { flows: listFlowsSummary() };
        if (a.op === 'show') {
          const flow = loadFlow(String(a.name ?? ''));
          if (!flow) throw new Error(`no flow "${a.name}"`);
          return { flow };
        }
        throw new Error(`unknown flow op ${JSON.stringify(a.op)}`);
      }

      case 'run': {
        const controller = new AbortController();
        this.inflight = controller;
        try {
          return await this.runFlow(String(a.name ?? ''), (a.vars as Record<string, string>) ?? {}, {
            maxTurns: typeof a.maxTurns === 'number' ? a.maxTurns : 30,
            timeoutMs: (typeof a.timeoutS === 'number' ? a.timeoutS : 300) * 1000,
            ...(typeof a.turnTimeoutS === 'number' ? { turnTimeoutMs: a.turnTimeoutS * 1000 } : {}),
            provider: this.provider(),
            fallback: a.escalate === false ? null : this.fallbackProvider({}, this.provider()),
            // Recovery goes STRAIGHT to the strong model: a step that failed to
            // replay is, by definition, no longer the straightforward case the
            // cheap model handled at record time. Resolves to the configured
            // fallback model (even when per-step escalation is off), or an
            // explicit --recovery-model, falling back to the routine model.
            recovery: this.recoveryProvider(a.recoveryModel ? String(a.recoveryModel) : undefined),
            signal: controller.signal,
            progress,
          });
        } finally {
          if (this.inflight === controller) this.inflight = null;
        }
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
        // Export the session as a replayable flow before the context closes.
        let savedFlow;
        if (a.saveFlow) {
          try {
            savedFlow = this.exportFlow(String(a.saveFlow));
          } catch (err) {
            savedFlow = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        const videos = await this.browser.close();
        return { stopping: true, preempted, videos, ...(savedFlow ? { flow: savedFlow } : {}) };
      }

      default:
        throw new Error(`unknown command: ${(req as Request).command}`);
    }
  }

  /**
   * Export the current learning session as a flow: the instructions it issued,
   * in order, each pinned to the skill it used and to the values it read back,
   * with declared run variables turned into references. Requires learning mode
   * (the recording is the source) and a session that ran at least one step.
   */
  private exportFlow(name: string): { path: string; name: string; steps: number; vars: string[] } {
    if (!this.browser.learn || !this.browser.script) {
      throw new Error('not a learning session — start it with --learn to record a flow');
    }
    const entries = this.browser.script.entries;
    const firstGoto = entries.find((e) => e.k === 'step' && e.tool === 'goto');
    const startUrl =
      (firstGoto && 'args' in firstGoto ? String(firstGoto.args.url ?? '') : '') ||
      entries.find((e): e is Extract<typeof e, { k: 'instruction' }> => e.k === 'instruction' && Boolean(e.url))?.url ||
      '';
    const origin = startUrl ? originOf(startUrl) : null;
    if (!origin || !startUrl) throw new Error('could not determine the session start url — was anything opened?');
    const store = this.browser.learn;
    const flow = buildFlow(entries, {
      name,
      origin,
      startUrl,
      vars: this.state.vars,
      session: this.opts.session,
      model: this.provider().model,
      bind: (id, instr) => {
        const sk = store.get(id);
        return sk ? bindSkill(sk, instr) : null;
      },
    });
    if (!flow || !flow.steps.length) throw new Error('nothing to export — no successful instruction was recorded');
    const file = saveFlow(flow);
    return { path: file, name: flow.name, steps: flow.steps.length, vars: flow.vars };
  }

  /**
   * Replay a saved flow with no caller in the loop. Each step resolves its
   * {{var}}/{{step.output}} references, then runs through the normal escalating
   * instruction path — which itself tries the pinned skill first (Tier A/B),
   * repairs on the cheap model if the page drifted, and escalates on blocked.
   * The flow halts at the first step that ends non-success, returning the
   * per-step report so a caller can be brought back in to continue.
   */
  private async runFlow(
    name: string,
    varsIn: Record<string, string>,
    opts: {
      maxTurns: number;
      timeoutMs: number;
      turnTimeoutMs?: number;
      provider: Provider;
      fallback: Provider | null;
      recovery: Provider;
      signal: AbortSignal;
      progress: (m: string) => void;
    },
  ): Promise<unknown> {
    const flow = loadFlow(name);
    if (!flow) throw new Error(`no flow "${name}" (looked in the flows dir and as a path)`);
    const missingVars = flow.vars.filter((v) => !(v in varsIn));
    if (missingVars.length) throw new Error(`flow "${flow.name}" needs --var for: ${missingVars.join(', ')}`);

    if (this.browser.learn) {
      // A run's own repairs should be learned, but not re-pin from a fresh
      // store elsewhere; the flow's pinned skills come from its own file.
    }
    const page = await this.browser.getPage();
    await page.goto(flow.startUrl, { waitUntil: 'load', timeout: 30_000 }).catch(() => {});
    this.browser.script?.commit(await this.browser.script.prepare(page, 'goto', { url: flow.startUrl }).catch(() => null), 'ok');

    const screenshotDir = path.join(ensureSessionDir(this.opts.session), 'screenshots');
    const outputs: Record<string, Record<string, string>> = {};
    const stepResults: Array<Record<string, unknown>> = [];
    const driftTickets: DriftTicket[] = [];
    const started = Date.now();
    let halted = false;

    for (const step of flow.steps) {
      if (opts.signal.aborted) {
        stepResults.push({ id: step.id, status: 'blocked', reason: 'run stopped' });
        halted = true;
        break;
      }
      const { text, missing } = resolveInstruction(step, varsIn, outputs);
      const bound = resolveStepParams(step, varsIn, outputs);
      // A reference that could not be threaded (an output an earlier step did
      // not read back live) does NOT halt the flow: the zero-model replay is
      // skipped and the step goes to recovery on the strong model, built from
      // what IS known (softResolve keeps the resolved title even when the id is
      // missing). Only a genuine failure there halts.
      const unresolved = missing.length > 0 || Boolean(bound && bound.missing.length);
      const recoveryText = unresolved ? softResolveInstruction(step, varsIn, outputs) : text;
      opts.progress(`[flow ${flow.name}] ${step.id}: ${(unresolved ? recoveryText : text).slice(0, 80)}`);
      const mark = this.browser.script?.mark() ?? 0;
      // Zero-model first: replay the step's pinned skill directly, binding its
      // params from the flow's stored bindings (robust to reworded steps)
      // rather than re-deriving them from the instruction text.
      const direct = step.skill && !unresolved
        ? await this.replayDirect(text, screenshotDir, opts.signal, opts.progress, { id: step.skill, params: bound?.params })
        : {};
      let result: InstructionResult;
      let recovered = false;
      if (direct.done) {
        result = direct.done;
      } else {
        // Recovery is hard by definition → strong model, one shot, no cheap
        // pre-attempt. The partial replay (if any) is handed to it directly.
        recovered = true;
        opts.progress(`[flow ${flow.name}] ${step.id}: ${unresolved ? 'reference could not be threaded — ' : ''}recovering on ${opts.recovery.model}`);
        result = await runEscalatingInstruction(
          opts.recovery,
          null,
          this.browser,
          this.state,
          direct.prelude ? `${recoveryText}

${direct.prelude}` : recoveryText,
          {
            maxTurns: opts.maxTurns,
            timeoutMs: opts.timeoutMs,
            ...(opts.turnTimeoutMs ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
            screenshotDir,
            signal: opts.signal,
            onProgress: opts.progress,
          },
        );
        if (direct.partial && result.skill) result.skill = { ...result.skill, ...direct.partial, listed: result.skill.listed };
      }
      // Learn from a repair so the flow's steps get cheaper over successive runs.
      let repinned;
      if (this.browser.learn) {
        const learned = learnFromInstruction(this.browser.learn, {
          result,
          instruction: text,
          entries: this.browser.script?.entriesSince(mark) ?? [],
          session: this.opts.session,
          model: opts.provider.model,
        });
        // Lifecycle-gated adoption: the pin only ever moves to a skill that is
        // VALIDATED and has just replayed this step cleanly. A skill compiled
        // from a single model recovery enters the store provisional and must
        // EARN the pin by validating across runs — flow5 showed that
        // force-pinning such a skill (usually MORE fragile than the clean
        // original) makes the zero-model fraction non-monotone: fail, recover,
        // re-pin another provisional, churn. The pin is a hint, not an
        // authority: selection each run is by track record (selectCandidates),
        // so an unhealthy pin costs one refused/failed attempt, not the step.
        const outcome = learned?.outcome;
        if (result.report.status === 'success' && outcome?.ok && outcome.status === 'validated' && outcome.skill !== step.skill) {
          repinned = outcome.skill;
        }
      }
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(result.report.evidence?.values ?? {})) values[k] = String(v);
      // A recovery's model names its read-backs freely (ticketRef vs
      // ticket_ref vs ticket-id); later steps reference the names recorded at
      // capture time. Alias each expected output that is missing but present
      // under a cosmetically different key, so one cosmetic rename cannot
      // cascade every later step into recovery (the flow6 failure mode).
      if (recovered) {
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const want of step.outputs) {
          if (want in values) continue;
          const hits = Object.keys(values).filter((k) => norm(k) === norm(want));
          if (hits.length === 1) values[want] = values[hits[0]];
        }
      }
      outputs[step.id] = values;
      const sk = result.skill;
      // Drift telemetry: record, never repair inline. One ticket per primary-
      // locator miss, plus one for a recovery with no structured miss to blame.
      if (sk?.invoked) {
        const pageUrlPattern = sk.replayUrl ? compiledUrlPattern(sk.replayUrl) : undefined;
        for (const m of sk.misses ?? []) {
          driftTickets.push({
            flow: flow.name, step: step.id, skill: m.skill ?? sk.invoked, atStep: m.step, key: m.key,
            similarity: sk.similarity, missedLocator: m.primary, fallbackUsed: m.used, ...(m.usedIndex !== undefined ? { fallbackIndex: m.usedIndex } : {}), recovered,
            ...(pageUrlPattern ? { pageUrlPattern } : {}),
          });
        }
        if (recovered && !(sk.misses ?? []).length) {
          driftTickets.push({
            flow: flow.name, step: step.id, skill: sk.invoked, similarity: sk.similarity,
            missedLocator: null, fallbackUsed: null, recovered: true,
            ...(sk.failReason ? { reason: sk.failReason } : {}),
            ...(pageUrlPattern ? { pageUrlPattern } : {}),
          });
        }
      }
      stepResults.push({
        id: step.id,
        status: result.report.status,
        summary: result.report.summary,
        values,
        tier: sk?.tier ?? null,
        replayed: sk?.invoked ? `${sk.stepsReplayed}/${sk.stepsTotal}` : null,
        repaired: Boolean(sk?.repaired),
        turns: result.turns,
        ...(repinned ? { repinned } : {}),
      });
      if (result.report.status !== 'success') {
        halted = true;
        break;
      }
    }

    // Re-pin any repaired steps so the flow file itself gets cheaper next run.
    let updated = 0;
    for (const r of stepResults) {
      if (r.repinned) {
        const step = flow.steps.find((st) => st.id === r.id);
        if (step) {
          step.skill = String(r.repinned);
          updated++;
        }
      }
    }
    if (updated) saveFlow(flow);

    const passed = stepResults.filter((r) => r.status === 'success').length;
    return {
      flow: flow.name,
      status: halted && passed < flow.steps.length ? 'halted' : 'success',
      steps: stepResults,
      passed,
      total: flow.steps.length,
      repinned: updated,
      drift: driftTickets.length,
      ...(driftTickets.length ? { driftTickets } : {}),
      wallMs: Date.now() - started,
      model: opts.provider.model,
    };
  }

  /**
   * Tier A: try a validated, template-matching skill before the model is
   * involved at all. Returns a finished result when the replay completed, a
   * prelude for the agent when it stopped part-way, or nothing when no skill
   * matched (the common case, and free: one store read, no page round trip).
   */
  private async replayDirect(
    instruction: string,
    screenshotDir: string,
    signal: AbortSignal,
    progress: (m: string) => void,
    /** Flow replay pins the skill (and may supply its params); without it, fall back to a validated template match. */
    chosen?: { id: string; params?: Record<string, string> },
  ): Promise<{ done?: InstructionResult; prelude?: string; partial?: Partial<SkillRecord> }> {
    const store = this.browser.learn;
    if (!store || !this.browser.isOpen) return {};
    let url: string;
    try {
      url = (await this.browser.getPage()).url();
    } catch {
      return {};
    }
    const origin = originOf(url);
    if (!origin) return {};
    // Candidates for this instruction, best track record first. In flow mode
    // the pinned skill is only a hint that names the procedure family —
    // selection is by the store's own lifecycle (validated > success rate >
    // experience), so a fragile pin cannot dominate the step run after run.
    let candidates: { skill: import('../skills/store.js').Skill; params: Record<string, string> }[];
    if (chosen) {
      candidates = selectCandidates(store.list(origin), chosen.id, instruction, chosen.params);
    } else {
      const m = matchTemplate(store.list(origin), instruction, url);
      candidates = m ? [m] : [];
    }
    if (!candidates.length) return {};
    this.browser.script?.beginInstruction(instruction, { url });
    let match: { skill: import('../skills/store.js').Skill; params: Record<string, string> } | null = null;
    let replay: NonNullable<Awaited<ReturnType<typeof executeTool>>['replay']> | null = null;
    let attempts = 0;
    for (const cand of candidates) {
      if (attempts >= MAX_CANDIDATE_ATTEMPTS) break;
      progress(`[skill] trying ${cand.skill.id} (${cand.skill.status}, ${cand.skill.stats.successes}/${cand.skill.stats.uses}) without the model`);
      const execution = await executeTool(this.browser, 'run_skill', { id: cand.skill.id, params: cand.params }, screenshotDir, signal);
      const r = execution.replay;
      if (!r) return {};
      if (r.refused) continue; // wrong page / bad params: nothing ran, free to try the next
      attempts++;
      match = cand;
      replay = r;
      if (r.ok) break;
      if (r.stepsRun === 0) {
        // Failed before touching the page — safe to try the next candidate.
        // Record the failure so the store's own lifecycle (two strikes →
        // demoted) drops a flaky skill out of selection.
        store.recordOutcome(cand.skill.id, { ok: false, failedAt: r.failedAt, fallthroughs: r.fallthroughs, instructionSucceeded: false });
        match = null;
        replay = null;
        continue;
      }
      break; // partial: the page has changed — hand what ran to recovery, never restart another candidate
    }
    if (!match || !replay) return {};

    // Walk the segment chain: a multi-segment skill replays segment by
    // segment, each gated by its own precondition. A cleanly-replayed
    // segment's outcome is recorded on ITS skill immediately (its own success
    // regardless of what later segments do — that independence is the point
    // of segmentation); the LAST replay, clean or not, is left to the
    // instruction-level learning so it is not double-counted. On a mid-chain
    // stop, recovery inherits only the failed segment's blame.
    const agg = {
      stepsRun: replay.stepsRun,
      stepsTotal: replay.stepsTotal,
      fallthroughs: replay.fallthroughs,
      misses: replay.misses.map((m) => ({ ...m, skill: replay!.skill })),
      values: { ...replay.values },
      segmentsDone: 0,
    };
    let current = match.skill;
    let last = match.skill; // whose replay `replay` currently holds
    while (replay.ok && current.seq && current.seq.index < current.seq.of - 1) {
      const next = store.list(origin).find((s) => s.seq?.chain === current.seq!.chain && s.seq?.index === current.seq!.index + 1);
      if (!next) {
        replay = { ...replay, ok: false, reason: `segment ${current.seq.index + 2}/${current.seq.of} of this procedure chain is missing from the store` };
        break;
      }
      // The just-finished segment succeeded on its own terms — record it now.
      store.recordOutcome(last.id, { ok: true, fallthroughs: replay.fallthroughs, instructionSucceeded: true });
      agg.segmentsDone++;
      progress(`[skill] chain ${current.seq.chain}: segment ${next.seq!.index + 1}/${next.seq!.of} → ${next.id}`);
      const nextExec = await executeTool(this.browser, 'run_skill', { id: next.id, params: match.params }, screenshotDir, signal);
      const r = nextExec.replay;
      if (!r) return {};
      replay = r;
      last = next;
      current = next;
      agg.stepsRun += r.stepsRun;
      agg.stepsTotal += r.stepsTotal;
      agg.fallthroughs += r.fallthroughs;
      agg.misses.push(...r.misses.map((m) => ({ ...m, skill: next.id })));
      Object.assign(agg.values, r.values);
    }

    const record: Partial<SkillRecord> = {
      // On success the chain head answers for the whole run; on a stop, the
      // segment that stopped does, so demotion and variants attach to it.
      invoked: replay.ok ? match.skill.id : last.id,
      stepsReplayed: replay.ok ? agg.stepsRun : replay.stepsRun,
      stepsTotal: replay.ok ? agg.stepsTotal : replay.stepsTotal,
      refused: Boolean(replay.refused),
      fallthroughs: agg.fallthroughs,
      similarity: replay.similarity,
      ...(agg.misses.length ? { misses: agg.misses } : {}),
      ...(replay.reason ? { failReason: replay.reason } : {}),
      ...(replay.failedAt !== undefined ? { failedAt: replay.failedAt } : {}),
      replayUrl: replay.url,
      deterministicActions: agg.stepsRun,
      totalActions: agg.stepsRun,
      tier: 'A',
    };
    if (!replay.ok) {
      const ranNote = agg.segmentsDone
        ? `[replay] ${agg.segmentsDone} earlier segment(s) of this procedure chain replayed cleanly and HAVE changed the page. Then a stored segment stopped part-way. Its output:\n`
        : `[replay] A stored procedure was replayed before you started and stopped part-way. Its output:\n`;
      return {
        prelude: ranNote + renderReplay(last, replay),
        partial: record,
      };
    }
    const report = synthesizeReport(last, match.params, agg.values);
    // Keep the conversation coherent for later instructions: the same one-line
    // entry the loop would have written.
    this.state.messages.push({ role: 'user', content: instruction });
    const facts = Object.entries(report.evidence?.values ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    this.state.messages.push({ role: 'assistant', content: `[report] success: ${report.summary}${facts ? ' | ' + facts : ''}` });
    return {
      done: {
        report,
        turns: 0,
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
        screenshots: [],
        skill: { listed: [match.skill.id], repaired: false, ...record } as SkillRecord,
      },
    };
  }

  private async shutdown(): Promise<void> {
    await this.browser.close();
    this.server?.close();
    // give the result frame time to flush before exiting
    await new Promise((r) => setTimeout(r, 150));
    process.exit(0);
  }
}

function listFlowsSummary() {
  return listFlows().map((f) => ({ name: f.name, origin: f.origin, steps: f.steps.length, vars: f.vars, created: f.provenance.created }));
}

function describeLearned(l: ReturnType<typeof learnFromInstruction>): string {
  if (!l) return 'nothing';
  const parts: string[] = [];
  if (l.outcome) parts.push(`${l.outcome.skill} ${l.outcome.ok ? 'replayed ok' : 'replay stopped part-way'} → ${l.outcome.status}`);
  if (l.compiled) parts.push(`stored ${l.compiled}${l.variantOf ? ` as a variant of ${l.variantOf}` : ''}`);
  if (l.merged) parts.push(`merged into ${l.merged}`);
  if (l.superseded) parts.push(`${l.superseded} superseded`);
  return parts.join('; ') || 'nothing';
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Anthropic speaks its own wire format; everything else is OpenAI-compatible. */
function build(config: ReturnType<typeof resolveProviderConfig>): Provider {
  return config.provider === 'anthropic' ? new AnthropicProvider(config) : new OpenAICompatProvider(config);
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
    learn: argv.includes('--learn'),
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
