import { candidateExpr, makeLocator, type LocatorCandidate } from '../daemon/recorder.js';
import type { Page } from 'playwright-core';
import { newSkillId, type Skill, type SkillStore } from './store.js';

/**
 * A drift observation from one flow-step replay: the primary locator missed
 * (fallthrough or dead chain) or the step needed model recovery. Recording
 * only — repair happens AFTER the session (SLOW MODE), by the pass below
 * draining these tickets. `similarity` is the localized-vs-redesign
 * classifier: high similarity + a missed locator = localized drift
 * (patchable); low similarity = broad redesign (re-record the segment, do
 * not patch selectors).
 */
export interface DriftTicket {
  flow: string;
  step: string;
  skill: string;
  /** Skill-internal step tag the miss happened at (e.g. "5" or "9.2.1"), when known. */
  atStep?: string;
  /** Which arg the locator was for ("target"/"source"), when known. */
  key?: string;
  similarity: number | null;
  missedLocator: string | null;
  /** The fallback that resolved, or null when nothing did. */
  fallbackUsed: string | null;
  /** Chain index of the fallback that resolved (0 is the primary). */
  fallbackIndex?: number;
  /** The step went to model recovery. */
  recovered: boolean;
  reason?: string;
  pageUrlPattern?: string;
}

/**
 * Below this start-page similarity a drift is treated as a redesign: the page
 * the skill was recorded on no longer exists in recognisable form, so patching
 * individual selectors is selector-archaeology — the segment needs a fresh
 * record run instead. Chosen from the flow benches, where healthy replays sat
 * ≥0.95 and template changes dropped well below 0.8. A ticket with no
 * similarity (no stored fingerprint) is treated as localized, because the
 * cheap actions below are safe either way.
 */
export const LOCALIZED_SIMILARITY = 0.8;

export type TriageAction =
  /** The chain already self-healed: put the fallback that worked first. Cheap, no model. */
  | { kind: 'promote-fallback'; ticket: DriftTicket }
  /** Localized drift with nothing left in the chain: a model must re-derive the locator on the live page. */
  | { kind: 'patch-segment'; ticket: DriftTicket }
  /** Broad redesign: flag the segment/flow for a fresh record run. Never patch selectors. */
  | { kind: 're-record'; ticket: DriftTicket; why: string }
  | { kind: 'skip'; ticket: DriftTicket; why: string };

/**
 * Classify a run's drift tickets into repair work. Pure and deterministic —
 * the model is only ever involved later, in executing `patch-segment`.
 */
