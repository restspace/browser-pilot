import { candidateExpr, makeLocator, positionalExpr, type LocatorCandidate } from '../daemon/recorder.js';
import type { Page } from 'playwright-core';
import type { Provider } from '../agent/llm.js';
import { fillParams } from './compile.js';
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
  /**
   * Why the ZERO-MODEL path did not run it — an unresolved reference, a
   * refused precondition, no matching skill, a replay that stopped part-way.
   * Without this every fallback with no locator miss produced an identical
   * ticket, so three different causes wore one signature and the real one had
   * to be guessed from the store.
   */
  fellBack?: string;
  reason?: string;
  pageUrlPattern?: string;
  /**
   * The CONCRETE url the miss happened on, as the live page read it — not the
   * generalised `pageUrlPattern` beside it.
   *
   * Both are kept because they answer different questions. The pattern is
   * cross-run evidence (which page template drifts, matchable against a
   * store); the concrete url is the only thing a repair pass can actually
   * NAVIGATE to. Deriving one from the other is a lossy guess: a pattern that
   * generalised `#/tickets/t42` to `#/tickets/:id` cannot be filled back in
   * from the store, because the id was minted by the run — which is exactly
   * the case `repairPageUrl` has to refuse. With the concrete url the
   * in-session drain does not need to refuse it at all: it revisits the page
   * the run itself was standing on, still signed in.
   */
  pageUrl?: string;
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
export function triage(tickets: DriftTicket[], store?: Pick<SkillStore, 'get'>): TriageAction[] {
  const seen = new Set<string>();
  const out: TriageAction[] = [];
  // Loop iterations ("2.1.1", "2.4.1") all share one body step — canonicalise
  // the tag so a loop that missed on every iteration yields ONE action, not
  // one per iteration (repeat splices with stale indices would scramble the
  // chain).
  const canon = (tag: string | undefined) => (tag && tag.split('.').length === 3 ? tag.replace(/\.\d+\./, '.*.') : tag);
  for (const t of tickets) {
    const dedupe = `${t.skill}|${canon(t.atStep) ?? ''}|${t.key ?? ''}|${t.missedLocator ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const localized = t.similarity === null || t.similarity >= LOCALIZED_SIMILARITY;
    if (!localized) {
      out.push({ kind: 're-record', ticket: t, why: `similarity ${t.similarity} < ${LOCALIZED_SIMILARITY}: the page template changed too much to patch selectors` });
      continue;
    }
    if (t.fallbackUsed !== null && !positionalExpr(t.fallbackUsed)) {
      out.push({ kind: 'promote-fallback', ticket: t });
      continue;
    }
    if (t.missedLocator !== null) {
      // An observation step that waits for or reads TEXT is not repairable by
      // proposing a control: see notAControlWhy. Routed here, with the store
      // to hand, so no proposer is ever asked for a locator for it.
      const notAControl = store ? notAControlWhy(store.get(t.skill), t) : null;
      if (notAControl) {
        out.push({ kind: 'skip', ticket: t, why: notAControl });
        continue;
      }
      // A POSITIONAL fallback that worked is a symptom, not a self-heal:
      // promoting it would put "wherever sorted into that slot" first in the
      // chain and enshrine exactly what verify-artifacts flags (fwgr17-n3's
      // 03-open). The semantic locator moved — re-derive it.
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
  // The index was observed on a param-filled chain; make sure it still names
  // the candidate the ticket promoted (a prior promotion, or a chain edit,
  // may have moved it). Parameterised candidates can only be index-checked.
  const expr = candidateExpr(chain[ticket.fallbackIndex]);
  if (ticket.fallbackUsed && !expr.includes('{{') && expr !== ticket.fallbackUsed) return false;
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
  /**
   * What KIND of control the recording named - the point candidate's role (or
   * its tag when it had none), else a role candidate's role, else what the
   * step's tool implies. Undefined when nothing in the step says. Given to the
   * proposer so it can be told what to look for, and enforced afterwards by
   * patchSegment.
   */
  recordedKind?: string;
  /** The drifted step's tool ("click", "fill", ...), for the same reason. */
  tool?: string;
}

/**
 * The kind of control a drifted step named, as far as the recording can say.
 * `families` are the live roles that count as the SAME kind (a button that
 * became a link is still a command; a textbox that became a searchbox is
 * still a text input) - matching on the family rather than the exact role
 * keeps honest repairs while still refusing a button in a textbox's place.
 */
export interface RecordedKind {
  /** How to name it to a human or a model: the role, or the tag when there is no role. */
  label: string;
  families: string[];
  source: 'point' | 'role' | 'tool';
}

const ROLE_FAMILY: Record<string, string> = {
  textbox: 'text-input', searchbox: 'text-input', spinbutton: 'text-input',
  combobox: 'select', listbox: 'select',
  checkbox: 'toggle', radio: 'toggle', switch: 'toggle',
  button: 'command', link: 'command', tab: 'command', option: 'command',
  menuitem: 'command', menuitemcheckbox: 'command', menuitemradio: 'command',
};

const TAG_FAMILY: Record<string, string> = {
  input: 'text-input', textarea: 'text-input', select: 'select',
  button: 'command', a: 'command', summary: 'command',
};

/**
 * The family a role/tag belongs to. An unknown role is its own family
 * (`role:heading`), so it still compares equal to itself and unequal to
 * everything else - unknown must not mean "matches anything".
 */
export function kindFamily(k: { role?: string | null; tag?: string | null }): string | null {
  if (k.role) return ROLE_FAMILY[k.role] ?? `role:${k.role}`;
  if (k.tag) return TAG_FAMILY[k.tag] ?? `tag:${k.tag}`;
  return null;
}

/** What the step's tool alone implies about its target, when the chain says nothing. */
const TOOL_KIND: Record<string, { label: string; families: string[] }> = {
  // A combobox in the ARIA sense is often a typed-into autocomplete, so a fill
  // may legitimately land on either.
  fill: { label: 'text input', families: ['text-input', 'select'] },
  type: { label: 'text input', families: ['text-input', 'select'] },
  select: { label: 'combobox', families: ['select'] },
  check: { label: 'checkbox', families: ['toggle'] },
  uncheck: { label: 'checkbox', families: ['toggle'] },
};

/**
 * What kind of control the drifted step named - the whole point of the
 * soundness check in patchSegment. In order of how much the recording
 * actually knows: the `point` candidate carries the recorded element's own
 * role and tag (the recorder reads them off the element at record time); a
 * `role` candidate carries the role it was matched by; and failing both, the
 * tool implies a shape (you do not `fill` a button). Null when nothing says -
 * a click on a css path, say.
 */
export function recordedKindOf(step: { tool: string } | null | undefined, chain: LocatorCandidate[]): RecordedKind | null {
  const point = chain.find((c): c is Extract<LocatorCandidate, { kind: 'point' }> => c.kind === 'point');
  if (point) {
    const label = point.role ?? point.tag;
    const family = kindFamily({ role: point.role, tag: point.tag });
    if (label && family) return { label, families: [family], source: 'point' };
  }
  const role = chain.find((c): c is Extract<LocatorCandidate, { kind: 'role' }> => c.kind === 'role');
  if (role) return { label: role.role, families: [kindFamily({ role: role.role })!], source: 'role' };
  const byTool = step ? TOOL_KIND[step.tool] : undefined;
  return byTool ? { ...byTool, source: 'tool' } : null;
}

/**
 * The role/tag of the element a candidate resolves to on the LIVE page, read
 * the way the recorder reads it (recorder.ts's `implicitRole`, and markPoint's
 * `kindOf`): an explicit role attribute, else the tag's implicit role.
 * Mirrored here rather than imported because both copies live inside
 * page.evaluate bodies in recorder.ts and are not exported.
 */
export async function liveKind(page: Page, c: LocatorCandidate): Promise<{ role: string | null; tag: string } | null> {
  try {
    return await makeLocator(page, c).evaluate((el: Element) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const implicit = (): string | null => {
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
      return { role: el.getAttribute('role') || implicit(), tag };
    });
  } catch {
    return null;
  }
}

/**
 * Why this ticket cannot be repaired by proposing a CONTROL, or null when it
 * can.
 *
 * A `wait_for` (or `read`) whose target names TEXT is an EXPECTATION, not a
 * control that moved: "wait until the page shows 'Screen protector'". When it
 * stops resolving, the honest reading is that the page no longer shows that
 * text - the thing was deleted, or renamed, or never got created - and asking
 * a model for "the element that serves the same purpose" invites exactly the
 * answer a live repair gave: `getByTestId('archive')`, the Archive BUTTON,
 * offered as the replacement for the text of a part that had just been
 * deleted. Resolution is not intent. This is a failed expectation for a human
 * to look at, not drift for a machine to patch.
 */
export function notAControlWhy(skill: Skill | null | undefined, ticket: DriftTicket): string | null {
  const step = skill ? stepByTag(skill, ticket.atStep) : null;
  const chain = step?.locators[ticket.key ?? 'target'];
  if (!step || !chain) return null;
  // A step recorded with NO locator at all was never findable: the agent read
  // something back without naming an element ("(read-back)"), so there is
  // nothing that drifted and nothing a proposal could replace. Without this the
  // model was asked for "the control" of an unlabelled read and, having no
  // recorded kind to be checked against, its guess (a search box) was stored.
  if (!chain.length) {
    return `step ${ticket.atStep ?? '?'} (${step.tool}) was recorded without a locator, so nothing drifted - there is nothing to patch`;
  }
  if (!['wait_for', 'read', 'read_all'].includes(step.tool)) return null;
  const primary = chain[0];
  const namesText =
    (primary?.kind === 'text' && !!primary.text) ||
    (primary?.kind === 'scoped' && !!primary.hasText && !primary.selector) ||
    (step.tool === 'wait_for' && /^text_/.test(String(step.args.state ?? '')));
  if (!namesText) return null;
  const what =
    primary?.kind === 'text' ? JSON.stringify(primary.text)
    : primary?.kind === 'scoped' ? JSON.stringify(primary.hasText)
    : JSON.stringify(String(step.args.text ?? ''));
  const verb = step.tool === 'wait_for' ? 'waits for' : 'reads';
  return `step ${ticket.atStep ?? '?'} ${verb} the text ${what}, which the page no longer shows: a failed expectation for a human to look at, not a control that drifted - there is no control to propose`;
}

/** Re-derives a locator for a moved control; null when it cannot. */
export type ProposeLocator = (context: ProposeContext) => Promise<LocatorCandidate | null>;

export interface PatchResult {
  ticket: DriftTicket;
  /** The new provisional variant skill, stored; undefined when the patch was not possible. */
  variant?: string;
  outcome: 'patched' | 'no-proposal' | 'proposal-does-not-resolve' | 'not-applicable' | 'wrong-kind' | 'not-a-control';
  detail?: string;
  /**
   * Patched without being able to check the proposal is the same KIND of
   * control - the recording said nothing about the kind, or the live element's
   * role could not be read. The patch stands; the flag is so a report can say
   * this one was taken on trust.
   */
  unverifiedKind?: boolean;
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

  // Before any model is asked anything: some steps have no control to
  // re-derive at all. Asking anyway is what produced the Archive button as the
  // replacement for a deleted part's text.
  const notAControl = notAControlWhy(skill, ticket);
  if (notAControl) return { ticket, outcome: 'not-a-control', detail: notAControl };

  const recorded = recordedKindOf(step, chain);
  const snapshot = await interactiveSnapshot(page);
  const proposed = await propose({ skill, ticket, chain, snapshot, recordedKind: recorded?.label, tool: step.tool });
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

  // RESOLVING IS NOT INTENT. A locator that finds exactly one element on the
  // live page has proved only that the element exists - not that it is the
  // control the step was about. Ask the live element what kind of thing it is,
  // the same way the recorder asked at record time, and refuse a proposal of a
  // different kind outright.
  const live = await liveKind(page, proposed);
  const liveFamily = live ? kindFamily(live) : null;
  let unverifiedKind = false;
  if (!recorded || !live || !liveFamily) {
    // Nothing to check against (a click on a bare css path, or an element
    // whose role could not be read). Take the proposal, but say so.
    unverifiedKind = true;
  } else if (!recorded.families.includes(liveFamily)) {
    const liveLabel = live.role ?? live.tag;
    return {
      ticket,
      outcome: 'wrong-kind',
      detail: `${candidateExpr(proposed)} proposed a ${liveLabel}, the recorded control was a ${recorded.label}`,
    };
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
  return { ticket, variant: variant.id, outcome: 'patched', detail: candidateExpr(proposed), ...(unverifiedKind ? { unverifiedKind } : {}) };
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

/**
 * Fold a replay's per-candidate outcomes onto the stored skill.
 *
 * Only from a run that SUCCEEDED past the step, the same rule the url
 * `generalisations` follow: a miss inside a run that then failed says more
 * about the run than about the locator.
 *
 * This is the answer to "is this id real or ephemeral?" that does not guess
 * from its shape. Grafana's `_r8b_` is a React-minted id matching no id-shaped
 * pattern we have; two replays where it misses while a sibling resolves say so
 * outright. Nothing is deleted — `retired` sorts it last, so if the app
 * changes back it can still win on a later pass.
 */
export function recordCandidateEvidence(
  store: SkillStore,
  skillId: string,
  evidence: { step: string; key: string; hit: number; missed: number[] }[],
): boolean {
  const skill = store.get(skillId);
  if (!skill || !evidence.length) return false;
  let touched = false;
  for (const e of evidence) {
    const step = stepByTag(skill, e.step);
    const chain = step?.locators[e.key];
    if (!chain) continue;
    const bump = (i: number, field: 'hit' | 'miss') => {
      const c = chain[i];
      if (!c) return;
      c.seen = { hit: c.seen?.hit ?? 0, miss: c.seen?.miss ?? 0 };
      c.seen[field] += 1;
      touched = true;
    };
    bump(e.hit, 'hit');
    for (const i of e.missed) bump(i, 'miss');
  }
  if (touched) store.put(skill);
  return touched;
}

/**
 * Demonstrated volatile: it has missed at least twice with the element
 * present, and has never once resolved.
 *
 * Twice, not once — a single miss can be a transient (a slow paint the
 * poll happened to lose, a modal in the way). Two independent runs is the
 * cheapest evidence that is not one bad afternoon.
 */
export function retired(c: { seen?: { hit: number; miss: number } }): boolean {
  return (c.seen?.hit ?? 0) === 0 && (c.seen?.miss ?? 0) >= MIN_MISSES_TO_RETIRE;
}

const MIN_MISSES_TO_RETIRE = 2;

// --- draining a run's tickets (shared by the daemon and both CLI paths) ------

/** What one drain pass did, as rows a reporter (text or JSON) can print. */
export interface DrainSummary {
  promoted: Array<Record<string, unknown>>;
  patched: Array<Record<string, unknown>>;
  reRecord: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
}

/**
 * Why a proposal came back empty, in the only terms that distinguish "the
 * page had nothing to offer" from "the model was looking at the wrong page".
 * A cold repair pass that landed on a login screen reports 6 interactive
 * elements and a `null` reply; the same ticket drained inside the live
 * session reports 40 and a locator. Without this the two are the same line.
 */
export interface ProposalDiagnostic {
  url?: string;
  snapshotRows: number;
  snapshotBytes: number;
  /** The model's raw reply, clipped — the honest answer to "why nothing?". */
  reply: string;
}

/** A proposer that remembers what it last saw and said, for the report. */
export interface DiagnosticProposer extends ProposeLocator {
  last?: ProposalDiagnostic;
}

/** ProposeLocator backed by the repair model: strict-JSON locator proposals from the live-page snapshot. */
export function llmProposer(provider: Provider): DiagnosticProposer {
  const propose: DiagnosticProposer = async ({ skill, ticket, chain, snapshot, recordedKind, tool }) => {
    const prompt = [
      "A stored browser procedure has drifted: one step's locator no longer resolves on the live page.",
      `Procedure template: ${skill.template}`,
      `Step ${ticket.atStep ?? '?'} (${ticket.key ?? 'target'}); its known locators, best first, ALL of which failed to resolve:`,
      ...chain.map((c) => `  - ${candidateExpr(c)}`),
      // The kind is the one fact that rules out the plausible-looking wrong
      // answer: a live repair once offered the Archive BUTTON in place of a
      // textbox. A proposal of a different kind is rejected after the fact,
      // so saying it up front saves the round trip.
      ...(recordedKind ? [`The control was a ${recordedKind}${tool ? ` (the step ${tool}s it)` : ''}; propose an element of that same kind and nothing else.`] : []),
      '',
      'Interactive elements currently on the page, one per line:',
      snapshot || '(none found)',
      '',
      'Pick the ONE element that serves the same purpose the dead locators described (the control probably moved or was renamed).',
      'Do NOT offer a nearby element of a different kind just because it exists: if the control itself is gone, that is not a rename.',
      'Reply with ONLY a JSON object, no prose, in one of these shapes:',
      '{"kind":"role","role":"button","name":"..."} {"kind":"label","label":"..."} {"kind":"placeholder","placeholder":"..."}',
      '{"kind":"testid","attr":"data-testid","value":"..."} {"kind":"id","selector":"#..."} {"kind":"text","text":"..."} {"kind":"css","selector":"..."}',
      'If no element on the page serves that purpose, reply with exactly: null',
    ].join('\n');
    const completion = await provider.complete([{ role: 'user', content: prompt }], []);
    const text = (completion.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    propose.last = {
      snapshotRows: snapshot ? snapshot.split('\n').length : 0,
      snapshotBytes: snapshot.length,
      reply: text.slice(0, 300),
    };
    if (!text || text === 'null') return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') return parsed;
    } catch {
      /* not JSON */
    }
    return null;
  };
  return propose;
}

/**
 * A url the drifted page can be revisited at, or null when it cannot.
 *
 * The concrete url the ticket carries wins outright: it is where the miss
 * actually happened. The patterns behind it are a fallback for tickets filed
 * before `pageUrl` existed (and for the standalone `skills repair --drift`
 * path, whose sidecar may be old), and they are refused the moment they still
 * carry a slot or a `:id` — a generalised url cannot be filled back in from
 * the store when the id was minted by the run that drifted.
 */
export function repairPageUrl(store: SkillStore, ticket: DriftTicket): string | null {
  if (ticket.pageUrl && !ticket.pageUrl.includes('{{')) return ticket.pageUrl;
  const skill = store.get(ticket.skill);
  if (!skill) return null;
  const candidates = [ticket.pageUrlPattern, skill.preconditions.urlPattern];
  for (const c of candidates) {
    if (!c) continue;
    const filled = fillParams(c, Object.fromEntries(Object.entries(skill.params).map(([k, p]) => [k, p.example])));
    if (!filled.includes(':id') && !filled.includes('{{')) return filled;
  }
  return null;
}

export interface DrainOptions {
  /** Triage and report only: no chain is reordered, no variant is stored, no model is called. */
  dryRun: boolean;
  /**
   * Put a live page on `url` and hand it back, or null when this caller has
   * no browser to do it with. The daemon passes its OWN page — still signed
   * in, still where the run left it — which is the whole reason patch-segment
   * works in-session and did not cold.
   */
  openPage?: (url: string) => Promise<Page | null>;
  propose?: ProposeLocator | DiagnosticProposer;
  /** Reported beside a patch, so a summary says which model proposed it. */
  model?: string;
}

/**
 * Drain a run's drift tickets onto `store`: triage, then the cheap codemod
 * (promote-fallback), then the model-and-live-page one (patch-segment).
 * Re-record is REPORTED, never attempted — a broad redesign is a fresh
 * recording, and guessing at it is how a spec quietly stops testing what it
 * says it tests (PLAN-self-updating-spec.md, "what the agent is allowed to
 * change").
 *
 * Takes the store, the page opener and the proposer as arguments rather than
 * building them, because the three callers differ in exactly those: the
 * daemon drains in-session on its live page, `sitelooper repair` asks the
 * daemon to, and `skills repair --drift` opens a cold browser of its own.
 * The triage and the summary shape are identical for all three.
 */
export async function drainDrift(store: SkillStore, tickets: DriftTicket[], opts: DrainOptions): Promise<DrainSummary> {
  const actions = triage(tickets, store);
  const summary: DrainSummary = { promoted: [], patched: [], reRecord: [], skipped: [] };

  for (const a of actions) {
    if (a.kind === 'promote-fallback') {
      const ok = opts.dryRun ? true : promoteFallback(store, a.ticket);
      (ok ? summary.promoted : summary.skipped).push({
        skill: a.ticket.skill, step: a.ticket.atStep, from: a.ticket.missedLocator, to: a.ticket.fallbackUsed,
        ...(opts.dryRun ? { dryRun: true } : {}), ...(ok ? {} : { why: 'ticket no longer maps onto the stored skill' }),
      });
    } else if (a.kind === 're-record') {
      summary.reRecord.push({ flow: a.ticket.flow, step: a.ticket.step, skill: a.ticket.skill, why: a.why });
    } else if (a.kind === 'skip') {
      summary.skipped.push({ skill: a.ticket.skill, step: a.ticket.step, why: a.why });
    }
  }

  const patches = actions.filter((x): x is Extract<TriageAction, { kind: 'patch-segment' }> => x.kind === 'patch-segment');
  if (!patches.length) return summary;
  if (opts.dryRun || !opts.openPage || !opts.propose) {
    for (const a of patches) {
      summary.skipped.push({
        skill: a.ticket.skill, step: a.ticket.atStep,
        why: opts.dryRun ? 'patch-segment (dry run: needs the repair model + live page)' : 'patch-segment (no live page or repair model available here)',
      });
    }
    return summary;
  }

  const propose = opts.propose;
  for (const a of patches) {
    const url = repairPageUrl(store, a.ticket);
    if (!url) {
      summary.reRecord.push({ flow: a.ticket.flow, step: a.ticket.step, skill: a.ticket.skill, why: 'the drifted page cannot be revisited (its url needs run-specific ids)' });
      continue;
    }
    const page = await opts.openPage(url).catch(() => null);
    if (!page) {
      summary.skipped.push({ skill: a.ticket.skill, step: a.ticket.atStep, why: `could not reopen ${url}` });
      continue;
    }
    // A proposer that cannot run at all (no key, no balance, a provider
    // outage) is a REPORTABLE outcome, not a crash: the promotions this pass
    // already made are real work, and losing them to an unhandled 403 would
    // make the whole repair look like a tool bug.
    let res: PatchResult;
    try {
      res = await patchSegment(store, a.ticket, page, propose);
    } catch (err) {
      summary.skipped.push({ skill: a.ticket.skill, step: a.ticket.atStep, why: `the repair model could not be reached (${(err as Error).message.slice(0, 200)})` });
      continue;
    }
    const diagnostic = 'last' in propose ? propose.last : undefined;
    if (res.outcome === 'patched') {
      summary.patched.push({ skill: a.ticket.skill, step: a.ticket.atStep, key: a.ticket.key ?? 'target', variant: res.variant, locator: res.detail, url, model: opts.model, ...(res.unverifiedKind ? { unverifiedKind: true } : {}) });
    } else {
      summary.skipped.push({
        skill: a.ticket.skill, step: a.ticket.atStep,
        why: `${res.outcome}${res.detail ? `: ${res.detail}` : ''}`,
        // What the model was actually looking at. A `no-proposal` on a page
        // with 6 interactive rows is a navigation failure wearing a modelling
        // failure's clothes; with 40 rows it is a genuine "nothing here fits".
        ...(diagnostic ? { url, snapshotRows: diagnostic.snapshotRows, snapshotBytes: diagnostic.snapshotBytes, modelReply: diagnostic.reply } : { url }),
      });
    }
  }
  return summary;
}
