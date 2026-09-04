/**
 * The IR as `@playwright/test` source (Tier 2: no sitelooper runtime).
 *
 * Two files, because they have two owners. `<name>.flow.ts` is the TOOL's:
 * every line of it is generated from the FLOW constant it carries, and
 * `repair` regenerates it wholesale, so a hand edit there is lost work.
 * `<name>.spec.ts` is the USER's: it is written once, never rewritten, and
 * it is where their own assertions live. Keeping the regenerated half and
 * the hand-written half in separate files is what lets convergence stay
 * automatic without ever clobbering a reviewer's work.
 *
 * What the emitted body must be is a faithful reading of `replay.ts`: the
 * same locator chain in the same order (see `./locators.js`), the same
 * effect gates as assertions, the same derived-value binding after the step
 * that mints it. Where Tier 2 cannot follow — a `point` candidate, the loop
 * cursor, the live measurement behind a fallback — it says so in a comment
 * instead of pretending, because a spec that asserts something the recording
 * never observed is worse than one that admits the gap.
 */
import type { LocatorCandidate } from '../daemon/recorder.js';
import { TRANSIENT_LINE } from '../skills/compile.js';
import { OPENER_LINE, consequentialExpectations } from '../skills/replay.js';
import type { SkillStep } from '../skills/store.js';
import { chainSource, matcherSource, stringSource } from './locators.js';
import type { SpecFlow, SpecSegment, SpecStep } from './ir.js';

export interface EmitOptions {
  /** Tier 2, no runtime. The only tier this module emits. */
  tier: 'plain';
}

/** Markers LIFT reads the FLOW constant back out of. Changing either breaks the round trip. */
const BEGIN_MARKER = '// @sitelooper-flow-begin';
const END_MARKER = '// @sitelooper-flow-end';

/**
 * Roles whose appearance is worth an assertion on its own. A recorded page
 * change with no parameter in it is soft in replay (the gate warns rather
 * than stopping), so asserting every one of them would fail the spec on app
 * furniture. These are the lines that mean the step DID something: a tab or
 * heading appeared, an action became available, a row rendered.
 */
const STRUCTURAL_ROLES = new Set(['tab', 'heading', 'button', 'link', 'cell']);

/** Playwright's own default; only a different timeout is worth carrying over. */
const DEFAULT_WAIT_MS = 10_000;

/** How long a recorded template may run inside a generated comment. */
const COMMENT_CLIP = 120;

/** How far a chain's `.or(` continuation lines sit in from the statement that opens them. */
const CONT_INDENT = '  ';

/** Default iterations a folded loop may run when the recording set no cap. */
const DEFAULT_LOOP_MAX = 20;

const clip = (s: string, max = COMMENT_CLIP) => (s.length <= max ? s : s.slice(0, max) + '…');

/** One line of comment text: no newlines, and nothing that would close a doc comment. */
const commentSafe = (s: string) => clip(String(s).replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim(), 200);

/** A slot marker anywhere in the text — the mark of a value this run supplies. */
const SLOT_LINE = /\{\{v\d+\}\}/;

/** How a recorded slot renders inside generated source: as the step's own param. */
const slotAsParam = (s: string) => '${p.' + s + '}';

/** A JS single-quoted literal (mirrors recorder.q, which this module cannot import without pulling in playwright types). */
function q(value: string): string {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '').replace(/\n/g, '\\n')}'`;
}

/** An object key as source: bare when it is an identifier, quoted otherwise. */
function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : q(name);
}

