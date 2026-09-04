import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import type { BrowserSession } from '../daemon/browser.js';
import { clip } from '../shared/text.js';
import { captureSignature, diffSignatures, type PageSignature } from '../daemon/diff.js';
import { html5DragDrop, reactSafeFill, reactSafeSelect, syntheticHover } from '../daemon/inputs.js';
import { tryRecipe } from '../skills/components.js';
import { resolveSecretsDeep, scrubSecrets, scrubSecretsDeep } from '../shared/secrets.js';
import { resolveTarget, snapshot, truncate } from '../daemon/refs.js';
import { fingerprintPage } from '../daemon/fingerprint.js';
import { isRecordable, type StepDiff } from '../daemon/recorder.js';
import { urlPattern as compiledUrlPattern } from '../skills/compile.js';
import { renderReplay, replaySkill, type ReplayResult } from '../skills/replay.js';
import type { ToolDef } from './llm.js';

const TARGET = {
  type: 'string',
  description: 'Element target: an @ref from the latest snapshot (e.g. "@e12") or a CSS selector.',
} as const;

const TOOL_RESULT_BUDGET = 4000;

/**
 * Tools whose result gets a `[state: …]` summary of what the action changed on
 * the page, so the agent does not spend a turn observing what it just did.
 * goto/back already report the new url and title; read-only tools change
 * nothing worth diffing.
 */
const STATE_CHANGING = new Set([
  'click', 'dblclick', 'modifier_click', 'right_click', 'fill', 'type', 'press',
  'select', 'check', 'drag', 'upload',
]);

/** Beat given to async renders (React, in-flight fetches) before the after-capture. */
const SETTLE_MS = 150;
/** Tools whose effect may be a navigation the app performs on the answer to a request. */
const NAVIGATING = new Set(['click', 'dblclick', 'press', 'submit', 'select']);
/** How long a click's late navigation is given before its effect is captured as final. */
const LATE_NAV_MS = 1_500;

const MAX_BATCH_STEPS = 10;

/**
 * Tools a batch may contain: mechanical actions and cheap checks whose outcome
 * the agent does not need to see before choosing the next step. Everything else
 * (navigation, snapshot/eval/screenshot output, report, nested batch) either
 * feeds a decision or produces output that only makes sense on its own turn.
 */
const BATCHABLE = new Set([
  'click', 'dblclick', 'modifier_click', 'right_click', 'fill', 'type', 'press',
  'select', 'check', 'hover', 'scroll_into_view', 'wait_for', 'read', 'read_all',
  'upload', 'dialog_expect',
]);

/** Per-step lines stay short so a long batch still reads at a glance. */
const BATCH_STEP_CHARS = 160;
const BATCH_STEP_ERROR_CHARS = 300;

