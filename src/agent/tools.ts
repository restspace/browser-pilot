import fs from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright-core';
import type { BrowserSession } from '../daemon/browser.js';
import { captureSignature, diffSignatures, type PageSignature } from '../daemon/diff.js';
import { html5DragDrop, reactSafeFill, reactSafeSelect, syntheticHover } from '../daemon/inputs.js';
import { resolveTarget, snapshot, truncate } from '../daemon/refs.js';
import { isRecordable } from '../daemon/recorder.js';
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
      'Set the full value of an input/textarea. React-safe: works on controlled components and number inputs (clears first). Use for text fields; use select for <select>.',
    parameters: {
      type: 'object',
      required: ['target', 'value'],
      properties: { target: TARGET, value: { type: 'string' } },
    },
  },
  {
    name: 'type',
    description: 'Type text key-by-key into an element (triggers per-keystroke handlers, e.g. autocomplete).',
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
      'Read text/value/attribute/count from a selector (the first match) — much cheaper than a full snapshot for spot checks.',
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
            values: { type: 'object', description: 'Key facts the caller may need (ids, names, counts).' },
          },
        },
      },
    },
  },
];

export interface ToolExecution {
  result: string;
  isError: boolean;
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
  if (name === 'batch') return executeBatch(session, args, screenshotDir, signal);
  try {
    const diffing = STATE_CHANGING.has(name) ? await session.getPage().catch(() => null) : null;
    const before: PageSignature | null = diffing ? await captureSignature(diffing) : null;
    const result = await runStep(session, name, args, screenshotDir, signal);
    const stateNote = diffing && before ? await stateDiff(diffing, before) : '';
    return {
      result: truncate(result + stateNote + dialogNote(session), TOOL_RESULT_BUDGET + 8200),
      isError: false,
    };
  } catch (err) {
    return { result: truncate(`ERROR: ${explainError(err, args)}`, TOOL_RESULT_BUDGET), isError: true };
  }
}

/**
 * One tool call with its recording, and nothing else: no diff, no dialog
 * drain. Shared by the single-tool path and by every step of a batch, which
 * needs the same recording behaviour but only ONE combined diff at the end.
 */
async function runStep(
  session: BrowserSession,
  name: string,
  args: Record<string, unknown>,
  screenshotDir: string,
  signal?: AbortSignal,
): Promise<string> {
  // Describe the targets BEFORE acting: a click can navigate or unmount the
  // element, and a recorder that runs afterwards has nothing left to describe.
  // Recording never fails a run — a broken capture just means a missing step.
  const recorder = session.script;
  const pending =
    recorder && isRecordable(name)
      ? await recorder.prepare(await session.getPage(), name, args).catch(() => null)
      : null;
  const result = await dispatch(session, name, args, screenshotDir, signal);
  recorder?.commit(pending, result);
  return result;
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
      const result = await runStep(session, step.tool, step.args, screenshotDir, signal);
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

  const stateNote = page && before && (ran || failedAt >= 0) ? await stateDiff(page, before, BATCH_LINE_BUDGET) : '';
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

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '…';
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
): Promise<string> {
  if (signal?.aborted) throw new Error('cancelled before starting: instruction budget exhausted');
  const page = await session.getPage();
  const t = (key = 'target') => resolveTarget(page, String(args[key]));
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
    case 'modifier_click':
      await t().click({ timeout, modifiers: args.modifiers as ('Shift' | 'Control' | 'Alt' | 'Meta')[] });
      return `clicked with ${(args.modifiers as string[]).join('+')}`;
    case 'right_click':
      await t().click({ timeout, button: 'right' });
      return 'right-clicked';

    case 'fill':
      await reactSafeFill(t(), String(args.value ?? ''));
      return 'filled';
    case 'type':
      await t().pressSequentially(String(args.text ?? ''), {
        timeout,
        delay: typeof args.delay_ms === 'number' ? args.delay_ms : 20,
      });
      return 'typed';
    case 'press':
      if (args.target) await t().press(String(args.key), { timeout });
      else await page.keyboard.press(String(args.key));
      return `pressed ${args.key}`;
    case 'select': {
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
      const source = resolveTarget(page, String(args.source));
      const target = resolveTarget(page, String(args.target));
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
      const loc = t().first();
      switch (args.what) {
        case 'text':
          return JSON.stringify(await loc.innerText({ timeout }));
        case 'value':
          return JSON.stringify(await loc.inputValue({ timeout }));
        case 'attr':
          return JSON.stringify(await loc.getAttribute(String(args.attr), { timeout }));
        case 'count':
          return String(await t().count());
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
async function robustClick(loc: Locator, opts: { timeout: number; dbl?: boolean }): Promise<string> {
  const label = opts.dbl ? 'double-clicked' : 'clicked';
  const act = (o: { timeout: number; force?: boolean }) => (opts.dbl ? loc.dblclick(o) : loc.click(o));
  try {
    await act({ timeout: opts.timeout });
    return label;
  } catch (first) {
    if (/strict mode violation/i.test(first instanceof Error ? first.message : String(first))) throw first;
    await loc.scrollIntoViewIfNeeded({ timeout: opts.timeout }).catch(() => {});
    try {
      await act({ timeout: opts.timeout, force: true });
      return `${label} (forced past actionability checks)`;
    } catch {
      await loc.first().evaluate((el, dbl) => {
        const fire = (type: string) =>
          el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        fire('click');
        if (dbl) {
          fire('click');
          fire('dblclick');
        }
      }, Boolean(opts.dbl));
      return `${label} (dispatched DOM event — element was not normally clickable)`;
    }
  }
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
