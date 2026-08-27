import type { BrowserSession } from '../daemon/browser.js';
import type { SessionState } from '../daemon/state.js';
import type { ChatMessage, Provider, ToolDef } from './llm.js';
import { captureSignature } from '../daemon/diff.js';
import { fingerprintPage } from '../daemon/fingerprint.js';
import { candidatesFor, renderCandidates, type ReplayResult } from '../skills/replay.js';
import { componentsOnPage, renderComponents } from '../skills/components.js';
import { originOf } from '../skills/store.js';
import { buildSystemPrompt } from './prompt.js';
import { addEvidenceValue, backfillReadValues, proseIdentifiers, validateReport, type Report } from './report.js';
import { executeTool, toolDefsFor, type ToolExecution } from './tools.js';
import { captureReadBack, captureReadBackAt, setIdentityHints } from '../daemon/recorder.js';

/** Tools that change the page URL, staleing every existing snapshot's refs. */
const NAVIGATION_TOOLS = new Set(['goto', 'back', 'tabs']);

/** Per-turn LLM watchdog: a turn that hasn't produced a tool call by now is aborted. */
export const DEFAULT_TURN_TIMEOUT_MS = 90_000;

/**
 * Consecutive turns allowed to end without a tool call (watchdog abort or
 * prose-only reply) before the loop gives up. Bailing here turns a silent
 * multi-minute stall into a fast, explicit failure.
 */
const MAX_UNPRODUCTIVE_TURNS = 3;

/**
 * Extra turn/time budget the escalation attempt gets when the routine model
 * bailed by exhausting its own. Deliberately modest: the point is to clear a
 * wall the first attempt proved is there, not to let one instruction run away.
 */
const ESCALATION_BUDGET_MULTIPLIER = 1.5;

/** Cap on the evidence values carried into the durable one-line report entry. */
const REPORT_FACTS_CHARS = 600;

export interface LoopOptions {
  maxTurns: number;
  timeoutMs: number;
  screenshotDir: string;
  /** Watchdog for a single LLM call; also clamped by the instruction deadline. */
  turnTimeoutMs?: number;
  /** Preempts the instruction (daemon `stop`); yields a blocked report, not a throw. */
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /**
   * Record this run under a different instruction text. The escalation path
   * sets it so the recording carries the caller's ORIGINAL wording (marked
   * `resume`), never the "You are RESUMING…" scaffold — a skill compiled from
   * scaffold text has an unmatchable template and a mid-crisis precondition,
   * so it refuses on every replay. The scaffold still goes to the model;
   * only what the recorder files changes.
   */
  recordAs?: { text: string; resume: true };
}

/** One tool call the instruction made, for the resume-safety actions log. */
export interface ActionRecord {
  tool: string;
  args: string;
  ok: boolean;
}

export interface InstructionResult {
  report: Report;
  turns: number;
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
  /** Last few transcript lines, included when the loop had to bail out. */
  transcriptTail?: string[];
  /**
   * Ordered tool calls this instruction made — included on bail-out (turn/time
   * cap) so a caller can see which state-changing actions ran before deciding
   * whether to resume. Omitted on a clean report to keep results lean.
   */
  actions?: ActionRecord[];
  /**
   * Where the browser was left on bail-out. Included even when nothing ran, so
   * a timed-out instruction still hands back something observable rather than
   * an empty actions log.
   */
  finalState?: { url: string; title?: string };
  /**
   * Paths of every screenshot the agent saved during this instruction, in the
   * order taken. Tracked by the loop from actual tool results (not the
   * model's self-report), and always included — screenshots are often the
   * caller's only evidence, so they must survive a run whether the report is
   * a clean success or a bail-out.
   */
  screenshots: string[];
  /**
   * Present only when the routine model left the instruction blocked and a
   * stronger fallback model retried it. `report`/`turns`/`usage` above are then
   * the COMBINED result (so cost accounting stays honest); this records what
   * the first attempt cost and why the retry happened.
   */
  escalation?: EscalationRecord;
  /**
   * Why the loop gave up, when it did. Lets a caller (notably the escalation
   * path) distinguish "ran out of road" from "decided it was stuck" instead of
   * pattern-matching the summary prose.
   */
  bailReason?: BailReason;
  /**
   * Learning-mode accounting: which stored skills were offered, which one
   * (if any) the agent replayed and how far it got, and what fraction of the
   * instruction's browser actions ran deterministically.
   */
  skill?: SkillRecord;
}