/** A combined diff spans several actions, so it may list more churn than one action's. */
const BATCH_LINE_BUDGET = 20;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'snapshot',
    description:
      'Accessibility snapshot of the current page with @ref handles for elements. Returns interactive/labelled elements only by default (what you need to pick something to act on); pass full:true for the complete tree including static text nodes. Call after navigation or DOM changes; refs from older snapshots go stale. For a specific value prefer read/read_all over a full tree.',
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Include non-interactive text nodes too (default false = interactive/labelled elements only).' },
        selector: { type: 'string', description: 'Scope the snapshot to this CSS selector.' },
      },
    },
  },
  {
    name: 'click',
    description: 'Click an element.',
    parameters: { type: 'object', required: ['target'], properties: { target: TARGET } },
  },
  {
    name: 'dblclick',
    description: 'Double-click an element.',
    parameters: { type: 'object', required: ['target'], properties: { target: TARGET } },
  },
  {
    name: 'modifier_click',
    description: 'Click while holding modifier keys (e.g. Shift/Control-click gestures).',
    parameters: {
      type: 'object',
      required: ['target', 'modifiers'],
      properties: {
        target: TARGET,
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['Shift', 'Control', 'Alt', 'Meta'] },
        },
      },
    },
  },
  {
    name: 'right_click',
    description: 'Right-click (context menu) an element.',
    parameters: { type: 'object', required: ['target'], properties: { target: TARGET } },
  },
  {
    name: 'fill',
    description:
      'Set the full value of an input/textarea. React-safe: works on controlled components and number inputs (clears first). Use for text fields; use select for <select>. A {{env:NAME}} secret marker in value is resolved at execution time — pass it through verbatim.',
    parameters: {
      type: 'object',
      required: ['target', 'value'],
      properties: { target: TARGET, value: { type: 'string' } },
    },
  },
  {
    name: 'type',
    description: 'Type text key-by-key into an element (triggers per-keystroke handlers, e.g. autocomplete). A {{env:NAME}} secret marker in text is resolved at execution time — pass it through verbatim.',
    parameters: {
      type: 'object',
      required: ['target', 'text'],
      properties: {
        target: TARGET,
        text: { type: 'string' },
        delay_ms: { type: 'number', description: 'Delay between keystrokes (default 20).' },
      },
    },
  },
  {
    name: 'press',
    description: 'Press a key or chord (e.g. "Enter", "Escape", "Control+a") on an element or the page.',
    parameters: {
      type: 'object',
      required: ['key'],
      properties: { key: { type: 'string' }, target: { ...TARGET, description: TARGET.description + ' Optional; defaults to the focused element.' } },
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a <select>, matching by visible label first, then by value.',
    parameters: {
      type: 'object',
      required: ['target', 'option'],
      properties: { target: TARGET, option: { type: 'string' } },
    },
  },
  {
    name: 'check',
    description: 'Set a checkbox/radio to checked or unchecked.',
    parameters: {
      type: 'object',
      required: ['target'],
      properties: { target: TARGET, checked: { type: 'boolean', description: 'Default true.' } },
    },
  },
  {
    name: 'hover',
    description: 'Hover an element (also dispatches synthetic mouseover/enter for JS-driven menus).',
    parameters: { type: 'object', required: ['target'], properties: { target: TARGET } },
  },
  {
    name: 'scroll_into_view',
    description: 'Scroll an element into view.',
    parameters: { type: 'object', required: ['target'], properties: { target: TARGET } },
  },
  {
    name: 'drag',
    description:
      'Drag one element onto another. Tries a real mouse drag, then falls back to synthetic HTML5 drag events (dragstart/dragover/drop with a DataTransfer).',
    parameters: {
      type: 'object',
      required: ['source', 'target'],
      properties: {
        source: { ...TARGET, description: 'Element to drag. ' + TARGET.description },
        target: { ...TARGET, description: 'Drop target. ' + TARGET.description },
      },
    },
  },
  {
    name: 'wait_for',
    description:
      'Wait for a condition on a selector: visible, hidden, text_equals, text_contains, or count. Use this instead of sleeping or polling. Returns immediately if the condition already holds. Use count/text only for a value you expect to CHANGE — counting rendered rows is unreliable on virtualised lists (only visible rows exist in the DOM), so wait on a stable indicator instead.',
    parameters: {
      type: 'object',
      required: ['target', 'state'],
      properties: {
        target: TARGET,
        state: { type: 'string', enum: ['visible', 'hidden', 'text_equals', 'text_contains', 'count'] },
        text: { type: 'string', description: 'Expected text for text_equals/text_contains.' },
        count: { type: 'number', description: 'Expected element count for count.' },
        timeout_ms: { type: 'number', description: 'Default 10000.' },
      },
    },
  },
  {
    name: 'read',
    description:
      'Read text/value/attribute from ONE element — much cheaper than a full snapshot for spot checks. ' +
      'The target must match exactly one element, or the read fails: a snapshot ref (@e123) always does, ' +
      'and a bare tag like "h1" usually does not. Use read_all to read every match, or what=count to count them. ' +
      'If the value matters beyond this glance — a reference, id, name, or total the task or a later step will use — ' +
      'pass `label` NOW: a labelled value is published under that name automatically; an unlabelled one stays anonymous. ' +
      'what=url reads the current page URL (no target) — the way to report where a record lives.',
    parameters: {
      type: 'object',
      required: ['what'],
      properties: {
        target: TARGET,
        what: { type: 'string', enum: ['text', 'value', 'attr', 'count', 'url'] },
        attr: { type: 'string', description: 'Attribute name when what=attr.' },
        label: {
          type: 'string',
          description:
            'Name for this value, the way a person would say it: order_reference, unit_price, customer_name. Later steps address the value by this name.',
        },
      },
    },
  },
  {
    name: 'read_all',
    description:
      'Like read, but returns a JSON array of the value across EVERY element matching the selector — read a whole list of rows/cells in one call instead of many. what: text (visible text of each), value (input value of each), attr (an attribute of each), or count.',
    parameters: {
      type: 'object',
      required: ['target', 'what'],
      properties: {
        target: TARGET,
        what: { type: 'string', enum: ['text', 'value', 'attr', 'count'] },
        attr: { type: 'string', description: 'Attribute name when what=attr.' },
      },
    },
  },
  {
    name: 'eval',
    description:
      'Escape hatch: run a JavaScript expression in the page and return its JSON-serialised result. Prefer the dedicated tools.',
    parameters: {
      type: 'object',
      required: ['expression'],
      properties: { expression: { type: 'string', description: 'JS expression or IIFE body, e.g. "document.title".' } },
    },
  },
  {
    name: 'fetch_source',
    description:
      "Fetch the raw HTTP response body for a URL (default: the current page's URL) using the browser's cookies, WITHOUT executing JavaScript. This is the SERVER-RENDERED source — every other tool shows the live post-hydration DOM instead. Use it before making any claim about what the server sent, and to tell an SSR bug (element missing from the source) apart from a hydration bug (present in the source, absent live).",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute or page-relative URL; defaults to the current page URL.' },
        contains: {
          type: 'string',
          description:
            'Return only the lines containing this substring (plus a match count) instead of the whole body — use it on large documents to check for a specific element.',
        },
      },
    },
  },
  {
    name: 'goto',
    description: 'Navigate the current tab to a URL and wait for load.',
    parameters: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
  },
  {
    name: 'back',
    description: 'Go back one history entry.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tabs',
    description: 'List open tabs, or switch the active tab by index.',
    parameters: {
      type: 'object',
      properties: { switch_to: { type: 'number', description: 'Tab index to make active; omit to just list.' } },
    },
  },
  {
    name: 'upload',
    description: 'Set files on a file input.',
    parameters: {
      type: 'object',
      required: ['target', 'paths'],
      properties: { target: TARGET, paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' } },
    },
  },
  {
    name: 'download',
    description: 'Click an element and capture the download it triggers; saves to the session downloads dir (or save_path).',
    parameters: {
      type: 'object',
      required: ['target'],
      properties: { target: TARGET, save_path: { type: 'string' } },
    },
  },
  {
    name: 'set_viewport',
    description: 'Resize the viewport.',
    parameters: {
      type: 'object',
      required: ['width', 'height'],
      properties: { width: { type: 'number' }, height: { type: 'number' } },
    },
  },
  {
    name: 'set_offline',
    description: 'Toggle network offline mode.',
    parameters: { type: 'object', required: ['offline'], properties: { offline: { type: 'boolean' } } },
  },
  {
    name: 'screenshot',
    description: 'Save a screenshot to disk and return its path (for evidence; you cannot see images).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, full_page: { type: 'boolean' } },
    },
  },
  {
    name: 'dialog_expect',
    description:
      'Arm handling for native dialogs (alert/confirm/prompt) triggered by your NEXT action: accept or dismiss, with optional prompt text. Call BEFORE the click that opens the dialog. Captured dialog messages are returned in that action\'s result.',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss'] },
        prompt_text: { type: 'string', description: 'Text to enter if the dialog is a prompt().' },
        count: { type: 'number', description: 'How many dialogs to cover (default 1).' },
      },
    },
  },
  {
    name: 'batch',
    description:
      'Execute several actions in ONE call when you already know each next step with certainty (e.g. filling a form you have just seen, then submitting it). Steps run in order and stop at the first error; the result lists each step\'s outcome, which steps did not run, and ONE combined [state: …] summary. Do not batch across a judgment point — anything whose outcome you must see before deciding the next action.',
    parameters: {
      type: 'object',
      required: ['steps'],
      properties: {
        steps: {
          type: 'array',
          minItems: 2,
          description: `Ordered steps, 2-${MAX_BATCH_STEPS}. A single-step batch is pointless — call the tool directly instead.`,
          items: {
            type: 'object',
            required: ['tool', 'args'],
            properties: {
              tool: { type: 'string', enum: [...BATCHABLE] },
              args: { type: 'object', description: "That tool's own arguments." },
            },
          },
        },
      },
    },
  },
  {
    name: 'run_skill',
    description:
      'Replay a stored procedure listed under [skills] in the instruction, deterministically and without further reasoning: every recorded step runs in order with its parameters filled in, stopping at the first step that no longer works. Returns each step\'s outcome and every value read back from the live page. If it stops part-way, the steps that ran HAVE changed the page — observe, then continue from there yourself. Call it as your FIRST action when a listed procedure matches the instruction.',
    parameters: {
      type: 'object',
      required: ['id', 'params'],
      properties: {
        id: { type: 'string', description: 'The skill id shown in the [skills] list, e.g. "s_9f2a1b".' },
        params: {
          type: 'object',
          description: 'Values for every {{vN}} slot in the skill template, taken from the instruction (e.g. {"v1": "x7 RD Part A", "v2": "100"}).',
        },
      },
    },
  },
  {
    name: 'report',
    description:
      'REQUIRED final call: report the outcome of the instruction. Nothing after this is executed. Keep summary to one short paragraph.',
    parameters: {
      type: 'object',
      required: ['status', 'summary'],
      properties: {
        status: { type: 'string', enum: ['success', 'failure', 'blocked'] },
        summary: { type: 'string', description: 'One concise paragraph: what happened and what was verified.' },
        details: { type: 'string', description: 'Optional extra detail (errors seen, workaround used).' },
        evidence: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            capturedDialogs: { type: 'array', items: { type: 'string' } },
            values: {
              type: 'object',
              description:
                'Every concrete value you read off the page, as name -> value. ' +
                'ALWAYS include any reference the APP assigned to a record you created or opened ' +
                '(an order number, ticket ref, uid, generated id) — later work addresses that record by it, ' +
                'and a value left only in the summary prose cannot be used. Names should be ones a person would ' +
                'write (order_reference, unit_price), not selector fragments.',
            },
          },
        },
      },
    },
  },
];

