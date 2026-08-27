import fs from 'node:fs';
import path from 'node:path';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import { ensureSessionDir } from '../shared/paths.js';
import { isRefTarget, resolveTarget } from './refs.js';
import { tagComponent } from '../skills/components.js';

/**
 * One way of finding an element, in a form that can be rebuilt into a Locator
 * on a different page load (no expression strings to parse). `nth` is present
 * only when the candidate was checked against the recorded element and matched
 * at that index; a candidate without it is a fallback that must resolve to
 * exactly one element to be trusted at replay.
 */
export type LocatorCandidate = (
  | { kind: 'testid'; attr: string; value: string }
  | { kind: 'role'; role: string; name: string }
  | { kind: 'label'; label: string }
  | { kind: 'placeholder'; placeholder: string }
  | { kind: 'id'; selector: string }
  | { kind: 'text'; text: string }
  | { kind: 'css'; selector: string }
  /**
   * Identity-scoped: the element found INSIDE the repeated container (a table
   * row, a list item) that shows `hasText`. The one locator shape that names
   * a RECORD rather than a position — `hasText` carries a caller-vouched
   * value, so compile slots it and every replay re-binds it to its own
   * record. fwrd10-n2 is why it exists: its read-backs were pinned to
   * `#ticket-rows > tr:nth-of-type(1)`, the newly created ticket was not row
   * 1 on that run, and the flow published the SEED ticket's reference as its
   * own identity — every later step then worked the wrong ticket.
   */
  | { kind: 'scoped'; container: string; hasText: string; selector?: string }
) & { nth?: number };

/** Rebuild a candidate into a live Locator. Shared by recording and replay. */
export function makeLocator(page: Page, c: LocatorCandidate): Locator {
  let loc: Locator;
  switch (c.kind) {
    case 'testid':
      loc = c.attr === 'data-testid' ? page.getByTestId(c.value) : page.locator(`[${c.attr}=${JSON.stringify(c.value)}]`);
      break;
    case 'role':
      loc = page.getByRole(c.role as Parameters<Page['getByRole']>[0], { name: c.name });
      break;
    case 'label':
      loc = page.getByLabel(c.label);
      break;
    case 'placeholder':
      loc = page.getByPlaceholder(c.placeholder);
      break;
    case 'text':
      loc = page.getByText(c.text, { exact: true });
      break;
    case 'id':
    case 'css':
      loc = page.locator(c.selector);
      break;
    case 'scoped': {
      const within = page.locator(c.container, { hasText: c.hasText });
      loc = c.selector ? within.locator(c.selector) : within;
      break;
    }
  }
  return c.nth !== undefined && c.nth > 0 ? loc.nth(c.nth) : loc;
}

/** Source text for a candidate, e.g. `page.getByRole('button', { name: 'Save' })`. */
export function candidateExpr(c: LocatorCandidate): string {
  let expr: string;
  switch (c.kind) {
    case 'testid':
      expr = c.attr === 'data-testid' ? `page.getByTestId(${q(c.value)})` : `page.locator(${q(`[${c.attr}=${JSON.stringify(c.value)}]`)})`;
      break;
    case 'role':
      expr = `page.getByRole(${q(c.role)}, { name: ${q(c.name)} })`;
      break;
    case 'label':
      expr = `page.getByLabel(${q(c.label)})`;
      break;
    case 'placeholder':
      expr = `page.getByPlaceholder(${q(c.placeholder)})`;
      break;
    case 'text':
      expr = `page.getByText(${q(c.text)}, { exact: true })`;
      break;
    case 'id':
    case 'css':
      expr = `page.locator(${q(c.selector)})`;
      break;
    case 'scoped':
      expr = `page.locator(${q(c.container)}, { hasText: ${q(c.hasText)} })` + (c.selector ? `.locator(${q(c.selector)})` : '');
      break;
  }
  return c.nth !== undefined && c.nth > 0 ? `${expr}.nth(${c.nth})` : expr;
}

/**
 * A durable Playwright locator expression for one element the agent acted on,
 * resolved from the live page at record time. `verified` means the expression
 * was replayed against the page and resolved to exactly the element that was
 * acted on — an unverified expression is a best guess, and is flagged as such
 * in the generated script.
 */