export interface SkillRecord {
  listed: string[];
  invoked?: string;
  stepsReplayed: number;
  stepsTotal: number;
  /** The replay stopped part-way and the agent carried on. */
  repaired: boolean;
  /** Replay refused to start (wrong page / bad params). */
  refused: boolean;
  fallthroughs: number;
  similarity: number | null;
  /** Structured locator misses from the replay (drift telemetry). */
  misses?: import('../skills/replay.js').LocatorMiss[];
  /** Why the replay stopped, when it did (drift telemetry). */
  failReason?: string;
  /** 1-based skill step the replay failed at, when it did. */
  failedAt?: number;
  /** The url the replay finished (or stopped) on. */
  replayUrl?: string;
  /** Browser actions taken by replay vs. in total (batch steps count individually). */
  deterministicActions: number;
  totalActions: number;
  /** 'A' = replayed by the daemon without any model call; 'B' = the agent invoked run_skill. */
  tier?: 'A' | 'B';
}

export type BailReason = 'turn-cap' | 'timeout' | 'stalled' | 'stopped' | 'invalid-report';

export interface EscalationRecord {
  from: string;
  to: string;
  /** The blocked summary that triggered the retry. */
  reason: string;
  firstAttempt: {
    status: Report['status'];
    turns: number;
    usage: { promptTokens: number; completionTokens: number; cachedTokens: number };
  };
  /** Whether the stronger model actually rescued the instruction. */
  rescued: boolean;
  /** Tool results blanked from the failed attempt before the retry saw it. */
  compactedToolResults: number;
}

/**
 * The agentic loop: send instruction + history, execute the model's tool
 * calls in-process, feed results back, until a valid `report` (or turn/time
 * caps hit → blocked with a transcript tail).
 */