/** Literal text inside a template literal: a backtick or a `${` would end it or open a hole. */
function templateSafe(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The inlined helpers, keyed by the token that proves the body uses one. */
const HELPERS: { token: string; source: string[] }[] = [
  {
    token: 'urlPart(',
    source: [
      '/**',
      " * The addressable parts of a url, labelled as the recorder labels them:",
      ' * path segments `p<i>`, hash-route segments `h<i>`, hash-state values `q.<key>`.',
      ' * Inlined so the spec depends on nothing but Playwright.',
      ' */',
      'function urlPart(url: string, label: string): string {',
      '  let u: URL;',
      '  try {',
      '    u = new URL(url);',
      '  } catch {',
      "    return '';",
      '  }',
      '  const dec = (s: string) => {',
      '    try {',
      '      return decodeURIComponent(s);',
      '    } catch {',
      '      return s;',
      '    }',
      '  };',
      '  const parts: Record<string, string> = {};',
      "  u.pathname.split('/').filter(Boolean).forEach((v, i) => (parts[`p${i}`] ??= dec(v)));",
      "  const body = u.hash.length > 1 ? u.hash.slice(1).split('?')[0] : '';",
      "  if (body.startsWith('/') || (body && !body.includes('='))) {",
      "    body.split('/').filter(Boolean).forEach((v, i) => (parts[`h${i}`] ??= dec(v)));",
      '  } else if (body) {',
      "    for (const pair of body.split('&').filter(Boolean)) {",
      "      const eq = pair.indexOf('=');",
      '      const k = eq < 0 ? pair : pair.slice(0, eq);',
      "      parts[`q.${k}`] ??= eq < 0 ? '' : dec(pair.slice(eq + 1));",
      '    }',
      '  }',
      "  return parts[label] ?? '';",
      '}',
    ],
  },
  {
    token: 'escapeRe(',
    source: [
      '/** A value interpolated into a pattern is DATA: its own metacharacters must not become pattern. */',
      'function escapeRe(s: string): string {',
      "  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
      '}',
    ],
  },
];

/** Emission state shared by every step of one flow step's body. */
interface Ctx {
  /** Flow step id, the prefix of every output key this body writes. */
  stepId: string;
  /** Slot names the body needs in `p`, collected as it emits. */
  slots: Set<string>;
  warnings: string[];
  downloads: number;
  /**
   * The url pattern already asserted, so an SPA whose every step records the
   * same pattern is asserted once rather than twenty times. The assertion
   * carries information only where the pattern CHANGES; repeated, it is noise
   * a reviewer has to read past. Reset at each segment, which is where the
   * page template can change under the procedure.
   */
  lastUrl: string | null;
  /** Hoisted loop guards, so each loop names its own. */
  loops: number;
}

const src = (text: string) => stringSource(text, { slot: slotAsParam });
const match = (text: string) => matcherSource(text, { slot: slotAsParam });

/**
 * A url pattern as a RegExp source for `toHaveURL`, mirroring `urlMatches`:
 * `:id`/`:var` stand for any one segment, a slot for this run's own value
 * (escaped — it is data), the query is not part of the identity of a page
 * and the hash route is. Null when the pattern is not a url at all.
 */
function urlRegexSource(pattern: string): string | null {
  if (!/^[a-z]+:\/\//i.test(pattern)) return null;
  const hashAt = pattern.indexOf('#');
  const head = hashAt < 0 ? pattern : pattern.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : pattern.slice(hashAt);
  const queryAt = head.indexOf('?');
  const body = (piece: string): string => {
    let out = '';
    let last = 0;
    const token = /\{\{([vd]\d+)\}\}|:id\b|:var\b/g;
    for (const m of piece.matchAll(token)) {
      const at = m.index ?? 0;
      out += templateSafe(escapeRe(piece.slice(last, at)));
      out += m[1] ? '${escapeRe(p.' + m[1] + ')}' : '[^/]+';
      last = at + m[0].length;
    }
    return out + templateSafe(escapeRe(piece.slice(last)));
  };
  const headSource = body(queryAt < 0 ? head : head.slice(0, queryAt));
  // The query is dropped from the pattern, so the live url may still carry
  // one: allow it exactly where it would sit, before the hash route.
  return hash ? `^${headSource}(?:\\\\?[^#]*)?${body(hash)}$` : `^${headSource}(?:[?#].*)?$`;
}

/**
 * A Playwright locator for one recorded page line (`- role "name"`,
 * `- text: foo`). Null when the line names nothing findable — an unnamed
 * control, or a value with no role — in which case the caller leaves the
 * observation as a comment rather than inventing an assertion.
 */
function lineLocator(line: string): string | null {
  const roled = /^-?\s*([a-zA-Z]+)\s+"((?:[^"\\]|\\.)*)"/.exec(line);
  if (roled) {
    const name = roled[2].replace(/\\(.)/g, '$1');
    if (!name.trim()) return null;
    return `page.getByRole(${q(roled[1])}, { name: ${match(name)}, exact: true }).first()`;
  }
  const text = /^-?\s*(?:text:)?\s*(.+?)\s*$/.exec(line);
  const value = text?.[1];
  if (!value || value.includes('"')) return null;
  return `page.getByText(${match(value)}, { exact: true }).first()`;
}

