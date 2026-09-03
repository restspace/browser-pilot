import type { Locator, Page } from 'playwright-core';

export interface SnapshotOptions {
  /** Keep only lines that carry a ref or look interactive. */
  interactiveOnly?: boolean;
  /** Scope the snapshot to a CSS selector. */
  selector?: string;
  /** Character budget for the returned snapshot. */
  maxChars?: number;
}

/**
 * A11y snapshot with `@ref` handles. Uses Playwright's AI snapshot (which
 * emits `[ref=eNN]` markers resolvable via the `aria-ref=` selector engine)
 * when available, falling back to the plain aria snapshot without refs.
 */
export async function snapshot(page: Page, opts: SnapshotOptions = {}): Promise<string> {
  let raw: string;
  const scope = opts.selector ? page.locator(opts.selector) : page;
  try {
    // mode:'ai' (Playwright 1.61+) emits [ref=eN] markers resolvable via aria-ref=
    raw = await scope.ariaSnapshot({ mode: 'ai' } as Parameters<typeof scope.ariaSnapshot>[0]);
  } catch {
    raw = await (opts.selector ? page.locator(opts.selector) : page.locator('body')).ariaSnapshot();
  }
  let text = normalizeRefs(raw);
  rememberRefs(page, text);
  if (opts.interactiveOnly) text = filterInteractive(text);
  if (!text.trim()) {
    // An empty tree and a broken page look identical, and the operator has no
    // other way to tell them apart — so say which this is likely to be
    // instead of returning nothing and letting it guess.
    return '(no accessible content on this page yet — it may still be rendering; wait_for a concrete element you expect, or re-snapshot)';
  }
  return truncate(text, opts.maxChars ?? 8000);
}

/**
 * Wait until the page exposes something to act on, or the deadline passes.
 *
 * `load` fires before a client-rendered app has painted, so snapshotting a
 * heavy SPA the instant navigation "finishes" returns an EMPTY tree —
 * NocoDB's dashboard did exactly that, with an empty title to match. Polling
 * for content is the app-agnostic way to wait: network idleness is unusable
 * (Odoo long-polls forever) and a fixed sleep is either too short or wasted.
 *
 * Best-effort and bounded: a page that really has nothing costs the deadline
 * and no more.
 */
export async function waitForContent(page: Page, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ready = await page
      .evaluate(() => {
        const b = document.body;
        if (!b) return false;
        if (b.querySelector('a,button,input,select,textarea,[role],h1,h2')) return true;
        return (b.innerText ?? '').trim().length > 0;
      })
      .catch(() => true); // a page we cannot evaluate against is not ours to wait on
    if (ready || Date.now() >= deadline) return;
    await page.waitForTimeout(150).catch(() => {});
  }
}

/**
 * Rewrite Playwright's `[ref=e12]` markers to the compact `[@e12]` form the
 * agent uses. Elements inside an iframe are referenced `f<frame>e<element>`
 * ("f1e2"), and those must be rewritten too: the snapshot descends into
 * frames, and `aria-ref=f1e2` resolves through to the element, so the only
 * thing that ever stopped the agent reaching inside an iframe was this
 * pattern not recognising the ref.
 */
export function normalizeRefs(snapshotText: string): string {
  return snapshotText.replace(/\[ref=((?:f\d+)?e\d+)\]/g, '[@$1]');
}

/**
 * What each @ref looked like in the snapshots this page has produced — the
 * role and accessible name on its line — kept per page and merged across
 * snapshots, since a ref minted by an earlier snapshot stays valid after a
 * later one. This is the fallback description for a ref whose element has
 * gone by the time the recorder describes it (fwgr20's data-source picker
 * item re-rendered between the snapshot and the click): the click still
 * lands via aria-ref, but without this the step compiles with NO locator and
 * every replay dies there with "(none recorded)".
 */
const refLines = new WeakMap<Page, Map<string, { role: string; name?: string }>>();

export function rememberRefs(page: Page, snapshotText: string): void {
  let map = refLines.get(page);
  if (!map) refLines.set(page, (map = new Map()));
  for (const [ref, hint] of parseRefLines(snapshotText)) map.set(ref, hint);
}

/** The role (and name, when the line carried one) a ref showed in a snapshot. */
export function refHint(page: Page, ref: string): { role: string; name?: string } | undefined {
  return refLines.get(page)?.get(ref.replace(/^@/, ''));
}

