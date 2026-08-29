import type { Locator, Page } from 'playwright-core';
import { captureSignature } from '../daemon/diff.js';
import { cosine, fingerprintPage } from '../daemon/fingerprint.js';
import { candidateExpr, makeLocator, type LocatorCandidate, type StepDiff } from '../daemon/recorder.js';
import { retired } from './repair.js';
import { isRefTarget } from '../daemon/refs.js';
import { fillParams, fillParamsDeep, softUrlMatch, urlMatches, urlPart, urlPattern } from './compile.js';
import type { Skill, SkillStep } from './store.js';

/** Executes one step against the live page, recording it; throws on failure. */
export type StepExecutor = (
  tool: string,
  args: Record<string, unknown>,
  resolved: Record<string, Locator>,
  via: { skill: string; step: number },
) => Promise<{ result: string; diff?: StepDiff }>;

export interface ReplayOptions {
  page: Page;
  exec: StepExecutor;
  signal?: AbortSignal;
}

/**
 * One locator that did not resolve as recorded: either a fallback candidate
 * had to stand in (`used` set — localized drift that self-healed) or nothing
 * in the chain matched (`used` null — the step failed or the read was
 * skipped). Structured so post-session repair can act on it; the prose
 * `warnings` remain for humans and the agent.
 */
export interface LocatorMiss {
  /** Human step tag, e.g. "5" or "9.2.1" inside a loop. */
  step: string;
  /** Which arg the locator was for: "target" or "source". */
  key: string;
  /** The primary (recorded) locator that missed. */
  primary: string;
  /** The fallback that resolved, or null when the whole chain missed. */
  used: string | null;
  /** Chain index of the fallback that resolved (0 is the primary). */
  usedIndex?: number;
  /** Which skill the miss belongs to, set when misses from a segment chain are aggregated. */
  skill?: string;
}

export interface ReplayResult {
  ok: boolean;
  skill: string;
  stepsRun: number;
  stepsTotal: number;
  /** 1-based, when !ok. */
  failedAt?: number;
  reason?: string;
  /** Live read-back values, keyed by the step's label or `readN`. */
  values: Record<string, string>;
  /** Per-step lines for the tool result. */
  lines: string[];
  /** Soft-expectation misses: logged, never fatal in Stage 1. */
  warnings: string[];
  fallthroughs: number;
  /** Structured record of every locator that missed its primary. */
  misses: LocatorMiss[];
  /**
   * Per-candidate outcomes from the pass that resolved: which chain index won
   * and which were rejected with the element demonstrably present. The caller
   * folds these onto the stored chain only if the run past this point
   * succeeded, so a candidate is retired for being repeatedly WRONG, never for
   * looking wrong.
   */
  candidateEvidence: { step: string; key: string; hit: number; missed: number[]; skill?: string }[];
  /** Values this replay itself minted and bound ({{dN}} derived params), for later segments and callers. */
  derivedValues: Record<string, string>;
  /**
   * Url patterns whose literal segment(s) disagreed with the live url while
   * everything else matched (mechanism 2, PLAN-replay-v2). The replay
   * proceeded optimistically; the caller persists the generalised pattern
   * onto the skill only once the run past that point succeeded — the segment
   * has then demonstrated volatility.
   */
  generalisations: { kind: 'precondition' | 'expect'; step?: number; pattern: string }[];
  /** Cosine similarity between the stored start-page fingerprint and the live page, if both exist. */
  similarity: number | null;
  url: string;
  /** The replay never started (wrong page / bad params) — nothing was touched. */
  refused?: boolean;
  /**
   * The refusal was an IDENTITY mismatch: right template, wrong record. The
   * caller cannot fix this by trying another skill — every skill for this
   * procedure will refuse the same page — so the flow runner returns the
   * browser to the flow's start url before recovery, instead of letting a
   * model "repair" the step on whatever record happens to be open (which is
   * how fwrd8-n2/n3 did the whole flow's work on a seed ticket).
   */
  wrongRecord?: string;
}

const MAX_LINE = 160;

/** Tools whose miss can be substituted by navigating to the step's recorded
 * destination: plain navigation clicks. modifier_click (new tabs) and loop
 * bodies are excluded. */
const NAV_FALLBACK_TOOLS = new Set(['click', 'dblclick']);

/** A soft-matched precondition needs the page's structural fingerprint to
 * agree before replay proceeds on it. Same-template-different-record pages
 * measured 0.94–1.0 in the swg sweeps; the different-template fixture pair
 * measures 0.57. */
const SOFT_MATCH_MIN_SIMILARITY = 0.8;

/**
 * Replay a stored skill deterministically: precondition → each step with its
 * locator chain → expectation check → next. Stops at the first failure and
 * hands back exactly what ran, so the agent can continue from the real page
 * state without repeating anything.
 */