/** The role token a page line starts with, for the structural test. */
function lineRole(line: string): string {
  return /^-?\s*([a-zA-Z]+)\b/.exec(line)?.[1] ?? '';
}

/**
 * The step's recorded page changes as assertions, mirroring the
 * `expectedChanges` gate: a line carrying a slot is HARD (it is what
 * distinguishes this run from the recorded one, so its absence means the
 * step acted on the wrong thing), everything else is soft and only becomes
 * an assertion when it is the kind of line that means the action landed.
 */
function expectationLines(step: SkillStep, out: string[]): void {
  const recorded = step.expect?.addedContains ?? [];
  let lines = recorded.filter((l) => !TRANSIENT_LINE.test(l));
  if (!lines.length) return;
  // A fill's own echo in a same-role element is no evidence — the WRONG
  // textbox produces it too. Same choice replay makes, made visible here.
  if (step.tool === 'fill' && typeof step.args.value === 'string') {
    lines = consequentialExpectations(lines, step.args.value);
  }
  for (const line of lines) {
    const hard = SLOT_LINE.test(line);
    if (!hard && !OPENER_LINE.test(line) && !STRUCTURAL_ROLES.has(lineRole(line))) {
      out.push(`// observed: ${commentSafe(line)}`);
      continue;
    }
    const loc = lineLocator(line);
    if (!loc) {
      out.push(`// observed${hard ? ' (parameterised, but nothing nameable in it)' : ''}: ${commentSafe(line)}`);
      continue;
    }
    out.push(`await expect(${loc}).toBeVisible();`);
  }
}

/** The url and alert halves of a step's expectation. */
function effectLines(step: SkillStep, ctx: Ctx, out: string[]): void {
  const pattern = step.expect?.urlPattern;
  if (pattern && pattern !== ctx.lastUrl) {
    ctx.lastUrl = pattern;
    const re = urlRegexSource(pattern);
    if (re) out.push(`await expect(page).toHaveURL(new RegExp(\`${re}\`));`);
    else out.push(`// expected url ${commentSafe(pattern)} (not a url pattern this compiler can express)`);
  }
  // Toasts are volatile: recorded soft in replay, and a spec that asserted
  // one would fail on timing rather than on behaviour.
  if (step.expect?.alertContains) out.push(`// expected alert containing ${JSON.stringify(commentSafe(step.expect.alertContains))}`);
}

/** Collect the slots a piece of recorded text needs from `p`. */
function noteSlots(value: unknown, ctx: Ctx): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{([vd]\d+)\}\}/g)) ctx.slots.add(m[1]);
    return;
  }
  if (Array.isArray(value)) for (const v of value) noteSlots(v, ctx);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) noteSlots(v, ctx);
}

/**
 * The chain as source, with what Tier 2 could not carry reported as a TODO.
 * Returns null when nothing at all could be expressed — the caller then
 * emits the action as a TODO rather than a statement it cannot target.
 */
function targetSource(step: SkillStep, key: 'target' | 'source', ctx: Ctx): string | null {
  const chain = step.locators?.[key] ?? [];
  noteSlots(chain, ctx);
  const { source } = chainSource(chain, { slot: slotAsParam, indent: CONT_INDENT });
  return source || null;
}