export function triage(tickets: DriftTicket[]): TriageAction[] {
  const seen = new Set<string>();
  const out: TriageAction[] = [];
  for (const t of tickets) {
    const dedupe = `${t.skill}|${t.atStep ?? ''}|${t.key ?? ''}|${t.missedLocator ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const localized = t.similarity === null || t.similarity >= LOCALIZED_SIMILARITY;
    if (!localized) {
      out.push({ kind: 're-record', ticket: t, why: `similarity ${t.similarity} < ${LOCALIZED_SIMILARITY}: the page template changed too much to patch selectors` });
      continue;
    }
    if (t.fallbackUsed !== null) {
      out.push({ kind: 'promote-fallback', ticket: t });
      continue;
    }
    if (t.missedLocator !== null) {
      out.push({ kind: 'patch-segment', ticket: t });
      continue;
    }
    // Recovery with no locator to blame (unresolved reference, missing chain
    // segment, ...): nothing a selector patch can fix.
    out.push({ kind: 'skip', ticket: t, why: t.reason ? `no locator to patch (${t.reason})` : 'no locator to patch' });
  }
  return out;
}

/** Resolve a skill-internal step tag ("5" / "9.2.1" inside a loop) to the step holding the locator chain. */
export function stepByTag(skill: Skill, tag: string | undefined): import('./store.js').SkillStep | null {
  if (!tag) return null;
  const parts = tag.split('.').map((n) => Number(n));
  const top = skill.steps[parts[0] - 1];
  if (!top) return null;
  if (parts.length === 1) return top;
  // "n.iter.k": a loop body step — the iteration index does not matter, the body is shared.
  return top.body?.[parts[2] - 1] ?? null;
}

/**
 * The cheap, no-model repair: the replay already proved a fallback resolves,
 * so make it the primary. Mutates the stored skill in place — same
 * candidates, new order, nothing invented — and keeps the old primary in the
 * chain (drift can revert). Returns false when the ticket does not map onto
 * the stored skill any more (skill gone, step gone, index out of range).
 */
export function promoteFallback(store: SkillStore, ticket: DriftTicket): boolean {
  const skill = store.get(ticket.skill);
  if (!skill || ticket.fallbackIndex === undefined || ticket.fallbackIndex < 1) return false;
  const step = stepByTag(skill, ticket.atStep);
  const chain = step?.locators[ticket.key ?? 'target'];
  if (!chain || ticket.fallbackIndex >= chain.length) return false;
  const [used] = chain.splice(ticket.fallbackIndex, 1);
  chain.unshift(used);
  store.put(skill);
  return true;
}

/** What a patch-segment proposer gets to work from. */
export interface ProposeContext {
  skill: Skill;
  ticket: DriftTicket;
  /** The dead chain, as stored (may carry {{vN}} slots). */
  chain: LocatorCandidate[];
  /** A textual snapshot of the live page's interactive elements. */
  snapshot: string;
}

/** Re-derives a locator for a moved control; null when it cannot. */
export type ProposeLocator = (context: ProposeContext) => Promise<LocatorCandidate | null>;

export interface PatchResult {
  ticket: DriftTicket;
  /** The new provisional variant skill, stored; undefined when the patch was not possible. */
  variant?: string;
  outcome: 'patched' | 'no-proposal' | 'proposal-does-not-resolve' | 'not-applicable';
  detail?: string;
}

/**
 * The SLOW-MODE model repair for one localized-drift ticket: ask `propose`
 * (a smart model, or a test stub) for the moved control's new locator on the
 * live page, verify it actually resolves there, and store the patched chain
 * as a NEW provisional variant of the drifted skill. The variant must EARN
 * adoption through the normal promote/demote lifecycle — the original is
 * left untouched until the variant validates and supersedes it.
 */
export async function patchSegment(
  store: SkillStore,
  ticket: DriftTicket,
  page: Page,
  propose: ProposeLocator,
  now = new Date().toISOString(),
): Promise<PatchResult> {
  const skill = store.get(ticket.skill);
  const step = skill ? stepByTag(skill, ticket.atStep) : null;
  const chain = step?.locators[ticket.key ?? 'target'];
  if (!skill || !step || !chain) return { ticket, outcome: 'not-applicable', detail: 'the ticket no longer maps onto a stored skill step' };

  const snapshot = await interactiveSnapshot(page);
  const proposed = await propose({ skill, ticket, chain, snapshot });
  if (!proposed) return { ticket, outcome: 'no-proposal' };

  // Verify against the live page before adopting anything.
  let count = 0;
  try {
    count = await makeLocator(page, proposed).count();
  } catch {
    count = 0;
  }
  if (count !== 1) {
    return { ticket, outcome: 'proposal-does-not-resolve', detail: `${candidateExpr(proposed)} matched ${count} element(s)` };
  }

  const variant: Skill = structuredClone(skill);
  const vstep = stepByTag(variant, ticket.atStep)!;
  vstep.locators[ticket.key ?? 'target'] = [proposed, ...chain];
  // The control changed, so the step's recorded page-change expectations are
  // stale by construction (they name the OLD control — e.g. its accessible
  // label — and would hard-fail the patched replay). Drop them on the
  // variant; safety comes from the lifecycle, which makes the variant earn
  // validation across runs before it supersedes the original.
  delete vstep.expect;
  variant.id = newSkillId(variant.origin, `${variant.template}~repair`, now);
  variant.status = 'provisional';
  variant.variantOf = skill.id;
  variant.stats = { uses: 0, successes: 0, partial: 0, created: now, failedAtStep: {}, fallthroughs: 0 };
  variant.provenance = { ...variant.provenance, session: 'post-session-repair', created: now };
  store.put(variant);
  return { ticket, variant: variant.id, outcome: 'patched', detail: candidateExpr(proposed) };
}

/**
 * The interactive elements of the live page, one per line, in the shapes a
 * proposer can turn straight into a LocatorCandidate: role+name, label,
 * placeholder, testid, id.
 */
export async function interactiveSnapshot(page: Page, limit = 120): Promise<string> {
  const rows = await page
    .evaluate((max) => {
      const out: string[] = [];
      const els = document.querySelectorAll('a, button, input, select, textarea, [role], [tabindex], label');
      for (const el of Array.from(els).slice(0, max * 2)) {
        if (out.length >= max) break;
        const h = el as HTMLElement;
        if (h.offsetParent === null && h.tagName !== 'OPTION') continue;
        const bits: string[] = [h.tagName.toLowerCase()];
        const role = h.getAttribute('role');
        if (role) bits.push(`role=${role}`);
        const id = h.id;
        if (id) bits.push(`id=${id}`);
        const testid = h.getAttribute('data-testid');
        if (testid) bits.push(`testid=${testid}`);
        const label = (h.closest('label')?.textContent ?? h.getAttribute('aria-label') ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (label) bits.push(`label=${JSON.stringify(label)}`);
        const placeholder = h.getAttribute('placeholder');
        if (placeholder) bits.push(`placeholder=${JSON.stringify(placeholder)}`);
        const text = (h.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
        if (text && text !== label) bits.push(`text=${JSON.stringify(text)}`);
        out.push(bits.join(' '));
      }
      return out;
    }, limit)
    .catch(() => [] as string[]);
  return rows.join('\n');
}
