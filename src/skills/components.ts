import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import type { RecordedEntry, RecordedStep } from '../daemon/recorder.js';
import { rootDir } from '../shared/paths.js';
import { countTokenOccurrences } from './compile.js';
import { originOf } from './store.js';

/**
 * Component recipes (PLAN-component-recipes): origin-INDEPENDENT
 * micro-procedures for third-party widgets that defeat the naive
 * fill/type/select primitives — monaco, CodeMirror, contenteditable editors,
 * portal-rendered comboboxes. A recipe is a short action list with the
 * payload parameterised as {{value}}, plus a mandatory verification read:
 * a recipe that cannot re-observe its own effect did not succeed. Component
 * knowledge is cross-app by construction (monaco is monaco everywhere), so
 * the store is keyed by component family, never by origin — app knowledge
 * stays in the session briefing, exactly as before.
 */

export type RecipeIntent = 'set-value' | 'read-value' | 'select-option' | 'open' | 'dismiss';

export interface RecipeStep {
  action: 'click' | 'press' | 'insertText' | 'fill' | 'blur' | 'settle';
  /**
   * CSS relative to the component root; absent = the root itself. A
   * `page:<css>` prefix scopes to the whole page — for option lists rendered
   * into a portal outside the component's subtree.
   */
  target?: string;
  key?: string;
  /** For insertText/fill; "{{value}}" is replaced by the payload. */
  text?: string;
  ms?: number;
  /** Restrict a page-scoped click to elements containing this (filled) text. */
  withText?: string;
}

export interface Recipe {
  id: string;
  family: string;
  intent: RecipeIntent;
  steps: RecipeStep[];
  /** CSS relative to root for the verification read; absent = the root itself. */
  verifyRead?: string;
  status: 'provisional' | 'validated' | 'demoted';
  stats: RecipeStats;
  /** Shipped with browser-pilot rather than learned; still starts provisional. */
  seeded?: boolean;
  provenance?: { session?: string; instruction?: string; created: string };
}

export interface RecipeStats {
  uses: number;
  successes: number;
  /** Verified successes per origin — cross-origin success is what proves the knowledge is component-level. */
  origins: Record<string, number>;
  /** Consecutive verification failures; two in a row demotes. */
  failStreak: number;
  created: string;
  lastUsed?: string;
}

export interface ComponentFamily {
  id: string;
  /** CSS the component ROOT matches (used with Element.closest). */
  root: string;
  /** Default verification read for learned recipes of this family. */
  verifyRead?: string;
}

/**
 * Recognition set. Order matters: more specific families first (CodeMirror's
 * .cm-content IS contenteditable; monaco embeds a textarea). Recognition may
 * be heuristic because being wrong is cheap: the recipe's verification read
 * fails, the action falls back to the naive primitive and then the model.
 */
export const FAMILIES: ComponentFamily[] = [
  { id: 'monaco', root: '.monaco-editor', verifyRead: '.view-lines' },
  { id: 'codemirror6', root: '.cm-editor', verifyRead: '.cm-content' },
  { id: 'prosemirror', root: '.ProseMirror' },
  { id: 'contenteditable', root: '[contenteditable="true"]' },
  { id: 'aria-combobox', root: '[role="combobox"]' },
];

export function familyOf(id: string): ComponentFamily | undefined {
  return FAMILIES.find((f) => f.id === id);
}

const SEED_CREATED = '2026-08-25T00:00:00Z';

function seedStats(): RecipeStats {
  return { uses: 0, successes: 0, origins: {}, failStreak: 0, created: SEED_CREATED };
}

/** Select-all → replace → commit, the shape every keyboard-driven editor takes. */
function editorSetValue(clickTarget?: string, blurTarget?: string): RecipeStep[] {
  return [
    { action: 'click', ...(clickTarget ? { target: clickTarget } : {}) },
    { action: 'press', key: 'ControlOrMeta+a' },
    { action: 'insertText', text: '{{value}}' },
    { action: 'settle', ms: 400 },
    { action: 'press', key: 'Escape' },
    { action: 'blur', ...(blurTarget ? { target: blurTarget } : {}) },
    { action: 'settle', ms: 200 },
  ];
}

