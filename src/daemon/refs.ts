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
  if (opts.interactiveOnly) text = filterInteractive(text);
  return truncate(text, opts.maxChars ?? 8000);
}

/** Rewrite Playwright's `[ref=e12]` markers to the compact `[@e12]` form the agent uses. */
export function normalizeRefs(snapshotText: string): string {
  return snapshotText.replace(/\[ref=(e\d+)\]/g, '[@$1]');
}

const INTERACTIVE_ROLES =
  /\b(button|link|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|menuitem|option|tab|listbox|grid|row|cell|dialog|alertdialog|heading|alert|status)\b/;

export function filterInteractive(snapshotText: string): string {
  return snapshotText
    .split('\n')
    .filter((line) => line.includes('[@e') || INTERACTIVE_ROLES.test(line))
    .join('\n');
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n… [truncated ${text.length - maxChars} chars — use a scoped snapshot or read()]`;
}

const REF_RE = /^@?(e\d+)$/;

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
