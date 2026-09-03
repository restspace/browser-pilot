import type { Locator, Page } from 'playwright-core';
import { clip } from '../shared/text.js';
import { captureSignature } from '../daemon/diff.js';
import { cosine, fingerprintPage } from '../daemon/fingerprint.js';
import { candidateExpr, makeLocator, markPoint, type LocatorCandidate, type StepDiff } from '../daemon/recorder.js';
import { retired } from './repair.js';
import { isRefTarget } from '../daemon/refs.js';
import { TRANSIENT_LINE, WILDCARD, fillParams, fillParamsDeep, maskVolatile, softUrlMatch, urlMatches, urlPart, urlPattern } from './compile.js';

/** Tools that look at or move to an element without setting or choosing anything. */
const OBSERVATION_TOOLS = new Set(['scroll_into_view', 'wait_for', 'hover', 'scroll', 'focus', 'screenshot', 'peek']);
import { originOf, type Skill, type SkillStep } from './store.js';

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
  /**
   * Labels of read-backs whose value merely echoes something the skill itself
   * put on the page earlier this run — a fill value, or the name of an option
   * it clicked. Such a read confirms the control still shows what we typed or
   * chose, NOT that the app persisted it: grafana's top-bar time picker reads
   * back "Last 6 hours" (the option the skill clicked) whether or not the save
   * actually stored the range, so the flow reported a persisted time range the
   * API says was dropped. The caller drops these from the report's confident
   * values so a replay never claims a persist it only echoed.
   */
  echoedValues: string[];
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
   * Identifiers of records this replay BROUGHT INTO EXISTENCE, read off the
   * live url as each minting step ran. Past one of these a stop is not a
   * clean slate, and recovery must be told so by name.
   */
  created: string[];
  /**
   * A state-changing action was DISPATCHED — whether or not the step it
   * belonged to went on to complete. The page may have changed, so this
   * replay is not repeatable and no sibling candidate may be tried after it.
   */
  acted: boolean;
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
// Shortest interacted/read value worth treating as an echo. Below this the
// coincidence rate is too high (a "1m" refresh, a "3" quantity) — a false echo
// would wrongly drop a legitimate finding, so only substantial values qualify.
const MIN_ECHO_LEN = 5;

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
    echoedValues: [],
    lines: [],
    warnings: [],
    fallthroughs: 0,
    misses: [],
    derivedValues: {},
    generalisations: [],
    candidateEvidence: [],
    created: [],
    acted: false,
    similarity: null,
    url: page.url(),
  };

  // Values the skill puts on the page as it runs — fill/type values, and the
  // names of options it clicks. A later read that returns one of these is an
  // echo (confirming the control, not app persistence); see echoedValues.
  // Loosely keyed so "Last 6 hours" matches "last 6 hours".
  const interacted = new Set<string>();
  // A recorded dialog that did not open (see StepVerdict.absentDialog): while
  // set, a step whose target cannot be found is skipped as belonging to that
  // dialog rather than stopping the replay; cleared by the next step that
  // resolves its target normally.
  let absentDialog: string | null = null;
  const looseKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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
    // Whether ANY target of this step resolved through a structural candidate
    // — position, not identity. Sharpens the effect gate below: a positional
    // resolution must be corroborated by a consequential page change, not by
    // the fill's own echo.
    let positionalResolution = false;
    for (const key of ['target', 'source']) {
      if (!(key in args)) continue;
      const chain = (fillParamsDeep(step.locators[key] ?? [], params) as LocatorCandidate[]) ?? [];
      const identity = identityOfPrimary(step.locators[key] ?? [], skill, params);
      const policy = {
        rawTarget: typeof args[key] === 'string' ? String(args[key]) : '',
        allowMultiple: step.tool === 'read_all',
        ambiguousNth,
        requireIdentity: identity,
        waitMs: resolveWaitMs(),
        stayOnOrigin: originOf(step.expect?.urlPattern ?? '') ?? originOf(page.url()) ?? undefined,
      };
      let hit = await resolveChain(page, chain, policy);
      // A virtualised page renders below-the-fold content only once it has
      // been scrolled to. The agent's scrolls were evals, which never compile,
      // so a read of the third panel heading found two headings and was
      // skipped (fwgr23 01-open, both replays: objective 1 lost). One sweep
      // of the page before giving up on an observation.
      if (!hit && isRead && (await sweepPage(page))) hit = await resolveChain(page, chain, { ...policy, waitMs: 0 });
      if (!hit) {
        resolveError = `no element matched any known locator for ${key}${chain.length ? ` (tried ${chain.length}: ${chain.slice(0, 3).map(candidateExpr).join(', ')}${chain.length > 3 ? ', …' : ''})` : ' (none recorded)'}`;
        res.misses.push({ step: tag, key, primary: chain[0] ? candidateExpr(chain[0]) : '(none recorded)', used: null });
        break;
      }
      resolved[key] = hit.locator;
      if (structural(hit.candidate)) positionalResolution = true;
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
      // Record what this action put on the page (see `interacted`). Only for
      // non-read steps: a read observes, it does not set. The accessible name
      // of a clicked option ("Last 6 hours") is the value it selects.
      // Only a step that can SET or SELECT something counts. A scroll to the
      // heading "Latency by endpoint" set nothing, but its target's name
      // landed here and the later read of that heading was discounted as an
      // echo — fwgr23 published two of three panel titles on every replay
      // and objective 1 failed each time.
      if (!isRead && !OBSERVATION_TOOLS.has(step.tool)) {
        for (const cand of chain) {
          const named = (cand as { name?: string; label?: string }).name ?? (cand as { name?: string; label?: string }).label;
          if (named && named.length >= MIN_ECHO_LEN) interacted.add(looseKey(named));
        }
      }
      if (hit.index > 0) {
        res.fallthroughs++;
        res.misses.push({ step: tag, key, primary: candidateExpr(chain[0]), used: candidateExpr(hit.candidate), usedIndex: hit.index });
        res.warnings.push(`step ${tag}: primary locator did not resolve; used fallback #${hit.index + 1} ${candidateExpr(hit.candidate)}`);
      }
    }
    // A typed/filled value is likewise something the skill put on the page.
    const setsSomething = !isRead && !OBSERVATION_TOOLS.has(step.tool);
    if (setsSomething && typeof args.value === 'string' && args.value.length >= MIN_ECHO_LEN) interacted.add(looseKey(args.value));
    if (setsSomething && typeof args.text === 'string' && args.text.length >= MIN_ECHO_LEN) interacted.add(looseKey(args.text));
    if (!resolveError) absentDialog = null;
    if (resolveError) {
      if (isRead) {
        res.warnings.push(`step ${tag}: skipped read — ${resolveError}`);
        res.lines.push(`${head} → skipped (${resolveError})`);
        return 'skipped';
      }
      if (absentDialog !== null) {
        res.warnings.push(`step ${tag}: skipped — acts inside the dialog ${JSON.stringify(absentDialog)}, which did not open this time`);
        res.lines.push(`${head} → skipped (dialog ${JSON.stringify(absentDialog)} did not open)`);
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
        const arrived = await navigateToDestination(page, destPattern!, params, (tool, a, resolved) => opts.exec(tool, a, resolved, { skill: skill.id, step: failIndex }));
        if (arrived) {
          const miss = res.misses[res.misses.length - 1];
          if (miss && miss.step === tag) miss.used = arrived.used;
          res.fallthroughs++;
          res.warnings.push(`step ${tag}: ${resolveError}; ${arrived.note}`);
          res.lines.push(`${head} → target gone; ${arrived.note}`);
          return 'ran';
        }
      }
      res.failedAt = failIndex;
      res.reason = resolveError;
      res.lines.push(`${head} → FAILED: ${resolveError}`);
      return 'stop';
    }

    let outcome: { result: string; diff?: StepDiff };
    // Dispatched, not completed. A step whose action fires and whose
    // EXPECTATION then fails returns 'stop' without incrementing stepsRun, so
    // stepsRun === 0 has never meant "the page was not touched" — and the
    // caller reads it as exactly that before trying another candidate. A
    // second candidate then clicks Create again.
    if (!isRead) res.acted = true;
    const urlBefore = page.url();

    // A click that opens a popup (menu, dialog, listbox) is a TOGGLE in most
    // SPAs: the same click on an already-open popup closes it. When the
    // recorded effect is already showing before the click, the click would
    // undo the state the next step depends on — fwgr26's third click on
    // "New" shut the menu its "New dashboard" link lived in, on every
    // replay. Skipped as already in effect. Only popup lines count: a
    // re-usable effect (another row of textboxes) must still be produced.
    const opener = openerLines(step, params);
    if (opener.length && (await presentOnPage(page, opener))) {
      res.warnings.push(`step ${tag}: the recorded effect (${clip(opener[0], 60)}) is already showing — a click would toggle it away; skipped as already in effect`);
      res.lines.push(`${head} → skipped (already in effect)`);
      return 'skipped';
    }

    // A click that produced NO observable change at all (no diff, no url
    // change, no alert) while the recording shows one most likely landed
    // during a repaint — React detaches and re-mounts controls between
    // frames, and Playwright's click can hit the old node. One retry after
    // the DOM settles; a click that changed anything is never repeated.
    for (let attempt = 0; ; attempt++) {
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

      // A navigation renders a route skeleton first; let it hydrate before
      // the effect gates look for the recorded content.
      if (page.url() !== urlBefore) await settleDom(page);

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

      // A step declared record-minting has now run: read THIS run's identifier
      // off the live url and keep it. If the replay later stops, recovery is
      // told the record already exists and what it is called, instead of being
      // told only how many steps ran and left to infer the rest — which is how
      // fwod13 came to create a second and third order.
      if (step.mints) {
        // Only a part the step CHANGED: a rejected click leaves the url as it
        // was, and "new" from /tickets/new is not a record this run created.
        const made = urlPart(page.url(), step.mints.at);
        if (made && made !== urlPart(urlBefore, step.mints.at) && !res.created.includes(made)) res.created.push(made);
      }

      // Effect gates: did the step leave the page as the recording said it
      // would? Each gate's warnings and staged generalisations always apply; a
      // stop ends the replay here, with what ran already in `res`.
      let stop: StepVerdict | null = null;
      const warnings: string[] = [];
      for (const gate of STEP_GATES) {
        const verdict = await gate({ page, step, tag, failIndex, args, params, outcome, isRead, positionalResolution });
        if (!verdict) continue;
        if (verdict.warnings) warnings.push(...verdict.warnings);
        if (verdict.generalise) res.generalisations.push(verdict.generalise);
        if (verdict.absentDialog !== undefined) absentDialog = verdict.absentDialog;
        if (verdict.stop) {
          stop = verdict;
          break;
        }
      }
      if (!stop) {
        res.warnings.push(...warnings);
        break;
      }
      const noEffect =
        step.tool === 'click' && !!outcome.diff && !outcome.diff.added.length && !outcome.diff.alerts.length && page.url() === urlBefore;
      if (stop.retryable && noEffect && attempt === 0) {
        res.warnings.push(`step ${tag}: the click changed nothing on the page — retried once after the DOM settled`);
        await settleDom(page);
        continue;
      }
      res.warnings.push(...warnings);
      // The step took the tab off the app (an error page, another origin):
      // whoever picks up from here — recovery, the next segment — needs the
      // app, not the wreck. Go back to where the step started. rpgr13-r2's
      // recovery spent its whole budget on chrome-error://chromewebdata/.
      const landed = page.url();
      if (landed !== urlBefore && (/^chrome-error:|^about:neterror/.test(landed) || (originOf(landed) ?? '') !== (originOf(urlBefore) ?? ''))) {
        try {
          await page.goto(urlBefore, { waitUntil: 'domcontentloaded' });
          warnings.push(`step ${tag}: the browser was returned to ${urlPattern(urlBefore)} from ${urlPattern(landed)}`);
          res.warnings.push(warnings[warnings.length - 1]);
        } catch {
          // the tab is truly gone; the stop below says where it ended
        }
      }
      res.failedAt = failIndex;
      res.reason = stop.stop!;
      res.lines.push(`${head} → ran, but ${stop.stop}`);
      return 'stop';
    }

    if (isRead) {
      const key = step.label ?? `read${tag}`;
      const value = parseRead(outcome.result);
      res.values[key] = value;
      // An echo read: this value is only what the skill itself set or chose,
      // so it confirms the control's display, not that the app persisted it.
      if (value && value.length >= MIN_ECHO_LEN && interacted.has(looseKey(value))) {
        res.echoedValues.push(key);
        res.warnings.push(`step ${tag}: read '${key}' returned a value the skill itself set/selected ('${clip(value, 60)}') — confirms the control, not persistence; dropped from the report's confident values`);
      }
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
      // A loop cut short by the budget is NOT a finished loop: breaking out
      // used to count it as 'ran', and a part-cleared list became a success.
      if (opts.signal?.aborted) {
        res.stepsRun = before;
        res.failedAt = n;
        res.reason = `instruction budget exhausted after ${iter} loop iteration(s), before the loop finished`;
        res.lines.push(`${n}. loop → stopped after ×${iter}: ${res.reason}`);
        return 'stop';
      }
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
      // NOT `refused`. Refused means "nothing ran, free to try the next
      // candidate" — and the goto has already moved the browser, so trying
      // another candidate would run it from a page nobody expects. This is a
      // partial stop: what ran, ran, and the caller hands it to recovery
      // rather than restarting. `wrongRecord` still tells the flow runner to
      // put the browser back on the flow's start url first.
      res.refused = false;
      res.failedAt = n;
      res.url = page.url(); // the goto moved the browser; the caller repositions from here
      return res;
    }
  }

  res.ok = res.stepsRun === skill.steps.length && res.failedAt === undefined;
  res.url = page.url();
  return res;
}

