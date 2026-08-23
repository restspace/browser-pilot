import fs from 'node:fs';
import path from 'node:path';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import { ensureSessionDir } from '../shared/paths.js';
import { isRefTarget } from './refs.js';

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
  /** Set when the step was executed by replaying a stored skill, not chosen by the agent. */
  via?: { skill: string; step: number };
}

export interface RecordedInstruction {
  k: 'instruction';
  text: string;
  /** Where the browser was when the instruction started (learning mode). */
  url?: string;
  /** Structural fingerprint of that page (learning mode; see fingerprint.ts). */
  fingerprint?: number[];
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

/** Tools that map onto Playwright script lines; everything else is agent-only scaffolding. */
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
  beginInstruction(text: string, context: { url?: string; fingerprint?: number[] } = {}): void {
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
    const locators: Record<string, LocatorExpr> = {};
    for (const key of ['target', 'source'] as const) {
      const raw = args[key];
      if (resolved?.[key]) {
        const rawText = typeof raw === 'string' ? raw : '';
        locators[key] = await describeLocator(page, resolved[key], rawText).catch(() => ({
          expr: '',
          verified: false,
          raw: rawText,
        }));
        continue;
      }
      if (typeof raw !== 'string' || !raw.trim()) continue;
      locators[key] = await describeTarget(page, raw).catch(() => ({ expr: '', verified: false, raw }));
    }
    return { k: 'step', tool, args, locators };
  }

  /** Commit a prepared step once the action succeeded. Failed actions are dropped. */
  commit(step: RecordedStep | null, result: string, extra: { diff?: StepDiff; via?: RecordedStep['via'] } = {}): void {
    if (!step) return;
    const entry: RecordedStep = {
      ...step,
      ...(extra.diff ? { diff: extra.diff } : {}),
      ...(extra.via ? { via: extra.via } : {}),
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
export async function describeTarget(page: Page, raw: string): Promise<LocatorExpr> {
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
    return await describeHandle(page, handle, raw);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

/** Describe the element a live Locator resolves to (replay path). */
export async function describeLocator(page: Page, locator: Locator, raw: string): Promise<LocatorExpr> {
  const handle = await locator.elementHandle({ timeout: 2_000 }).catch(() => null);
  if (!handle) return { expr: '', verified: false, raw };
  try {
    return await describeHandle(page, handle, raw);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function describeHandle(page: Page, handle: ElementHandle<Node>, raw: string): Promise<LocatorExpr> {
  const info = (await handle.evaluate(describeInPage)) as ElementInfo;
  const { winner, chain } = await verifiedChain(page, info, handle);
  if (winner) return { expr: candidateExpr(winner), verified: true, raw, chain };
  // Nothing resolved back to this element — hand over the structural path and
  // let the generated script flag it, rather than inventing something clean.
  return { expr: `page.locator(${q(info.cssPath)})`, verified: false, raw, chain };
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
  };
}

/** Single-quoted JS string literal. */
export function q(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '').replace(/\n/g, '\\n')}'`;
}