/**
 * The shipped starter library. Seeds are a floor, not an authority: they
 * enter the lifecycle provisional, must verify on first contact, and can be
 * demoted or superseded by learned variants when a library version changes
 * behaviour.
 */
export function seedRecipes(): Recipe[] {
  const mk = (family: string, intent: RecipeIntent, steps: RecipeStep[], verifyRead?: string): Recipe => ({
    id: `r_${crypto.createHash('sha1').update(`${family}\n${intent}\nseed`).digest('hex').slice(0, 6)}`,
    family,
    intent,
    steps,
    ...(verifyRead ? { verifyRead } : {}),
    status: 'provisional',
    stats: seedStats(),
    seeded: true,
    provenance: { created: SEED_CREATED },
  });
  return [
    mk('monaco', 'set-value', editorSetValue(undefined, 'textarea'), '.view-lines'),
    mk('monaco', 'read-value', [], '.view-lines'),
    mk('codemirror6', 'set-value', editorSetValue('.cm-content', '.cm-content'), '.cm-content'),
    mk('codemirror6', 'read-value', [], '.cm-content'),
    mk('prosemirror', 'set-value', editorSetValue()),
    mk('contenteditable', 'set-value', editorSetValue()),
    mk('aria-combobox', 'select-option', [
      { action: 'click' },
      { action: 'press', key: 'ControlOrMeta+a' },
      { action: 'insertText', text: '{{value}}' },
      { action: 'settle', ms: 400 },
      { action: 'click', target: 'page:[role="option"]', withText: '{{value}}' },
      { action: 'settle', ms: 200 },
    ]),
  ];
}

/** Where recipes live: `$BROWSER_PILOT_COMPONENTS_FILE` or `<home>/components.json`. */
export function componentsFile(): string {
  return process.env.BROWSER_PILOT_COMPONENTS_FILE || path.join(rootDir(), 'components.json');
}

/**
 * One JSON file, global (NOT per origin — that is the point). Reads are fresh
 * per access, like SkillStore. Seeds are merged in for any (family, intent)
 * with no stored recipe, and materialise into the file on first outcome.
 */
export class ComponentStore {
  constructor(readonly file: string = componentsFile()) {}

  private read(): Recipe[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(raw?.recipes) ? (raw.recipes as Recipe[]) : [];
    } catch {
      return [];
    }
  }

  private write(recipes: Recipe[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, recipes }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /** Stored recipes plus seeds for any (family, intent) not represented. */
  list(): Recipe[] {
    const stored = this.read();
    const covered = new Set(stored.map((r) => `${r.family}\n${r.intent}`));
    return [...stored, ...seedRecipes().filter((s) => !covered.has(`${s.family}\n${s.intent}`))];
  }

  get(id: string): Recipe | null {
    return this.list().find((r) => r.id === id) ?? null;
  }

  put(recipe: Recipe): void {
    const stored = this.read().filter((r) => r.id !== recipe.id);
    stored.push(recipe);
    this.write(stored);
  }

  /**
   * Same lifecycle as skills, with cross-origin weighting: a verified success
   * on a SECOND origin counts double, because working on two different apps
   * is what proves the knowledge is component-level rather than app-level in
   * disguise. Two consecutive verification failures demote.
   */
  recordOutcome(id: string, ok: boolean, origin: string, now = new Date().toISOString()): Recipe | null {
    const recipe = this.get(id);
    if (!recipe) return null;
    const st = recipe.stats;
    st.uses += 1;
    st.lastUsed = now;
    if (ok) {
      st.successes += 1;
      st.origins[origin] = (st.origins[origin] ?? 0) + 1;
      st.failStreak = 0;
      const distinctOrigins = Object.keys(st.origins).length;
      if (recipe.status === 'provisional' && st.successes + Math.max(0, distinctOrigins - 1) >= 2) {
        recipe.status = 'validated';
      }
    } else {
      st.failStreak += 1;
      if (st.failStreak >= 2) recipe.status = 'demoted';
    }
    this.put(recipe);
    return recipe;
  }
}