export interface ToolExecution {
  result: string;
  isError: boolean;
  /** Present for run_skill: what the replay did, for the loop's accounting. */
  replay?: ReplayResult;
}

/** Tool definitions for a session: run_skill only exists when a skill store is attached. */
export function toolDefsFor(session: BrowserSession): ToolDef[] {
  return session.learn ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.name !== 'run_skill');
}

/**
 * Execute one tool call against the live browser session. Always returns a
 * string result (errors included) so the loop can hand it back to the model.
 * Captured native dialogs are appended to whichever tool result follows them.
 */
export async function executeTool(
  session: BrowserSession,
  name: string,
  args: Record<string, unknown>,
  screenshotDir: string,
  /** Cancels cooperative waits (wait_for polling) when the caller's deadline expires. */
  signal?: AbortSignal,
): Promise<ToolExecution> {
  try {
    // Inside the guard: a dead browser (getPage throwing) must come back as
    // an error result the loop can report, never a rejection that ends the
    // instruction with no report and a dangling user message.
    if (name === 'batch') return await executeBatch(session, args, screenshotDir, signal);
    if (name === 'run_skill') return await executeSkill(session, args, screenshotDir, signal);
    const diffing = STATE_CHANGING.has(name) ? await session.getPage().catch(() => null) : null;
    const before: PageSignature | null = diffing ? await captureSignature(diffing) : null;
    const { result } = await runStep(session, name, args, screenshotDir, signal, { before });
    const stateNote = diffing && before ? scrubSecrets(await stateDiff(diffing, before)) : '';
    return {
      result: truncate(result + stateNote + dialogNote(session), TOOL_RESULT_BUDGET + 8200),
      isError: false,
    };
  } catch (err) {
    return { result: truncate(`ERROR: ${explainError(err, args)}`, TOOL_RESULT_BUDGET), isError: true };
  }
}

/**
 * Replay a stored skill as one tool call. The replay goes through runStep
 * for every step, so each replayed action is recorded exactly like an
 * agent-chosen one — which is what lets a replay-then-repair be compiled into
 * a variant afterwards. A refusal (wrong page, missing params) is an error
 * result; a part-way stop is not, since the page has changed.
 */
async function executeSkill(
  session: BrowserSession,
  args: Record<string, unknown>,
  screenshotDir: string,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const store = session.learn;
  if (!store) return { result: 'ERROR: no skill store is attached to this session.', isError: true };
  const id = String(args.id ?? '').trim();
  const skill = id ? store.get(id) : null;
  if (!skill) return { result: `ERROR: unknown skill ${JSON.stringify(id)} — use an id from the [skills] list.`, isError: true };
  const rawParams = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? (args.params as Record<string, unknown>) : {};
  const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, String(v ?? '')]));

  const page = await session.getPage();
  const before = await captureSignature(page);
  // The replay stays on its page: a replayed click that opens a tab (a
  // recorded stray click on a target=_blank link) must not move it.
  const replay = await session.withPinnedPage(page, () =>
    replaySkill(skill, params, {
      page,
      signal,
      exec: async (tool, stepArgs, resolved, via) => runStep(session, tool, stepArgs, screenshotDir, signal, { resolved, via }),
    }),
  );
  // Mechanism 2 (PLAN-replay-v2): a url segment that soft-matched and was
  // then walked PAST has demonstrated volatility — generalise exactly that
  // segment in the stored pattern, permanently. Segments that never vary stay
  // exact. A soft match the replay did NOT get past stays unconfirmed.
  const confirmed = replay.generalisations.filter((g) =>
    g.kind === 'precondition' ? replay.stepsRun >= 1 : replay.ok || (g.step !== undefined && replay.stepsRun > g.step),
  );
  if (confirmed.length) {
    const fresh = store.get(skill.id);
    if (fresh) {
      let changed = false;
      for (const g of confirmed) {
        if (g.kind === 'precondition') {
          fresh.preconditions.urlPattern = g.pattern;
          changed = true;
        } else if (g.step !== undefined) {
          const st = fresh.steps[g.step - 1];
          if (st && st.tool !== 'loop' && st.expect?.urlPattern) {
            st.expect.urlPattern = g.pattern;
            changed = true;
          }
        }
      }
      if (changed) store.put(fresh);
    }
  }
  const stateNote = before && replay.stepsRun ? scrubSecrets(await stateDiff(page, before, BATCH_LINE_BUDGET)) : '';
  const body = scrubSecrets(renderReplay(skill, replay)) + stateNote + dialogNote(session);
  return { result: truncate(body, TOOL_RESULT_BUDGET + 8200), isError: Boolean(replay.refused), replay };
}

