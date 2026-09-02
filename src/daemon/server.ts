import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AnthropicProvider, OpenAICompatProvider, resolveProviderConfig, type Provider } from '../agent/llm.js';
import { runEscalatingInstruction, type InstructionResult, type SkillRecord } from '../agent/loop.js';
import { executeTool } from '../agent/tools.js';
import { urlPattern as compiledUrlPattern, stranded, urlParts } from '../skills/compile.js';
import type { DriftTicket } from '../skills/repair.js';
import { bindSkill, canAdoptPin, learnFromInstruction, matchTemplate, publishedOutputs, selectCandidates, synthesizeReport } from '../skills/learn.js';
import { buildFlow, consumedUrlOutputs, lintFlowRefs, listFlows, loadFlow, lookupOutput, noteOutputEvidence, recoveryRoute, resolveInstruction, resolveStepParams, softResolveInstruction, saveFlow, saveRejectedFlow, stableOutputs, staleInstructionIds, unbankedMutations, urlOutputs } from '../skills/flow.js';
import { applyRelabelToEntries, applyRelabelToSkills, relabelCases, requestRelabelPlan } from '../skills/relabel.js';
import { renderReplay } from '../skills/replay.js';
import { recordCandidateEvidence } from '../skills/repair.js';
import { RunLedger, bindingKey, describeLeaks, fatal, scanForLeaks, type Leak } from '../skills/ledger.js';
import { originOf, type Skill } from '../skills/store.js';
import type { LocatorCandidate } from './recorder.js';
import { generateScript } from './codegen.js';
import { snapshot, waitForContent } from './refs.js';
import { ScriptRecorder } from './recorder.js';
import { encodeFrame, LineDecoder, type CommandName, type Frame, type Request } from '../shared/protocol.js';
import { aliasLegacyEnv, ensureSessionDir, socketPath, validateSessionName } from '../shared/paths.js';
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
  /**
   * Everything THIS RUN made — caller vars, ids minted in a url, values a
   * step reported — each with a binding saying how a later run re-derives its
   * own. A later instruction naming one of these is naming a value of this
   * run, not of the app, so compile must slot it; fwgr6 shipped n1's uid 62
   * times inside skill templates because recording had no such registry.
   * See PLAN-provenance.md.
   */
  private ledger = new RunLedger();
  /** Instruction counter, so a ledger entry can say where it first appeared. */
  private instructionIndex = 0;

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

  /** Bank what this instruction minted: url ids first, then reported values. */
  private noteMintedIds(entries: ReturnType<ScriptRecorder['entriesSince']>, stepId: string): void {
    for (const e of entries) {
      const url = e.k === 'step' ? e.diff?.url : e.k === 'instruction' ? e.url : undefined;
      if (url) this.ledger.addUrlIds(url, stepId, urlParts(url));
      if (e.k === 'report') {
        for (const [name, value] of Object.entries(e.values ?? {})) {
          this.ledger.add(String(value), { from: 'output', step: stepId, name }, { known: true });
        }
      }
    }
  }

  /** Caller vars seeded once, so every producer sees the same run values. */
  private seedLedger(): void {
    for (const [name, value] of Object.entries(this.state.vars ?? {})) this.ledger.add(value, { from: 'var', name });
  }

  /**
   * Scan a freshly compiled skill for values this run made. The flow export
   * scan (below) covers what a flow carries; this covers the STORE, which is
   * where the damage actually lands — an anchor holding the recording run's
   * runid still resolves on the run that recorded it, so the sweep passes and
   * the defect only shows up as a drift ticket two runs later.
   *
   * WARN, not ERROR: what is being measured is the ledger's coverage.
   */
  private reportSkillLeaks(learned: { compiled?: string; compiledAll?: string[] }, progress: (m: string) => void): void {
    const store = this.browser.learn;
    if (!store) return;
    const ids = learned.compiledAll ?? (learned.compiled ? [learned.compiled] : []);
    for (const id of ids) {
      const skill = store.get(id);
      if (!skill) continue;
      const leaks = scanForLeaks(skill, this.ledger, id);
      if (leaks.length) progress(`[learn] warning: ${leaks.length} run value(s) survived into ${id}:
${describeLeaks(leaks.slice(0, 6))}`);
    }
  }

  /**
   * Drop locator candidates carrying a value the ledger knows this run made.
   * Never empties a chain — a step with no way to find its element is worse
   * than one carrying a candidate that will miss. Returns how many went.
   */
  private stripLeakedCandidates(flow: import('../skills/flow.js').Flow, store: NonNullable<typeof this.browser.learn>): number {
    const runValues = this.ledger.values().filter((v) => v.length >= 3);
    if (!runValues.length) return 0;
    let removed = 0;
    for (const skill of this.sessionSkills(flow, store)) {
      let touched = false;
      const walk = (steps: Skill['steps']): void => {
        for (const step of steps) {
          for (const [key, chain] of Object.entries(step.locators ?? {}) as [string, LocatorCandidate[]][]) {
            const kept = chain.filter((c) => !stranded(c, runValues));
            if (!kept.length || kept.length === chain.length) continue;
            removed += chain.length - kept.length;
            step.locators[key] = kept;
            touched = true;
          }
          if (step.body) walk(step.body);
        }
      };
      walk(skill.steps);
      if (touched) store.put(skill);
    }
    return removed;
  }

  /**
   * Everything of this run's that survived into what the export will publish.
   * The SKILLS as well as the flow: a flow has no locators of its own, and a
   * locator is where a leak does its damage silently.
   */
  private leaksIn(flow: import('../skills/flow.js').Flow, store: NonNullable<typeof this.browser.learn>): Leak[] {
    const leaks = scanForLeaks(flow, this.ledger, 'flow');
    for (const sk of this.sessionSkills(flow, store)) leaks.push(...scanForLeaks(sk, this.ledger, sk.id));
    return leaks;
  }

  /**
   * The skills this run's ledger has any business rewriting: everything THIS
   * SESSION compiled, plus whatever the flow pinned.
   *
   * Pinned-only was too narrow. fwrd26l exported clean while two skills it had
   * just compiled still carried `RD-1015` and a creation date in a row-text
   * locator — unpinned, so unscanned, and selectCandidates will happily pick
   * one at replay because it binds the instruction. Session-scoped and not
   * store-wide, because a skill some EARLIER run made is not ours to rewrite:
   * a literal that looks like this run's value may have been legitimate in its.
   */
  private sessionSkills(flow: import('../skills/flow.js').Flow, store: NonNullable<typeof this.browser.learn>): Skill[] {
    const out = new Map<string, Skill>();
    for (const sk of store.list(flow.origin)) {
      if (sk.provenance?.session === this.opts.session) out.set(sk.id, sk);
    }
    for (const st of flow.steps) {
      const sk = st.skill ? store.get(st.skill) : null;
      if (sk) out.set(sk.id, sk);
    }
    return [...out.values()];
  }

  /** The run's values keyed by their ORIGIN, so a param can bind to where a value comes from. */
  private knownValues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.ledger.all()) out[bindingKey(e.binding)] = e.value;
    return out;
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
    // A different model must not inherit the main model's extraBody: routing
    // pins are per-model calibration (see ProviderConfig.extraBody).
    return build({ ...config, model: config.fallbackModel, extraBody: config.fallbackExtraBody });
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
    // Same rule as fallbackProvider: extraBody is main-model calibration, so
    // a recovery built for a different model takes fallbackExtraBody. This is
    // what aborted relabel on 3 of 4 live runs — the bench's Baidu pin
    // (chosen for deepseek-v4-flash) forced glm-5.3 through a slow upstream:
    // 25.5s measured with the pin vs 3.9s without, against a 75s timebox.
    return build({ ...config, model, ...(model !== config.model ? { extraBody: config.fallbackExtraBody } : {}) });
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
        // `load` fires before a client-rendered app has painted, and the very
        // next thing anyone does with an opened page is snapshot it.
        await waitForContent(page);
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
          // Bank the ids this instruction minted BEFORE compiling it: a value
          // first seen in this instruction's own url is already known to the
          // caller by the time the next instruction names it, and compile
          // must treat it as a run value rather than app furniture.
          const entriesSince = this.browser.script?.entriesSince(mark) ?? [];
          this.instructionIndex += 1;
          this.ledger.beginInstruction(this.instructionIndex);
          this.seedLedger();
          const learned = this.browser.learn
            ? learnFromInstruction(this.browser.learn, {
                result,
                instruction,
                entries: entriesSince,
                session: this.opts.session,
                model: provider.model,
                vars: this.knownValues(),
              })
            : null;
          this.noteMintedIds(entriesSince, `i${this.instructionIndex}`);
          if (learned) progress(`[learn] ${describeLearned(learned)}`);
          if (learned) this.reportSkillLeaks(learned, progress);
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
            'nothing recorded for this session — start it with --script (or SLEEP_WALKER_SCRIPT=1) before running instructions',
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
            // Flow recovery goes straight to the strong model on a step that
            // is by definition no longer straightforward — give it double the
            // interactive default (swg2-n3 step 05 died mid-recovery at 300s).
            timeoutMs: (typeof a.timeoutS === 'number' ? a.timeoutS : 600) * 1000,
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
            savedFlow = await this.exportFlow(String(a.saveFlow));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Swallowing this into a result field is how a refused export went
            // unnoticed through a whole sweep: nothing prints it.
            console.error(`[flow] export failed: ${message}`);
            savedFlow = { error: message };
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
  private async exportFlow(name: string): Promise<{ path: string; name: string; steps: number; vars: string[]; warnings?: string[] }> {
    if (!this.browser.learn || !this.browser.script) {
      throw new Error('not a learning session — start it with --learn to record a flow');
    }
    // THIS take only — a session dir that survived a crash or a container
    // restart must not blend the killed take into the exported flow.
    const entries = this.browser.script.entriesThisTake();
    const prior = this.browser.script.priorEntries;
    const firstGoto = entries.find((e) => e.k === 'step' && e.tool === 'goto');
    const startUrl =
      (firstGoto && 'args' in firstGoto ? String(firstGoto.args.url ?? '') : '') ||
      entries.find((e): e is Extract<typeof e, { k: 'instruction' }> => e.k === 'instruction' && Boolean(e.url))?.url ||
      '';
    const origin = startUrl ? originOf(startUrl) : null;
    if (!origin || !startUrl) throw new Error('could not determine the session start url — was anything opened?');
    const store = this.browser.learn;
    // ONE definition of "what a zero-model replay republishes", shared by the
    // flow builder (which decides what may become a reference) and the linter
    // (which reports what still did). A step's pin may be the HEAD of a
    // segment chain whose later segment does the reading, so the whole chain
    // counts.
    const publishedOutputsOf = (id: string): string[] | null => {
      const sk = store.get(id);
      if (!sk) return null;
      const chain = sk.seq ? store.list(sk.origin).filter((s) => s.seq?.chain === sk.seq!.chain) : [sk];
      return chain.flatMap(publishedOutputs);
    };
    // Post-session relabel: one smart-model pass over the finished session's
    // value names, BEFORE buildFlow mints any {{step.name}} reference. Session
    // end is the only moment naming can use hindsight — which values later
    // instructions actually consumed — and renaming is value-keyed, so nothing
    // banked can be lost; see relabel.ts. Best-effort: a failed call exports
    // the flow with the names it already has. Instruction order in this take
    // matches the ledger's i<N> because a take begins with the daemon.
    try {
      const cases = relabelCases(entries);
      if (cases.length) {
        // Time-boxed: this runs inside `stop`, whose caller is waiting. A
        // slow model costs a bounded wait and the flow exports with the names
        // it has; it must never cost the export (see the CLI's stop timeout,
        // 150s with --save-flow). 30s proved too tight (fwod28 aborted on
        // both outings), and 75s still lost fwod29-n1 — the un-pinned call
        // itself takes ~4s, so what 75s cannot absorb is ONE 429 whose
        // Retry-After hint runs to 65s. 100s covers a full rate-limit wait
        // plus the retry.
        const relabelStarted = Date.now();
        const { plan, dropped } = await requestRelabelPlan(this.recoveryProvider(), cases, {
          signal: AbortSignal.timeout(100_000),
        });
        // Instrumented after fwgr19-n1 aborted with the call still pending:
        // the duration says whether the fix (effort: 'low' in relabel.ts)
        // holds or the pass is drifting back toward the timebox.
        console.error(`[relabel] plan returned in ${Date.now() - relabelStarted}ms (${cases.length} case(s))`);
        if (dropped.length) console.error(`[relabel] dropped ${dropped.length} unsafe rename(s): ${dropped.join('; ')}`);
        // Leave a trace even when nothing is renamed: fwod27's script showed
        // zero `relabel` fields and could not say whether the pass proposed
        // nothing or never ran — this daemon's stderr goes nowhere.
        const emptyTrace = (): void => {
          const last = [...entries].reverse().find((e) => e.k === 'report' && e.status === 'success');
          if (last && last.k === 'report') {
            last.relabel = {};
            this.browser.script?.persist();
          }
        };
        if (!plan.size) emptyTrace();
        if (plan.size) {
          const applied = applyRelabelToEntries(entries, plan);
          // A skill may be the head of a segment chain whose LATER segment
          // holds the labelled read, so the whole chain takes the rename.
          const skillIndex = new Map<string, number>();
          for (const c of cases) {
            if (!c.skill) continue;
            const sk = store.get(c.skill);
            if (!sk) continue;
            const chain = sk.seq ? store.list(sk.origin).filter((s) => s.seq?.chain === sk.seq!.chain) : [sk];
            for (const s of chain) skillIndex.set(s.id, c.index);
          }
          const skills = [...skillIndex.keys()].map((id) => store.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
          // Persist the objects applyRelabelToSkills MUTATED. The first cut
          // re-fetched with store.get(id) here — but get() re-reads from disk
          // every call, so it handed back pristine copies and the put was a
          // no-op. The skill-side rename silently never persisted on ANY run:
          // fwkb1's flow said {{01-open.column_3}} while its skill kept
          // publishing table_tr_first_child_th_2, both replays hit unresolved
          // refs, and n3's recovery — destination blanked — invented "Ready"
          // and reported success. One dead-reference bug in a new costume,
          // exactly as relabel.ts's doc comment warned.
          const byId = new Map(skills.map((s) => [s.id, s]));
          for (const id of applyRelabelToSkills(skills, plan, skillIndex)) {
            const sk = byId.get(id);
            if (sk) store.put(sk);
          }
          this.browser.script.persist();
          console.error(`[relabel] renamed ${applied} value(s) across ${plan.size} instruction(s)`);
          // A plan whose every rename missed its report (validator survivors
          // that matched no existing key) writes no per-report trace at all —
          // fwrd38-n1's silence. Ran-but-changed-nothing must still say so.
          if (applied === 0) emptyTrace();
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[relabel] skipped: ${message}`);
      const last = [...entries].reverse().find((e) => e.k === 'report' && e.status === 'success');
      if (last && last.k === 'report') {
        last.relabel = { '(error)': message.slice(0, 120) };
        this.browser.script.persist();
      }
    }
    const flow = buildFlow(entries, {
      name,
      origin,
      startUrl,
      vars: this.state.vars,
      session: this.opts.session,
      model: this.provider().model,
      bind: (id, instr) => {
        const sk = store.get(id);
        return sk ? bindSkill(sk, instr, this.knownValues()) : null;
      },

    });
    if (!flow || !flow.steps.length) throw new Error('nothing to export — no successful instruction was recorded');
    // Before anything is written. The first cut of this ran after saveFlow,
    // so a "refused" export still left a usable flow on disk and the next run
    // replayed it regardless — a gate that refuses to REPORT is not a gate.
    // Export knows more than compile did. `ticket-link-t15` is welded out of
    // a value the ticket-CREATING instruction minted, so while that
    // instruction compiled, nothing had banked t15 and `stranded` could not
    // see it — the ledger only learns it when a later instruction lands on
    // that url. By export it is known, so apply the same provenance rule with
    // the knowledge that arrived late, and refuse only what survives it.
    //
    // Deleting HERE and not at compile is the whole distinction: this is
    // provenance (the ledger knows the run made the value), never a guess
    // from the token's shape. A shape guess only ever demotes — see
    // `bookmarked` — and observation settles it.
    const stripped = this.stripLeakedCandidates(flow, store);
    const fatalLeaks = this.leaksIn(flow, store).filter(fatal);
    if (fatalLeaks.length) {
      const detail =
        `${fatalLeaks.length} value(s) this run made survived into a locator, ` +
        `where they would silently move a step onto another record:
${describeLeaks(fatalLeaks.slice(0, 10))}`;
      // Kept, but somewhere nothing will replay it: the recording cost real
      // time and money, and the fix is usually obvious from the leak list.
      const kept = saveRejectedFlow(flow, detail);
      throw new Error(`refusing to export: ${detail}

the flow was written to ${kept} for inspection (it will not be replayed)`);
    }
    const file = saveFlow(flow);
    // Reference lint (case 4a): warn now, while re-recording is still cheap,
    // about any {{step.output}} only model recovery could re-observe. A step's
    // pin may be one segment of a chain whose LATER segment does the read, so
    // publishes() unions the whole chain.
    const warnings = lintFlowRefs(flow, publishedOutputsOf);
    // Phase 2 of PLAN-provenance: report anything of this run's that survived
    // into the flow. WARN for now — the ledger's coverage is what is being
    // measured, and a false alarm must not block an export.
    const leaks = this.leaksIn(flow, store);
    if (leaks.length) {
      warnings.unshift(`warning: ${leaks.length} run value(s) survived unslotted (non-fatal — a stale urlPattern fails loudly, a stale reportTemplate is caught by synthesizeReport):
${describeLeaks(leaks.slice(0, 10))}`);
    }
    // Work the recording did that the flow does not contain. Loud, because a
    // flow missing its create step is unusable and looks fine until a replay
    // runs against a clean app.
    for (const w of staleInstructionIds(entries, flow).reverse()) warnings.unshift(`warning: ${w}`);
    for (const m of unbankedMutations(entries).reverse()) warnings.unshift(`warning: ${m}`);
    const adopted = flow.steps.filter((s) => s.adopted);
    if (adopted.length) {
      warnings.unshift(
        `note: ${adopted.length} step(s) adopted from non-success instruction(s) whose work the session continued from ` +
          `(${adopted.map((s) => s.id).join(', ')}) — they replay model-first with doubled budget, and a non-success there does not halt the flow`,
      );
    }
    if (stripped) warnings.unshift(`note: dropped ${stripped} locator candidate(s) carrying a value this run minted (known only by export time)`);
    if (prior) warnings.unshift(`warning: ignored ${prior} entr${prior === 1 ? 'y' : 'ies'} from an earlier take in session '${this.opts.session}' — this flow covers only what this daemon recorded`);
    return { path: file, name: flow.name, steps: flow.steps.length, vars: flow.vars, ...(warnings.length ? { warnings } : {}) };
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
    // Which url.* outputs of each step a LATER step consumes — the capture
    // below waits (bounded) for those to appear in the URL. See
    // consumedUrlOutputs for the SPA-updates-the-url-late failure this closes.
    const wantedUrlOuts = consumedUrlOutputs(flow.steps);
    const stepResults: Array<Record<string, unknown>> = [];
    const driftTickets: DriftTicket[] = [];
    const started = Date.now();
    // Inner-model spend across the whole flow run. A pure tier-A replay is
    // genuinely zero; recovery steps are not, and reporting them as free
    // overstated the record-once/replay-many economics.
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    // Per-model split of the same spend, via SessionState's ledger: cheap-first
    // recoveries (route-by-cause) must not be priced at the strong model's
    // rate, or the routing win is invisible in the bench.
    const usageBefore = JSON.parse(JSON.stringify(this.state.usageByModel)) as typeof this.state.usageByModel;
    let halted = false;
    /** Adoptions decided this run, before the write-back — see the repin gate. */
    const pendingPins = new Map<string, string>();
    /** Adopted steps that recovered cleanly this run and should shed `adopted`. */
    const graduated = new Set<string>();
    /**
     * Outputs an earlier run demonstrated are the app's, not this run's, so
     * their recorded literal resolves instead of sending the step to recovery.
     * Read once: a verdict reached mid-run applies from the NEXT run, so every
     * step of one run sees the same evidence.
     */
    const stable = stableOutputs(flow);
    if (Object.keys(stable).length) {
      opts.progress(`[flow ${flow.name}] ${Object.keys(stable).length} output(s) demonstrated stable by an earlier run: ${Object.keys(stable).join(', ')}`);
    }
    /** Steps whose output evidence this run changed, for the write-back below. */
    let evidenceChanged = 0;

    // Set by a step that recovered on the model: a recovery can end
    // "successfully" yet leave a blocking dialog open (rpod1-r2: an earlier
    // recovery left an email composer and an Edit dialog behind, and 06-open
    // paid 56 turns clearing debris its predecessor left). A clean tier-A
    // replay ends where the recording ended — at rest — so only a recovery
    // needs the boundary swept.
    let prevRecovered = false;

    for (const step of flow.steps) {
      if (opts.signal.aborted) {
        stepResults.push({ id: step.id, status: 'blocked', reason: 'run stopped' });
        halted = true;
        break;
      }
      // Between-step hygiene: at a step boundary the page should be at rest, so
      // a still-open modal is debris from the previous step's recovery. Clear
      // it before this step's own skill replay so the debris is not charged to
      // this step. Gated on prevRecovered (nothing to sweep after a clean
      // replay) and bounded; uses the ARIA-standard modal signal, never an
      // app selector. In-skill dialogs are unaffected — this runs only at the
      // boundary, never mid-skill.
      if (prevRecovered) {
        try {
          const page = await this.browser.getPage();
          const blockers = page.locator('[role="dialog"], [aria-modal="true"]');
          for (let i = 0; i < 3 && (await blockers.count()) > 0 && (await blockers.first().isVisible().catch(() => false)); i++) {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(250);
          }
          if ((await blockers.count()) > 0 && (await blockers.first().isVisible().catch(() => false))) {
            opts.progress(`[flow ${flow.name}] ${step.id}: a blocking dialog from the previous step's recovery would not dismiss — proceeding, the step's own recovery will handle it`);
          }
        } catch {
          /* browser gone or overlay check failed — the step runs anyway */
        }
      }
      prevRecovered = false;
      const { text, missing } = resolveInstruction(step, varsIn, outputs, stable);
      const bound = resolveStepParams(step, varsIn, outputs, stable);
      // A reference that could not be threaded (an output an earlier step did
      // not read back live) does NOT halt the flow: the zero-model replay is
      // skipped and the step goes to recovery on the strong model, built from
      // what IS known (softResolve keeps the resolved title even when the id is
      // missing). Only a genuine failure there halts.
      const unresolved = missing.length > 0 || Boolean(bound && bound.missing.length);
      const recoveryText = unresolved ? softResolveInstruction(step, varsIn, outputs, stable) : text;
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
      // Why this step could not run without the model, in the step result and
      // the drift ticket. Without it every fallback looks the same from the
      // outside and the cause has to be guessed from the store.
      const fellBack = unresolved
        ? `unresolved reference(s): ${[...missing, ...(bound?.missing ?? [])].join(', ')}`
        : !step.skill
          ? 'the flow step has no pinned skill'
          : (direct.why ?? 'no reason recorded');
      if (direct.done) {
        result = direct.done;
      } else {
        opts.progress(`[flow ${flow.name}] ${step.id}: falling back to the model — ${fellBack}`);
        // All recovery causes run cheap-first with the strong model as
        // escalation-on-blocked (see recoveryRoute): the fwrd4l sweep showed
        // the session model rescuing replay-failed steps too, at a fraction
        // of the strong tier's rate; the cause label still names why.
        recovered = true;
        // Wrong record, not wrong procedure: every skill refused because the
        // open page belongs to a different record of the same template. A
        // model handed that page repairs the step where it stands — fwrd8-n2
        // added both parts, edited and archived a SEED ticket and reported
        // success. Put the browser back on the flow's start page so recovery
        // has to navigate to the record the instruction names.
        let resetNote = '';
        if (direct.wrongRecord) {
          opts.progress(`[flow ${flow.name}] ${step.id}: ${direct.wrongRecord}`);
          try {
            const page = await this.browser.getPage();
            await page.goto(flow.startUrl);
            resetNote = `\n\n[replay] The browser was showing a different record than this step needs (${direct.wrongRecord}). It has been returned to ${flow.startUrl} — navigate to the record this instruction names before doing anything else.`;
          } catch {
            resetNote = `\n\n[replay] The browser is showing a different record than this step needs (${direct.wrongRecord}). Navigate to the record this instruction names before doing anything else.`;
          }
        }
        // A soft-resolved instruction has BLANKS where its references were.
        // fwkb1-n3 is what an unguarded blank costs: "move the task into the
        // '' column" left the destination to the model's imagination, it
        // picked "Ready", moved the card there, verified ITS OWN choice and
        // reported success — a wrong outcome delivered confidently. Guessing
        // a detail (which button opens a form) is recovery working; guessing
        // the GOAL is not.
        const blankNote = unresolved
          ? `\n\n[replay] One or more details in this instruction could not be resolved and appear blank or missing. ` +
            `Work them out from the page when the goal itself is clear — but if a blank leaves the goal ambiguous ` +
            `(a destination, a target record, a value to set), STOP and report blocked instead of guessing.`
          : '';
        const route = recoveryRoute(step, unresolved);
        const primary = route.easy ? opts.provider : opts.recovery;
        const escalation = route.easy && opts.recovery.model !== opts.provider.model ? opts.recovery : null;
        opts.progress(`[flow ${flow.name}] ${step.id}: ${route.cause} — recovering on ${primary.model}${escalation ? ` (escalates to ${escalation.model})` : ''}`);
        // An adopted step is known-hard: at record time it exhausted one full
        // budget on the cheap model AND one on the escalation. One budget will
        // not do it now either, so double it rather than replay the recorded
        // stall.
        const budget = step.adopted
          ? { maxTurns: opts.maxTurns * 2, timeoutMs: opts.timeoutMs * 2 }
          : { maxTurns: opts.maxTurns, timeoutMs: opts.timeoutMs };
        try {
          result = await runEscalatingInstruction(
            primary,
            escalation,
            this.browser,
            this.state,
            (direct.prelude ? `${recoveryText}

${direct.prelude}` : recoveryText) + blankNote + resetNote,
            {
              maxTurns: budget.maxTurns,
              timeoutMs: budget.timeoutMs,
              ...(opts.turnTimeoutMs ? { turnTimeoutMs: opts.turnTimeoutMs } : {}),
              screenshotDir,
              signal: opts.signal,
              onProgress: opts.progress,
            },
          );
        } catch (err) {
          // A hard infrastructure failure (LLM retries exhausted, browser
          // gone) must not throw away the whole flowrun: the runs that DID
          // complete, the priced usage, and the halt point are the result.
          // fwgr2-n2/n3 died this way on an OpenRouter 429 and left nothing.
          const message = err instanceof Error ? err.message : String(err);
          stepResults.push({ id: step.id, status: 'blocked', summary: `recovery failed before completing: ${message.slice(0, 300)}`, values: {}, tier: null, replayed: null, repaired: false, turns: 0 });
          halted = true;
          break;
        }
        if (direct.partial && result.skill) result.skill = { ...result.skill, ...direct.partial, listed: result.skill.listed };
      }
      // Learn from a repair so the flow's steps get cheaper over successive runs.
      let repinned;
      if (this.browser.learn) {
        const learned = learnFromInstruction(this.browser.learn, {
          result,
          // Never hand compile an instruction with unresolved {{ref}} markers:
          // they leak verbatim into the skill template (s_166633 carried a
          // literal "{{01-open.ticket_ref}}"), which no live instruction can
          // ever match. The soft-resolved text is what actually drove the run.
          instruction: unresolved ? recoveryText : text,
          entries: this.browser.script?.entriesSince(mark) ?? [],
          session: this.opts.session,
          model: opts.provider.model,
          // Slot-by-policy inputs: this run's declared vars plus every url
          // provenance value minted so far, so a skill compiled from a repair
          // is generic across runs instead of baking in this run's ids.
          vars: { ...varsIn, ...provenanceValues(outputs), ...referencedValues(step, outputs) },
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
        // Two further gates, both from fwrd14l-n2, where step 08 (create a
        // scratch ticket) and step 09 (delete both parts) were re-pinned to
        // s_0b2413 — step 07's READ-ONLY skill, validated and matching the
        // same detail page. n3 inherited the rewritten flow, replayed 07's
        // read chain three times, mutated NOTHING, reported success for all
        // three, and halted at step 10 on a scratch ticket that was never
        // created. A replay that reports success having done nothing is the
        // worst outcome this system can produce, so the pin must be about
        // this step's WORK, not merely a skill that resolves on this page.
        // Pending re-pins count as owned. The write-back happens after the
        // loop, so on the flow object alone this run's own adoptions are
        // invisible — fwrd16-n3 re-pinned 02-create AND 10-open onto the same
        // s_738ec0 in one pass, straight through the gate that exists to
        // forbid it.
        const owned = flow.steps.map((st) => ({ id: st.id, skill: pendingPins.get(st.id) ?? st.skill }));
        const adoptable = outcome && canAdoptPin(this.browser.learn, owned, step.id, step.skill, outcome.skill);
        if (result.report.status === 'success' && outcome?.ok && outcome.status === 'validated' && outcome.skill !== step.skill && adoptable) {
          repinned = outcome.skill;
          pendingPins.set(step.id, outcome.skill);
        } else if (
          // Adopted-step graduation. An adopted step's incumbent skill (if it
          // has one) is a PARTIAL compiled from a non-success recording — the
          // reason it was adopted was that its instruction never reported
          // success, so its skill covers only the sub-steps that ran before
          // the session moved on (rpod1's 01-open replayed 1/2 then paid ~90
          // turns of model recovery on EVERY replay, plus the adopted doubled
          // budget, forever). The normal gate withholds the pin until a fresh
          // provisional validates across runs — sound when the incumbent is a
          // healthy validated skill, but inverted here: the incumbent is known
          // scaffolding, strictly worse than a recovery that just completed
          // the whole step. So on the FIRST clean recovery, pin the recovery
          // skill (provisional is fine) and shed `adopted`, letting the next
          // run treat this as an ordinary step whose skill earns its place
          // through the normal lifecycle instead of re-recovering from zero.
          // Still gated by canAdoptPin (never steal another step's skill,
          // never demote a mutating step to a read-only one).
          step.adopted &&
          result.report.status === 'success' &&
          outcome?.ok &&
          outcome.skill &&
          outcome.skill !== step.skill &&
          adoptable
        ) {
          repinned = outcome.skill;
          pendingPins.set(step.id, outcome.skill);
          graduated.add(step.id);
          opts.progress(`[flow ${flow.name}] ${step.id}: adopted step graduated — pinned ${outcome.skill} (${outcome.status}), shedding model-first replay`);
        }
      }
      usage.promptTokens += result.usage.promptTokens;
      usage.completionTokens += result.usage.completionTokens;
      usage.cachedTokens += result.usage.cachedTokens;
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
      // Mechanism 1 at the flow level (PLAN-replay-v2): the step's end-url
      // parts are outputs too, so a later step whose recorded value was
      // minted here (a dashboard uid in the post-create url) binds to THIS
      // run's value. Kept out of the step's reported values in the flow
      // result — they are addresses, not findings.
      const stepOutputs: Record<string, string> = { ...values };
      try {
        // Whatever this run's browser landed on, published under the same
        // rule buildFlow used to mint the references — see urlOutputs. When a
        // later step is known to consume one of this step's url outputs, wait
        // (bounded) for the URL to actually carry it: an SPA can update its
        // URL a beat after the page settles, and a structural replay finishes
        // inside that beat — fwod30 lost {{03-open.url.q.id}} to a snapshot
        // taken before Odoo's hash gained the freshly minted id.
        const flowPage = await this.browser.getPage();
        let urlOuts = urlOutputs(flowPage.url());
        const wanted = wantedUrlOuts.get(step.id);
        if (wanted?.size) {
          const deadline = Date.now() + 5_000;
          while ([...wanted].some((k) => !(k in urlOuts)) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250));
            urlOuts = urlOutputs(flowPage.url());
          }
          const missing = [...wanted].filter((k) => !(k in urlOuts));
          if (missing.length) console.error(`[flow] ${step.id}: url output(s) never appeared: ${missing.join(', ')} (url: ${flowPage.url().slice(0, 160)})`);
        }
        for (const [key, value] of Object.entries(urlOuts)) {
          if (!(key in stepOutputs)) stepOutputs[key] = value;
        }
      } catch {
        /* browser gone — nothing to bind */
      }
      outputs[step.id] = stepOutputs;
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
            fellBack,
            ...(sk.failReason ? { reason: sk.failReason } : {}),
            ...(pageUrlPattern ? { pageUrlPattern } : {}),
          });
        }
      }
      // Cross-run evidence: did this run produce the same values here? That is
      // what decides whether a reference to one of them is a record pointer or
      // app furniture — the question run 1 could not answer. Only on success:
      // a blocked step's values describe how far it got, not what the app
      // shows.
      if (result.report.status === 'success') {
        const changed = noteOutputEvidence(step, values);
        if (changed.length) {
          evidenceChanged += changed.length;
          const verdict = (n: string) => {
            const ev = step.outputEvidence?.[n];
            return ev && ev.differed === 0 ? 'stable' : 'volatile';
          };
          opts.progress(`[flow ${flow.name}] ${step.id}: ${changed.map((n) => `${n}=${verdict(n)}`).join(', ')}`);
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
        // An adopted step does not halt the flow: the recording's own path
        // continued from this instruction's partial state (that continuation
        // is why it was adopted at all), so a replay that got as far as the
        // recording did is no worse off. If the work genuinely did not stick,
        // the NEXT step fails on its own terms and halts honestly.
        if (step.adopted) {
          opts.progress(`[flow ${flow.name}] ${step.id}: adopted step ended ${result.report.status} — continuing, as the recording's own path did`);
        } else {
          halted = true;
          break;
        }
      }
      // A recovery may have left a dialog open; sweep it at the next boundary.
      prevRecovered = recovered;
    }

    // Re-pin any repaired steps so the flow file itself gets cheaper next run.
    let updated = 0;
    for (const r of stepResults) {
      if (r.repinned) {
        const step = flow.steps.find((st) => st.id === r.id);
        if (step) {
          step.skill = String(r.repinned);
          // A graduated adopted step is no longer model-first: it now owns a
          // skill that completed it, so drop the flag that gave it the doubled
          // recovery budget and the 'adopted' recovery route.
          if (graduated.has(String(r.id)) && step.adopted) delete step.adopted;
          updated++;
        }
      }
    }
    // Evidence is written back even when nothing was re-pinned: it is the
    // whole point of this run for a flow whose references cannot resolve yet.
    if (updated || evidenceChanged) saveFlow(flow);

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
      // What the replay actually cost. `usageByModel` is the accurate
      // per-model split (recordUsage buckets each instruction under the
      // provider that ran it, escalations under theirs); `usage` +
      // `recoveryModel` remain as the coarse fallback for older tooling,
      // priced at the dearest tier in play — an over-, never under-estimate.
      usage,
      usageByModel: diffUsageByModel(usageBefore, this.state.usageByModel),
      recoveryModel: opts.recovery.model,
      provider: this.provider().constructor.name === 'AnthropicProvider' ? 'anthropic' : (process.env.SLEEP_WALKER_PROVIDER || 'zhipu'),
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
    /**
     * `why` explains a fallback. Tier B is expensive and its causes are not
     * visible from the outside: a step that fell back with no locator miss and
     * no fail reason produced an identical drift ticket whether no skill
     * matched, a precondition refused, or the replay stopped part-way. Three
     * different bugs, one signature.
     */
  ): Promise<{ done?: InstructionResult; prelude?: string; partial?: Partial<SkillRecord>; wrongRecord?: string; why?: string }> {
    const store = this.browser.learn;
    if (!store || !this.browser.isOpen) return { why: 'no skill store, or the browser is closed' };
    let url: string;
    try {
      url = (await this.browser.getPage()).url();
    } catch {
      return { why: 'could not read the page url' };
    }
    const origin = originOf(url);
    if (!origin) return { why: `no origin for ${url}` };
    // Candidates for this instruction, best track record first. In flow mode
    // the pinned skill is only a hint that names the procedure family —
    // selection is by the store's own lifecycle (validated > success rate >
    // experience), so a fragile pin cannot dominate the step run after run.
    let candidates: { skill: import('../skills/store.js').Skill; params: Record<string, string> }[];
    if (chosen) {
      candidates = selectCandidates(store.list(origin), chosen.id, instruction, chosen.params, this.knownValues());
    } else {
      const m = matchTemplate(store.list(origin), instruction, url, this.knownValues());
      candidates = m ? [m] : [];
    }
    if (!candidates.length) return { why: chosen ? `the pinned skill ${chosen.id} bound no params for this instruction` : 'no validated skill matched the instruction and page' };
    this.browser.script?.beginInstruction(instruction, { url });
    let match: { skill: import('../skills/store.js').Skill; params: Record<string, string> } | null = null;
    let replay: NonNullable<Awaited<ReturnType<typeof executeTool>>['replay']> | null = null;
    let attempts = 0;
    let wrongRecord: string | undefined;
    const refusals: string[] = [];
    for (const cand of candidates) {
      if (attempts >= MAX_CANDIDATE_ATTEMPTS) break;
      progress(`[skill] trying ${cand.skill.id} (${cand.skill.status}, ${cand.skill.stats.successes}/${cand.skill.stats.uses}) without the model`);
      const execution = await executeTool(this.browser, 'run_skill', { id: cand.skill.id, params: cand.params }, screenshotDir, signal);
      const r = execution.replay;
      if (!r) return { why: `run_skill returned nothing for ${cand.skill.id}` };
      if (r.refused) {
        // Right template, wrong record: no other skill can fix that, so keep
        // the reason and let the caller re-establish the page (see below).
        if (r.wrongRecord) wrongRecord = r.wrongRecord;
        refusals.push(`${cand.skill.id}: ${r.reason ?? 'refused'}`);
        continue; // wrong page / bad params: nothing ran, free to try the next
      }
      attempts++;
      match = cand;
      replay = r;
      if (r.ok) break;
      if (r.stepsRun === 0 && !r.acted && !r.created.length) {
        // Failed before touching the page — safe to try the next candidate.
        // `stepsRun === 0` alone does NOT establish that: a step whose action
        // fires and whose expectation then fails stops without counting, so
        // the click already happened. Trying the next candidate then clicks
        // Create a second time, which is the shape of fwod13 finishing with
        // 2 and 3 orders where the task creates one.
        // Record the failure so the store's own lifecycle (two strikes →
        // demoted) drops a flaky skill out of selection.
        store.recordOutcome(cand.skill.id, { ok: false, failedAt: r.failedAt, fallthroughs: r.fallthroughs, instructionSucceeded: false });
        // Recorded, or the fallback reason reads "no candidate ran" and names
        // neither the skill nor the failure — which is exactly what fwrd28l's
        // one tier-B step reported, leaving nothing to diagnose it with.
        refusals.push(`${cand.skill.id}: failed at step ${r.failedAt ?? '?'} before touching the page — ${r.reason ?? 'no reason recorded'}`);
        match = null;
        replay = null;
        continue;
      }
      break; // partial: the page has changed — hand what ran to recovery, never restart another candidate
    }
    if (!match || !replay) {
      const why = refusals.length ? `every candidate refused — ${refusals.join('; ')}` : 'no candidate ran';
      return wrongRecord ? { wrongRecord, why } : { why };
    }

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
      evidence: replay.candidateEvidence.map((e) => ({ ...e, skill: match!.skill.id })),
      values: { ...replay.values },
      echoed: [...replay.echoedValues],
      segmentsDone: 0,
    };
    // Values the replay itself minted ({{dN}}): bound in the segment that
    // minted them, threaded into every later segment's params so a later
    // precondition/locator references THIS run's identifier.
    const derived: Record<string, string> = { ...replay.derivedValues };
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
      const nextExec = await executeTool(this.browser, 'run_skill', { id: next.id, params: { ...match.params, ...derived } }, screenshotDir, signal);
      const r = nextExec.replay;
      if (!r) return {};
      Object.assign(derived, r.derivedValues ?? {});
      replay = r;
      last = next;
      current = next;
      agg.stepsRun += r.stepsRun;
      agg.stepsTotal += r.stepsTotal;
      agg.fallthroughs += r.fallthroughs;
      agg.misses.push(...r.misses.map((m) => ({ ...m, skill: next.id })));
      agg.evidence.push(...r.candidateEvidence.map((e) => ({ ...e, skill: next.id })));
      // A chain's earlier segment may have created the record the later one
      // stops on; recovery needs the whole chain's creations, not the last
      // segment's.
      replay.created.push(...r.created);
      Object.assign(agg.values, r.values);
      agg.echoed.push(...r.echoedValues);
    }
    // The walk records each segment when it advances PAST it, and the
    // instruction-level learning records the head (record.invoked). A chain's
    // FINAL segment is neither — record it here, or it could never validate.
    if (replay.ok && last.id !== match.skill.id) {
      store.recordOutcome(last.id, { ok: true, fallthroughs: replay.fallthroughs, instructionSucceeded: true });
    }
    // Per-candidate evidence, folded on ONLY when the run got past these steps
    // — the same rule the url generalisations follow. A miss inside a run that
    // then failed says more about the run than about the locator. This is what
    // decides whether a recorded id is a real handle or an ephemeral one:
    // observation across runs, not the shape of the token.
    if (replay.ok) {
      const bySkill = new Map<string, typeof agg.evidence>();
      for (const e of agg.evidence) {
        if (!e.skill) continue;
        bySkill.set(e.skill, [...(bySkill.get(e.skill) ?? []), e]);
      }
      for (const [id, list] of bySkill) recordCandidateEvidence(store, id, list);
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
        why: `${last.id} stopped at step ${replay.failedAt ?? '?'} — ${replay.reason ?? 'no reason recorded'}`,
      };
    }
    // Drop echo reads from the report's confident values: a value the skill
    // only re-read from a control it set itself is not proof the app persisted
    // it (grafana's time picker — see ReplayResult.echoedValues). A later step
    // that genuinely needs the value still routes to recovery rather than
    // trusting an echo, and the flow stops reporting a persist it cannot vouch
    // for. A value re-observed by a NON-echo read in another segment survives.
    const confidentValues = { ...agg.values };
    for (const key of agg.echoed) {
      if (!Object.keys(agg.values).includes(key)) continue;
      // Keep it only if some segment read it back WITHOUT it being an echo
      // there — i.e. it appears in values but the echoed list is not the whole
      // story. Simplest sound rule: echoed anywhere ⇒ not confident.
      delete confidentValues[key];
    }
    if (agg.echoed.length) progress(`[replay] dropped ${agg.echoed.length} echo read(s) from confident values: ${[...new Set(agg.echoed)].join(', ')}`);
    const report = synthesizeReport(last, match.params, confidentValues);
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