export async function runInstruction(
  provider: Provider,
  browser: BrowserSession,
  state: SessionState,
  instruction: string,
  opts: LoopOptions,
): Promise<InstructionResult> {
  const deadline = Date.now() + opts.timeoutMs;
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  const transcript: string[] = [];
  const actions: ActionRecord[] = [];
  const screenshots: string[] = [];
  let reportRetried = false;
  let capWarned = false;
  let unproductiveTurns = 0;

  // Previous instructions' raw tool output describes a page that has usually
  // moved on; their durable conclusion survives as the `[report]` line below.
  // Blanking it here keeps per-turn context flat across a long session instead
  // of letting it grow until trimHistory's size cap forces the same thing.
  const elided = state.elidePriorToolResults();
  if (elided.elided) {
    opts.onProgress?.(
      `[history] elided ${elided.elided} tool result(s) from earlier instructions (~${Math.round(elided.charsSaved / 4000)}k tokens/turn saved)`,
    );
  }
  state.trimHistory();
  const location = await describeLocation(browser);
  // Learning mode: offer the stored procedures that start on this page. They
  // go in the user message, not the system prompt, so the cached prefix stays
  // byte-identical across instructions.
  const offered = await offerSkills(browser);
  const skill: SkillRecord = {
    listed: offered.ids,
    stepsReplayed: 0,
    stepsTotal: 0,
    repaired: false,
    refused: false,
    fallthroughs: 0,
    similarity: null,
    deterministicActions: 0,
    totalActions: 0,
  };
  state.messages.push({
    role: 'user',
    content: [instruction, location, offered.text].filter(Boolean).join('\n\n'),
  });
  // Script recording (opt-in) groups this instruction's actions under one
  // test.step, so a generated spec reads as the plan that produced it.
  // Identity hints for this instruction's locators: the caller's declared
  // variables (the runid every record of this run is named after). Typed
  // values join them as the instruction runs — see ScriptRecorder.prepare.
  setIdentityHints(Object.values(state.vars ?? {}));
  browser.script?.beginInstruction(
    opts.recordAs?.text ?? instruction,
    opts.recordAs ? { ...offered.context, resume: true } : offered.context,
  );

  const system: ChatMessage = { role: 'system', content: buildSystemPrompt(state) };
  const toolDefs = toolDefsFor(browser);

  /** Resume advice differs sharply depending on whether anything actually ran. */
  const resumeHint = () =>
    actions.length
      ? 'Work may be partially complete — check the actions log and verify current state before resuming.'
      : 'No tool call ran, so the browser was not touched — nothing to undo.';
  /** Only for the failure modes where the agent never got going by itself. */
  const narrowHint = ' Re-run with one concrete artifact per instruction.';

  const finish = async (
    report: Report,
    turns: number,
    blockedTail = false,
    bailReason?: BailReason,
  ): Promise<InstructionResult> => {
    // Deterministic evidence backfill: a read value the model cited in prose
    // but left out of evidence.values would drop the read at compile time and
    // leave the step with no skill. Runs before the facts line and before
    // read-back synthesis so both see the promoted values.
    if (report.status === 'success' && browser.script) {
      const promoted = backfillReadValues(report, browser.script.readsThisInstruction());
      if (promoted.length) opts.onProgress?.(`[report] promoted ${promoted.length} prose-cited read value(s) into evidence: ${promoted.join(', ')}`);
      // Second source, for the identifiers no read observed at all: a record
      // reference the model only ever put in prose (a confirmed order's
      // S00021). Pin it on the live page as a real read, so it becomes a
      // published output a later step can reference and a replay re-reads its
      // OWN — fwod5 cancelled the recorded run's order for want of this.
      if (browser.isOpen) {
        try {
          const page = await browser.getPage();
          const pinned: string[] = [];
          for (const value of proseIdentifiers(report)) {
            const step = await captureReadBack(page, value);
            if (!step) continue; // not uniquely on the page — it stays prose
            browser.script.addStep(step);
            pinned.push(addEvidenceValue(report, String(step.args.target ?? 'ref'), value));
          }
          if (pinned.length) opts.onProgress?.(`[report] pinned ${pinned.length} prose-cited identifier(s) to the page: ${pinned.join(', ')}`);
        } catch {
          // a wedged/navigating page must never turn a good report into no report
        }
      }
    }
    // This line is what survives once the instruction's tool results are
    // elided at the next boundary, so the facts the caller asked for ride
    // along with the prose — otherwise a value read in step 3 would be gone
    // by step 4 despite having been correctly obtained and reported.
    const values = report.evidence?.values;
    const facts =
      values && Object.keys(values).length
        ? ' | ' +
          Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
            .slice(0, REPORT_FACTS_CHARS)
        : '';
    state.messages.push({
      role: 'assistant',
      content: `[report] ${report.status}: ${report.summary}${facts}`,
    });
    // Close the recording's instruction group with its outcome, so a flow can
    // be built from what each step achieved (values, the skill it used).
    if (browser.script) {
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(report.evidence?.values ?? {})) values[k] = String(v);
      // Read-back synthesis: for each value the agent reported, capture a
      // durable read of the live element showing it, so a replay re-reads the
      // value rather than dropping it as stale. Record-time only, best-effort,
      // never blocks the report. Skip values already backed by a real read.
      if (report.status === 'success' && Object.keys(values).length) {
        try {
          const page = await browser.getPage();
          const alreadyRead = browser.script.readResultsThisInstruction();
          const stragglers: string[] = [];
          for (const value of new Set(Object.values(values))) {
            if (!value || alreadyRead.has(value)) continue;
            const step = await captureReadBack(page, value);
            if (step) browser.script.addStep(step);
            else stragglers.push(value); // not pinnable by text — try the model next
          }
          // Verified model fallback: for values the deterministic search could
          // not pin (typically because they are not unique on the page), ask
          // the model — which knows where it read them — for a selector, then
          // trust it only after it resolves to exactly that value. One extra
          // turn, and only when a straggler exists.
          if (stragglers.length) {
            const sourced = await sourceStragglers(provider, page, system, state, stragglers, opts, usage);
            for (const step of sourced) browser.script.addStep(step);
          }
        } catch {
          // a wedged/navigating page must never turn a good report into no report
        }
      }
      browser.script.endInstruction({
        status: report.status,
        summary: report.summary,
        values,
        ...(skill.invoked ? { skill: skill.invoked } : {}),
        ...(skill.tier ? { tier: skill.tier } : {}),
      });
    }
    state.recordUsage(provider.model, usage);
    // Any blocked outcome carries its evidence, not just loop-enforced bail-outs:
    // an agent that declares itself stuck is exactly when a caller — or the
    // escalation model — needs to know what already ran. Clean successes stay lean.
    const includeTail = blockedTail || report.status === 'blocked';
    const finalState = includeTail ? await captureFinalState(browser) : undefined;
    if (skill.invoked && !skill.refused && skill.stepsReplayed < skill.stepsTotal && report.status === 'success') {
      skill.repaired = true;
    }
    return {
      report,
      turns,
      usage,
      screenshots,
      ...(includeTail ? { transcriptTail: transcript.slice(-12), actions: actions.slice(-40) } : {}),
      ...(finalState ? { finalState } : {}),
      ...(bailReason ? { bailReason } : {}),
      ...(browser.learn ? { skill } : {}),
    };
  };

  const timedOut = (turns: number) =>
    finish(
      {
        status: 'blocked',
        summary: `Instruction timed out after ${Math.round(opts.timeoutMs / 1000)}s (${turns} turns, ${actions.length} tool call(s)). ${resumeHint()}${actions.length ? '' : narrowHint}`,
      },
      turns,
      true,
      'timeout',
    );

  const stalled = (turns: number) =>
    finish(
      {
        status: 'blocked',
        summary: `Agent stalled: ${MAX_UNPRODUCTIVE_TURNS} consecutive turns produced no tool call — it reasoned without driving the browser. ${resumeHint()}${narrowHint} Raise --turn-timeout if the model legitimately needs longer per step.`,
      },
      turns,
      true,
      'stalled',
    );

  /**
   * Run one tool call, bounded by the instruction deadline (and by `stop`).
   * Playwright actions have their own internal timeouts, but some can exceed
   * the remaining budget or wedge entirely (a drag against a blocked renderer),
   * which would otherwise let a single call run past `--timeout` unchecked.
   * On expiry we abandon the call — the cooperative signal stops wait_for's
   * polling, anything still in flight inside Playwright is left to settle
   * unobserved — and hand back an error result so the loop bails out with the
   * same blocked report a timeout produces.
   */
  const runTool = async (name: string, args: Record<string, unknown>): Promise<ToolExecution> => {
    const abort = new AbortController();
    const abortTool = () => abort.abort();
    const timer = setTimeout(abortTool, Math.max(0, deadline - Date.now()));
    opts.signal?.addEventListener('abort', abortTool, { once: true });
    try {
      return await Promise.race([
        executeTool(browser, name, args, opts.screenshotDir, abort.signal),
        new Promise<ToolExecution>((resolve) => {
          abort.signal.addEventListener(
            'abort',
            () =>
              resolve({
                result: `ERROR: ${name} was abandoned — it did not finish within the remaining instruction budget. The page may be mid-action; verify state before repeating it.`,
                isError: true,
              }),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortTool);
    }
  };

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    if (opts.signal?.aborted) {
      return finish(
        {
          status: 'blocked',
          summary: `Instruction was stopped after ${turn - 1} turns and ${actions.length} tool call(s). ${resumeHint()}`,
        },
        turn - 1,
        true,
        'stopped',
      );
    }
    if (Date.now() > deadline) return timedOut(turn - 1);

    // Near the cap, tell the agent to stop acting and report now — otherwise a
    // completed-but-unreported instruction is misreported as blocked/failed.
    if (!capWarned && turn > opts.maxTurns - 2) {
      capWarned = true;
      state.messages.push({
        role: 'user',
        content: `Only ${opts.maxTurns - turn + 1} turn(s) left before the cap. Call report NOW with your best current assessment of what was done and verified — do not start new actions. Flag anything you could not confirm.`,
      });
    }

    // Watchdog the LLM call itself: a model that reasons without emitting a tool
    // call would otherwise spend the entire instruction budget inside one
    // request, returning zero actions. Never wait past the instruction deadline.
    // Floor keeps a nearly-expired deadline from producing a zero-length budget;
    // the abort then falls through to the deadline check and reports a timeout.
    const turnBudgetMs = Math.max(
      250,
      Math.min(opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS, deadline - Date.now()),
    );
    const watchdog = new AbortController();
    const abortTurn = () => watchdog.abort();
    const timer = setTimeout(abortTurn, turnBudgetMs);
    opts.signal?.addEventListener('abort', abortTurn, { once: true });

    let completion;
    try {
      completion = await provider.complete([system, ...state.messages], toolDefs, {
        signal: watchdog.signal,
      });
    } catch (err) {
      if (!watchdog.signal.aborted) throw err;
      // Aborted: the assistant message never arrived, so history stays consistent.
      if (opts.signal?.aborted) continue; // stop requested — reported at the top of the next pass
      if (Date.now() > deadline) return timedOut(turn - 1);
      unproductiveTurns++;
      const secs = Math.round(turnBudgetMs / 1000);
      transcript.push(`turn ${turn}: aborted after ${secs}s — still reasoning, no tool call issued`);
      opts.onProgress?.(`[turn ${turn}/${opts.maxTurns}] watchdog: no tool call within ${secs}s, retrying`);
      if (unproductiveTurns >= MAX_UNPRODUCTIVE_TURNS) return stalled(turn);
      state.messages.push({
        role: 'user',
        content: `Your previous turn was aborted after ${secs}s because it produced no tool call. Stop planning and issue exactly ONE tool call now — the smallest observation that moves the instruction forward (snapshot, read, or eval). You will get another turn after you see its result.`,
      });
      continue;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortTurn);
    }

    usage.promptTokens += completion.usage.promptTokens;
    usage.completionTokens += completion.usage.completionTokens;
    usage.cachedTokens += completion.usage.cachedTokens;
    state.messages.push(completion.assistantMessage);
    if (completion.text) transcript.push(`assistant: ${completion.text.slice(0, 300)}`);

    if (completion.toolCalls.length === 0) {
      // Model replied with prose only — remind it of the contract once per occurrence.
      unproductiveTurns++;
      if (unproductiveTurns >= MAX_UNPRODUCTIVE_TURNS) return stalled(turn);
      state.messages.push({
        role: 'user',
        content:
          'Reminder: act via tool calls only, and finish by calling the report tool. Continue with the instruction.',
      });
      continue;
    }
    unproductiveTurns = 0;

    for (const call of completion.toolCalls) {
      if (Date.now() > deadline) break;

      if (call.name === 'report') {
        const validation = call.args ? validateReport(call.args) : { ok: false as const, error: 'arguments were not valid JSON' };
        if (validation.ok) {
          // A repaired payload is accepted, not silently rewritten: the caller
          // and the transcript both see what was changed on the agent's behalf.
          if (validation.coerced?.length) {
            transcript.push(`report coerced: ${validation.coerced.join('; ')}`);
            opts.onProgress?.(`[turn ${turn}] report accepted after repair: ${validation.coerced.join('; ')}`);
          }
          state.messages.push({ role: 'tool', tool_call_id: call.id, content: 'report accepted' });
          return finish(validation.report, turn);
        }
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `report rejected — ${validation.error}. Call report again with a valid payload (status: success|failure|blocked, summary: string).`,
        });
        transcript.push(`report rejected: ${validation.error}`);
        if (reportRetried) {
          return finish(
            {
              status: 'blocked',
              summary: `Agent could not produce a schema-valid report (last error: ${validation.error}).`,
            },
            turn,
            true,
            'invalid-report',
          );
        }
        reportRetried = true;
        continue;
      }

      if (!call.args) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `ERROR: arguments for ${call.name} were not valid JSON. Re-issue the call.`,
        });
        transcript.push(`${call.name}: malformed arguments`);
        continue;
      }

      const summary = summarizeArgs(call.args);
      opts.onProgress?.(`[turn ${turn}/${opts.maxTurns}] ${call.name} ${summary}`);
      const execution = await runTool(call.name, call.args);
      actions.push({ tool: call.name, args: summary, ok: !execution.isError });
      state.messages.push({ role: 'tool', tool_call_id: call.id, content: execution.result });
      accountActions(skill, call.name, call.args, execution);

      if (call.name === 'screenshot' && !execution.isError) {
        const m = execution.result.match(/^screenshot saved: (.+)$/);
        if (m) screenshots.push(m[1]);
      }

      // Keep the re-sent context lean: a snapshot's @refs go stale on navigation
      // and when a newer snapshot arrives, so stub superseded snapshots now
      // rather than re-sending them (up to ~2k tokens each) every remaining turn.
      if (!execution.isError) {
        if (call.name === 'snapshot') state.elideSnapshots(call.id);
        else if (NAVIGATION_TOOLS.has(call.name) && !(call.name === 'tabs' && call.args.switch_to === undefined)) {
          state.elideSnapshots();
        }
      }
      transcript.push(
        `${call.name} ${summary} → ${execution.isError ? execution.result.slice(0, 200) : 'ok'}`,
      );
    }
  }

  return finish(
    {
      status: 'blocked',
      summary: `Turn cap (${opts.maxTurns}) reached without a final report. ${resumeHint()} Do not blindly repeat state-changing actions like submit/delete/move.`,
    },
    opts.maxTurns,
    true,
    'turn-cap',
  );
}

