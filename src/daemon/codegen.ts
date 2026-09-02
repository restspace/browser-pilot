import { q, type RecordedEntry, type RecordedStep } from './recorder.js';

export interface CodegenOptions {
  /** Session the recording came from; used for the test title and header. */
  session: string;
  /** Overrides the generated test title. */
  title?: string;
}

/**
 * Render recorded steps as a standalone `@playwright/test` spec.
 *
 * The output is a starting point, not a finished test: locators come from the
 * live DOM at record time and are flagged where they could not be verified, and
 * the agent's read-backs are emitted as commented-out assertions, since a read
 * the agent used to orient itself is not necessarily something worth asserting.
 */
export function generateScript(entries: RecordedEntry[], opts: CodegenOptions): string {
  const steps = entries.filter((e): e is RecordedStep => e.k === 'step');
  const unverified = steps.filter((s) => Object.values(s.locators).some((l) => !l.verified)).length;

  const out: string[] = [
    "import { expect, test } from '@playwright/test';",
    '',
    `// Recorded by sleep-walker from session "${opts.session}".`,
    `// ${steps.length} action(s) across ${entries.filter((e) => e.k === 'instruction').length} instruction(s).`,
    '// Locators were resolved from the live page at record time and replayed to confirm',
    '// they matched the element that was acted on. Review before committing:',
    unverified
      ? `// ${unverified} step(s) carry an unverified locator and are marked TODO below.`
      : '// every locator below was verified unique against the recorded element.',
    '// Read-backs the agent made are emitted as commented-out assertions.',
    '',
    `test(${q(opts.title ?? `${opts.session} (recorded)`)}, async ({ page }) => {`,
  ];

  const ctx: Ctx = { downloads: 0 };
  let inStep = false;
  const indent = () => (inStep ? '    ' : '  ');

  for (const entry of entries) {
    if (entry.k === 'report') continue;
    if (entry.k === 'instruction') {
      if (inStep) out.push('  });', '');
      out.push(`  await test.step(${q(entry.text)}, async () => {`);
      inStep = true;
      continue;
    }
    for (const line of emitStep(entry, ctx)) out.push(line ? indent() + line : '');
  }
  if (inStep) out.push('  });');
  out.push('});', '');
  return out.join('\n');
}

interface Ctx {
  downloads: number;
}

