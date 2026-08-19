import fs from 'node:fs';
import path from 'node:path';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import { ensureSessionDir } from '../shared/paths.js';
import { isRefTarget } from './refs.js';

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
}

export interface RecordedStep {
  k: 'step';
  tool: string;
  args: Record<string, unknown>;
  /** Keyed by the arg the expression replaces ("target" / "source"). */
  locators: Record<string, LocatorExpr>;
  /** Tool result, kept only for the tools whose output becomes an assertion. */
  result?: string;
}

export interface RecordedInstruction {
  k: 'instruction';
  text: string;
}

export type RecordedEntry = RecordedStep | RecordedInstruction;

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
  beginInstruction(text: string): void {
    this.append({ k: 'instruction', text });
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
  async prepare(page: Page, tool: string, args: Record<string, unknown>): Promise<RecordedStep | null> {
    if (!RECORDABLE.has(tool)) return null;
    const locators: Record<string, LocatorExpr> = {};
    for (const key of ['target', 'source'] as const) {
      const raw = args[key];
      if (typeof raw !== 'string' || !raw.trim()) continue;
      locators[key] = await describeTarget(page, raw).catch(() => ({ expr: '', verified: false, raw }));
    }
    return { k: 'step', tool, args, locators };
  }

  /** Commit a prepared step once the action succeeded. Failed actions are dropped. */
  commit(step: RecordedStep | null, result: string): void {
    if (!step) return;
    this.append(RESULT_TOOLS.has(step.tool) ? { ...step, result } : step);
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
}

/**
 * Turn one agent-supplied target into a durable locator expression. Raw CSS
 * selectors pass through as-is (the agent already chose something stable);
 * `@ref` handles are re-derived from the element's own attributes, preferring
 * test ids and roles over structural paths.
 */
export async function describeTarget(page: Page, raw: string): Promise<LocatorExpr> {
  if (!isRefTarget(raw)) {
    const expr = `page.locator(${q(raw)})`;
    const verified = await page
      .locator(raw)
      .count()
      .then((n) => n === 1)
      .catch(() => false);
    return { expr, verified, raw };
  }

  const ref = raw.trim().replace(/^@/, '');
  const handle = await page
    .locator(`aria-ref=${ref}`)
    .first()
    .elementHandle({ timeout: 2_000 })
    .catch(() => null);
  if (!handle) return { expr: '', verified: false, raw };

  try {
    const info = (await handle.evaluate(describeInPage)) as ElementInfo;
    for (const candidate of candidatesFor(info)) {
      const match = await matchIndex(candidate.make(page), handle);
      if (match === null) continue;
      const expr = match === 0 ? candidate.expr : `${candidate.expr}.nth(${match})`;
      return { expr, verified: true, raw };
    }
    // Nothing resolved back to this element — hand over the structural path and
    // let the generated script flag it, rather than inventing something clean.
    return { expr: `page.locator(${q(info.cssPath)})`, verified: false, raw };
  } finally {
    await handle.dispose().catch(() => {});
  }
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
    if (attr === 'data-testid') {
      out.push({ expr: `page.getByTestId(${q(value)})`, make: (p) => p.getByTestId(value) });
    } else {
      const sel = `[${attr}=${JSON.stringify(value)}]`;
      out.push({ expr: `page.locator(${q(sel)})`, make: (p) => p.locator(sel) });
    }
  }
  if (info.role && info.name) {
    const role = info.role as Parameters<Page['getByRole']>[0];
    const name = info.name;
    out.push({
      expr: `page.getByRole(${q(info.role)}, { name: ${q(name)} })`,
      make: (p) => p.getByRole(role, { name }),
    });
  }
  if (info.label) {
    const label = info.label;
    out.push({ expr: `page.getByLabel(${q(label)})`, make: (p) => p.getByLabel(label) });
  }
  if (info.placeholder) {
    const placeholder = info.placeholder;
    out.push({
      expr: `page.getByPlaceholder(${q(placeholder)})`,
      make: (p) => p.getByPlaceholder(placeholder),
    });
  }
  if (info.id && isStableId(info.id)) {
    const sel = /^[A-Za-z][\w-]*$/.test(info.id) ? `#${info.id}` : `[id=${JSON.stringify(info.id)}]`;
    out.push({ expr: `page.locator(${q(sel)})`, make: (p) => p.locator(sel) });
  }
  if (info.text && !info.role) {
    const text = info.text;
    out.push({
      expr: `page.getByText(${q(text)}, { exact: true })`,
      make: (p) => p.getByText(text, { exact: true }),
    });
  }
  out.push({ expr: `page.locator(${q(info.cssPath)})`, make: (p) => p.locator(info.cssPath) });
  return out;
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