/**
 * Run an instruction on the routine model and, if it comes back blocked, retry
 * it once on a stronger fallback model.
 *
 * Why blocked only: `failure` is a verified negative answer (the assertion was
 * checked and did not hold) — retrying it on a better model just buys the same
 * answer twice. `blocked` means the agent could not determine the answer, which
 * is precisely the failure mode a stronger model can rescue, and the one this
 * project measured on a real app (a cheap model abandoned a supplier-autocomplete
 * step after 29 turns that a stronger model then solved).
 *
 * The retry shares the SAME live browser and message history, so the fallback
 * inherits everything the first attempt discovered — and, critically, is told it
 * is resuming, so it verifies state before repeating anything destructive.
 */
export async function runEscalatingInstruction(
  primary: Provider,
  fallback: Provider | null,
  browser: BrowserSession,
  state: SessionState,
  instruction: string,
  opts: LoopOptions,
): Promise<InstructionResult> {
  // Where this instruction's history starts, so the failed attempt can be
  // compacted on handoff without touching earlier instructions (which are
  // already cached and were not the thing that went wrong).
  const historyMark = state.messages.length;
  const first = await runInstruction(primary, browser, state, instruction, opts);

  const blocked = first.report.status === 'blocked';
  // An operator `stop` also yields a blocked report — escalating there would
  // restart work the operator just killed, which is the opposite of the ask.
  const operatorStopped = Boolean(opts.signal?.aborted);
  if (!fallback || !blocked || operatorStopped || fallback.model === primary.model) return first;

  // A first attempt that exhausted its turn/time budget is positive evidence
  // that the instruction needs MORE of that budget — handing the fallback the
  // same allowance mostly buys a second bail-out at the same wall. Measured on
  // a real app: both tiers hit a 30-turn cap on one step that the routine model
  // then completed in 19 turns once the cap was raised.
  const headroom = (n: number) => Math.ceil(n * ESCALATION_BUDGET_MULTIPLIER);
  const escalatedOpts: LoopOptions = {
    ...opts,
    // The recording must carry the caller's wording, not the resume scaffold —
    // see LoopOptions.recordAs. Flow building then merges the continuation
    // into the failed first attempt's group.
    recordAs: { text: instruction, resume: true },
    ...(first.bailReason === 'turn-cap' ? { maxTurns: headroom(opts.maxTurns) } : {}),
    ...(first.bailReason === 'timeout' ? { timeoutMs: headroom(opts.timeoutMs) } : {}),
  };

  // Hand the stronger model a clean brief, not a transcript of the failure.
  // escalationPrompt() below already carries what mattered — the blocked
  // report, the ordered actions log, where the browser was left — so leaving
  // the raw tool results in place would re-send that same information every
  // turn at the escalation tier's (much higher) cache rate.
  const compacted = state.compactToolResults(historyMark);

  opts.onProgress?.(
    `[escalating] ${primary.model} reported blocked (${first.bailReason ?? 'agent gave up'}) — ` +
      `retrying on ${fallback.model}${escalatedOpts.maxTurns !== opts.maxTurns ? ` with ${escalatedOpts.maxTurns} turns` : ''}` +
      `${compacted.elided ? `, compacted ${compacted.elided} tool result(s) (~${Math.round(compacted.charsSaved / 4000)}k tokens/turn saved)` : ''}`,
  );

  const second = await runInstruction(
    fallback,
    browser,
    state,
    escalationPrompt(instruction, first),
    escalatedOpts,
  );

  return {
    ...second,
    turns: first.turns + second.turns,
    usage: {
      promptTokens: first.usage.promptTokens + second.usage.promptTokens,
      completionTokens: first.usage.completionTokens + second.usage.completionTokens,
      cachedTokens: first.usage.cachedTokens + second.usage.cachedTokens,
    },
    screenshots: [...first.screenshots, ...second.screenshots],
    escalation: {
      from: primary.model,
      to: fallback.model,
      reason: first.report.summary,
      firstAttempt: { status: first.report.status, turns: first.turns, usage: first.usage },
      rescued: second.report.status === 'success',
      compactedToolResults: compacted.elided,
    },
  };
}