/** The `point` candidates a step lost, as one honest comment. */
function droppedNotes(step: SkillStep, out: string[]): void {
  const lost: LocatorCandidate[] = [];
  for (const key of ['target', 'source']) {
    for (const c of step.locators?.[key] ?? []) if (c.kind === 'point') lost.push(c);
  }
  if (!lost.length) return;
  const where = lost
    .map((c) => (c.kind === 'point' ? `${c.role ?? c.tag} at ${c.x},${c.y}` : ''))
    .filter(Boolean)
    .join(', ');
  out.push(`// TODO: dropped the recorded position fallback (${where}) — a spec cannot find an element by where it was.`);
}

/** `p.dN = urlPart(...)` for every value this step mints, bound before the assertions read it. */
function derivedLines(segment: SpecSegment, index: number, ctx: Ctx, out: string[]): void {
  for (const [name, d] of Object.entries(segment.derived ?? {})) {
    if (d.step !== index) continue;
    ctx.slots.add(name);
    out.push(`p.${name} = urlPart(page.url(), ${q(d.at)}); // recorded example: ${commentSafe(d.example)}`);
  }
}

/**
 * One recorded step as source. `first` marks a loop body, where every target
 * is taken at its first match (see emitLoop).
 */
function emitSkillStep(step: SkillStep, segment: SpecSegment, index: number, ctx: Ctx, first = false): string[] {
  const out: string[] = [];
  const args = step.args ?? {};
  noteSlots(args, ctx);
  const str = (name: string, fallback = '') => String(args[name] ?? fallback);
  const num = (name: string): number | undefined => (typeof args[name] === 'number' ? (args[name] as number) : undefined);

  // Steps that act on the page itself, before any locator is needed.
  switch (step.tool) {
    case 'goto':
      out.push(`await page.goto(${src(str('url'))});`);
      effectLines(step, ctx, out);
      derivedLines(segment, index, ctx, out);
      return out;
    case 'back':
      out.push('await page.goBack();');
      return out;
    case 'set_viewport':
      out.push(`await page.setViewportSize({ width: ${num('width') ?? 0}, height: ${num('height') ?? 0} });`);
      return out;
    case 'set_offline':
      out.push(`await page.context().setOffline(${Boolean(args.offline)});`);
      return out;
    case 'eval':
      out.push(`await page.evaluate(${src(str('expression'))});`);
      return out;
    case 'screenshot':
      out.push(`await page.screenshot({ path: ${src(args.path ? str('path') : 'screenshot.jpg')}${args.full_page ? ', fullPage: true' : ''} });`);
      return out;
    case 'dialog_expect': {
      const action = args.action === 'accept' ? 'accept' : 'dismiss';
      const arg = action === 'accept' && args.prompt_text ? src(str('prompt_text')) : '';
      const count = num('count') ?? 1;
      out.push(`page.${count > 1 ? 'on' : 'once'}('dialog', (dialog) => dialog.${action}(${arg}));`);
      return out;
    }
    case 'tabs':
      // A second page needs a real handle, and inventing one would silently
      // re-point every later `page.` line.
      out.push(`// TODO: the recording switched to tab ${String(args.switch_to)} here — take the handle yourself.`);
      return out;
    case 'press':
      if (!args.target) {
        out.push(`await page.keyboard.press(${src(str('key'))});`);
        return out;
      }
      break;
    default:
      break;
  }

  droppedNotes(step, out);
  const isRead = step.tool === 'read' || step.tool === 'read_all';
  if (isRead && str('what') === 'url') {
    if (step.label) out.push(`outputs[${q(`${ctx.stepId}.${step.label}`)}] = page.url();`);
    return out;
  }

  const raw = targetSource(step, 'target', ctx);
  if (!raw) {
    ctx.warnings.push(`${ctx.stepId}: step ${index} (${step.tool}) has no locator a spec can express`);
    out.push(`// TODO: no locator this compiler can express for ${step.tool} — fill it in by hand.`);
    return out;
  }
  // In a loop the cursor is always the first match: the record this pass acts on.
  const target = first ? `(${raw}).first()` : raw;

  switch (step.tool) {
    case 'click':
      out.push(`await ${target}.click();`);
      break;
    case 'dblclick':
      out.push(`await ${target}.dblclick();`);
      break;
    case 'right_click':
      out.push(`await ${target}.click({ button: 'right' });`);
      break;
    case 'modifier_click': {
      const mods = Array.isArray(args.modifiers) ? (args.modifiers as string[]) : [];
      out.push(`await ${target}.click({ modifiers: [${mods.map(q).join(', ')}] });`);
      break;
    }
    case 'fill':
      out.push(`await ${target}.fill(${src(str('value'))});`);
      break;
    case 'type': {
      const delay = num('delay_ms');
      out.push(`await ${target}.pressSequentially(${src(str('text'))}${delay === undefined ? '' : `, { delay: ${delay} }`});`);
      break;
    }
    case 'press':
      out.push(`await ${target}.press(${src(str('key'))});`);
      break;
    case 'select':
      // By label, not value: the recording watched a human pick the option
      // they could read, and an app is free to renumber its values.
      out.push(`await ${target}.selectOption({ label: ${src(str('option'))} });`);
      break;
    case 'check':
      out.push(`await ${target}.${args.checked === false ? 'uncheck' : 'check'}();`);
      break;
    case 'hover':
      out.push(`await ${target}.hover();`);
      break;
    case 'scroll_into_view':
      out.push(`await ${target}.scrollIntoViewIfNeeded();`);
      break;
    case 'upload': {
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      out.push(`await ${target}.setInputFiles([${paths.map(q).join(', ')}]);`);
      break;
    }
    case 'download': {
      const n = ++ctx.downloads;
      out.push(`const downloadPromise${n} = page.waitForEvent('download');`);
      out.push(`await ${target}.click();`);
      out.push(`const download${n} = await downloadPromise${n};`);
      out.push(`await download${n}.saveAs(${args.save_path ? src(str('save_path')) : `\`downloads/\${download${n}.suggestedFilename()}\``});`);
      break;
    }
    case 'drag': {
      const source = targetSource(step, 'source', ctx);
      if (source) out.push(`await ${source}.dragTo(${target});`);
      else out.push(`// TODO: no locator this compiler can express for the drag source.`);
      break;
    }
    case 'wait_for':
      out.push(waitForLine(target, args, num('timeout_ms')));
      break;
    case 'read':
    case 'read_all':
      out.push(...readLine(target, step, ctx));
      break;
    default:
      out.push(`// TODO: recorded tool ${step.tool} has no Tier 2 form.`);
      ctx.warnings.push(`${ctx.stepId}: step ${index} uses tool ${step.tool}, which has no Tier 2 form`);
      break;
  }

  derivedLines(segment, index, ctx, out);
  if (step.mints) {
    out.push(`// This step CREATES a record (its id is url part ${q(step.mints.at)}) — clean it up in your teardown.`);
  }
  if (!isRead) {
    effectLines(step, ctx, out);
    expectationLines(step, out);
  }
  return out;
}