interface StepOptions {
  /** Signature captured by the caller before the action, to avoid a second capture. */
  before?: PageSignature | null;
  /** Replay: locators already resolved through a skill's chain. */
  resolved?: Record<string, Locator>;
  via?: { skill: string; step: number };
}

/**
 * One tool call with its recording, and nothing else: no dialog drain. Shared
 * by the single-tool path, by every step of a batch, and by skill replay.
 * In learning mode a per-step page diff is captured around state-changing
 * steps and stored with the recording — that is what becomes a replayed
 * step's expectation.
 */
async function runStep(
  session: BrowserSession,
  name: string,
  args: Record<string, unknown>,
  screenshotDir: string,
  signal?: AbortSignal,
  opts: StepOptions = {},
): Promise<{ result: string; diff?: StepDiff }> {
  // Describe the targets BEFORE acting: a click can navigate or unmount the
  // element, and a recorder that runs afterwards has nothing left to describe.
  // Recording never fails a run — a broken capture just means a missing step.
  const recorder = session.script;
  const page = recorder || session.learn ? await session.getPage() : null;
  const pending =
    recorder && page && isRecordable(name)
      ? await recorder.prepare(page, name, args, opts.resolved).catch(() => null)
      : null;
  const wantDiff = Boolean(session.learn) && page && STATE_CHANGING.has(name);
  const before = wantDiff ? (opts.before ?? (await captureSignature(page!))) : null;
  // Secrets ({{env:NAME}}) resolve HERE and only here — after the recorder
  // captured the marker-bearing args above, immediately before the browser
  // needs the real value. Everything persisted or shown to the model keeps
  // the marker; scrubbing below catches values the page echoes back.
  const result = scrubSecrets(await dispatch(session, name, resolveSecretsDeep(args), screenshotDir, signal, opts.resolved));
  let diff: StepDiff | undefined;
  let fingerprintAfter: number[] | undefined;
  if (wantDiff && before) {
    let after = await settledSignature(page!);
    // A click that starts a request and routes on its answer looks finished
    // while the request is in flight: the DOM is quiet and the url is still
    // the old one. fwat2's sign-in was recorded that way — expected url "/"
    // and an added "Logging in..." button — and the replay, which arrived at
    // the landing page, could match neither. Give a late navigation a moment
    // before the effect is taken as final; a step that changed the url
    // already, or changes nothing, pays nothing.
    if (after && NAVIGATING.has(name) && after.url === before.url) {
      const deadline = Date.now() + LATE_NAV_MS;
      while (Date.now() < deadline && page!.url() === before.url) await new Promise((r) => setTimeout(r, 100));
      if (page!.url() !== before.url) after = await settledSignature(page!);
    }
    if (after) {
      diff = scrubSecretsDeep({
        url: after.url,
        alerts: after.alerts.filter((a) => !before.alerts.includes(a)),
        added: after.lines.filter((l) => !before.lines.includes(l)).slice(0, 20),
      });
      // The step crossed a page-template seam (its url pattern changed):
      // fingerprint the new page so compile can split a skill here and gate
      // the next segment on the page it actually runs on.
      if (compiledUrlPattern(after.url) !== compiledUrlPattern(before.url)) {
        fingerprintAfter = (await fingerprintPage(page!)) ?? undefined;
      }
    }
  }
  recorder?.commit(pending, result, { diff, via: opts.via, fingerprintAfter });
  return { result, diff };
}

async function settledSignature(page: Page): Promise<PageSignature | null> {
  try {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    return await captureSignature(page);
  } catch {
    return null;
  }
}

function explainError(err: unknown, args: Record<string, unknown>): string {
  const message = err instanceof Error ? err.message.split('\nCall log:')[0] : String(err);
  if (/strict mode violation/i.test(message)) {
    // Playwright's raw strict-mode error dumps every matched element; replace
    // it with a concise, one-step-fixable hint so the agent disambiguates
    // instead of burning a turn discovering the syntax.
    const n = /resolved to (\d+) elements/.exec(message)?.[1] ?? 'multiple';
    const sel = JSON.stringify(args.target ?? args.source ?? '');
    return `selector ${sel} matched ${n} elements — refine it, or append " >> nth=0" (nth=N for another) to target exactly one.`;
  }
  return message;
}

/** Dialogs captured since the last drain, as a trailing note (or ''). */
function dialogNote(session: BrowserSession): string {
  const dialogs = session.dialogs.drain();
  return dialogs.length
    ? '\n[native dialogs: ' +
        dialogs.map((d) => `${d.type}(${JSON.stringify(d.message)}) → ${d.action}`).join('; ') +
        ']'
    : '';
}