function escalationPrompt(instruction: string, first: InstructionResult): string {
  const ran = first.actions?.length
    ? `\nActions the previous attempt ran (most recent last):\n${first.actions
        .map((a) => `  ${a.ok ? 'ok' : 'FAILED'} ${a.tool} ${a.args}`)
        .join('\n')}`
    : '';
  const where = first.finalState ? `\nThe browser was left at: ${first.finalState.url}` : '';
  return (
    `You are RESUMING an instruction that a previous, weaker model could not complete. ` +
    `It gave up with this report:\n"${first.report.summary}"${ran}${where}\n\n` +
    `The browser session is that same attempt — nothing has been reset — but the previous attempt's ` +
    `raw tool output has been elided from the conversation above to keep it small, so treat the ` +
    `summary and action list here as the record of it and re-observe the page for anything you need. ` +
    `Before you repeat ANY state-changing action (submit, create, delete, move), observe the current ` +
    `page and confirm whether it already took effect; the previous attempt may have partially ` +
    `succeeded. Do not assume its conclusions were correct — it may have been stuck because it ` +
    `misread the page or probed the wrong values, so re-examine the evidence yourself and look for an ` +
    `approach it did not try.\n\nThe original instruction to complete is:\n${instruction}`
  );
}

/**
 * Verified model fallback for read-back synthesis: ask the model where each
 * un-pinnable reported value lives on the current page, then trust the answer
 * only after it resolves to exactly that value. Ephemeral — does not touch the
 * running history — and bounded to one completion.
 */