/** What an effect gate sees after a step's action ran. */
interface StepGateInput {
  page: Page;
  step: SkillStep;
  /** Human step tag ("5", or "9.2.1" inside a loop). */
  tag: string;
  /** Top-level step number, for staged generalisations. */
  failIndex: number;
  /** The step's args with params filled. */
  args: Record<string, unknown>;
  params: Record<string, string>;
  outcome: { result: string; diff?: StepDiff };
  isRead: boolean;
  /** Some target of this step resolved through a structural (positional) candidate. */
  positionalResolution: boolean;
}

/** A gate's verdict. Warnings and generalisations always apply; `stop` ends the replay with that reason. */
interface StepVerdict {
  warnings?: string[];
  generalise?: ReplayResult['generalisations'][number];
  stop?: string;
  /**
   * The recorded effect was a dialog opening and no dialog opened. A dialog
   * is conditional UI — "Discard changes?" appears only when there are
   * changes — so its absence is a legitimate state, not a failed effect; the
   * steps that were going to act inside it are skipped (see runOneStep).
   */
  absentDialog?: string;
  /** The stop is "the recorded effect did not appear": worth one retry when the action changed nothing at all. */
  retryable?: boolean;
}

type StepGate = (g: StepGateInput) => Promise<StepVerdict | null> | StepVerdict | null;