export interface LocatorExpr {
  /** Source text, e.g. `page.getByRole('button', { name: 'Save' })`. Empty if nothing could be derived. */
  expr: string;
  verified: boolean;
  /** The agent's original target (an @ref or a raw selector), for TODO comments. */
  raw: string;
  /**
   * Every way the element could be found, best first; `expr` is the first one
   * that verified. Replay walks this chain when the page has drifted.
   */
  chain?: LocatorCandidate[];
}

/** What a state-changing step visibly did, kept so replay can check for it. */
export interface StepDiff {
  url: string;
  alerts: string[];
  added: string[];
}

export interface RecordedStep {
  k: 'step';
  tool: string;
  args: Record<string, unknown>;
  /** Keyed by the arg the expression replaces ("target" / "source"). */
  locators: Record<string, LocatorExpr>;
  /** Tool result, kept only for the tools whose output becomes an assertion. */
  result?: string;
  /** Page signature delta around a state-changing step (learning mode only). */
  diff?: StepDiff;
  /**
   * Structural fingerprint of the page AFTER this step, captured only when the
   * step navigated to a different page template (its url pattern changed).
   * This is a segment seam: compile splits skills here, and the fingerprint
   * becomes the next segment's precondition.
   */
  fingerprintAfter?: number[];
  /** Set when the step was executed by replaying a stored skill, not chosen by the agent. */
  via?: { skill: string; step: number };
  /** The recognized component the target sits inside, for recipe compilation. */
  component?: { family: string; rel: string };
}

export interface RecordedInstruction {
  k: 'instruction';
  text: string;
  /** Where the browser was when the instruction started (learning mode). */
  url?: string;
  /** Structural fingerprint of that page (learning mode; see fingerprint.ts). */
  fingerprint?: number[];
  /**
   * The page's visible signature text when the instruction started, capped.
   * Textual counterpart to `fingerprint`: the fingerprint says which TEMPLATE
   * the page was, this says which RECORD it showed. Compile turns the
   * caller-vouched values visible here into the skill's identity
   * precondition, so a replay cannot run a ticket's procedure on a different
   * ticket that happens to share the template (fwrd8 did exactly that).
   */
  startText?: string;
  /**
   * This entry continues the immediately preceding instruction after an
   * escalation — `text` is the ORIGINAL caller wording, not the resume
   * scaffold the model was shown, and `url`/`fingerprint` describe wherever
   * the failed attempt happened to leave the browser (mid-crisis, not a
   * usable precondition). Flow building merges it into its predecessor.
   */
  resume?: true;
}

/** How one instruction ended — closes the group opened by the matching `instruction` entry. */
export interface RecordedReport {
  k: 'report';
  status: 'success' | 'failure' | 'blocked';
  summary: string;
  values: Record<string, string>;
  /** The skill this instruction compiled into, merged into, or fully replayed (learning mode). */
  skill?: string;
  tier?: 'A' | 'B';
}

export type RecordedEntry = RecordedStep | RecordedInstruction | RecordedReport;

/** Click tools: their target may be a table row whose durable locator is the record link inside it. */
const CLICK_TOOLS = new Set(['click', 'dblclick', 'modifier_click', 'right_click']);

/** Tools whose target is worth tagging with its component family (recipe compilation). */
const COMPONENT_TOOLS = new Set(['click', 'dblclick', 'fill', 'type', 'press']);

/** Tools that map onto Playwright script lines; everything else is agent-only scaffolding. */
/** Args whose typed value identifies a record (see addIdentityHint). */
const VALUE_ARG_KEYS = ['value', 'text', 'option'] as const;

const RECORDABLE = new Set([
  'click', 'dblclick', 'right_click', 'modifier_click', 'fill', 'type', 'press', 'select',
  'check', 'hover', 'scroll_into_view', 'drag', 'wait_for', 'read', 'read_all', 'eval',
  'goto', 'back', 'upload', 'download', 'set_viewport', 'set_offline', 'screenshot',
  'dialog_expect', 'tabs',
]);

/** Tools whose observed result is turned into a (commented) assertion. */
const RESULT_TOOLS = new Set(['read', 'read_all']);

export function isRecordable(tool: string): boolean {
  return RECORDABLE.has(tool);
}