async function sourceStragglers(
  provider: Provider,
  page: import('playwright-core').Page,
  system: ChatMessage,
  state: SessionState,
  values: string[],
  opts: LoopOptions,
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number },
): Promise<import('../daemon/recorder.js').RecordedStep[]> {
  const ask: ChatMessage = {
    role: 'user',
    content:
      `Before this instruction is filed, point to where these value(s) you just reported are shown on the CURRENT page, so they can be re-read on a later run. ` +
      `Call locate with, for each value, a CSS selector (or @ref from your latest snapshot) that resolves to EXACTLY the one element displaying it — or an empty selector if the value is computed and not shown verbatim on the page. Values:\n` +
      values.map((v) => `- ${JSON.stringify(v)}`).join('\n'),
  };
  let completion;
  try {
    completion = await provider.complete([system, ...state.messages, ask], [LOCATE_TOOL], { signal: opts.signal });
  } catch {
    return [];
  }
  usage.promptTokens += completion.usage.promptTokens;
  usage.completionTokens += completion.usage.completionTokens;
  usage.cachedTokens += completion.usage.cachedTokens;
  const call = completion.toolCalls.find((c) => c.name === 'locate');
  const sources = call?.args && Array.isArray((call.args as { sources?: unknown }).sources) ? ((call.args as { sources: unknown[] }).sources) : [];
  const out: import('../daemon/recorder.js').RecordedStep[] = [];
  for (const entry of sources) {
    const e = entry as { value?: unknown; selector?: unknown };
    if (typeof e.value !== 'string' || typeof e.selector !== 'string' || !e.selector.trim()) continue;
    const step = await captureReadBackAt(page, e.value, e.selector).catch(() => null);
    if (step) out.push(step);
  }
  if (out.length) opts.onProgress?.(`[read-back] model sourced ${out.length}/${values.length} un-pinnable value(s)`);
  return out;
}