/**
 * Hard expectation: where the step was supposed to leave the browser. A
 * same-shape url whose literal segment(s) disagree is treated as volatile
 * (mechanism 2): warn, stage the generalisation, continue.
 */
const expectedUrl: StepGate = ({ step, page, params, tag, failIndex }) => {
  const pattern = step.expect?.urlPattern;
  if (!pattern || urlMatches(pattern, page.url(), params)) return null;
  const soft = softUrlMatch(pattern, page.url(), params);
  if (!soft) return { stop: `after step ${tag} expected url ${fillParams(pattern, params)} but browser is at ${urlPattern(page.url())}` };
  return {
    warnings: [`step ${tag}: url segment(s) differ from recorded (${soft.diffs.map((d) => `${d.expected}→${d.actual}`).join(', ')}) — treated as volatile`],
    generalise: { kind: 'expect', step: failIndex, pattern: soft.generalised },
  };
};

/**
 * An alert the recording never saw is the app talking back — usually a
 * rejection ("Ticket is not ready…") that leaves the page superficially
 * intact. fwrd4l-n3 clicked into exactly that: the step counted as run, the
 * synthesized report declared the recorded outcome, and only external
 * verification caught that the ticket never reached Ready. So a
 * state-changing step that provokes an UNRECORDED alert fails hard, while a
 * recorded-but-missing alert stays soft (expectedAlert — toasts are volatile).
 */