/** Best recipe for a (family, intent): validated first, then track record. */
export function pickRecipe(recipes: Recipe[], family: string, intent: RecipeIntent): Recipe | null {
  return (
    recipes
      .filter((r) => r.family === family && r.intent === intent && r.status !== 'demoted')
      .sort((a, b) => {
        const rank = (r: Recipe) => (r.status === 'validated' ? 1 : 0);
        return rank(b) - rank(a) || b.stats.successes - a.stats.successes || Number(Boolean(a.seeded)) - Number(Boolean(b.seeded));
      })[0] ?? null
  );
}

export interface RecognizedComponent {
  family: ComponentFamily;
  root: ElementHandle;
}

/**
 * Which component (if any) the target element sits inside: nearest matching
 * ancestor, first family in FAMILIES order wins.
 */
export async function recognize(locator: Locator): Promise<RecognizedComponent | null> {
  let el: ElementHandle | null = null;
  try {
    el = await locator.elementHandle({ timeout: 1_500 });
  } catch {
    return null;
  }
  if (!el) return null;
  for (const family of FAMILIES) {
    try {
      const rootHandle = await el.evaluateHandle((node, sel) => (node as Element).closest(sel), family.root);
      const root = rootHandle.asElement();
      if (root) return { family, root };
    } catch {
      // malformed selector / detached node — try the next family
    }
  }
  return null;
}

/** The component annotation recorded on a step, for recipe compilation. */
export interface StepComponent {
  family: string;
  /** CSS path of the acted-on element relative to the component root ('' = root). */
  rel: string;
}

/**
 * In-page component tagging for the recorder: one evaluate, all families.
 * Returns the first matching family and the element's root-relative path.
 */
export async function tagComponent(locator: Locator): Promise<StepComponent | null> {
  let el: ElementHandle | null = null;
  try {
    el = await locator.elementHandle({ timeout: 1_000 });
  } catch {
    return null;
  }
  if (!el) return null;
  try {
    return await el.evaluate((node, families) => {
      for (const f of families) {
        const root = (node as Element).closest(f.root);
        if (!root) continue;
        const segs: string[] = [];
        let n: Element | null = node as Element;
        while (n && n !== root) {
          const parent: Element | null = n.parentElement;
          if (!parent) break;
          const tag = n.tagName.toLowerCase();
          const same = Array.from(parent.children).filter((c) => c.tagName === n!.tagName);
          segs.unshift(`${tag}:nth-of-type(${same.indexOf(n) + 1})`);
          n = parent;
        }
        return { family: f.id, rel: segs.join(' > ') };
      }
      return null;
    }, FAMILIES.map((f) => ({ id: f.id, root: f.root })));
  } catch {
    return null;
  }
}

const RECIPE_STEP_TIMEOUT_MS = 3_000;

async function stepHandle(root: ElementHandle, target: string | undefined): Promise<ElementHandle | null> {
  if (!target) return root;
  return root.$(target);
}

/** Run a recipe's steps against a recognized component root. Throws on a step that cannot run. */
export async function executeRecipe(page: Page, root: ElementHandle, recipe: Recipe, payload: string): Promise<void> {
  for (const s of recipe.steps) {
    const text = s.text?.split('{{value}}').join(payload);
    const withText = s.withText?.split('{{value}}').join(payload);
    switch (s.action) {
      case 'click': {
        if (s.target?.startsWith('page:')) {
          let loc = page.locator(s.target.slice(5));
          if (withText) loc = loc.filter({ hasText: withText });
          await loc.first().click({ timeout: RECIPE_STEP_TIMEOUT_MS });
        } else {
          const h = await stepHandle(root, s.target);
          if (!h) throw new Error(`recipe ${recipe.id}: no "${s.target}" inside the component`);
          await h.click({ timeout: RECIPE_STEP_TIMEOUT_MS });
        }
        break;
      }
      case 'press':
        await page.keyboard.press(String(s.key ?? ''));
        break;
      case 'insertText':
        await page.keyboard.insertText(text ?? '');
        break;
      case 'fill': {
        const h = await stepHandle(root, s.target);
        if (!h) throw new Error(`recipe ${recipe.id}: no "${s.target}" inside the component`);
        await h.fill(text ?? '', { timeout: RECIPE_STEP_TIMEOUT_MS });
        break;
      }
      case 'blur': {
        const h = await stepHandle(root, s.target);
        await h?.evaluate((el) => (el as HTMLElement).blur?.());
        break;
      }
      case 'settle':
        await page.waitForTimeout(s.ms ?? 300);
        break;
    }
  }
}