const LOCATE_TOOL: ToolDef = {
  name: 'locate',
  description: 'Point to where each listed value is shown on the current page, so it can be re-read later.',
  parameters: {
    type: 'object',
    required: ['sources'],
    properties: {
      sources: {
        type: 'array',
        items: {
          type: 'object',
          required: ['value', 'selector'],
          properties: {
            value: { type: 'string', description: 'The reported value, exactly as given.' },
            selector: { type: 'string', description: 'CSS selector or @ref resolving to exactly the element that displays this value; "" if it is computed / not shown.' },
          },
        },
      },
    },
  },
};

/** What the stored-skill listing contributes to an instruction's first message. */
/** Cap on the recorded instruction-start page text (identity evidence, not a snapshot). */
const START_TEXT_BUDGET = 8000;

async function offerSkills(
  browser: BrowserSession,
): Promise<{ ids: string[]; text: string; context: { url?: string; fingerprint?: number[]; startText?: string } }> {
  const none = { ids: [], text: '', context: {} };
  if (!browser.learn || !browser.isOpen) return none;
  try {
    const page = await browser.getPage();
    const url = page.url();
    const origin = originOf(url);
    if (!origin) return none;
    const candidates = candidatesFor(browser.learn.list(origin), url);
    const fingerprint = (await fingerprintPage(page)) ?? undefined;
    // Recognized hard widgets on this page: one line telling the model that
    // plain fill/type/select on them is recipe-backed and self-verifying, so
    // it does not improvise long keyboard workarounds.
    const components = renderComponents(await componentsOnPage(page));
    const text = [renderCandidates(candidates), components].filter(Boolean).join('\n');
    // Which RECORD this page showed when the instruction started, capped: the
    // evidence compile needs to give a skill an identity precondition (see
    // RecordedInstruction.startText).
    const sig = await captureSignature(page);
    const startText = sig ? sig.lines.join('\n').slice(0, START_TEXT_BUDGET) : undefined;
    return {
      ids: candidates.map((s) => s.id),
      text,
      context: { url, ...(fingerprint ? { fingerprint } : {}), ...(startText ? { startText } : {}) },
    };
  } catch {
    return none;
  }
}