const unrecordedAlert: StepGate = ({ outcome, isRead, step, tag }) => {
  if (!outcome.diff?.alerts.length || isRead || step.expect?.alertContains) return null;
  return { stop: `step ${tag} raised an alert the recording never saw: ${clip(outcome.diff.alerts.join(' | '), 200)}` };
};

const expectedAlert: StepGate = ({ outcome, step, params, tag }) => {
  if (!outcome.diff || !step.expect?.alertContains) return null;
  const want = fillParams(step.expect.alertContains, params);
  return outcome.diff.alerts.some((a) => a.includes(want)) ? null : { warnings: [`step ${tag}: expected alert containing ${JSON.stringify(want)}`] };
};

/**
 * Page-change expectations. Lines that carry a parameter are HARD: they are
 * what distinguishes this run from the recorded one (the new title appearing
 * as a heading), so their absence means the step acted on the wrong thing
 * even though it "worked". Everything else stays soft until data says it is
 * reliable — but a plain change absent from the diff AND the live page means
 * the action did not have its recorded effect, and failing there is what
 * turns a rejected state change into a clean recovery instead of a false
 * success (the fwrd4l-n3 Ready click).
 */
const expectedChanges: StepGate = async ({ outcome, step, params, tag, args, page, positionalResolution }) => {
  if (!outcome.diff || !step.expect?.addedContains?.length) return null;
  const warnings: string[] = [];
  // A line carrying a {{vN}} slot is HARD (below). A {{dN}} derived marker
  // is filled like any other param but stays soft — the app minted it.
  const isParam = (l: string) => /\{\{v\d+\}\}/.test(l);
  // maskVolatile at replay too, so a store compiled before masking existed
  // (every skill recorded up to set 24) stops failing on the recording's clock.
  // Transient lines (spinners, progress bars) are dropped here too, so a
  // store compiled before TRANSIENT_LINE existed stops failing on them.
  const lines = step.expect.addedContains.filter((l) => !TRANSIENT_LINE.test(l));
  if (!lines.length) return null;
  let parameterised = lines.filter(isParam).map((l) => fillParams(maskVolatile(l), params));
  const plain = lines.filter((l) => !isParam(l)).map((l) => fillParams(maskVolatile(l), params));
  // A positionally-resolved fill must prove itself with a CONSEQUENTIAL
  // change: its own echo in a same-role element is what the wrong element
  // produces too (see consequentialExpectations). When the echo is all the
  // recording has, the old gate stands and we say so.
  if (positionalResolution && parameterised.length && typeof args.value === 'string' && args.value) {
    const value = args.value;
    const consequential = parameterised.filter((l) => !isEchoLine(l, value));
    if (consequential.length) parameterised = consequential;
    else warnings.push(`step ${tag}: resolved positionally and its only recorded effect is the fill's own echo — the effect gate cannot tell right element from wrong here`);
  }
  if (parameterised.length && !lineShows(outcome.diff.added, parameterised) && !(await presentOnPage(page, parameterised))) {
    return { warnings, stop: `after step ${tag} the page did not show ${parameterised.map((w) => JSON.stringify(w)).join(' / ')} as it did when recorded — the step ran but probably acted on the wrong element` };
  }
  if (plain.length && !lineShows(outcome.diff.added, plain)) {
    // None of the recorded effects in the step diff — check the live page
    // before judging (a change can land outside the diff window).
    if (!(await presentOnPage(page, plain))) {
      // The recorded effect was a dialog opening. A dialog is conditional
      // UI: fwgr24's create step recorded "Exit edit" → "Discard changes to
      // dashboard?" because the RECORDING had unsaved edits at that moment;
      // a replay whose earlier steps saved cleanly has none, no dialog
      // opens, and that is the app working — not the step failing. The
      // steps that would have acted inside the dialog are skipped instead.
      const dialog = plain.map((l) => /^-\s*dialog\s+"([^"]*)"/.exec(l)?.[1]).find((n) => n !== undefined);
      if (dialog !== undefined) {
        warnings.push(`step ${tag}: the recorded dialog ${JSON.stringify(dialog)} did not open — conditional UI, treated as absent; steps inside it will be skipped`);
        return { warnings, absentDialog: dialog };
      }
      return { warnings, retryable: true, stop: `after step ${tag} none of the ${plain.length} recorded page change(s) appeared (e.g. ${JSON.stringify(plain[0])}) — the step ran but did not have its recorded effect` };
    }
    warnings.push(`step ${tag}: none of the ${plain.length} expected page change(s) appeared in the step diff (found on the page instead)`);
  }
  return warnings.length ? { warnings } : null;
};