/**
 * Captures the actions an instruction takes as replayable Playwright steps.
 *
 * The agent drives the page through `@ref` handles, which are snapshot-scoped
 * and meaningless in a standalone test, so every target is re-described against
 * the live DOM *before* the action runs (afterwards the element may be gone),
 * and the resulting expression is replayed to confirm it still resolves to that
 * exact element. Entries are appended to `script.jsonl` in the session dir as
 * they happen, so a recording survives a daemon restart or a hard kill.
 */
export class ScriptRecorder {
  readonly entries: RecordedEntry[] = [];

  constructor(private readonly session: string) {
    this.load();
  }

  private file(): string {
    return path.join(ensureSessionDir(this.session), 'script.jsonl');
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(), 'utf8');
    } catch {
      return; // nothing recorded yet for this session
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.entries.push(JSON.parse(line) as RecordedEntry);
      } catch {
        // a partially written last line after a kill — drop it, keep the rest
      }
    }
  }

  private append(entry: RecordedEntry): void {
    this.entries.push(entry);
    try {
      fs.appendFileSync(this.file(), JSON.stringify(entry) + '\n');
    } catch {
      // recording must never break the run it is observing
    }
  }

  /** Mark the start of one `do` instruction; becomes a test.step in the script. */
  beginInstruction(text: string, context: { url?: string; fingerprint?: number[]; startText?: string; resume?: true } = {}): void {
    this.append({ k: 'instruction', text, ...context });
  }

  /** Close the current instruction with its outcome (learning mode; flows are built from these). */
  endInstruction(report: Omit<RecordedReport, 'k'>): void {
    this.append({ k: 'report', ...report });
  }

  /**
   * Pin the skill this instruction produced onto its report entry, after
   * compilation (which happens once the report is already recorded). Rewrites
   * the last report entry in memory and in script.jsonl so a flow exported
   * later has the skill to replay.
   */
  pinSkill(skill: string): void {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.k === 'report') {
        if (!e.skill) e.skill = skill;
        this.rewrite();
        return;
      }
      if (e.k === 'instruction') return; // no report for this instruction
    }
  }

  private rewrite(): void {
    try {
      fs.writeFileSync(this.file(), this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch {
      // recording must never break the run it observes
    }
  }

  /** Append a synthetic step (a read-back captured at report time). */
  addStep(step: RecordedStep): void {
    this.append(step);
  }

  /** Values already read via a read step since the last instruction began. */
  readResultsThisInstruction(): Set<string> {
    const out = new Set<string>();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.k === 'instruction') break;
      if (e.k === 'step' && (e.tool === 'read' || e.tool === 'read_all') && typeof e.result === 'string') {
        try {
          const v = JSON.parse(e.result);
          if (typeof v === 'string') out.add(v);
        } catch {
          out.add(e.result);
        }
      }
    }
    return out;
  }

  /**
   * The current instruction's real reads with their parsed values — target
   * label included, read_all arrays expanded — for report-time promotion of
   * prose-cited values into evidence.values. Synthetic read-backs excluded.
   */
  readsThisInstruction(): { target: string; values: string[] }[] {
    const out: { target: string; values: string[] }[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.k === 'instruction') break;
      if (e.k !== 'step' || (e.tool !== 'read' && e.tool !== 'read_all') || typeof e.result !== 'string') continue;
      if (e.args.target === '(read-back)') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.result);
      } catch {
        parsed = e.result;
      }
      const values = (Array.isArray(parsed) ? parsed : [parsed]).filter((v): v is string => typeof v === 'string');
      if (values.length) out.unshift({ target: String(e.args.target ?? ''), values });
    }
    return out;
  }

  /** Index just past the last entry — pass to entriesSince() to read back one instruction. */
  mark(): number {
    return this.entries.length;
  }

  entriesSince(mark: number): RecordedEntry[] {
    return this.entries.slice(mark);
  }

  clear(): void {
    this.entries.length = 0;
    try {
      fs.rmSync(this.file(), { force: true });
    } catch {
      // best effort
    }
  }

  /**
   * Describe a step's targets against the live page. Called BEFORE the action,
   * because a click can navigate or unmount the very element being described.
   * Returns null for tools that do not map onto a script line.
   */
  async prepare(
    page: Page,
    tool: string,
    args: Record<string, unknown>,
    /** Pre-resolved locators (replay): described from the element itself, not from args. */
    resolved?: Record<string, Locator>,
  ): Promise<RecordedStep | null> {
    if (!RECORDABLE.has(tool)) return null;
    // What the agent types names what it creates: the ticket title typed here
    // is how every later read in this instruction can be anchored to the row
    // it belongs to rather than to a row number.
    for (const key of VALUE_ARG_KEYS) {
      const v = args[key];
      if (typeof v === 'string') addIdentityHint(v);
    }
    const locators: Record<string, LocatorExpr> = {};
    for (const key of ['target', 'source'] as const) {
      const raw = args[key];
      const retarget = key === 'target' && CLICK_TOOLS.has(tool);
      if (resolved?.[key]) {
        const rawText = typeof raw === 'string' ? raw : '';
        locators[key] = await describeLocator(page, resolved[key], rawText, retarget).catch(() => ({
          expr: '',
          verified: false,
          raw: rawText,
        }));
        continue;
      }
      if (typeof raw !== 'string' || !raw.trim()) continue;
      locators[key] = await describeTarget(page, raw, retarget).catch(() => ({ expr: '', verified: false, raw }));
    }
    // Component tagging (PLAN-component-recipes): note which recognized
    // widget family the target sits inside, so a successful agent-driven
    // interaction with a hard component can later compile into a recipe.
    // Best effort like everything else here — a missing tag just means no
    // recipe is learned from this step.
    let component: RecordedStep['component'];
    if (COMPONENT_TOOLS.has(tool) && typeof args.target === 'string' && args.target.trim()) {
      const target = resolved?.target ?? resolveTarget(page, args.target);
      component = (await tagComponent(target).catch(() => null)) ?? undefined;
    }
    return { k: 'step', tool, args, locators, ...(component ? { component } : {}) };
  }

  /** Commit a prepared step once the action succeeded. Failed actions are dropped. */
  commit(step: RecordedStep | null, result: string, extra: { diff?: StepDiff; via?: RecordedStep['via']; fingerprintAfter?: number[] } = {}): void {
    if (!step) return;
    const entry: RecordedStep = {
      ...step,
      ...(extra.diff ? { diff: extra.diff } : {}),
      ...(extra.via ? { via: extra.via } : {}),
      ...(extra.fingerprintAfter ? { fingerprintAfter: extra.fingerprintAfter } : {}),
    };
    this.append(RESULT_TOOLS.has(step.tool) ? { ...entry, result } : entry);
  }
}