type UsageLedger = Record<string, { promptTokens: number; completionTokens: number; cachedTokens: number; instructions: number }>;

/** Per-model token delta between two snapshots of the session's usage ledger, models with no activity omitted. */
/**
 * The url-provenance values earlier flow steps published this run
 * ({{sid.url.*}} parts — minted ids like a dashboard uid). Fed to compile as
 * slot-by-policy values so a repair's skill parameterises them instead of
 * baking this run's id into its template and steps.
 */
function provenanceValues(outputs: Record<string, Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [sid, vals] of Object.entries(outputs)) {
    for (const [name, value] of Object.entries(vals)) {
      if (name.startsWith('url.') && value) out[`${sid}.${name}`] = value;
    }
  }
  return out;
}

/**
 * The values behind the {{step.output}} references this flow step's
 * instruction/params carry (a ticket ref, a minted uid) — run-scoped by
 * definition, so compile slots them by policy too.
 */
function referencedValues(step: { instruction: string; params?: Record<string, string> }, outputs: Record<string, Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const text of [step.instruction, ...Object.values(step.params ?? {})]) {
    for (const m of text.matchAll(/\{\{([\w-]+)\.([\w.#-]+)\}\}/g)) {
      const v = lookupOutput(outputs, m[1], m[2]);
      if (v) out[`${m[1]}.${m[2]}`] = v;
    }
  }
  return out;
}

function diffUsageByModel(before: UsageLedger, after: UsageLedger): Record<string, { promptTokens: number; completionTokens: number; cachedTokens: number }> {
  const out: Record<string, { promptTokens: number; completionTokens: number; cachedTokens: number }> = {};
  for (const [model, u] of Object.entries(after)) {
    const b = before[model];
    const d = {
      promptTokens: u.promptTokens - (b?.promptTokens ?? 0),
      completionTokens: u.completionTokens - (b?.completionTokens ?? 0),
      cachedTokens: u.cachedTokens - (b?.cachedTokens ?? 0),
    };
    if (d.promptTokens || d.completionTokens || d.cachedTokens) out[model] = d;
  }
  return out;
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
  aliasLegacyEnv(); // honor legacy BROWSER_PILOT_* env vars (also inherited from the CLI) — see paths.ts
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
      process.stdout.write(`sleep-walker daemon listening (session=${session}, pid=${process.pid})\n`);
    })
    .catch((err) => {
      process.stderr.write(`daemon failed to start: ${err?.message || err}\n`);
      process.exit(2);
    });
}