/** Count browser actions per tool call, and fold a replay's outcome into the record. */
function accountActions(skill: SkillRecord, name: string, args: Record<string, unknown>, execution: ToolExecution): void {
  if (name === 'snapshot' || name === 'report') return;
  if (name === 'run_skill') {
    const r: ReplayResult | undefined = execution.replay;
    if (!r) return;
    // First replay wins the record; a second run_skill in one instruction is
    // unusual and its steps still count as deterministic actions.
    if (!skill.invoked) {
      skill.tier = 'B';
      skill.invoked = r.skill;
      skill.stepsReplayed = r.stepsRun;
      skill.stepsTotal = r.stepsTotal;
      skill.refused = Boolean(r.refused);
      skill.fallthroughs = r.fallthroughs;
      skill.similarity = r.similarity;
      if (r.misses.length) skill.misses = r.misses;
      if (r.reason) skill.failReason = r.reason;
      if (r.failedAt !== undefined) skill.failedAt = r.failedAt;
      skill.replayUrl = r.url;
    }
    skill.deterministicActions += r.stepsRun;
    skill.totalActions += r.stepsRun;
    return;
  }
  if (name === 'batch' && Array.isArray(args.steps)) {
    // Only the steps that ran count; the result lists one line per step that did.
    const ran = (execution.result.match(/^\d+\. /gm) ?? []).length;
    skill.totalActions += ran || args.steps.length;
    return;
  }
  skill.totalActions += 1;
}

function summarizeArgs(args: Record<string, unknown>): string {
  // A batch's raw args are a wall of nested JSON; the step tools are what the
  // progress line and the actions log actually need to convey.
  if (Array.isArray(args.steps)) {
    const tools = args.steps.map((s) => String((s as { tool?: unknown })?.tool ?? '?'));
    return `[${tools.length} steps: ${tools.join(', ')}]`;
  }
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/**
 * Best-effort "where did this leave the browser" for bail-out results. Bounded
 * and never throws: this runs on the failure path, where a wedged page must not
 * turn a blocked report into no report at all.
 */
async function captureFinalState(
  browser: BrowserSession,
): Promise<{ url: string; title?: string } | undefined> {
  try {
    if (!browser.isOpen) return undefined; // never launch a browser just to report on one
    const page = await browser.getPage();
    const url = page.url();
    const title = await Promise.race([
      page.title().catch(() => undefined),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 2_000)),
    ]);
    return title ? { url, title } : { url };
  } catch {
    return undefined;
  }
}

/**
 * Where the browser is right now, as a line appended to every instruction.
 *
 * Without it the model starts blind and, being told to act rather than
 * deliberate, may guess. Bench run c0822bp (2026-08-22) began its first
 * instruction with `goto http://localhost:3000` although the caller had just
 * opened the app on another port: it landed on a browser error page,
 * port-scanned from inside it, reported the app unreachable, and — because
 * history persists across instructions — repeated that verdict 118 times.
 * Naming the page costs ~30 tokens per instruction and removes the guess.
 *
 * Never launches a browser: a session with no page yet gets no line, and the
 * rules then only allow a URL the instruction itself provides. Never throws —
 * a wedged page must not stop an instruction from starting.
 */
async function describeLocation(browser: BrowserSession): Promise<string | null> {
  if (!browser.isOpen) return null;
  try {
    const page = await browser.getPage();
    const url = page.url();
    const title = await Promise.race([
      page.title().catch(() => ''),
      new Promise<string>((r) => setTimeout(() => r(''), 2_000)),
    ]);
    let line = `[browser] You are currently on ${url}${title ? ` — "${title}"` : ''}.`;
    if (url.startsWith('chrome-error://')) {
      line +=
        ' That is a browser error page: the last navigation failed, so the app is NOT at that address. Use back to return to the page the caller set up, or goto a URL the instruction gives — do not guess one.';
    } else if (url === 'about:blank') {
      line += ' Nothing has been loaded yet: only navigate to a URL the instruction or briefing gives.';
    } else {
      line += ' Start from this page; the caller put the browser here on purpose.';
    }
    return line;
  } catch {
    return null;
  }
}