// --- selector derivation ---

interface ElementInfo {
  tag: string;
  testid: { attr: string; value: string } | null;
  id: string | null;
  role: string | null;
  name: string | null;
  label: string | null;
  placeholder: string | null;
  text: string | null;
  cssPath: string;
  /**
   * The nearest repeated container (table row, list item) this element sits
   * in: a GENERIC selector for containers of its kind, the container's
   * visible text, and this element's path relative to it. Raw material for an
   * identity-scoped candidate — see LocatorCandidate's 'scoped'.
   */
  row: { container: string; text: string; inner: string; cells: string[] } | null;
}

interface Candidate {
  expr: string;
  make: (page: Page) => Locator;
  spec: LocatorCandidate;
}

/**
 * Turn one agent-supplied target into a durable locator expression. Raw CSS
 * selectors pass through as-is (the agent already chose something stable);
 * `@ref` handles are re-derived from the element's own attributes, preferring
 * test ids and roles over structural paths.
 */
export async function describeTarget(page: Page, raw: string, retarget = false): Promise<LocatorExpr> {
  if (!isRefTarget(raw)) {
    // A raw selector the agent chose: keep it as the primary, but still
    // describe the element it hit so replay has attribute-based fallbacks.
    const loc = page.locator(raw);
    const count = await loc.count().catch(() => 0);
    const primary: LocatorCandidate = { kind: 'css', selector: raw };
    if (count !== 1) return { expr: candidateExpr(primary), verified: false, raw, chain: [primary] };
    const handle = await loc.elementHandle({ timeout: 2_000 }).catch(() => null);
    if (!handle) return { expr: candidateExpr(primary), verified: true, raw, chain: [primary] };
    try {
      const info = (await handle.evaluate(describeInPage)) as ElementInfo;
      const chain = [primary, ...(await verifiedChain(page, info, handle)).chain];
      return { expr: candidateExpr(primary), verified: true, raw, chain };
    } finally {
      await handle.dispose().catch(() => {});
    }
  }

  const ref = raw.trim().replace(/^@/, '');
  const handle = await page
    .locator(`aria-ref=${ref}`)
    .first()
    .elementHandle({ timeout: 2_000 })
    .catch(() => null);
  if (!handle) return { expr: '', verified: false, raw };
  try {
    return await describeHandle(page, handle, raw, retarget);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/**
 * The identifying string a candidate matches on — the thing that would make it
 * a *circular* locator if it equals the value we are trying to re-read. A price
 * cell must not be located by "125.00"; it is located by its testid or its
 * structural path instead.
 */
function candidateIdentity(c: LocatorCandidate): string | null {
  switch (c.kind) {
    case 'role':
      return c.name;
    case 'text':
      return c.text;
    case 'label':
      return c.label;
    case 'placeholder':
      return c.placeholder;
    case 'testid':
      return c.value;
    case 'scoped':
      // Anchoring a read to the very value it reads would re-read whatever
      // the next run happens to show there — the circularity this guards.
      return c.hasText;
    default:
      return null;
  }
}

/**
 * Record-time read-back synthesis (progressive automation option (c)): given a
 * value the agent just reported, find the live element showing it and derive a
 * durable, NON-value locator for it, so the same value can be re-read on a
 * later replay instead of being reported from memory. Returns a synthetic
 * `read` step, or null when the value cannot be pinned to a single element or
 * only a value-based (circular) locator would resolve — in which case the
 * value stays un-threadable and the caller falls back to recovery.
 */
export async function captureReadBack(page: Page, value: string): Promise<RecordedStep | null> {
  const v = value.trim();
  if (v.length < 2 || v.length > 80) return null; // too short to be distinctive, or prose
  const loc = page.getByText(v, { exact: true });
  const count = await loc.count().catch(() => 0);
  if (count !== 1) return null; // ambiguous or absent — cannot pin it by text
  const handle = await loc.first().elementHandle({ timeout: 1_000 }).catch(() => null);
  if (!handle) return null;
  try {
    return await readBackFromHandle(page, handle, v);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/**
 * Read-back from a selector the MODEL supplied (the verified-fallback path,
 * for values captureReadBack could not pin by text — e.g. a value that is not
 * unique). The selector is trusted only after it resolves to exactly one
 * element whose text actually IS the value; otherwise null and the value stays
 * un-threadable.
 */
export async function captureReadBackAt(page: Page, value: string, selector: string): Promise<RecordedStep | null> {
  const v = value.trim();
  if (!selector.trim() || v.length < 2 || v.length > 80) return null;
  let loc;
  try {
    loc = resolveTarget(page, selector);
  } catch {
    return null;
  }
  const count = await loc.count().catch(() => 0);
  if (count !== 1) return null; // must be unambiguous
  const handle = await loc.first().elementHandle({ timeout: 1_000 }).catch(() => null);
  if (!handle) return null;
  try {
    const raw = await handle
      .evaluate((el) => ((el as HTMLElement).innerText ?? (el as HTMLInputElement).value ?? '').trim())
      .catch(() => '');
    if (raw !== v && !raw.includes(v)) return null; // the model pointed at the wrong element
    return await readBackFromHandle(page, handle, v);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/** Derive a durable, non-circular read step for `value` from a live element. */
async function readBackFromHandle(page: Page, handle: ElementHandle<Node>, v: string): Promise<RecordedStep | null> {
  const info = (await handle.evaluate(describeInPage)) as ElementInfo;
  const chain: LocatorCandidate[] = [];
  let winner: LocatorCandidate | null = null;
  for (const candidate of candidatesFor(info)) {
    // Skip any candidate whose identity IS the value — locating the price by
    // "125.00" would never match a different price on the next run.
    if (candidateIdentity(candidate.spec) === v) continue;
    // Same uniqueness rule as verifiedChain: an ambiguous anchor is not identity.
    if (candidate.spec.kind === 'scoped' && (await candidate.make(page).count().catch(() => 0)) !== 1) continue;
    const match = await matchIndex(candidate.make(page), handle);
    if (match === null) continue;
    const spec = match === 0 ? candidate.spec : { ...candidate.spec, nth: match };
    if (!winner) winner = spec;
    chain.push(spec);
  }
  if (!winner) return null; // only a circular locator resolved — cannot re-read stably
  return {
    k: 'step',
    tool: 'read',
    args: { target: '(read-back)', what: 'text' },
    locators: { target: { expr: candidateExpr(winner), verified: true, raw: '(read-back)', chain } },
    result: JSON.stringify(v),
  };
}

/** Describe the element a live Locator resolves to (replay path). */
export async function describeLocator(page: Page, locator: Locator, raw: string, retarget = false): Promise<LocatorExpr> {
  const handle = await locator.elementHandle({ timeout: 2_000 }).catch(() => null);
  if (!handle) return { expr: '', verified: false, raw };
  try {
    return await describeHandle(page, handle, raw, retarget);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function describeHandle(page: Page, handle: ElementHandle<Node>, raw: string, retarget = false): Promise<LocatorExpr> {
  // A click on a table ROW opening a record is more durably located by the
  // record's own link inside it (name = the ref, which parameterises) than by
  // the row (name = the whole volatile row text; a positional css otherwise).
  // Retarget to that link, keeping the row's structural path as a fallback.
  if (retarget) {
    const link = await recordLinkOf(handle).catch(() => null);
    if (link) {
      try {
        const linkInfo = (await link.evaluate(describeInPage)) as ElementInfo;
        const { winner, chain } = await verifiedChain(page, linkInfo, link);
        if (winner) {
          const rowInfo = (await handle.evaluate(describeInPage)) as ElementInfo;
          const fallback: LocatorCandidate = { kind: 'css', selector: rowInfo.cssPath };
          return { expr: candidateExpr(winner), verified: true, raw, chain: [...chain, fallback] };
        }
      } finally {
        await link.dispose().catch(() => {});
      }
    }
  }
  const info = (await handle.evaluate(describeInPage)) as ElementInfo;
  const { winner, chain } = await verifiedChain(page, info, handle);
  if (winner) return { expr: candidateExpr(winner), verified: true, raw, chain };
  // Nothing resolved back to this element — hand over the structural path and
  // let the generated script flag it, rather than inventing something clean.
  return { expr: `page.locator(${q(info.cssPath)})`, verified: false, raw, chain };
}

/**
 * If `handle` is a container (a table row, list item, card) that wraps exactly
 * one hyperlink, return a handle to that link — the durable, often
 * parameterisable target for a navigation click. Null otherwise, including
 * when the element already IS the link or has several links (ambiguous).
 */
async function recordLinkOf(handle: ElementHandle<Node>): Promise<ElementHandle<Element> | null> {
  const found = await handle.evaluateHandle((el) => {
    const node = el as Element;
    if (node.tagName === 'A') return null; // already a link
    const container = /^(TR|LI|TD|TH|DIV|SECTION|ARTICLE)$/.test(node.tagName) || node.getAttribute('role') === 'row' || node.getAttribute('role') === 'listitem';
    if (!container) return null;
    const links = Array.from(node.querySelectorAll('a[href]')).filter((a) => (a as HTMLElement).offsetParent !== null || a.getClientRects().length > 0);
    return links.length === 1 ? links[0] : null;
  });
  const el = found.asElement() as ElementHandle<Element> | null;
  if (!el) {
    await found.dispose().catch(() => {});
    return null;
  }
  return el;
}

/**
 * All candidates for an element, the first that resolves back to it marked
 * with its index. Later candidates are kept unindexed as replay fallbacks —
 * checking each costs round trips, and a fallback that resolves to exactly
 * one element needs no index anyway.
 */
async function verifiedChain(
  page: Page,
  info: ElementInfo,
  handle: ElementHandle<Node>,
): Promise<{ winner: LocatorCandidate | null; chain: LocatorCandidate[] }> {
  const chain: LocatorCandidate[] = [];
  let winner: LocatorCandidate | null = null;
  for (const candidate of candidatesFor(info)) {
    // An identity anchor that matches several elements is not identity. It
    // would record clean (the handle is simply match 0) and then be discarded
    // at replay, where ambiguity in the primary reads as drift — so prove it
    // singles the record out HERE, while the page that produced it is live.
    if (candidate.spec.kind === 'scoped' && (await candidate.make(page).count().catch(() => 0)) !== 1) continue;
    if (winner) {
      chain.push(candidate.spec);
      continue;
    }
    const match = await matchIndex(candidate.make(page), handle);
    if (match === null) continue;
    winner = match === 0 ? candidate.spec : { ...candidate.spec, nth: match };
    chain.push(winner);
  }
  return { winner, chain };
}

/**
 * Index of `handle` within `locator`'s matches, or null if it is not among the
 * first few. Identity (not text equality) is the test: two buttons can share a
 * label, and only the one the agent actually used is the right recording.
 */
async function matchIndex(locator: Locator, handle: ElementHandle<Node>): Promise<number | null> {
  const count = await locator.count().catch(() => 0);
  if (count === 0) return null;
  for (let i = 0; i < Math.min(count, 10); i++) {
    const same = await locator
      .nth(i)
      .evaluate((el, other) => el === other, handle)
      .catch(() => false);
    if (same) return i;
  }
  return null;
}

function candidatesFor(info: ElementInfo): Candidate[] {
  const out: Candidate[] = [];
  // Identity first, when the element sits in a record's row that shows a
  // value the caller vouched for: that locator names the RECORD, so it is the
  // only candidate here that survives the record moving, being renumbered, or
  // another record sorting above it.
  const anchor = identityAnchor(info);
  if (anchor) out.push(cand(anchor));
  if (info.testid) {
    const { attr, value } = info.testid;
    out.push(cand({ kind: 'testid', attr, value }));
  }
  if (info.role && info.name) out.push(cand({ kind: 'role', role: info.role, name: info.name }));
  if (info.label) out.push(cand({ kind: 'label', label: info.label }));
  if (info.placeholder) out.push(cand({ kind: 'placeholder', placeholder: info.placeholder }));
  if (info.id && isStableId(info.id)) {
    const sel = /^[A-Za-z][\w-]*$/.test(info.id) ? `#${info.id}` : `[id=${JSON.stringify(info.id)}]`;
    out.push(cand({ kind: 'id', selector: sel }));
  }
  if (info.text && !info.role) out.push(cand({ kind: 'text', text: info.text }));
  out.push(cand({ kind: 'css', selector: info.cssPath }));
  return out;
}

/**
 * Values that IDENTIFY the record being worked on this instruction: the
 * caller's declared variables (a runid) plus anything typed during the
 * instruction (the title of the thing just created). Set by the agent loop
 * around each instruction; used only to prefer a record-anchored locator over
 * a positional one, so a stale or empty list costs nothing but the old
 * behaviour.
 */
let identityHints: string[] = [];

export function setIdentityHints(values: string[]): void {
  identityHints = values.map((v) => String(v ?? '').trim()).filter((v) => v.length >= MIN_HINT_LEN && v.length <= 120);
}

export function addIdentityHint(value: string): void {
  const v = String(value ?? '').trim();
  if (v.length >= MIN_HINT_LEN && v.length <= 120 && !identityHints.includes(v)) identityHints.push(v);
}

const MIN_HINT_LEN = 4;

/** The scoped candidate for this element, when its row shows an identity hint. */
function identityAnchor(info: ElementInfo): LocatorCandidate | null {
  const row = info.row;
  if (!row || !identityHints.length) return null;
  // Longest match wins: a part's full name is a sharper anchor than the runid
  // it starts with, and the runid alone would match every row of this run.
  const hit = identityHints.filter((h) => row.text.includes(h)).sort((a, b) => b.length - a.length)[0];
  if (!hit) return null;
  // A hint can be true of many rows at once: every part created this run is
  // named "<runid> RD Part X", so `hasText: runid` matches them all and replay
  // reads that ambiguity as drift (fwrd11l 03-add/04-edit/06-remove). Narrow
  // it to the shortest CELL containing the hint — that cell names this record
  // and still carries the hint, so compile slots the known value inside it.
  const narrowed = row.cells.filter((c) => c.includes(hit)).sort((a, b) => a.length - b.length)[0];
  const hasText = narrowed && narrowed.length <= 120 ? narrowed : hit;
  return { kind: 'scoped', container: row.container, hasText, ...(row.inner ? { selector: row.inner } : {}) };
}

function cand(spec: LocatorCandidate): Candidate {
  return { spec, expr: candidateExpr(spec), make: (p) => makeLocator(p, spec) };
}

/**
 * Framework-generated ids (React's `:r3:`, hash suffixes, bare counters) are
 * re-minted on the next run, so they are worse than the structural path.
 */
export function isStableId(id: string): boolean {
  if (!id || id.length > 64) return false;
  if (/^[:\d]/.test(id)) return false;
  if (/[0-9a-f]{8,}/i.test(id)) return false;
  return !/^(radix|headlessui|mui|react-aria)[-:]/i.test(id);
}

/** Runs in the page: everything a locator can be built from, in one round trip. */
function describeInPage(node: Node): ElementInfo {
  const el = node as Element;
  const attr = (name: string) => el.getAttribute(name) || null;
  const clean = (s: string | null | undefined) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t && t.length <= 80 ? t : null;
  };

  const testidAttr = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'].find((a) =>
    el.getAttribute(a),
  );
  const tag = el.tagName.toLowerCase();
  const type = (attr('type') || '').toLowerCase();

  const implicitRole = (): string | null => {
    if (tag === 'button') return 'button';
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'number') return 'spinbutton';
      if (['text', 'email', 'tel', 'url', 'password', ''].includes(type)) return 'textbox';
      return null;
    }
    return null;
  };

  const labelText = (): string | null => {
    const labelledBy = attr('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ');
      const cleaned = clean(parts);
      if (cleaned) return cleaned;
    }
    if (el.id) {
      const forLabel = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (forLabel) return clean(forLabel.textContent);
    }
    return clean(el.closest('label')?.textContent ?? null);
  };

  const cssPath = (): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const node: Element = cur;
      if (node.id && !/^[:\d]/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };

  // Nearest repeated container and this element's path inside it. The
  // container selector is deliberately GENERIC (its tag, scoped to a stable
  // ancestor id when there is one) so it matches every record's container on
  // a later run and `hasText` alone picks the record.
  const rowOf = (): { container: string; text: string; inner: string; cells: string[] } | null => {
    let box = el.closest('tr, li, [role="row"], [role="listitem"], [role="option"]');
    // Not every list is semantic: an app that renders rows as divs is just as
    // common. Fall back to the nearest ancestor that HAS siblings of its own
    // shape — that repetition is what makes it a record container.
    if (!box) {
      for (let cur: Element | null = el, hops = 0; cur && hops < 4; cur = cur.parentElement, hops++) {
        const parent = cur.parentElement;
        if (!parent) break;
        const shape = (n: Element) => `${n.tagName}.${n.getAttribute('class') ?? ''}`;
        const sibs = Array.from(parent.children).filter((c) => shape(c) === shape(cur!));
        if (sibs.length >= 2 && cur !== el) {
          box = cur;
          break;
        }
      }
    }
    if (!box) return null;
    const text = (box as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
    if (!text || text.length > 400) return null;
    const cls = (box.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0];
    const tagOf = box.tagName.toLowerCase() + (cls && /^[A-Za-z][\w-]*$/.test(cls) ? `.${cls}` : '');
    let container = tagOf;
    for (let p = box.parentElement, hops = 0; p && hops < 3; p = p.parentElement, hops++) {
      if (p.id && !/^[:\d]/.test(p.id)) {
        container = `#${CSS.escape(p.id)} ${tagOf}`;
        break;
      }
    }
    // The element's path relative to the container, same shape as cssPath.
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== box && parts.length < 5) {
      const parent: Element | null = cur.parentElement;
      let part = cur.tagName.toLowerCase();
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    // The row's own cells, so an anchor can be narrowed from "contains the
    // runid" (true of every row this run touched) to the one cell that
    // actually names this record.
    const cells = Array.from(box.children)
      .map((c) => (c as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '')
      .filter((t) => t && t.length <= 120)
      .slice(0, 12);
    return { container, text, inner: cur === box ? parts.join(' > ') : '', cells };
  };

  const label = labelText();
  const name =
    clean(attr('aria-label')) ||
    label ||
    clean(attr('placeholder')) ||
    clean(attr('alt')) ||
    clean(attr('title')) ||
    clean(tag === 'input' ? (el as HTMLInputElement).value : (el as HTMLElement).innerText);

  return {
    tag,
    testid: testidAttr ? { attr: testidAttr, value: el.getAttribute(testidAttr)! } : null,
    id: el.id || null,
    role: attr('role') || implicitRole(),
    name,
    label,
    placeholder: clean(attr('placeholder')),
    text: clean(tag === 'input' ? null : (el as HTMLElement).innerText),
    cssPath: cssPath(),
    row: rowOf(),
  };
}

/** Single-quoted JS string literal. */
export function q(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '').replace(/\n/g, '\\n')}'`;
}