/** Normalise for containment checks: monaco renders spaces as NBSP, editors rewrap lines. */
function squashText(s: string): string {
  return s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Read the component's effective value through the recipe's verification read. */
export async function readComponentValue(root: ElementHandle, recipe: Recipe): Promise<string | null> {
  try {
    const node = recipe.verifyRead ? await root.$(recipe.verifyRead) : root;
    if (!node) return null;
    return await node.evaluate((el) => {
      const anyEl = el as HTMLInputElement;
      if (typeof anyEl.value === 'string') return anyEl.value;
      return (el as HTMLElement).innerText ?? el.textContent ?? '';
    });
  } catch {
    return null;
  }
}

/**
 * The honesty rule made structural: the recipe only succeeded if the
 * component's effective value re-observes the payload. A recipe that cannot
 * prove its effect reports failure and the caller falls back.
 */
export async function verifyRecipe(root: ElementHandle, recipe: Recipe, payload: string): Promise<boolean> {
  const value = await readComponentValue(root, recipe);
  if (value === null) return false;
  if (!payload) return true;
  return squashText(value).includes(squashText(payload));
}

/**
 * The tool-layer entry point: attempt the intent through a stored recipe.
 * Returns the tool result string on VERIFIED success, or null so the caller
 * falls back to the naive primitive (and then the model). Every attempt is
 * folded into the recipe's lifecycle.
 */
export async function tryRecipe(
  page: Page,
  target: Locator,
  intent: RecipeIntent,
  payload: string,
  store: ComponentStore = new ComponentStore(),
): Promise<string | null> {
  let rec: RecognizedComponent | null;
  try {
    rec = await recognize(target);
  } catch {
    return null;
  }
  if (!rec) return null;
  const recipe = pickRecipe(store.list(), rec.family.id, intent);
  if (!recipe) return null;
  const origin = originOf(page.url()) ?? 'unknown';
  try {
    await executeRecipe(page, rec.root, recipe, payload);
    const ok = await verifyRecipe(rec.root, recipe, payload);
    store.recordOutcome(recipe.id, ok, origin);
    if (!ok) return null;
    const verb = intent === 'select-option' ? 'selected' : 'filled';
    return `${verb} via recipe ${rec.family.id}/${intent} (${recipe.id}); value verified on the component`;
  } catch {
    store.recordOutcome(recipe.id, false, origin);
    return null;
  }
}

/** Family root selectors present on the page right now (one evaluate). */
export async function componentsOnPage(page: Page): Promise<ComponentFamily[]> {
  try {
    const present: string[] = await page.evaluate(
      (sels) => sels.filter((s) => Boolean(document.querySelector(s))),
      FAMILIES.map((f) => f.root),
    );
    return FAMILIES.filter((f) => present.includes(f.root));
  } catch {
    return [];
  }
}

/** The `[components]` line for the inner agent's instruction context. */
export function renderComponents(families: ComponentFamily[], store: ComponentStore = new ComponentStore()): string {
  if (!families.length) return '';
  const recipes = store.list();
  const parts = families
    .map((f) => {
      const intents = [...new Set(recipes.filter((r) => r.family === f.id && r.status !== 'demoted').map((r) => r.intent))];
      return intents.length ? `${f.id} (${intents.join(', ')})` : '';
    })
    .filter(Boolean);
  if (!parts.length) return '';
  return `[components] recognized widgets on this page: ${parts.join('; ')} — fill/type/select on elements inside them automatically use a stored, self-verifying recipe. Prefer plain fill/type/select over manual keyboard work there.`;
}

const MAX_RECIPE_STEPS = 8;
const MIN_RECIPE_STEPS = 2;
const RECIPE_TOOLS = new Set(['click', 'dblclick', 'fill', 'type', 'press']);

/**
 * Compile recipes from a recording: a maximal run of consecutive
 * agent-chosen steps (never replayed ones) inside ONE component family,
 * carrying a payload the instruction names (so it can be parameterised),
 * becomes a provisional set-value recipe. Conservative by construction:
 * bounded length, action primitives only, payload required.
 */
export function compileRecipes(
  entries: RecordedEntry[],
  instruction: string,
  opts: { session: string; now?: string } = { session: '' },
): Recipe[] {
  const steps = entries.filter((e): e is RecordedStep => e.k === 'step');
  const out: Recipe[] = [];
  let i = 0;
  while (i < steps.length) {
    const fam = steps[i].component?.family;
    if (!fam || steps[i].via || !RECIPE_TOOLS.has(steps[i].tool)) {
      i++;
      continue;
    }
    let j = i;
    while (j < steps.length && steps[j].component?.family === fam && !steps[j].via && RECIPE_TOOLS.has(steps[j].tool)) j++;
    const run = steps.slice(i, j);
    i = j;
    if (run.length < MIN_RECIPE_STEPS || run.length > MAX_RECIPE_STEPS) continue;
    // The payload: a typed value the instruction names, exactly once.
    const payload = run
      .map((s) => (s.tool === 'fill' ? String(s.args.value ?? '') : s.tool === 'type' ? String(s.args.text ?? '') : ''))
      .find((v) => v.trim().length >= 2 && countTokenOccurrences(instruction, v.trim()) === 1);
    if (!payload) continue;
    const family = familyOf(fam);
    if (!family) continue;
    const recipeSteps: RecipeStep[] = run.map((s) => {
      const rel = s.component?.rel || undefined;
      switch (s.tool) {
        case 'click':
        case 'dblclick':
          return { action: 'click', ...(rel ? { target: rel } : {}) };
        case 'press':
          return { action: 'press', key: String(s.args.key ?? '') };
        case 'type':
          return { action: 'insertText', text: String(s.args.text ?? '').split(payload).join('{{value}}') };
        case 'fill':
        default:
          return { action: 'fill', ...(rel ? { target: rel } : {}), text: String(s.args.value ?? '').split(payload).join('{{value}}') };
      }
    });
    recipeSteps.push({ action: 'settle', ms: 300 });
    const now = opts.now ?? new Date().toISOString();
    out.push({
      id: `r_${crypto.createHash('sha1').update(`${fam}\nset-value\n${JSON.stringify(recipeSteps)}\n${now}`).digest('hex').slice(0, 6)}`,
      family: fam,
      intent: 'set-value',
      steps: recipeSteps,
      ...(family.verifyRead ? { verifyRead: family.verifyRead } : {}),
      status: 'provisional',
      stats: { uses: 0, successes: 0, origins: {}, failStreak: 0, created: now },
      provenance: { session: opts.session, instruction, created: now },
    });
  }
  return out;
}

/** Store compiled recipes that are not structural duplicates of existing ones. */
export function learnRecipes(
  store: ComponentStore,
  entries: RecordedEntry[],
  instruction: string,
  session: string,
  now?: string,
): string[] {
  const compiled = compileRecipes(entries, instruction, { session, now });
  if (!compiled.length) return [];
  const existing = store.list();
  const skeleton = (r: Recipe) => `${r.family}\n${r.intent}\n${JSON.stringify(r.steps)}`;
  const seen = new Set(existing.map(skeleton));
  const stored: string[] = [];
  for (const r of compiled) {
    if (seen.has(skeleton(r))) continue;
    seen.add(skeleton(r));
    store.put(r);
    stored.push(r.id);
  }
  return stored;
}
