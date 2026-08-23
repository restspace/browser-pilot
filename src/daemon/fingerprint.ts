import type { Page } from 'playwright-core';

/**
 * Structural page fingerprint: a fixed-size hashed bag of normalised DOM paths
 * (tags, roles, stable classes — no text, ids, or generated hashes). Two pages
 * built from the same template land close under cosine similarity; pages that
 * need a different procedure land far apart. Stage 1 only records it and logs
 * the similarity at replay, so thresholds can later be set from real outcomes
 * instead of guessed.
 */
export const FINGERPRINT_DIMS = 512;

const CAPTURE_TIMEOUT_MS = 2_000;

/** L2-normalised vector of FINGERPRINT_DIMS, or null if the page could not be read in time. */
export async function fingerprintPage(page: Page): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const counts = await Promise.race([
      page.evaluate(pathsInPage, { maxNodes: 3_000, dims: FINGERPRINT_DIMS }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
      }),
    ]);
    if (!counts) return null;
    return normalise(counts);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function cosine(a: number[] | undefined, b: number[] | undefined): number | null {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.round(dot * 1000) / 1000;
}

function normalise(counts: number[]): number[] {
  let norm = 0;
  for (const c of counts) norm += c * c;
  norm = Math.sqrt(norm) || 1;
  return counts.map((c) => Math.round((c / norm) * 1000) / 1000);
}

/**
 * Runs in the page. Emits, for every element, the path of
 * `tag[.stableClass][@role]` segments from the nearest landmark down, hashed
 * (FNV-1a) into `dims` buckets. Everything volatile is dropped: text, ids,
 * classes that look generated, inline styles, scripts.
 */
function pathsInPage(opts: { maxNodes: number; dims: number }): number[] {
  const counts = new Array<number>(opts.dims).fill(0);
  const fnv = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  };
  const stableClass = (c: string) =>
    c.length >= 3 && c.length <= 32 && !/\d{3,}|[0-9a-f]{6,}|^(css|sc|jss|emotion)-/i.test(c) && !/^_/.test(c);
  const segment = (el: Element): string => {
    let s = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role) s += '@' + role.split(' ')[0];
    const type = el.getAttribute('type');
    if (type && s.startsWith('input')) s += ':' + type.toLowerCase();
    const classes = Array.from(el.classList).filter(stableClass).sort().slice(0, 2);
    if (classes.length) s += '.' + classes.join('.');
    return s;
  };
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'BR']);
  const segs = new Map<Element, string>();
  const all = Array.from(document.querySelectorAll('body *')).slice(0, opts.maxNodes);
  for (const el of all) {
    if (skip.has(el.tagName) || el.closest('svg')) continue;
    const own = segment(el);
    const parent = el.parentElement;
    const parentPath = parent && segs.has(parent) ? segs.get(parent)! : parent ? segment(parent) : '';
    // Keep at most four ancestors: deeper paths are all noise from the same
    // widget, shallower ones lose the region the element sits in.
    const pathParts = parentPath ? parentPath.split('/').slice(-3) : [];
    pathParts.push(own);
    const p = pathParts.join('/');
    segs.set(el, p);
    counts[fnv(p) % opts.dims] += 1;
    // Parent-child bigram and the bare segment add robustness to reordering.
    counts[fnv('seg:' + own) % opts.dims] += 0.5;
  }
  return counts;
}