/** `- button "Save" [@e12]` → e12: { role: 'button', name: 'Save' }. */
export function parseRefLines(snapshotText: string): Map<string, { role: string; name?: string }> {
  const out = new Map<string, { role: string; name?: string }>();
  for (const line of snapshotText.split('\n')) {
    // Lazy across the state attributes Playwright renders BEFORE the ref
    // ([level=1], [expanded], [selected], …) — an expanded picker is exactly
    // the element that vanishes before it can be described.
    const m = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*?\[@((?:f\d+)?e\d+)\]/.exec(line);
    if (!m) continue;
    const name = m[2]?.replace(/\\"/g, '"');
    out.set(m[3], name ? { role: m[1], name } : { role: m[1] });
  }
  return out;
}

const INTERACTIVE_ROLES =
  /\b(button|link|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|menu|menubar|menuitem|option|tab|listbox|grid|row|cell|dialog|alertdialog|heading|alert|status)\b/;

/**
 * The per-line heuristic behind filterInteractive; shared with signature
 * capture. Matches any ref, in-frame ones included — testing for "[@e"
 * silently dropped every line inside an iframe, so an embedded editor or
 * payment form was invisible in the snapshot the agent works from.
 */
export function isInteractiveLine(line: string): boolean {
  return line.includes('[@') || INTERACTIVE_ROLES.test(line);
}

/**
 * A structural wrapper carrying nothing at all: an unnamed generic or image
 * with no name, no content and no state. A React-heavy app emits these by the
 * hundred — on Grafana's panel editor they were 27% of the snapshot budget,
 * budget the actionable controls further down the page never got, which left
 * the operator unable to see the field it had been asked to fill. Dropping
 * them loses no hierarchy: filterInteractive keeps lines independently, so the
 * tree is already non-contiguous. Anything named, clickable, stateful or
 * content-bearing is kept.
 */
const PURE_WRAPPER = /^\s*-\s+(?:generic|img)\s*(?:\[@e\d+\])?\s*:?\s*$/;

export function filterInteractive(snapshotText: string): string {
  return snapshotText
    .split('\n')
    .filter((line) => isInteractiveLine(line) && !PURE_WRAPPER.test(line))
    .join('\n');
}

/** Roles worth naming in a truncation notice as somewhere to scope into. */
const SCOPE_ROLES =
  /^(region|dialog|alertdialog|navigation|main|form|group|tablist|tabpanel|menu|listbox|table|grid|complementary|search|article|banner|contentinfo|heading|tab|button)$/;

/**
 * Named elements in a dropped tail, so a truncation notice can say what was
 * lost rather than only how much. Deduped by ref and capped — this is a
 * signpost, not a second snapshot.
 */
function droppedLandmarks(dropped: string, limit = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of dropped.split('\n')) {
    const m = /^\s*-\s+([a-z]+)\s+"([^"]{1,60})"[^\n]*?\[@(e\d+)\]/.exec(line);
    if (!m || !SCOPE_ROLES.test(m[1])) continue;
    if (seen.has(m[3])) continue;
    seen.add(m[3]);
    out.push(`${m[1]} "${m[2]}" [@${m[3]}]`);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Truncation that says what it lost, not just how much. A blind tail cut is
 * worse than it looks: "use a scoped snapshot" is unusable advice when the
 * containers worth scoping into were themselves in the discarded tail, and an
 * operator with no way to see the rest of the page falls back to DOM
 * archaeology with eval. Cut on a line boundary, then name what lies past it.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const boundary = text.lastIndexOf('\n', maxChars);
  const head = text.slice(0, boundary > 0 ? boundary : maxChars);
  const dropped = text.slice(head.length);
  const landmarks = droppedLandmarks(dropped);
  const scope = landmarks.length
    ? ` It contains: ${landmarks.join('; ')}. Snapshot one with selector "aria-ref=eNN" to see inside it.`
    : ' Use a scoped snapshot (selector) or read()/read_all to reach it.';
  return `${head}\n… [truncated ${dropped.length} chars of this page.${scope}]`;
}

/** `@e12`, or `@f1e2` for an element inside the page's first iframe. */
const REF_RE = /^@?((?:f\d+)?e\d+)$/;

/**
 * Resolve an agent-supplied target to a Locator. `@e12` (or bare `e12`)
 * resolves through the aria-ref engine against the most recent snapshot;
 * anything else is treated as a CSS/Playwright selector. Stale refs (after
 * navigation or DOM churn) fail inside Playwright with a clear error the
 * agent recovers from by re-snapshotting.
 */
export function resolveTarget(page: Page, target: string): Locator {
  const trimmed = target.trim();
  const refMatch = REF_RE.exec(trimmed);
  if (refMatch) return page.locator(`aria-ref=${refMatch[1]}`);
  return page.locator(trimmed);
}

export function isRefTarget(target: string): boolean {
  return REF_RE.test(target.trim());
}