function waitForLine(target: string, args: Record<string, unknown>, timeout?: number): string {
  const only = timeout && timeout !== DEFAULT_WAIT_MS ? `{ timeout: ${timeout} }` : '';
  const opt = only ? `, ${only}` : '';
  switch (String(args.state)) {
    case 'visible':
      return `await expect(${target}).toBeVisible(${only});`;
    case 'hidden':
      return `await expect(${target}).toBeHidden(${only});`;
    case 'text_equals':
      return `await expect(${target}).toHaveText(${src(String(args.text ?? ''))}${opt});`;
    case 'text_contains':
      return `await expect(${target}).toContainText(${src(String(args.text ?? ''))}${opt});`;
    case 'count':
      return `await expect(${target}).toHaveCount(${Number(args.count ?? 0)}${opt});`;
    default:
      return `// TODO: recorded wait_for state ${String(args.state)} has no Tier 2 form.`;
  }
}

/**
 * A read publishes a value later steps reference by `<stepId>.<label>`. An
 * unlabelled read fed nothing downstream — it was the agent orienting itself
 * — so it is left as a comment rather than an assertion nobody asked for.
 */
function readLine(target: string, step: SkillStep, ctx: Ctx): string[] {
  const what = String(step.args?.what ?? 'text');
  if (!step.label) return [`// observed: ${step.tool} ${commentSafe(what)} (unlabelled — it published no value)`];
  const out = `outputs[${q(`${ctx.stepId}.${step.label}`)}]`;
  if (what === 'value') return [`${out} = await ${target}.inputValue();`];
  if (what === 'text') {
    // read_all legitimately matches many elements, so textContent's strict
    // mode would throw where replay read every match.
    return step.tool === 'read_all'
      ? [`${out} = (await ${target}.allTextContents()).join('\\n');`]
      : [`${out} = (await ${target}.textContent()) ?? '';`];
  }
  return [`// TODO: read what=${commentSafe(what)} has no Tier 2 form (label ${commentSafe(step.label)}).`];
}