interface BatchStep {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Run an ordered list of known-next actions in one turn, stopping at the first
 * error, with a single combined state diff. Validation is total and happens
 * before anything runs, so a typo in step 4 cannot leave steps 1-3 applied.
 *
 * isError is true only when NOTHING ran: a batch that got partway through has
 * changed the page, and flagging that as an error would read to the agent as
 * "no effect" — the per-step lines carry the partial outcome instead.
 */
async function executeBatch(
  session: BrowserSession,
  args: Record<string, unknown>,
  screenshotDir: string,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  const fail = (message: string): ToolExecution => ({
    result: truncate(`ERROR: ${message}`, TOOL_RESULT_BUDGET),
    isError: true,
  });

  const raw = args.steps;
  if (!Array.isArray(raw)) return fail('batch requires a "steps" array.');
  if (raw.length < 2) {
    return fail('batch requires at least 2 steps — for a single action, call that tool directly.');
  }
  if (raw.length > MAX_BATCH_STEPS) {
    return fail(
      `batch accepts at most ${MAX_BATCH_STEPS} steps (got ${raw.length}) — split it into several batches. Nothing was executed.`,
    );
  }

  const steps: BatchStep[] = [];
  for (const [i, entry] of raw.entries()) {
    const step = entry as { tool?: unknown; args?: unknown };
    const tool = typeof step?.tool === 'string' ? step.tool : '';
    if (!BATCHABLE.has(tool)) {
      return fail(
        `step ${i + 1}: ${tool ? `"${tool}" cannot be used inside a batch` : 'missing "tool"'} — allowed tools are ${[...BATCHABLE].join(', ')}. Nothing was executed; re-issue without that step.`,
      );
    }
    const stepArgs = step.args;
    if (stepArgs !== undefined && (typeof stepArgs !== 'object' || stepArgs === null || Array.isArray(stepArgs))) {
      return fail(`step ${i + 1}: "args" must be an object. Nothing was executed.`);
    }
    steps.push({ tool, args: (stepArgs ?? {}) as Record<string, unknown> });
  }

  const page = await session.getPage().catch(() => null);
  const before: PageSignature | null = page ? await captureSignature(page) : null;

  const lines: string[] = [];
  const notes: string[] = [];
  let ran = 0;
  let failedAt = -1;

  for (const [i, step] of steps.entries()) {
    if (signal?.aborted) {
      notes.push(`[batch stopped: instruction budget exhausted; ${notRun(i, steps.length)}]`);
      break;
    }
    const head = `${i + 1}. ${step.tool} ${summarize(step.args)} → `;
    try {
      const { result } = await runStep(session, step.tool, step.args, screenshotDir, signal);
      lines.push(head + clip(result, BATCH_STEP_CHARS) + dialogNote(session).replace(/^\n/, ' '));
      ran++;
    } catch (err) {
      lines.push(
        head + 'ERROR: ' + clip(explainError(err, step.args), BATCH_STEP_ERROR_CHARS) +
          dialogNote(session).replace(/^\n/, ' '),
      );
      failedAt = i;
      const remaining = notRun(i + 1, steps.length);
      notes.push(`[stopped at step ${i + 1}${remaining ? `; ${remaining}` : ''}]`);
      break;
    }
  }

  const stateNote = page && before && (ran || failedAt >= 0) ? scrubSecrets(await stateDiff(page, before, BATCH_LINE_BUDGET)) : '';
  const body = [...lines, ...notes].join('\n') + stateNote;
  // Nothing ran at all — either the first step failed or the budget expired
  // before it started; that IS an error result.
  if (!ran) return { result: truncate(body || 'ERROR: batch ran no steps.', TOOL_RESULT_BUDGET + 8200), isError: true };
  return { result: truncate(body, TOOL_RESULT_BUDGET + 8200), isError: false };
}

/** "steps 4-5 not run" for the tail starting at index `from`, or '' if none. */
function notRun(from: number, total: number): string {
  if (from >= total) return '';
  return from === total - 1 ? `step ${total} not run` : `steps ${from + 1}-${total} not run`;
}

function summarize(args: Record<string, unknown>): string {
  return clip(JSON.stringify(args), 80);
}

/**
 * Summary of what the just-executed action changed, as `\n[state: …]`, or ''
 * if it could not be determined. The action already succeeded by the time this
 * runs, so nothing here may throw — a missing diff is the failure mode.
 */
async function stateDiff(page: Page, before: PageSignature, lineBudget?: number): Promise<string> {
  try {
    // One settle beat: DOM updates are usually async. Genuinely slow updates
    // are still wait_for's job — the diff is a hint, not proof.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const after = await captureSignature(page);
    return after ? `\n[state: ${diffSignatures(before, after, lineBudget)}]` : '';
  } catch {
    return '';
  }
}

async function dispatch(
  session: BrowserSession,
  name: string,
  args: Record<string, unknown>,
  screenshotDir: string,
  signal?: AbortSignal,
  /** Replay: pre-resolved locators that override args.target / args.source. */
  resolved?: Record<string, Locator>,
): Promise<string> {
  if (signal?.aborted) throw new Error('cancelled before starting: instruction budget exhausted');
  const page = await session.getPage();
  const t = (key = 'target') => resolved?.[key] ?? resolveTarget(page, String(args[key]));
  const timeout = 10_000;

  switch (name) {
    case 'snapshot':
      return snapshot(page, {
        interactiveOnly: args.full !== true,
        selector: args.selector ? String(args.selector) : undefined,
      });

    case 'click':
      return robustClick(t(), { timeout });
    case 'dblclick':
      return robustClick(t(), { timeout, dbl: true });
    case 'modifier_click': {
      // Validate BEFORE clicking: a missing list used to click plainly and
      // then throw on the result, so the model repeated a click that landed.
      const modifiers = args.modifiers;
      if (!Array.isArray(modifiers) || !modifiers.length) throw new Error('modifier_click needs a non-empty modifiers list (Shift, Control, Alt, Meta); use click for a plain click');
      await t().click({ timeout, modifiers: modifiers as ('Shift' | 'Control' | 'Alt' | 'Meta')[] });
      return `clicked with ${(modifiers as string[]).join('+')}`;
    }
    case 'right_click':
      await t().click({ timeout, button: 'right' });
      return 'right-clicked';

    case 'fill': {
      // Component recipes (PLAN-component-recipes): a target inside a
      // recognized widget (monaco, CodeMirror, contenteditable, ...) gets the
      // family's stored, self-verifying recipe instead of the naive fill —
      // which is known to lie on these widgets. Falls back to the naive path
      // when nothing is recognized or the recipe cannot verify its effect.
      const viaRecipe = await tryRecipe(page, t(), 'set-value', String(args.value ?? ''));
      if (viaRecipe) return viaRecipe;
      await reactSafeFill(t(), String(args.value ?? ''));
      return 'filled';
    }
    case 'type': {
      const viaRecipe = await tryRecipe(page, t(), 'set-value', String(args.text ?? ''));
      if (viaRecipe) return viaRecipe;
      await t().pressSequentially(String(args.text ?? ''), {
        timeout,
        delay: typeof args.delay_ms === 'number' ? args.delay_ms : 20,
      });
      return 'typed';
    }
    case 'press':
      if (args.target) await t().press(String(args.key), { timeout });
      else await page.keyboard.press(String(args.key));
      return `pressed ${args.key}`;
    case 'select': {
      const viaRecipe = await tryRecipe(page, t(), 'select-option', String(args.option ?? ''));
      if (viaRecipe) return viaRecipe;
      const selected = await reactSafeSelect(t(), String(args.option));
      return `selected ${JSON.stringify(selected)}`;
    }
    case 'check':
      if (args.checked === false) await t().uncheck({ timeout });
      else await t().check({ timeout });
      return args.checked === false ? 'unchecked' : 'checked';
    case 'hover':
      await syntheticHover(t());
      return 'hovered';
    case 'scroll_into_view':
      await t().scrollIntoViewIfNeeded({ timeout });
      return 'scrolled into view';

    case 'drag': {
      const source = t('source');
      const target = t('target');
      try {
        await source.dragTo(target, { timeout });
        return 'dragged (mouse)';
      } catch {
        await html5DragDrop(source, target);
        return 'dragged (synthetic HTML5 drag events fallback)';
      }
    }

    case 'wait_for':
      return waitFor(page, args, signal);

    case 'read': {
      // The page URL is an observation with no element behind it: a record's
      // address is often the only durable handle on it (the grafana flow
      // could name every panel yet had no way to publish the dashboard uid).
      if (args.what === 'url') return JSON.stringify(page.url());
      if (typeof args.target !== 'string' || !args.target.trim()) throw new Error(`read ${String(args.what)} needs a target (only what=url reads without one)`);
      const loc = t();
      // `count` asks HOW MANY, so plural is the answer, not an error.
      if (args.what === 'count') return String(await loc.count());
      // Every ACTION already insists on a unique target: click and fill hand
      // the locator to Playwright, whose strict mode throws on an ambiguous
      // match, and the agent answers that by naming something specific. A
      // singular read was the one exception — it took `.first()` of however
      // many matched, silently.
      //
      // That is the fwod24 defect end to end. `read text h1` matched three
      // headings on Odoo's form; we returned the first, and the recorder,
      // seeing a count that was not 1, stored the locator with NO alternates
      // (describeTarget bails before it derives any). The flow then threaded
      // that value through eleven references. On both replays resolveChain
      // met the same ambiguity, refused to guess which heading — correctly,
      // since picking wrong reads another record's number — and had no
      // fallback to try, so four of seven steps dropped to the model.
      //
      // Recording was accepting exactly what replay would refuse. Closing
      // that costs about two turns per recording (9 of 54 singular reads
      // across five recorded runs were ambiguous, three of them this bug),
      // and the agent already has a unique-by-construction answer it reaches
      // for unprompted in half of all reads: a snapshot ref.
      //
      // read_all stays plural. Reading every price in a table is the point,
      // and 14 of its 16 uses matched many by design.
      const n = await loc.count();
      if (n > 1) {
        throw new Error(
          `read matched ${n} elements for ${JSON.stringify(String(args.target))} — a read must name exactly one. ` +
            `Use a snapshot ref (@e123) for the one you mean, or a more specific selector; use read_all to read all ${n}.`,
        );
      }
      switch (args.what) {
        case 'text':
          return JSON.stringify(await loc.innerText({ timeout }));
        case 'value':
          return JSON.stringify(await loc.inputValue({ timeout }));
        case 'attr':
          return JSON.stringify(await loc.getAttribute(String(args.attr), { timeout }));
        default:
          throw new Error(`unknown read kind: ${args.what}`);
      }
    }

    case 'read_all': {
      const loc = t();
      switch (args.what) {
        case 'text':
          return JSON.stringify(await loc.allInnerTexts());
        case 'value':
          return JSON.stringify(
            await loc.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value ?? null)),
          );
        case 'attr':
          return JSON.stringify(
            await loc.evaluateAll((els, a) => els.map((e) => e.getAttribute(a)), String(args.attr)),
          );
        case 'count':
          return String(await loc.count());
        default:
          throw new Error(`unknown read_all kind: ${args.what}`);
      }
    }