/** The effect gates a step passes through after its action, in order. */
/**
 * The tab is on a browser error page (a crashed renderer, a navigation the
 * network refused): nothing recorded can hold there, and every later step
 * would resolve nothing while the replay pressed on. fwgr26-n2 ran eleven
 * more steps on chrome-error://chromewebdata/ before the next segment
 * refused with the unreadable "browser is at null/".
 */
const errorPage: StepGate = ({ page, tag }) => {
  const url = page.url();
  return /^chrome-error:|^about:neterror/.test(url) ? { stop: `after step ${tag} the browser is on an error page (${url}) — the tab crashed or a navigation failed` } : null;
};

const STEP_GATES: StepGate[] = [errorPage, expectedUrl, unrecordedAlert, expectedAlert, expectedChanges];

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
  if (c.kind === 'point') return true; // where it was, not what it is
  if (c.kind !== 'css') return false;
  return /[>+~]|:nth-/.test(c.selector);
}

/**
 * The expectation lines that could tell a right-element fill from a
 * wrong-element one. A recorded added-line that merely restates the fill in a
 * same-role element — `textbox "": {{v4}}` — is an ECHO: the WRONG textbox
 * produces it too, so it is no evidence at all. fwgr17-n3's 03-open passed
 * its effect gate on exactly that line after a positional fallback took the
 * step. When consequential lines exist (the heading that renders the typed
 * title, the menu button named after it), only those count; when the echo is
 * all the recording has, it is returned unchanged — a lone search-box fill
 * legitimately shows nothing else, and the caller warns instead.
 */
