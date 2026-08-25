import type { Locator, Page } from 'playwright-core';
import { captureSignature } from '../daemon/diff.js';
import { cosine, fingerprintPage } from '../daemon/fingerprint.js';
import { candidateExpr, makeLocator, type LocatorCandidate, type StepDiff } from '../daemon/recorder.js';
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
}

const MAX_LINE = 160;

/** Tools whose miss can be substituted by navigating to the step's recorded
 * destination: plain navigation clicks. modifier_click (new tabs) and loop
 * bodies are excluded. */
const NAV_FALLBACK_TOOLS = new Set(['click', 'dblclick']);

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
  if (!navigatesItself && !urlMatches(skill.preconditions.urlPattern, startUrl, params)) {
    // Same page shape with 1-2 disagreeing segments is likely an
    // environment-minted id (an Odoo action id, a Grafana uid): proceed
    // optimistically instead of refusing — a hard fail here is what turned a
    // one-segment difference into a dead flow, and it also makes the
    // volatility evidence uncollectible.
    const soft = softUrlMatch(skill.preconditions.urlPattern, startUrl, params);
    if (!soft) {
      res.refused = true;
      res.reason = `not on the page this procedure starts from (expects ${fillParams(skill.preconditions.urlPattern, params)}, browser is at ${urlPattern(startUrl)}) — nothing was run`;
      return res;
    }
    res.warnings.push(
      `start url differs from the recorded pattern in ${soft.diffs.length} segment(s) (${soft.diffs.map((d) => `${d.expected}→${d.actual}`).join(', ')}) — proceeding optimistically`,
    );
    res.generalisations.push({ kind: 'precondition', pattern: soft.generalised });
  }

  if (skill.preconditions.fingerprint) {
    res.similarity = cosine(skill.preconditions.fingerprint, (await fingerprintPage(page)) ?? undefined);
  }

  // One step against the live page. Mutates `res` (lines/warnings/values/
  // stepsRun) and returns how it went; a 'stop' has already set failedAt/reason.
  // `tag` labels the step for humans (e.g. "5" or, inside a loop, "9.2.1");
  // `failIndex` is the top-level step number recorded in failedAt on a stop.
  const runOneStep = async (step: SkillStep, tag: string, failIndex: number): Promise<'ran' | 'skipped' | 'stop'> => {
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
      const hit = await resolveChain(page, chain, typeof args[key] === 'string' ? String(args[key]) : '', step.tool === 'read_all');
      if (!hit) {
        resolveError = `no element matched any known locator for ${key}${chain.length ? ` (tried ${chain.length}: ${chain.slice(0, 3).map(candidateExpr).join(', ')}${chain.length > 3 ? ', …' : ''})` : ' (none recorded)'}`;
        res.misses.push({ step: tag, key, primary: chain[0] ? candidateExpr(chain[0]) : '(none recorded)', used: null });
        break;
      }
      resolved[key] = hit.locator;
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
      // destination is what the step was for. So when the chain cannot
      // resolve, a step whose recorded effect was to MOVE the browser (the
      // destination differs from here) to a fully concrete url (params and
      // derived values filled, nothing left volatile — no :id/:var/{{…}})
      // navigates there directly instead of failing. Logged as a fallthrough
      // so drift telemetry and post-session repair still see the miss.
      const dest = step.expect?.urlPattern ? fillParams(step.expect.urlPattern, params) : '';
      const concrete = dest && !dest.includes('{{') && !/[/=#](:id|:var)(?=[/&#]|$)/.test(dest);
      const navigational = NAV_FALLBACK_TOOLS.has(step.tool) && !tag.includes('.') && concrete && !urlMatches(step.expect!.urlPattern!, page.url(), params);
      if (navigational) {
        try {
          await opts.exec('goto', { url: dest }, {}, { skill: skill.id, step: failIndex });
          if (urlMatches(step.expect!.urlPattern!, page.url(), params)) {
            const miss = res.misses[res.misses.length - 1];
            if (miss && miss.step === tag) miss.used = `goto ${dest}`;
            res.fallthroughs++;
            res.warnings.push(`step ${tag}: ${resolveError}; navigated to the step's recorded destination instead (${dest})`);
            res.lines.push(`${head} → target gone; navigated to recorded destination ${dest}`);
            return 'ran';
          }
        } catch {
          // destination unreachable — report the original miss below
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
          res.warnings.push(`step ${tag}: none of the ${plain.length} expected page change(s) appeared`);
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
    while (iter < max) {
      if (opts.signal?.aborted) break;
      await settleDom(page);
      const chain = fillParamsDeep(guard, params) as LocatorCandidate[];
      const hit = await resolveChain(page, chain, '', true);
      const remaining = hit ? await hit.locator.count().catch(() => 0) : 0;
      if (!remaining) break;
      for (const [k, bstep] of body.entries()) {
        const st = await runOneStep(bstep, `${n}.${iter + 1}.${k + 1}`, n);
        if (st === 'stop') {
          res.stepsRun = before;
          return 'stop';
        }
      }
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
export async function resolveChain(
  page: Page,
  chain: LocatorCandidate[],
  rawTarget: string,
  /** read_all reads across every match, so its target need not be unique. */
  allowMultiple = false,
): Promise<{ locator: Locator; index: number; candidate: LocatorCandidate } | null> {
  const candidates = chain.length || !rawTarget || isRefTarget(rawTarget) ? chain : [{ kind: 'css', selector: rawTarget } as LocatorCandidate];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const locator = makeLocator(page, candidate);
      const count = await locator.count();
      if (count === 1) return { locator, index, candidate };
      if (count > 1) {
        if (allowMultiple) return { locator, index, candidate };
        if (candidate.nth === undefined && index === 0) continue; // was unique; ambiguity is drift, keep looking
      }
    } catch {
      // malformed selector or detached page — try the next candidate
    }
  }
  return null;
}

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