export async function replaySkill(
  skill: Skill,
  params: Record<string, string>,
  opts: ReplayOptions,
): Promise<ReplayResult> {
  const { page } = opts;
  const res: ReplayResult = {
    ok: false,
    skill: skill.id,
    stepsRun: 0,
    stepsTotal: skill.steps.length,
    values: {},
    lines: [],
    warnings: [],
    fallthroughs: 0,
    misses: [],
    derivedValues: {},
    generalisations: [],
    candidateEvidence: [],
    similarity: null,
    url: page.url(),
  };

  // Copy the caller's bindings: derived ({{dN}}) values minted mid-replay are
  // bound into this map as steps execute, so later steps see them.
  params = { ...params };

  const missing = Object.keys(skill.params).filter((p) => !(p in params) || params[p] === '');
  if (missing.length) {
    res.refused = true;
    res.reason = `missing params: ${missing.map((m) => `${m} (e.g. ${JSON.stringify(skill.params[m].example)})`).join(', ')} — nothing was run`;
    return res;
  }

  const startUrl = page.url();
  // A procedure whose FIRST step navigates (goto) carries its own
  // precondition: wherever the browser is, step 1 puts it on the recorded
  // page. Refusing it by start-url would make it permanently unreplayable on
  // apps that redirect at load (the recorded start url is a race between the
  // capture and the redirect) — the flow6 head step failed exactly this way.
  const navigatesItself = skill.steps[0]?.tool === 'goto';
  if (skill.preconditions.fingerprint) {
    res.similarity = cosine(skill.preconditions.fingerprint, (await fingerprintPage(page)) ?? undefined);
  }
  if (!navigatesItself && !urlMatches(skill.preconditions.urlPattern, startUrl, params)) {
    // Same page shape with 1-2 disagreeing segments is likely an
    // environment-minted id (an Odoo action id, a Grafana uid): proceed
    // optimistically instead of refusing — a hard fail here is what turned a
    // one-segment difference into a dead flow, and it also makes the
    // volatility evidence uncollectible. But "likely" is not evidence, so
    // when the segment carries a structural fingerprint, that second gate
    // decides: a different RECORD of the same template fingerprints close
    // (0.94–1.0 in the swg sweeps); a different TEMPLATE does not (the
    // fixture pair measures 0.57). Only a close page proceeds.
    const soft = softUrlMatch(skill.preconditions.urlPattern, startUrl, params);
    const structurallySame = res.similarity === null || res.similarity >= SOFT_MATCH_MIN_SIMILARITY;
    if (!soft || !structurallySame) {
      res.refused = true;
      res.reason =
        `not on the page this procedure starts from (expects ${fillParams(skill.preconditions.urlPattern, params)}, browser is at ${urlPattern(startUrl)}` +
        (soft && !structurallySame ? `; the url shape is close but the page structure is not — similarity ${res.similarity}` : '') +
        `) — nothing was run`;
      return res;
    }
    res.warnings.push(
      `start url differs from the recorded pattern in ${soft.diffs.length} segment(s) (${soft.diffs.map((d) => `${d.expected}→${d.actual}`).join(', ')}) — proceeding optimistically`,
    );
    res.generalisations.push({ kind: 'precondition', pattern: soft.generalised });
  }

  // Identity: the url pattern and the fingerprint both match every record of
  // this template, so neither can tell ticket t15 from ticket t14. A segment
  // that started on a page showing caller-vouched values must find them
  // again, or it is about to do this run's work on someone else's record.
  //
  // A self-navigating procedure is checked AFTER its goto, not skipped. The
  // old rule was "step 1 decides the page", which is true and beside the
  // point: the recorded goto carries the RECORDING run's record id, so it
  // decides the page to be the wrong one. fwod10 replayed
  //   goto .../web#id=44&...&model=res.partner
  // and steps 03-07 did this run's work on n1's records at tier A, published
  // no values, reported success, and verified 1/6. The guard designed to stop
  // exactly that was disabled precisely for the procedures most likely to
  // need it.
  const checkIdentity = async (): Promise<boolean> => {
    for (const marker of skill.preconditions.requireText ?? []) {
      const want = fillParams(marker, params);
      if (!want || /\{\{/.test(want)) continue; // unbound marker proves nothing
      if (await presentOnPage(page, [want])) continue;
      res.refused = true;
      res.wrongRecord = `the page at ${urlPattern(page.url())} does not show ${JSON.stringify(clip(want, 60))} — it matches this procedure's page template but is a different record — nothing was run`;
      res.reason = res.wrongRecord;
      return false;
    }
    return true;
  };
  if (!navigatesItself && skill.preconditions.requireText?.length && !(await checkIdentity())) return res;

  // One step against the live page. Mutates `res` (lines/warnings/values/
  // stepsRun) and returns how it went; a 'stop' has already set failedAt/reason.
  // `tag` labels the step for humans (e.g. "5" or, inside a loop, "9.2.1");
  // `failIndex` is the top-level step number recorded in failedAt on a stop.
  const runOneStep = async (
    step: SkillStep,
    tag: string,
    failIndex: number,
    /** When set (loop bodies), collects what each target actually resolved to, for the loop's progress check. */
    sink?: string[],
    /** Loop-body cursor: which match an ambiguous per-record locator should act on (see resolveChain). */
    ambiguousNth?: number,
  ): Promise<'ran' | 'skipped' | 'stop'> => {
    const args = fillParamsDeep(step.args, params) as Record<string, unknown>;
    const head = `${tag}. ${step.tool} ${describeArgs(step.tool, args)}`;

    // The agent's observation turns were implicit waits; a replay has none,
    // so let the DOM go quiet before looking for this step's target. Generic
    // (no network-idle, no app knowledge) and instant on a static page.
    await settleDom(page);

    // A read/read_all is an OBSERVATION, not a state change: its failure means
    // a value could not be re-captured, never that the procedure is broken. So
    // a read that cannot resolve or errors is skipped with a warning and the
    // replay continues — only an action step (click/fill/submit) or a hard
    // expectation stops it. read_all also legitimately matches many elements,
    // so its target need not be unique.
    const isRead = step.tool === 'read' || step.tool === 'read_all';

    // Resolve every target through its chain before touching the page.
    const resolved: Record<string, Locator> = {};
    let resolveError: string | null = null;
    for (const key of ['target', 'source']) {
      if (!(key in args)) continue;
      const chain = (fillParamsDeep(step.locators[key] ?? [], params) as LocatorCandidate[]) ?? [];
      const identity = identityOfPrimary(step.locators[key] ?? [], skill, params);
      const hit = await resolveChain(page, chain, {
        rawTarget: typeof args[key] === 'string' ? String(args[key]) : '',
        allowMultiple: step.tool === 'read_all',
        ambiguousNth,
        requireIdentity: identity,
        waitMs: resolveWaitMs(),
      });
      if (!hit) {
        resolveError = `no element matched any known locator for ${key}${chain.length ? ` (tried ${chain.length}: ${chain.slice(0, 3).map(candidateExpr).join(', ')}${chain.length > 3 ? ', …' : ''})` : ' (none recorded)'}`;
        res.misses.push({ step: tag, key, primary: chain[0] ? candidateExpr(chain[0]) : '(none recorded)', used: null });
        break;
      }
      resolved[key] = hit.locator;
      // Evidence ONLY from a pass whose winner names something. When a
      // structural path won, that is precisely the resolution we distrust —
      // it may have acted on whatever sorted into that position — and banking
      // it would retire the anchors that missed and confirm the path that hit,
      // turning one bad resolution into a permanent one. fwrd26l did exactly
      // that: its 8/8 zero-model replay had retired two identity anchors in
      // favour of `tr:nth-of-type(1)`.
      if (hit.missed.length && !structural(hit.candidate)) {
        res.candidateEvidence.push({ step: tag, key, hit: hit.index, missed: hit.missed });
      }
      sink?.push(`${key}=${candidateExpr(hit.candidate)}`);
      if (hit.index > 0) {
        res.fallthroughs++;
        res.misses.push({ step: tag, key, primary: candidateExpr(chain[0]), used: candidateExpr(hit.candidate), usedIndex: hit.index });
        res.warnings.push(`step ${tag}: primary locator did not resolve; used fallback #${hit.index + 1} ${candidateExpr(hit.candidate)}`);
      }
    }
    if (resolveError) {
      if (isRead) {
        res.warnings.push(`step ${tag}: skipped read — ${resolveError}`);
        res.lines.push(`${head} → skipped (${resolveError})`);
        return 'skipped';
      }
      // Navigation by recorded destination (PLAN-replay-v2 "order of
      // application", rung 3). A navigation step's recorded EVIDENCE includes
      // where it landed; the clicked affordance (a recents list, a shortcut —
      // anything session-local) may be gone on a fresh browser, but the
      // destination is what the step was for. Two sub-rungs, because this is
      // testing how the app works for a HUMAN: (a) another link on the page
      // to the same destination — click that, exercising the app's own
      // navigation; (b) only then, and only when the destination is fully
      // concrete (params/derived filled, nothing volatile left), navigate
      // there directly. Both are logged as fallthroughs so drift telemetry
      // and post-session repair still see the miss.
      const destPattern = step.expect?.urlPattern;
      const isMove =
        Boolean(destPattern) && NAV_FALLBACK_TOOLS.has(step.tool) && !tag.includes('.') && !urlMatches(destPattern!, page.url(), params);
      if (isMove) {
        const arrived = (used: string, note: string): 'ran' => {
          const miss = res.misses[res.misses.length - 1];
          if (miss && miss.step === tag) miss.used = used;
          res.fallthroughs++;
          res.warnings.push(`step ${tag}: ${resolveError}; ${note}`);
          res.lines.push(`${head} → target gone; ${note}`);
          return 'ran';
        };
        // (a) The page may offer the same destination through a different
        // link. Requires the matching anchors to agree on ONE destination —
        // ambiguity (a wildcard pattern matching many records) skips the rung.
        const link = await linkToDestination(page, destPattern!, params);
        if (link) {
          try {
            await opts.exec('click', { target: link.selector }, { target: page.locator(link.selector).first() }, { skill: skill.id, step: failIndex });
            await settleDom(page);
            if (urlMatches(destPattern!, page.url(), params)) {
              return arrived(`click ${link.selector}`, `clicked another link to the recorded destination (${link.selector})`);
            }
          } catch {
            // that link did not work either — try the direct navigation
          }
        }
        // (b) Direct navigation, last resort before model recovery.
        const dest = fillParams(destPattern!, params);
        const concrete = dest && !dest.includes('{{') && !/[/=#](:id|:var)(?=[/&#]|$)/.test(dest);
        if (concrete && !urlMatches(destPattern!, page.url(), params)) {
          try {
            await opts.exec('goto', { url: dest }, {}, { skill: skill.id, step: failIndex });
            if (urlMatches(destPattern!, page.url(), params)) {
              return arrived(`goto ${dest}`, `navigated to the step's recorded destination instead (${dest})`);
            }
          } catch {
            // destination unreachable — report the original miss below
          }
        }
      }
      res.failedAt = failIndex;
      res.reason = resolveError;
      res.lines.push(`${head} → FAILED: ${resolveError}`);
      return 'stop';
    }

    let outcome: { result: string; diff?: StepDiff };
    try {
      outcome = await opts.exec(step.tool, args, resolved, { skill: skill.id, step: failIndex });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split('\nCall log:')[0];
      if (isRead) {
        res.warnings.push(`step ${tag}: read errored — ${clip(message, 120)}`);
        res.lines.push(`${head} → skipped (${clip(message, 120)})`);
        return 'skipped';
      }
      res.failedAt = failIndex;
      res.reason = `${step.tool} failed: ${clip(message, 300)}`;
      res.lines.push(`${head} → FAILED: ${clip(message, 300)}`);
      return 'stop';
    }

    // Bind values this step just minted (derived params) from the live url,
    // BEFORE the expectation check: the minting step's own expectation refers
    // to the value it produced, so it must compare against the replay's own.
    if (skill.derived) {
      for (const [name, d] of Object.entries(skill.derived)) {
        if (d.step !== failIndex) continue;
        const v = urlPart(page.url(), d.at);
        if (v !== undefined) {
          params[name] = v;
          res.derivedValues[name] = v;
        }
      }
    }

    // Hard expectation: where the step was supposed to leave the browser.
    // A same-shape url whose literal segment(s) disagree is treated as
    // volatile (mechanism 2): warn, stage the generalisation, continue.
    if (step.expect?.urlPattern && !urlMatches(step.expect.urlPattern, page.url(), params)) {
      const soft = softUrlMatch(step.expect.urlPattern, page.url(), params);
      if (!soft) {
        res.failedAt = failIndex;
        res.reason = `after step ${tag} expected url ${fillParams(step.expect.urlPattern, params)} but browser is at ${urlPattern(page.url())}`;
        res.lines.push(`${head} → ran, but ${res.reason}`);
        return 'stop';
      }
      res.warnings.push(
        `step ${tag}: url segment(s) differ from recorded (${soft.diffs.map((d) => `${d.expected}→${d.actual}`).join(', ')}) — treated as volatile`,
      );
      res.generalisations.push({ kind: 'expect', step: failIndex, pattern: soft.generalised });
    }
    // Page-change expectations. Lines that carry a parameter are HARD: they
    // are what distinguishes this run from the recorded one (the new title
    // appearing as a heading), so their absence means the step acted on the
    // wrong thing even though it "worked". Everything else stays soft until
    // data says it is reliable.
    // An alert the recording never saw is the app talking back — usually a
    // rejection ("Ticket is not ready…") that leaves the page superficially
    // intact. fwrd4l-n3 clicked into exactly that: the step counted as run,
    // the synthesized report declared the recorded outcome, and only external
    // verification caught that the ticket never reached Ready. So a
    // state-changing step that provokes an UNRECORDED alert fails hard, while
    // a recorded-but-missing alert stays soft below (toasts are volatile).
    if (outcome.diff?.alerts.length && !isRead && !step.expect?.alertContains) {
      res.failedAt = failIndex;
      res.reason = `step ${tag} raised an alert the recording never saw: ${clip(outcome.diff.alerts.join(' | '), 200)}`;
      res.lines.push(`${head} → ran, but ${res.reason}`);
      return 'stop';
    }
    if (outcome.diff && step.expect) {
      if (step.expect.alertContains) {
        const want = fillParams(step.expect.alertContains, params);
        if (!outcome.diff.alerts.some((a) => a.includes(want))) res.warnings.push(`step ${tag}: expected alert containing ${JSON.stringify(want)}`);
      }
      if (step.expect.addedContains?.length) {
        const seen = outcome.diff.added.join('\n');
        const isParam = (l: string) => /\{\{v\d+\}\}/.test(l);
        const parameterised = step.expect.addedContains.filter(isParam).map((l) => fillParams(l, params));
        const plain = step.expect.addedContains.filter((l) => !isParam(l));
        if (parameterised.length && !parameterised.some((w) => seen.includes(w)) && !(await presentOnPage(page, parameterised))) {
          res.failedAt = failIndex;
          res.reason = `after step ${tag} the page did not show ${parameterised.map((w) => JSON.stringify(w)).join(' / ')} as it did when recorded — the step ran but probably acted on the wrong element`;
          res.lines.push(`${head} → ran, but ${res.reason}`);
          return 'stop';
        }
        if (plain.length && !plain.some((w) => seen.includes(w))) {
          // None of the recorded effects in the step diff — check the live
          // page before judging (a change can land outside the diff window).
          // Absent there too, the action did not have its recorded effect:
          // failing here is what turns a rejected state change into a clean
          // recovery instead of a false success (the fwrd4l-n3 Ready click).
          if (!(await presentOnPage(page, plain))) {
            res.failedAt = failIndex;
            res.reason = `after step ${tag} none of the ${plain.length} recorded page change(s) appeared (e.g. ${JSON.stringify(plain[0])}) — the step ran but did not have its recorded effect`;
            res.lines.push(`${head} → ran, but ${res.reason}`);
            return 'stop';
          }
          res.warnings.push(`step ${tag}: none of the ${plain.length} expected page change(s) appeared in the step diff (found on the page instead)`);
        }
      }
    }

    if (isRead) {
      const key = step.label ?? `read${tag}`;
      res.values[key] = parseRead(outcome.result);
      res.lines.push(`${head} → ${key} = ${clip(outcome.result, MAX_LINE)}`);
    } else {
      res.lines.push(`${head} → ${clip(outcome.result.split('\n')[0], MAX_LINE)}`);
    }
    return 'ran';
  };

  // A folded loop: repeat the body while its guard locator still matches an
  // element, capped at `max`. Counts as ONE top-level step no matter how many
  // times the body runs, so the ok check below stays about top-level progress.
  const runLoop = async (step: SkillStep, n: number): Promise<'ran' | 'stop'> => {
    const body = step.body ?? [];
    const guard = step.while ?? body[0]?.locators.target ?? [];
    const max = step.max ?? 20;
    const before = res.stepsRun;
    let iter = 0;
    // Progress guard: a folded loop exists because the recording acted on one
    // RECORD after another, so every iteration must either shrink the guard's
    // match count (a delete loop) or resolve different elements (a per-record
    // edit). When neither happens the per-record locators have stopped
    // distinguishing records — fwrd4l-n3's "edit each part's supplier" loop
    // missed its ambiguous role locator, fell through to a positional path
    // pinned to ROW 1, and edited the same part seven times while the replay
    // counted it as progress. Same targets + no shrink = fail to recovery.
    let prevSig: string | null = null;
    let prevRemaining = Number.POSITIVE_INFINITY;
    // Cursor over unprocessed records: a delete loop shrinks the guard count,
    // so match 0 is always the next record; an edit-in-place loop leaves the
    // count alone, so the next record is the next match index. The cursor
    // advances exactly when the previous iteration did not consume its record.
    let cursor = 0;
    while (iter < max) {
      if (opts.signal?.aborted) break;
      await settleDom(page);
      const chain = fillParamsDeep(guard, params) as LocatorCandidate[];
      // No waitMs: this asks whether the list still has rows, and a null
      // return is the loop's normal exit, not a failure to find something.
      const hit = await resolveChain(page, chain, { allowMultiple: true });
      const remaining = hit ? await hit.locator.count().catch(() => 0) : 0;
      if (!remaining || cursor >= remaining) break;
      const sig: string[] = [];
      for (const [k, bstep] of body.entries()) {
        const st = await runOneStep(bstep, `${n}.${iter + 1}.${k + 1}`, n, sig, cursor);
        if (st === 'stop') {
          res.stepsRun = before;
          return 'stop';
        }
      }
      const joined = sig.join('; ');
      if (joined && joined === prevSig && remaining >= prevRemaining) {
        res.stepsRun = before;
        res.failedAt = n;
        res.reason =
          `loop iteration ${iter + 1} resolved the same element(s) as the previous one with the guard count unchanged (${remaining}) — ` +
          `the recorded per-record locators no longer distinguish records, so the loop was re-acting on one record`;
        res.lines.push(`${n}. loop → FAILED after ×${iter + 1}: ${res.reason}`);
        return 'stop';
      }
      prevSig = joined;
      // Did this iteration consume its record (guard shrank) or leave it in
      // place (edit-in-place)? Advance the cursor only in the second case.
      // Settle first: a delete's row removal landing late would otherwise
      // advance the cursor and make the next iteration skip a record.
      await settleDom(page);
      // Recount with the SAME candidate that produced `remaining`. Re-walking
      // the chain can answer from a different rung — the recorded guard
      // `[data-testid="del-1"]` matches 1 before its row goes and 0 after, but
      // the chain then falls through to a generic `button "Remove"` matching
      // the OTHER rows, so a shrink read as growth, advanced the cursor, and
      // left the last row undeleted while the loop reported success.
      const count = async (): Promise<number> => makeLocator(page, hit!.candidate).count().catch(() => 0);
      // Poll for the shrink rather than reading the count once: a row that
      // leaves the DOM a beat after the click would otherwise look like an
      // edit-in-place, advance the cursor, and make a delete loop skip a
      // record — and then stop early on `cursor >= remaining`, leaving the
      // list part-cleared while reporting success.
      let after = await count();
      for (let waited = 0; after >= remaining && waited < LOOP_SHRINK_WAIT_MS; waited += LOOP_SHRINK_POLL_MS) {
        await page.waitForTimeout(LOOP_SHRINK_POLL_MS);
        after = await count();
      }
      if (after >= remaining) cursor++;
      prevRemaining = remaining;
      iter++;
    }
    res.stepsRun = before + 1;
    res.lines.push(`${n}. loop ×${iter} (while ${chain0Desc(guard)} matches)`);
    return 'ran';
  };

  for (const [i, step] of skill.steps.entries()) {
    const n = i + 1;
    if (opts.signal?.aborted) {
      res.failedAt = n;
      res.reason = 'instruction budget exhausted before this step';
      res.lines.push(`${n}. ${step.tool} — not run (budget exhausted)`);
      break;
    }
    if (step.tool === 'loop') {
      if ((await runLoop(step, n)) === 'stop') break;
      continue;
    }
    const status = await runOneStep(step, String(n), n);
    if (status === 'stop') break;
    res.stepsRun++;
    // The identity check a self-navigating procedure deferred: its goto has
    // now run, so ask whether it landed on THIS run's record before doing any
    // work on it. Refusing here costs a recovery; not refusing costs the work
    // being done to the wrong record and reported as success.
    if (navigatesItself && n === 1 && skill.preconditions.requireText?.length && !(await checkIdentity())) {
      res.stepsRun = 0; // a goto changed the page but touched no record
      return res;
    }
  }

  res.ok = res.stepsRun === skill.steps.length && res.failedAt === undefined;
  res.url = page.url();
  return res;
}

/** Short human label for a loop's guard locator. */
function chain0Desc(chain: LocatorCandidate[]): string {
  return chain[0] ? candidateExpr(chain[0]) : 'element';
}

/**
 * First candidate in the chain that resolves to exactly one element. An
 * indexed candidate (`nth`) already selects one; an unindexed fallback must
 * be unique on its own, since the element it was recorded against is gone.
 * A raw CSS target the agent chose is tried last if the chain is empty.
 */
/**
 * How a chain is READ: which candidates name the RECORD, which name the
 * ELEMENT, and which only say where it sits.
 *
 * This is PLAN-provenance's ElementSpec as a VIEW over the stored array
 * rather than a new stored shape, so no skill has to be migrated to gain the
 * invariant. What it buys is that resolution order stops being a convention
 * about array position: a chain whose head happens to be structural can no
 * longer let a positional candidate win ahead of one that names the record.
 * That is not hypothetical — the agent's own raw target is unshifted to the
 * head at record time, which is exactly how `text="..."` came to sit in front
 * of the identity anchor recorded for the same element.
 */
export interface ElementSpec {
  /** Names the RECORD: an anchor whose hasText carries a caller-vouched value. */
  identity: LocatorCandidate[];
  /** Names the ELEMENT: test id, role+name, label, placeholder, visible text. */
  handles: LocatorCandidate[];
  /** Finds it by WHERE it sits. Last resort, and never enough to name a record. */
  path: LocatorCandidate[];
}

/**
 * Structural: a path through the document, or an index into a set of matches.
 *
 * Note this is NOT "kind === css". An agent-chosen `#modal-save` is a handle
 * — it names one control — while `#view > div > button:nth-of-type(2)` is a
 * route to wherever that shape currently sits. Demoting the first alongside
 * the second would push a deliberate selector below a role guess.
 */
export function structural(c: LocatorCandidate): boolean {
  if (c.nth !== undefined) return true;
  if (c.kind !== 'css') return false;
  return /[>+~]|:nth-/.test(c.selector);
}

export function specOf(chain: LocatorCandidate[]): ElementSpec {
  return {
    identity: chain.filter((c) => c.kind === 'scoped'),
    handles: chain.filter((c) => c.kind !== 'scoped' && !structural(c)),
    path: chain.filter((c) => c.kind !== 'scoped' && structural(c)),
  };
}

/** Policy for one resolution. Named, because seven positional flags is how a call site gets one wrong. */
export interface ResolvePolicy {
  /** The agent's original target string, used only when no chain was recorded. */
  rawTarget?: string;
  /** read_all reads across every match, so its target need not be unique. */
  allowMultiple?: boolean;
  /**
   * Loop-body cursor: when a candidate matches several records, act on THIS
   * match index (the first unprocessed record) instead of skipping to a
   * fallback. A folded loop's per-record locator is often generic across rows
   * ("Edit" on every row), so ambiguity there is the loop's normal shape, not
   * drift — and the positional fallback it used to fall through to is pinned
   * to one recorded row, which is how fwrd4l edited part A seven times.
   */
  ambiguousNth?: number;
  /**
   * Identity the PRIMARY candidate carried: values the caller vouched for
   * that named the record this step acts on ("fwrd8-n2 RD Bench Ticket").
   * A fallback candidate is a different way of finding the SAME element, so
   * it must still land on something bearing that text — the positional and
   * record-id fallbacks recorded beside it are pinned to the recorded run's
   * row and id, and following one silently moves the whole procedure onto
   * another record (fwrd8-n2/n3 worked a seed ticket to completion this
   * way). When no fallback qualifies, the step fails to recovery, which is
   * cheap; acting on the wrong record is not.
   */
  requireIdentity?: string[];
  /**
   * How long to keep re-trying the WHOLE chain when nothing resolves.
   *
   * The agent never needed this: a model turn is seconds and it re-snapshots
   * each time, so anything the app was about to paint (repair-desk defers its
   * list refetch ~1s BY DESIGN) had always landed before it looked. A replay
   * has no turns, and settleDom only proves the DOM went quiet, which it does
   * in the gap BEFORE the refetch paints. The wait costs nothing on a healthy
   * page — it runs only after a full pass found nothing.
   *
   * Zero for a caller ASKING whether something is still there rather than
   * looking for it: the loop guard reads a null return as "the list is empty,
   * stop", so waiting there would stall every loop's normal exit.
   */
  waitMs?: number;
}

export async function resolveChain(
  page: Page,
  chain: LocatorCandidate[],
  policy: ResolvePolicy = {},
): Promise<{ locator: Locator; index: number; candidate: LocatorCandidate; missed: number[] } | null> {
  const { rawTarget = '', allowMultiple = false, ambiguousNth, requireIdentity = [], waitMs = 0 } = policy;
  const candidates = chain.length || !rawTarget || isRefTarget(rawTarget) ? chain : [{ kind: 'css', selector: rawTarget } as LocatorCandidate];
  // Identity, then handles, then paths — each keeping its recorded order, and
  // each carrying its index in the STORED chain so drift still reports which
  // recorded candidate actually took the step.
  const spec = specOf(candidates);
  // Demonstrated volatile last, whatever kind it is. Evidence outranks the
  // identity/handle/path ordering because that ordering is a prior about what
  // a candidate IS, and this is a measurement of whether it WORKS.
  const byEvidence = (list: LocatorCandidate[]) => [...list].sort((a, b) => Number(retired(a)) - Number(retired(b)));
  const ordered = [...byEvidence(spec.identity), ...byEvidence(spec.handles), ...byEvidence(spec.path)].map((candidate) => ({
    candidate,
    index: candidates.indexOf(candidate),
  }));
  /** Does this fallback still identify the record the primary named? */
  const keepsIdentity = async (index: number, candidate: LocatorCandidate, locator: Locator): Promise<boolean> => {
    if (index === 0 || !requireIdentity.length) return true;
    const expr = JSON.stringify(candidate);
    const wanted = requireIdentity.filter((v) => !expr.includes(v));
    if (!wanted.length) return true;
    let text: string;
    try {
      text = ((await locator.first().textContent({ timeout: 1_000 })) ?? '').replace(/\s+/g, ' ');
    } catch {
      return false;
    }
    return wanted.every((v) => text.toLowerCase().includes(v.toLowerCase()));
  };
  /**
   * One pass over the chain, best candidate first, reporting which candidates
   * it REJECTED before the winner.
   *
   * Per pass, deliberately. A candidate that missed while the page was still
   * painting and hits on the next poll is not volatile — it was early. Only
   * the pass that actually resolved is evidence about the locators, because
   * only then do we know the element was there to be found.
   */
  const walk = async (): Promise<{ locator: Locator; index: number; candidate: LocatorCandidate; missed: number[] } | null> => {
    const missed: number[] = [];
    for (const { index, candidate } of ordered) {
      try {
        const locator = makeLocator(page, candidate);
        const count = await locator.count();
        if (count === 1) {
          if (!(await keepsIdentity(index, candidate, locator))) {
            missed.push(index);
            continue;
          }
          return { locator, index, candidate, missed };
        }
        if (count > 1) {
          if (allowMultiple) return { locator, index, candidate, missed };
          if (ambiguousNth !== undefined && candidate.nth === undefined && ambiguousNth < count) {
            const picked = locator.nth(ambiguousNth);
            if (!(await keepsIdentity(index, candidate, picked))) {
              missed.push(index);
              continue;
            }
            return { locator: picked, index, candidate: { ...candidate, nth: ambiguousNth }, missed };
          }
          if (candidate.nth === undefined && index === 0) {
            missed.push(index); // was unique; ambiguity is drift, keep looking
            continue;
          }
        }
        missed.push(index);
      } catch {
        missed.push(index); // malformed selector or detached page — try the next
      }
    }
    return null;
  };

  // Fast path first: on a page that is ready this returns immediately and the
  // wait below never runs. Re-walking the WHOLE chain each poll (rather than
  // waiting on the primary alone) keeps the preference order intact — the
  // best candidate still wins the moment it appears — and the identity guard
  // stops a positional fallback taking the turn while the anchor is pending.
  const first = await walk();
  if (first) return first;
  for (let waited = 0; waited < waitMs; waited += RESOLVE_POLL_MS) {
    // A plain timer, not page.waitForTimeout: this path runs precisely when
    // the page is unhappy, and a navigating or detached page makes its own
    // clock throw.
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
    const hit = await walk();
    if (hit) return hit;
  }
  return null;
}

/**
 * The identity values the primary locator carried: known ({{known}}) slots
 * whose value the recorded run used to NAME the target by its visible text.
 * Only text-bearing locator kinds count — a slot inside a css selector or a
 * testid is an address, not a name, and holding a fallback to it would break
 * ordinary form fills whose fallbacks are structural by design.
 */
export function identityOfPrimary(chain: LocatorCandidate[], skill: Skill, params: Record<string, string>): string[] {
  // The WHOLE chain, not chain[0]. Identity is a property of the STEP — which
  // record it acts on — not of whichever candidate happens to sit first.
  //
  // fwrd26l is why. The agent's raw target was an XPath,
  // `//tr[contains(., '{{v5}}')]`, stored as `css` because the recorder does
  // not parse selector strings. So the primary advertised no identity, the
  // guard was disarmed, and `#ticket-rows > tr:nth-of-type(1)` took the step —
  // while the scoped anchor sitting right behind it named the record perfectly
  // well. Same shape as the `text="..."` case, different syntax; reading the
  // chain instead of its head fixes both without parsing anything.
  const named = chain
    .flatMap((c) => {
      const f = c as { name?: string; text?: string; label?: string; hasText?: string };
      return [f.name, f.text, f.label, f.hasText];
    })
    .filter((v): v is string => typeof v === 'string');
  if (!named.length) return [];
  const out = new Set<string>();
  for (const field of named) {
    for (const m of field.matchAll(/\{\{(v\d+)\}\}/g)) {
      if (!skill.params[m[1]]?.known) continue;
      const value = params[m[1]];
      if (value && value.length >= 3) out.add(value);
    }
  }
  return [...out];
}

/**
 * A visible anchor on the page whose destination matches the recorded
 * pattern. Used by the navigation fallback's first rung: when the recorded
 * link is gone, another route to the same place may exist (a sidebar entry, a
 * search result, a breadcrumb). Returns null unless every matching anchor
 * agrees on ONE destination — a wildcard-heavy pattern matching several
 * records is ambiguity, not evidence.
 */
async function linkToDestination(
  page: Page,
  pattern: string,
  params: Record<string, string>,
): Promise<{ selector: string; href: string } | null> {
  let anchors: { attr: string; abs: string }[];
  try {
    const raw = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => (a as HTMLElement).offsetParent !== null)
        .map((a) => ({ attr: a.getAttribute('href') ?? '', abs: (a as HTMLAnchorElement).href })),
    );
    anchors = Array.isArray(raw) ? raw : [];
  } catch {
    return null;
  }
  const hits = anchors.filter((a) => a.abs && urlMatches(pattern, a.abs, params));
  if (!hits.length || new Set(hits.map((h) => h.abs)).size !== 1) return null;
  return { selector: `a[href="${hits[0].attr.replace(/(["\\])/g, '\\$1')}"]`, href: hits[0].abs };
}

/** How long a loop iteration waits for its record to leave the guard's match set. */
const LOOP_SHRINK_WAIT_MS = 1_000;
const LOOP_SHRINK_POLL_MS = 100;

/**
 * How long a step keeps re-trying its locator chain before calling the target
 * absent. Overridable so a test exercising a FALLBACK path need not sit
 * through the wait that precedes it.
 */
function resolveWaitMs(): number {
  const raw = Number(process.env.BROWSER_PILOT_RESOLVE_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3_000;
}
const RESOLVE_POLL_MS = 100;

const SETTLE_QUIET_MS = 250;
const SETTLE_MAX_MS = 2_000;

/** Resolve once no DOM mutation has happened for SETTLE_QUIET_MS, or after SETTLE_MAX_MS. */
async function settleDom(page: Page): Promise<void> {
  try {
    await page.evaluate(
      ({ quiet, max }) =>
        new Promise<void>((resolve) => {
          let timer = setTimeout(resolve, quiet);
          const stop = setTimeout(() => {
            observer.disconnect();
            resolve();
          }, max);
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
              observer.disconnect();
              clearTimeout(stop);
              resolve();
            }, quiet);
          });
          observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
        }),
      { quiet: SETTLE_QUIET_MS, max: SETTLE_MAX_MS },
    );
  } catch {
    // navigating / detached — the locator resolution will report it
  }
}