    case 'eval': {
      const expression = String(args.expression ?? '');
      const mutation = evalMutation(expression);
      if (mutation) {
        throw new Error(
          `eval is read-only: the expression ${mutation}. That would run, but could never be replayed — only the dedicated tools are recorded. Use click / fill / press / select / goto instead (locate the element first if you only know its text).`,
        );
      }
      const value = await page.evaluate((expr) => {
        // eslint-disable-next-line no-eval
        return (0, eval)(expr);
      }, expression);
      return JSON.stringify(value) ?? 'undefined';
    }

    case 'fetch_source': {
      const url = new URL(args.url ? String(args.url) : page.url(), page.url()).toString();
      const res = await page.request.fetch(url, { timeout: 15_000 });
      const body = await res.text();
      const header = `HTTP ${res.status()} ${res.headers()['content-type'] ?? ''} — RAW SERVER RESPONSE for ${url} (${body.length} chars, no JavaScript executed; this is NOT the live DOM)`;
      if (args.contains) {
        const needle = String(args.contains);
        const hits = body.split('\n').filter((line) => line.includes(needle));
        return `${header}\n${hits.length} line(s) contain ${JSON.stringify(needle)}${hits.length ? ':\n' + hits.join('\n') : ''}`;
      }
      return `${header}\n${body}`;
    }