/** One recorded step as zero or more lines of test source (comments included). */
function emitStep(step: RecordedStep, ctx: Ctx): string[] {
  const { tool, args } = step;
  const out: string[] = [];

  const loc = (key: 'target' | 'source'): string | null => {
    const l = step.locators[key];
    if (!l) return null;
    if (!l.expr) {
      out.push(`// TODO: no durable selector for ${tool} on ${JSON.stringify(l.raw)} — fill this in by hand.`);
      return null;
    }
    if (!l.verified) {
      out.push(`// TODO: unverified locator (recorded from ${JSON.stringify(l.raw)}) — confirm it is right.`);
    }
    return l.expr;
  };

  const str = (key: string, fallback = '') => String(args[key] ?? fallback);
  const num = (key: string): number | undefined =>
    typeof args[key] === 'number' ? (args[key] as number) : undefined;

  switch (tool) {
    case 'goto':
      out.push(`await page.goto(${q(str('url'))});`);
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
      out.push(`await page.evaluate(${q(str('expression'))});`);
      return out;
    case 'screenshot':
      out.push(
        `await page.screenshot({ path: ${q(args.path ? str('path') : 'screenshot.jpg')}${
          args.full_page ? ', fullPage: true' : ''
        } });`,
      );
      return out;
    case 'dialog_expect': {
      const action = args.action === 'accept' ? 'accept' : 'dismiss';
      const arg = action === 'accept' && args.prompt_text ? q(str('prompt_text')) : '';
      const count = num('count') ?? 1;
      if (count > 1) out.push(`// armed for ${count} dialogs at record time — using page.on, not page.once.`);
      out.push(`page.${count > 1 ? 'on' : 'once'}('dialog', (dialog) => dialog.${action}(${arg}));`);
      return out;
    }
    case 'tabs':
      // Multi-page flows need a real page handle; emitting one silently would
      // rewrite every later `page.` line, so leave the hand-off explicit.
      if (typeof args.switch_to === 'number') {
        out.push(`// TODO: the agent switched to tab ${args.switch_to} here.`);
        out.push(`// const page${args.switch_to} = page.context().pages()[${args.switch_to}];`);
      }
      return out;
    case 'press':
      if (!args.target) {
        out.push(`await page.keyboard.press(${q(str('key'))});`);
        return out;
      }
      break;
    default:
      break;
  }

  const target = loc('target');
  if (!target) return out;

  switch (tool) {
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
      out.push(`await ${target}.fill(${q(str('value'))});`);
      break;
    case 'type': {
      const delay = num('delay_ms');
      out.push(
        `await ${target}.pressSequentially(${q(str('text'))}${delay === undefined ? '' : `, { delay: ${delay} }`});`,
      );
      break;
    }
    case 'press':
      out.push(`await ${target}.press(${q(str('key'))});`);
      break;
    case 'select':
      out.push(`await ${target}.selectOption({ label: ${q(str('option'))} });`);
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
      const savePath = args.save_path
        ? q(str('save_path'))
        : `\`downloads/\${download${n}.suggestedFilename()}\``;
      out.push(`await download${n}.saveAs(${savePath});`);
      break;
    }
    case 'drag': {
      const source = loc('source');
      if (source) out.push(`await ${source}.dragTo(${target});`);
      break;
    }
    case 'wait_for':
      out.push(waitForLine(target, args, num('timeout_ms')));
      break;
    case 'read':
    case 'read_all':
      out.push(...readAssertion(target, step));
      break;
    default:
      out.push(`// unhandled recorded tool: ${tool} ${JSON.stringify(args)}`);
  }
  return out;
}

function waitForLine(target: string, args: Record<string, unknown>, timeout?: number): string {
  // Only a non-default timeout is worth carrying over; Playwright's own default
  // applies otherwise.
  const only = timeout && timeout !== 10_000 ? `{ timeout: ${timeout} }` : '';
  const opt = only ? `, ${only}` : '';
  switch (String(args.state)) {
    case 'visible':
      return `await expect(${target}).toBeVisible(${only});`;
    case 'hidden':
      return `await expect(${target}).toBeHidden(${only});`;
    case 'text_equals':
      return `await expect(${target}).toHaveText(${q(String(args.text ?? ''))}${opt});`;
    case 'text_contains':
      return `await expect(${target}).toContainText(${q(String(args.text ?? ''))}${opt});`;
    case 'count':
      return `await expect(${target}).toHaveCount(${Number(args.count ?? 0)}${opt});`;
    default:
      return `// unhandled wait_for state: ${String(args.state)}`;
  }
}

/**
 * A read is an observation, not necessarily an assertion — the agent reads to
 * decide what to do next as often as to verify. Emit the assertion it *would*
 * make, commented out, so keeping it is one edit and dropping it is one delete.
 */
function readAssertion(target: string, step: RecordedStep): string[] {
  const { args, result, tool } = step;
  if (result === undefined) return [];
  const what = String(args.what);
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return [`// observed: ${tool} ${what} → ${result.slice(0, 120)}`];
  }
  const all = tool === 'read_all';

  if (what === 'url') return [`// await expect(page).toHaveURL(${q(String(value))});`];
  if (what === 'count') return [`// await expect(${target}).toHaveCount(${Number(value)});`];
  if (what === 'attr') {
    return all
      ? [`// observed attribute ${String(args.attr)} across matches: ${JSON.stringify(value).slice(0, 200)}`]
      : [`// await expect(${target}).toHaveAttribute(${q(String(args.attr))}, ${q(String(value))});`];
  }
  const matcher = what === 'value' ? 'toHaveValue' : 'toHaveText';
  if (all && Array.isArray(value)) {
    const items = value.map((v) => q(String(v))).join(', ');
    return [`// await expect(${target}).${matcher}([${items}]);`];
  }
  return [`// await expect(${target}).${matcher}(${q(String(value))});`];
}