/**
 * A folded loop: the recording did the same thing to record after record,
 * and replay repeats the body while the guard still matches, capped at
 * `max`. Tier 2 keeps the guard and the cap and always acts on the first
 * match — right for a list that shrinks, and the one place a spec cannot
 * follow replay's cursor, so it says so.
 */
function emitLoop(step: SkillStep, segment: SpecSegment, index: number, ctx: Ctx): string[] {
  const body = step.body ?? [];
  const guardChain = step.while ?? body[0]?.locators?.target ?? [];
  noteSlots(guardChain, ctx);
  const guard = chainSource(guardChain, { slot: slotAsParam, indent: CONT_INDENT }).source;
  if (!guard || !body.length) {
    ctx.warnings.push(`${ctx.stepId}: step ${index} is a loop with no ${guard ? 'body' : 'guard a spec can express'}`);
    return [`// TODO: recorded loop at step ${index} has no ${guard ? 'body' : 'expressible guard'}.`];
  }
  const max = step.max ?? DEFAULT_LOOP_MAX;
  const name = `guard${++ctx.loops}`;
  const out = [
    '// The recording folded a run of identical actions into a loop. Each pass acts on the',
    '// FIRST match: right for a list that shrinks, and all a spec can do — replay advances a',
    '// cursor here when the list stays the same length (see runLoop).',
    `const ${name} = ${guard};`,
    `for (let i = 0; i < ${max} && (await ${name}.count()) > 0; i++) {`,
  ];
  for (const [k, bstep] of body.entries()) {
    for (const line of emitSkillStep(bstep, segment, index, ctx, true)) {
      out.push(...line.split('\n').map((l) => (l ? '  ' + l : l)));
    }
    if (k < body.length - 1) out.push('');
  }
  out.push('}');
  return out;
}

/** Whether every slot in a marker is bound by this segment's params or its derived values. */
function markerBound(marker: string, segment: SpecSegment): boolean {
  const slots = [...marker.matchAll(/\{\{([vd]\d+)\}\}/g)].map((m) => m[1]);
  if (!slots.length) return Boolean(marker.trim());
  return slots.every((s) => s in segment.params || s in (segment.derived ?? {}));
}

/** One segment: its preconditions, then its steps. */
function emitSegment(segment: SpecSegment, ctx: Ctx): string[] {
  const out: string[] = [];
  ctx.lastUrl = null;
  out.push(`// ${segment.id}: ${commentSafe(segment.template)}`);
  out.push(`// recorded on a page matching ${commentSafe(segment.preconditions.urlPattern)}`);
  for (const marker of segment.preconditions.requireText ?? []) {
    // Identity: the url and the page shape match every record of this
    // template, so only the marker can say this is the RIGHT record. An
    // unbound marker proves nothing and is skipped, exactly as replay skips it.
    if (!markerBound(marker, segment)) {
      out.push(`// identity marker ${commentSafe(marker)} is unbound here — nothing to check.`);
      continue;
    }
    noteSlots(marker, ctx);
    out.push(`// identity: this must be the record the flow is working on, not another of the same shape.`);
    out.push(`await expect(page.getByText(${src(marker)}).first()).toBeVisible();`);
  }
  for (const [i, step] of segment.steps.entries()) {
    out.push('');
    const lines = step.tool === 'loop' ? emitLoop(step, segment, i + 1, ctx) : emitSkillStep(step, segment, i + 1, ctx);
    out.push(...lines);
  }
  return out;
}