    case 'goto':
      await page.goto(String(args.url), { waitUntil: 'load', timeout: 30_000 });
      return `at ${page.url()} — "${await page.title()}"`;
    case 'back':
      await page.goBack({ timeout: 15_000 });
      return `at ${page.url()}`;

    case 'tabs': {
      if (typeof args.switch_to === 'number') {
        const switched = await session.switchToPage(args.switch_to);
        return `switched to tab ${args.switch_to}: ${switched.url()}`;
      }
      const pages = await session.listPages();
      const lines = await Promise.all(
        pages.map(async (p, i) => `${i}${p === page ? '*' : ''}: ${await p.title().catch(() => '?')} — ${p.url()}`),
      );
      return lines.join('\n') || '(no tabs)';
    }

    case 'upload':
      await t().setInputFiles((args.paths as string[]).map((p) => path.resolve(p)));
      return 'files set';

    case 'download': {
      const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
      // If the click throws, nothing awaits this promise and its own timeout
      // would surface 30s later as an unhandled rejection that kills the daemon.
      downloadPromise.catch(() => {});
      await t().click({ timeout });
      const download = await downloadPromise;
      const savePath = args.save_path
        ? path.resolve(String(args.save_path))
        : path.join(screenshotDir, download.suggestedFilename() || 'download.bin');
      await download.saveAs(savePath);
      return `downloaded to ${savePath}`;
    }

    case 'set_viewport':
      await page.setViewportSize({ width: Number(args.width), height: Number(args.height) });
      return 'viewport set';
    case 'set_offline':
      await page.context().setOffline(Boolean(args.offline));
      return args.offline ? 'offline' : 'online';