export function isEchoLine(line: string, filledValue: string): boolean {
  const escaped = filledValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^-?\\s*(textbox|searchbox|spinbutton|combobox)\\b[^:]*:\\s*${escaped}\\s*$`).test(line.trim());
}

export function consequentialExpectations(lines: string[], filledValue: string | undefined): string[] {
  if (!filledValue) return lines;
  const rest = lines.filter((l) => !isEchoLine(l, filledValue));
  return rest.length ? rest : lines;
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
   * The origin the recorded step stayed on. A candidate that resolves to a
   * link leaving that origin cannot be the recorded control: diaggr1's
   * replay of fwgr26 fell from `link "New dashboard"` (its menu had been
   * toggled shut) to the structural `div > … > a:nth-of-type(1)`, which
   * matched Grafana's footer link to grafana.com; the offline box answered
   * with an error page and the whole create step went to recovery.
   */
  stayOnOrigin?: string;
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
  const { rawTarget = '', allowMultiple = false, ambiguousNth, requireIdentity = [], waitMs = 0, stayOnOrigin } = policy;
  /** Does the resolved element sit inside a link that leaves the recorded origin? */
  const leavesOrigin = async (locator: Locator): Promise<boolean> => {
    if (!stayOnOrigin) return false;
    try {
      return await locator.first().evaluate((el, origin) => {
        const a = (el as Element).closest('a[href]');
        if (!a) return false;
        try {
          const target = new URL((a as HTMLAnchorElement).href, location.href);
          // file:// pages have an opaque origin; a link there is "home" when
          // it stays on the same scheme.
          if (target.origin === 'null' || location.origin === 'null') return target.protocol !== location.protocol;
          return target.origin !== origin;
        } catch {
          return false;
        }
      }, stayOnOrigin);
    } catch {
      return false;
    }
  };
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
    // The recorded primary is trusted — unless it is itself structural (an
    // agent-typed positional selector at the head), which names no record.
    if (!requireIdentity.length || (index === 0 && !structural(candidate))) return true;
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
  // The recorded geometry, when the chain carries it: the yardstick a guess
  // is measured against. A structural fallback that resolves far from where
  // the recorded element sat is a different element — rpgr13's `div > … >
  // button` took a header button for a control in the editor's side pane.
  const recordedBox = candidates.find((c): c is Extract<LocatorCandidate, { kind: 'point' }> => c.kind === 'point') ?? null;
  const plausible = async (locator: Locator): Promise<boolean> => {
    if (!recordedBox) return true;
    try {
      const box = await locator.first().boundingBox();
      if (!box) return true; // nothing to measure — let the other guards judge
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      const cx = box.x + box.width / 2 + scroll.x;
      const cy = box.y + box.height / 2 + scroll.y;
      const limit = Math.max(recordedBox.vw, recordedBox.vh) / 3;
      return Math.hypot(cx - recordedBox.x, cy - recordedBox.y) <= limit;
    } catch {
      return true;
    }
  };
  const walk = async (): Promise<{ locator: Locator; index: number; candidate: LocatorCandidate; missed: number[] } | null> => {
    const missed: number[] = [];
    for (const { index, candidate } of ordered) {
      try {
        // A point names a place; find what is there (of the recorded kind)
        // before a locator can name it.
        if (candidate.kind === 'point' && !(await markPoint(page, candidate))) {
          missed.push(index);
          continue;
        }
        const locator = makeLocator(page, candidate);
        const count = await locator.count();
        if (count === 1) {
          if (!(await keepsIdentity(index, candidate, locator))) {
            missed.push(index);
            continue;
          }
          if ((index > 0 || structural(candidate)) && candidate.kind !== 'point' && !(await plausible(locator))) {
            missed.push(index);
            continue;
          }
          // The recorded primary is trusted even when it is such a link — the
          // recording clicked it (rpgr12-r2's sign-in skill had a stray click
          // on Grafana's "Support" footer link, and refusing it cost a
          // 19-turn recovery). Only a guess may not leave the origin.
          if ((index > 0 || structural(candidate)) && (await leavesOrigin(locator))) {
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
  //
  // A structural (positional) hit is not taken on the spot when the chain
  // also names the element: a path resolves instantly against whatever sits
  // in that slot while the named control is still rendering. rpgr13 lost
  // both replays that way — the panel editor's `toggle-viz-picker` test id
  // was not there yet, `div > … > button` matched a header button that
  // opens grafana.com, and the tab left the app. The guess is held until the
  // names have had the whole window; it stands only when none of them came.
  const named = ordered.some((o) => !structural(o.candidate));
  const guess = (hit: { candidate: LocatorCandidate } | null) => !!hit && named && structural(hit.candidate);
  let held: Awaited<ReturnType<typeof walk>> = null;
  const first = await walk();
  if (first && !guess(first)) return first;
  held = first;
  for (let waited = 0; waited < waitMs; waited += RESOLVE_POLL_MS) {
    // A plain timer, not page.waitForTimeout: this path runs precisely when
    // the page is unhappy, and a navigating or detached page makes its own
    // clock throw.
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
    const hit = await walk();
    if (hit && !guess(hit)) return hit;
    if (hit) held = hit;
  }
  return held;
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
 * The rungs a navigation step falls through when its recorded link is gone,
 * each testing how the app works for a HUMAN before the next is tried:
 *  (a) another link on the page to the same destination — click that,
 *      exercising the app's own navigation;
 *  (b) only then, and only when the destination is fully concrete
 *      (params/derived filled, nothing volatile left), navigate there
 *      directly — the last resort before model recovery.
 * Returns what got the browser there, or null when neither rung did.
 */
async function navigateToDestination(
  page: Page,
  destPattern: string,
  params: Record<string, string>,
  exec: (tool: string, args: Record<string, unknown>, resolved: Record<string, Locator>) => Promise<unknown>,
): Promise<{ used: string; note: string } | null> {
  // (a) Requires the matching anchors to agree on ONE destination —
  // ambiguity (a wildcard pattern matching many records) skips the rung.
  const link = await linkToDestination(page, destPattern, params);
  if (link) {
    try {
      await exec('click', { target: link.selector }, { target: page.locator(link.selector).first() });
      await settleDom(page);
      if (urlMatches(destPattern, page.url(), params)) {
        return { used: `click ${link.selector}`, note: `clicked another link to the recorded destination (${link.selector})` };
      }
    } catch {
      // that link did not work either — try the direct navigation
    }
  }
  // (b)
  const dest = fillParams(destPattern, params);
  const concrete = dest && !dest.includes('{{') && !/[/=#](:id|:var)(?=[/&#]|$)/.test(dest);
  if (concrete && !urlMatches(destPattern, page.url(), params)) {
    try {
      await exec('goto', { url: dest }, {});
      if (urlMatches(destPattern, page.url(), params)) {
        return { used: `goto ${dest}`, note: `navigated to the step's recorded destination instead (${dest})` };
      }
    } catch {
      // destination unreachable — the caller reports the original miss
    }
  }
  return null;
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
  const raw = Number(process.env.SLEEP_WALKER_RESOLVE_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3_000;
}
const RESOLVE_POLL_MS = 100;

/**
 * Scroll the page end to end so a virtualised or lazily rendered UI paints
 * everything it has, then let the DOM settle. Returns false when the page
 * cannot be scripted (gone, cross-origin frame), in which case the caller
 * simply does not retry.
 */
async function sweepPage(page: Page): Promise<boolean> {
  try {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settleDom(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await settleDom(page);
    return true;
  } catch {
    return false;
  }
}

const SETTLE_QUIET_MS = 250;
const SETTLE_MAX_MS = 2_000;
/**
 * How long a page gets to show it is busy before it is called quiet. The
 * quiet window used to be the floor too — 250ms per step even on a static
 * page, ~20s across an 80-step replay that was otherwise at the engine's
 * floor. Now the full quiet window is demanded only once a mutation shows.
 */
const SETTLE_PROBE_MS = 60;

/** Resolve once no DOM mutation has happened for SETTLE_QUIET_MS, or after SETTLE_MAX_MS. */
async function settleDom(page: Page): Promise<void> {
  try {
    await page.evaluate(
      ({ probe, quiet, max }) =>
        new Promise<void>((resolve) => {
          let timer = setTimeout(resolve, probe);
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
      { probe: SETTLE_PROBE_MS, quiet: SETTLE_QUIET_MS, max: SETTLE_MAX_MS },
    );
  } catch {
    // navigating / detached — the locator resolution will report it
  }
}

/** A snapshot line that names a popup: the thing a toggle opens and closes. */
export const OPENER_LINE = /^-?\s*(dialog|alertdialog|menu|menubar|listbox|tooltip)\b/;

/**
 * The popup lines a click was recorded to open, with params filled — empty
 * for anything but a click whose plain (unparameterised) effects include a
 * popup. See runOneStep's already-in-effect skip.
 */
export function openerLines(step: SkillStep, params: Record<string, string>): string[] {
  if (step.tool !== 'click' || !step.expect?.addedContains?.length) return [];
  const plain = step.expect.addedContains.filter((l) => !TRANSIENT_LINE.test(l) && !/\{\{v\d+\}\}/.test(l));
  if (!plain.some((l) => OPENER_LINE.test(l))) return [];
  return plain.map((l) => fillParams(maskVolatile(l), params));
}

/**
 * A parameterised line that did not *appear* may still be *there*: filling a
 * field with the value it already held produces no diff. One extra capture on
 * the miss path settles it.
 */
async function presentOnPage(page: Page, lines: string[]): Promise<boolean> {
  const sig = await captureSignature(page);
  if (!sig) return false;
  return lineShows(sig.lines, lines);
}

const normWs = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Does any of `wants` appear in `haystack` (recorded page lines, or a diff's
 * added lines)? Whitespace-insensitive on both sides — a marker copied with
 * a trailing space is the same word — and a `{{*}}` wildcard (see
 * maskVolatile) matches anything within one line.
 */
export function lineShows(haystack: string[], wants: string[]): boolean {
  const all = haystack.map(normWs).join('\n');
  return wants.some((raw) => {
    const want = normWs(raw);
    if (!want) return false;
    if (!want.includes(WILDCARD)) return all.includes(want);
    const re = new RegExp(
      want
        .split(WILDCARD)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^\\n]*?'),
    );
    return re.test(all);
  });
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
    // Naming the steps is not enough when the steps CREATED something. fwod13
    // replayed 02-create part-way, stopped, and recovery created a second
    // order: run n2 finished with 2 orders for its customer and n3 with 3,
    // which is why every later objective scored "no single order to check".
    // The model was told which steps ran; it was not told that a record it is
    // about to create may already exist.
    if (res.created.length) {
      // Evidence, not persuasion: these were read off the live url as the
      // minting steps ran, so they are THIS run's records, not the
      // recording's.
      lines.push(
        `ALREADY CREATED by those steps: ${res.created.map((c) => JSON.stringify(c)).join(', ')}. ` +
          `Continue with ${res.created.length === 1 ? 'it' : 'them'} — creating another is a silent duplicate, not a recovery.`,
      );
    } else if (res.stepsRun > 0) {
      lines.push(
        `If this instruction CREATES a record, one may already exist from those steps — search for it first and continue with it. Creating a second one is a silent duplicate, not a recovery.`,
      );
    }
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