/** The slots a step's `p` object carries: every param of every segment, plus what they mint. */
function slotsOf(step: SpecStep, found: Set<string>): string[] {
  const names = new Set(found);
  for (const seg of step.segments) {
    for (const name of Object.keys(seg.params)) names.add(name);
    for (const name of Object.keys(seg.derived ?? {})) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/**
 * A flow-step param value as an expression: a literal, a run var, an earlier
 * step's output, or an environment secret. Secrets stay markers everywhere
 * until the moment they are used — see shared/secrets.ts — and that holds in
 * a compiled spec too: the emitted file names the variable, never the value.
 */
function paramExpr(template: string, vars: Set<string>): string {
  const parts: { lit?: string; expr?: string }[] = [];
  let last = 0;
  for (const m of template.matchAll(/\{\{([\w.#:-]+)\}\}/g)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ lit: template.slice(last, at) });
    parts.push({ expr: refExpr(m[1], vars) });
    last = at + m[0].length;
  }
  if (last < template.length) parts.push({ lit: template.slice(last) });
  if (!parts.length) return q('');
  if (parts.length === 1 && parts[0].expr) return parts[0].expr!;
  if (parts.every((p) => p.lit !== undefined)) return q(parts.map((p) => p.lit).join(''));
  return '`' + parts.map((p) => (p.lit !== undefined ? templateSafe(p.lit) : '${' + p.expr + '}')).join('') + '`';
}

function refExpr(ref: string, vars: Set<string>): string {
  const secret = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref);
  if (secret) return `process.env.${secret[1]} ?? ''`;
  if (ref.includes('.')) return `outputs[${q(ref)}] ?? ''`;
  if (vars.has(ref)) return `vars.${key(ref)}`.replace(`vars.'${ref}'`, `vars[${q(ref)}]`);
  // A reference to something the flow never declared: honest at run time
  // rather than a compile-time guess at what the caller meant.
  return `(vars as Record<string, string>)[${q(ref)}] ?? ''`;
}

/** The `{ v1: …, d1: '' }` argument one step is called with. */
function callArgs(step: SpecStep, slots: string[], vars: Set<string>, warnings: string[]): string {
  const derived = new Set(step.segments.flatMap((s) => Object.keys(s.derived ?? {})));
  const fields = slots.map((slot) => {
    // A minted value has no caller binding by construction: the body reads it
    // off the live url after the step that creates it.
    if (derived.has(slot)) return `${slot}: ''`;
    const bound = step.params[slot];
    if (bound !== undefined) return `${slot}: ${paramExpr(bound, vars)}`;
    const example = step.segments.map((s) => s.params[slot]?.example).find((e) => typeof e === 'string');
    if (example === undefined) return `${slot}: ''`;
    // No flow binding: the recording's own value is the only one there is,
    // and inlining it silently is how a replay comes to work the recorded
    // run's record. Emitted, but the caller is told.
    warnings.push(`${step.id}: slot ${slot} has no flow binding — the recorded value is inlined`);
    return `${slot}: ${paramExpr(example, vars)} /* recorded value; no flow binding */`;
  });
  return `{ ${fields.join(', ')} }`;
}

export function emitFlowFile(spec: SpecFlow, o: EmitOptions): { source: string; warnings: string[] } {
  if (o.tier !== 'plain') throw new Error(`unknown emit tier ${String(o.tier)}`);
  const warnings: string[] = [];
  const vars = new Set(spec.vars);

  // Bodies first: which helpers the file needs is decided by what they use.
  const bodies = spec.steps.map((step) => {
    const ctx: Ctx = { stepId: step.id, slots: new Set(), warnings, downloads: 0, lastUrl: null, loops: 0 };
    const lines: string[] = [];
    if (!step.segments.length) {
      lines.push(`// TODO: no converged procedure for ${JSON.stringify(commentSafe(step.instruction))}`);
      lines.push(`throw new Error(${q(`step ${step.id} has no converged procedure — record it with sitelooper, then compile again`)});`);
    } else {
      for (const [i, segment] of step.segments.entries()) {
        if (i) lines.push('');
        lines.push(...emitSegment(segment, ctx));
      }
    }
    return { step, lines, slots: slotsOf(step, ctx.slots) };
  });

  const body = bodies.flatMap((b) => b.lines).join('\n');
  const helpers = HELPERS.filter((h) => body.includes(h.token));

  const out: string[] = [
    '// @sitelooper-flow v1',
    `// Generated by sitelooper from flow ${JSON.stringify(spec.name)} — do not edit by hand.`,
    '// Repair drift with `sitelooper repair <this file>`; the FLOW constant below is the source of truth.',
    "import { expect, type Page } from '@playwright/test';",
    '',
    BEGIN_MARKER,
    `export const FLOW = ${JSON.stringify(spec, null, 2)};`,
    END_MARKER,
    '',
    `export type Vars = ${spec.vars.length ? `{ ${spec.vars.map((v) => `${key(v)}: string`).join('; ')} }` : 'Record<string, never>'};`,
    '/** Values the steps read back, keyed "<stepId>.<output>". */',
    'export interface Outputs {',
    '  [key: string]: string;',
    '}',
  ];
  for (const helper of helpers) out.push('', ...helper.source);

  out.push('', 'export const steps = {');
  for (const [i, b] of bodies.entries()) {
    if (i) out.push('');
    out.push(`  /** ${commentSafe(b.step.instruction)} */`);
    const p = b.slots.length ? `{ ${b.slots.map((s) => `${s}: string`).join('; ')} }` : 'Record<string, string>';
    out.push(`  async ${q(b.step.id)}(page: Page, p: ${p}, outputs: Outputs): Promise<void> {`);
    for (const line of b.lines) out.push(...line.split('\n').map((l) => (l ? '    ' + l : '')));
    out.push('  },');
  }
  out.push('};');

  out.push('', '/** Runs every step in order. */', 'export async function runFlow(page: Page, vars: Vars): Promise<Outputs> {');
  out.push('  const outputs: Outputs = {};');
  out.push(`  await page.goto(${q(spec.startUrl)});`);
  for (const b of bodies) {
    out.push(`  await steps[${q(b.step.id)}](page, ${callArgs(b.step, b.slots, vars, warnings)}, outputs);`);
  }
  out.push('  return outputs;', '}', '');

  return { source: out.join('\n'), warnings };
}

/** An environment variable name for a run var, so the scaffold has something to pass. */
function envName(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
}

/**
 * The user's half. Written once and never rewritten, so it is deliberately
 * thin: the call, and an invitation to assert whatever this suite cares
 * about. Everything the tool regenerates lives in the `.flow.ts` beside it.
 */
export function emitSpecFile(spec: SpecFlow): string {
  const varFields = spec.vars.map((v) => `${key(v)}: process.env.${envName(v)} ?? ''`).join(', ');
  return [
    "import { test, expect } from '@playwright/test';",
    `import { runFlow, steps } from './${spec.name}.flow';`,
    '',
    `test(${q(spec.name)}, async ({ page }) => {`,
    `  const outputs = await runFlow(page, ${varFields ? `{ ${varFields} }` : '{}'});`,
    '  // Add your own assertions here; this file is yours and sitelooper never rewrites it.',
    '  // `outputs` holds every value the flow read back, keyed "<stepId>.<output>";',
    '  // `steps` lets you run one step on its own.',
    '  expect(Object.keys(outputs).length >= 0).toBe(true);',
    '  void steps;',
    '});',
    '',
  ].join('\n');
}