    case 'screenshot': {
      // Always encode as JPEG, regardless of what extension args.path uses —
      // callers that attach these to a vision model typically assume a fixed
      // image/jpeg media type, and Playwright infers encoding from the path
      // extension unless `type` is given explicitly, so a model choosing its
      // own filename (e.g. "confirmation.png") would otherwise silently write
      // real PNG bytes under a caller-controlled name.
      const file = args.path
        ? path.resolve(String(args.path))
        : path.join(screenshotDir, `shot-${Date.now()}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await page.screenshot({ path: file, type: 'jpeg', fullPage: Boolean(args.full_page) });
      return `screenshot saved: ${file}`;
    }

    case 'dialog_expect':
      session.dialogs.arm({
        action: args.action === 'accept' ? 'accept' : 'dismiss',
        promptText: args.prompt_text ? String(args.prompt_text) : undefined,
        remaining: typeof args.count === 'number' ? args.count : 1,
      });
      return `armed: will ${args.action} the next ${typeof args.count === 'number' ? args.count : 1} dialog(s)`;

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/**
 * Click that recovers from a covered/marginally-actionable element (friction
 * that otherwise sends the agent to a raw eval): normal click → scroll + force
 * → dispatched DOM event, reporting which path worked. A strict-mode violation
 * (selector matched many elements) is NOT swallowed — it is rethrown so the
 * caller gets the disambiguation hint rather than silently acting on .first().
 */
/**
 * Why an eval expression is refused: the page-mutating call it makes, or null.
 *
 * fwgr19 recorded its dashboard save as `btn.click()` inside an eval. The
 * step ran fine, but eval steps do not compile into skills — only the
 * dedicated tools carry locators — so the pinned skill had fill-title → wait
 * for dialog hidden with no save between them, failed there on every replay,
 * and paid 66 recovery turns per run forever. An unreplayable mutation is a
 * hole in the recording, so it is refused at the source, naming the tool to
 * use instead. Read expressions are untouched: a comparison (`el.value ===
 * x`) is not an assignment, and querying, filtering and serialising are fine.
 */
export function evalMutation(expression: string): string | null {
  const patterns: Array<[RegExp, string]> = [
    [/\.(click|submit|requestSubmit)\s*\(/, 'calls .$1()'],
    [/\.dispatchEvent\s*\(/, 'dispatches a synthetic event'],
    [/\.(value|checked|selectedIndex)\s*=(?!=)/, 'assigns .$1'],
    [/\.(innerHTML|outerHTML|textContent|innerText)\s*=(?!=)/, 'assigns .$1'],
    [/\blocation\.(href|hash)\s*=(?!=)/, 'assigns location.$1'],
    [/\blocation\.(assign|replace|reload)\s*\(/, 'navigates via location.$1()'],
    [/\bhistory\.(pushState|replaceState|back|forward|go)\s*\(/, 'navigates via history.$1()'],
    [/\.(remove|removeChild|appendChild|insertBefore|replaceChild|replaceWith)\s*\(/, 'edits the DOM with .$1()'],
    [/\.(setAttribute|removeAttribute)\s*\(/, 'edits the DOM with .$1()'],
    [/\b(localStorage|sessionStorage)\.(setItem|removeItem|clear)\s*\(/, 'writes $1'],
  ];
  for (const [re, why] of patterns) {
    const m = re.exec(expression);
    if (m) return why.replace('$1', m[1] ?? '');
  }
  return null;
}

type ClickOpts = { timeout: number; dbl?: boolean };
type ClickAct = (o: { timeout: number; force?: boolean }) => Promise<void>;

/**
 * One way to land a click. `note` is appended to the result so the agent (and
 * a post-mortem) can see which tier did the work.
 */
interface ClickTier {
  note: string;
  run: (loc: Locator, opts: ClickOpts, act: ClickAct) => Promise<void>;
}

/**
 * The tiers a click falls through, in order. Each is tried when the one
 * before it failed; the window tier (fireWhenAttached) comes last and its own
 * error is what the agent sees, because it is the only tier that can explain
 * WHY nothing landed.
 */
const CLICK_TIERS: ClickTier[] = [
  // Playwright's own click, actionability checks and all.
  { note: '', run: (_loc, opts, act) => act({ timeout: opts.timeout }) },
  // Scroll into view and skip the checks: a control under a sticky header,
  // or one an overlay covers in a way the app treats as fine.
  {
    note: ' (forced past actionability checks)',
    run: async (loc, opts, act) => {
      await loc.scrollIntoViewIfNeeded({ timeout: opts.timeout }).catch(() => {});
      await act({ timeout: opts.timeout, force: true });
    },
  },
  // A synthetic event straight at the element: React's delegated handlers see
  // it even when the element is not "clickable" by Playwright's rules.
  { note: ' (dispatched DOM event — element was not normally clickable)', run: (loc, opts) => loc.first().evaluate(fireClick, Boolean(opts.dbl)) },
];

async function robustClick(loc: Locator, opts: ClickOpts): Promise<string> {
  const label = opts.dbl ? 'double-clicked' : 'clicked';
  const act: ClickAct = (o) => (opts.dbl ? loc.dblclick(o) : loc.click(o));
  let firstFailure = '';
  for (const tier of CLICK_TIERS) {
    try {
      await tier.run(loc, opts, act);
      return `${label}${tier.note}`;
    } catch (err) {
      if (firstFailure) continue;
      firstFailure = err instanceof Error ? err.message : String(err);
      // Two or more matches is the agent's problem to fix, not a tier's.
      if (/strict mode violation/i.test(firstFailure)) throw err;
      // A control the app re-mounts on every render never passes the
      // attached→visible→stable check, and a forced click needs it attached
      // at the instant of the action just the same — so both tiers lose the
      // race and burn their full timeout (rpgr4-r2 spent 74 turns on
      // grafana's viz-picker toggle this way). Only Playwright's own detach
      // evidence sends a click straight to the window tier: its generic
      // timeout log reads "waiting for element to be visible, enabled and
      // stable" for EVERY stalled click, and matching on that routed 15
      // ordinary replay clicks per run past the tiers that had been landing
      // them (rpgr5).
      if (DETACHED.test(firstFailure)) break;
    }
  }
  return fireWhenAttached(loc, opts, label, firstFailure);
}

/** Playwright's own words for an element that left the DOM mid-action — never its generic actionability wording. */
const DETACHED = /element was detached|not attached to the DOM|element is not attached|element is not stable/i;

/** Runs in the page: a synthetic click (React's delegated handlers see it). */
function fireClick(el: Element, dbl: boolean): void {
  const fire = (type: string) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  fire('click');
  if (dbl) {
    fire('click');
    fire('dblclick');
  }
}

/**
 * Click a control that keeps re-mounting. Polls for the element and, the
 * moment a handle resolves, dispatches the click in the same tick — no
 * actionability wait at all. A flickering element is attached for a good
 * fraction of every cycle; the normal tiers never act inside that window.
 * If no window is found within the budget, the error says what the agent is
 * fighting and what to try instead of the same click again.
 */
export async function fireWhenAttached(loc: Locator, opts: { timeout: number; dbl?: boolean }, label = 'clicked', because = ''): Promise<string> {
  // The first line of the failure that sent us here rides along in the
  // result, so a post-mortem can see WHY a click took this route.
  const cause = because ? ` after: ${because.split('\n')[0].slice(0, 120)}` : '';
  const deadline = Date.now() + opts.timeout;
  let polls = 0;
  let attached = 0;
  while (Date.now() < deadline) {
    polls++;
    const handle = await loc.first().elementHandle({ timeout: 100 }).catch(() => null);
    if (handle) {
      attached++;
      try {
        await handle.evaluate(fireClick, Boolean(opts.dbl));
        return `${label} (dispatched during a re-render window${cause} — the element re-mounts continuously, so a normal click could not land; if the app did not respond, it may need a keyboard route or a wait_for on the state that settles it)`;
      } catch {
        // gone again between resolve and fire — next window
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    attached
      ? `target re-rendered continuously: attached on ${attached} of ${polls} polls but never long enough to click. The app re-mounts it on every render. Do not repeat this click — wait_for an element that appears once the state settles, or drive it by keyboard (focus a stable neighbour, Tab to it, press Enter).`
      : `target was never attached during ${Math.round(opts.timeout / 1000)}s of polling after an initial detach — it was removed by a re-render. Re-snapshot and locate it afresh rather than repeating this click.`,
  );
}

async function waitFor(
  page: Page,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const loc = resolveTarget(page, String(args.target));
  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 10_000;
  const state = String(args.state);

  if (state === 'visible' || state === 'hidden') {
    await loc.first().waitFor({ state, timeout });
    return `condition met: ${state}`;
  }

  const cancelled = () => {
    throw new Error('wait_for cancelled: instruction budget exhausted');
  };

  const deadline = Date.now() + timeout;
  let last = '';
  let firstObserved: string | null = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) cancelled();
    if (state === 'count') {
      const count = await loc.count();
      last = `count=${count}`;
      if (count === Number(args.count)) return `condition met: ${last}`;
    } else {
      const text = (await loc.first().innerText({ timeout: 1000 }).catch(() => null)) ?? '';
      last = `text=${JSON.stringify(text.slice(0, 200))}`;
      if (state === 'text_equals' && text.trim() === String(args.text).trim()) return `condition met: ${last}`;
      if (state === 'text_contains' && text.includes(String(args.text))) return `condition met: ${last}`;
    }
    if (firstObserved === null) firstObserved = last;
    // Wake early on cancellation so an abandoned wait stops polling the page
    // instead of ticking on in the background for the rest of its own timeout.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 250);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  if (signal?.aborted) cancelled();
  // If the observed value never budged, the condition is likely unsatisfiable
  // (e.g. a count wait against a virtualised list) rather than merely slow.
  const stableHint =
    firstObserved !== null && firstObserved === last
      ? ` — value never changed from ${last}, so this condition may be unsatisfiable (e.g. count against a virtualised list renders only visible rows); assert on a stable indicator instead`
      : '';
  throw new Error(`wait_for ${state} timed out after ${timeout}ms (last: ${last})${stableHint}`);
}