/**
 * A parameterised line that did not *appear* may still be *there*: filling a
 * field with the value it already held produces no diff. One extra capture on
 * the miss path settles it.
 */
async function presentOnPage(page: Page, lines: string[]): Promise<boolean> {
  const sig = await captureSignature(page);
  if (!sig) return false;
  const all = sig.lines.join('\n');
  return lines.some((l) => all.includes(l));
}

function parseRead(result: string): string {
  try {
    const v = JSON.parse(result);
    return Array.isArray(v) ? v.map(String).join(' | ') : String(v);
  } catch {
    return result;
  }
}

function describeArgs(tool: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === 'target' || k === 'source') continue;
    if (typeof v === 'string') parts.push(`${k}=${JSON.stringify(clip(v, 60))}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
  }
  void tool;
  return parts.join(' ');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

/** Text rendering of a replay result for the agent's tool output. */
export function renderReplay(skill: Skill, res: ReplayResult): string {
  const lines: string[] = [];
  if (res.refused) return `ERROR: could not replay ${skill.id}: ${res.reason}`;
  lines.push(
    res.ok
      ? `replayed ${skill.id}: ${res.stepsRun}/${res.stepsTotal} steps ok`
      : `replayed ${skill.id}: ${res.stepsRun}/${res.stepsTotal} steps ok, FAILED at step ${res.failedAt}`,
  );
  lines.push(...res.lines.map((l) => '  ' + l));
  if (!res.ok && res.failedAt !== undefined && res.failedAt < res.stepsTotal) {
    lines.push(`  not run: steps ${res.failedAt + 1}-${res.stepsTotal}`);
  }
  if (!res.ok) {
    lines.push(
      `Steps 1-${res.stepsRun} HAVE run and changed the page — do not repeat them. Observe the current page and continue from here to finish the instruction yourself.`,
    );
  }
  const values = Object.entries(res.values);
  if (values.length) lines.push(`values read from the live page: ${values.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
  if (res.warnings.length) lines.push(`notes: ${res.warnings.join('; ')}`);
  return lines.join('\n');
}

/** Which stored skills could apply on this page, best first. */
export function candidatesFor(skills: Skill[], url: string, limit = 5): Skill[] {
  return skills
    .filter((s) => s.status !== 'demoted' && !(s.seq && s.seq.index > 0) && urlMatches(s.preconditions.urlPattern, url))
    .sort((a, b) => {
      const rank = (s: Skill) => (s.status === 'validated' ? 1 : 0);
      const rate = (s: Skill) => (s.stats.uses ? s.stats.successes / s.stats.uses : 0);
      return rank(b) - rank(a) || rate(b) - rate(a) || (b.stats.lastUsed ?? '').localeCompare(a.stats.lastUsed ?? '');
    })
    .slice(0, limit);
}

/** Values a skill will type verbatim because they were not parameterised. */
export function literalInputs(s: Skill): string[] {
  const out: string[] = [];
  for (const st of s.steps) {
    for (const key of ['value', 'text', 'option'] as const) {
      const v = st.args[key];
      if (typeof v === 'string' && v.trim() && !/\{\{v\d+\}\}/.test(v) && !out.includes(JSON.stringify(clip(v, 40)))) {
        out.push(JSON.stringify(clip(v, 40)));
      }
    }
  }
  return out.slice(0, 6);
}

/** The `[skills]` block appended to an instruction's user message. */
export function renderCandidates(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = ['[skills] stored procedures that have worked on this page before — if one matches the instruction, call run_skill with it FIRST instead of rediscovering the steps:'];
  for (const s of skills) {
    const params = Object.entries(s.params)
      .map(([k, p]) => `${k} e.g. ${JSON.stringify(clip(p.example, 40))}`)
      .join(', ');
    const reads = s.steps.filter((st) => st.label).map((st) => st.label);
    const status = s.status === 'validated' ? `validated ${s.stats.successes}/${s.stats.uses}` : `unverified, ${s.stats.successes}/${s.stats.uses} run(s)`;
    lines.push(`  ${s.id}  ${JSON.stringify(s.template)}`);
    lines.push(`         ${s.steps.length} steps · ${status}${params ? ` · params: ${params}` : ' · no params'}${reads.length ? ` · reads back: ${reads.join(', ')}` : ''}`);
    const literals = literalInputs(s);
    if (literals.length) {
      lines.push(`         types these FIXED values (not parameters — do not use this procedure if the instruction wants different ones): ${literals.join(', ')}`);
    }
  }
  return lines.join('\n');
}
