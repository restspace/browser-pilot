import type { Locator } from 'playwright-core';

/**
 * React-safe input helpers (friction #5). Plain `locator.fill()` bypasses the
 * native value setter, so React controlled components never see the change
 * (or number inputs end up appending). We set the value through the native
 * prototype setter and dispatch input/change so React's synthetic event
 * system picks it up. Invisible to the agent: `fill` just works.
 */
export async function reactSafeFill(locator: Locator, value: string): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5_000 }).catch(() => {}); // focus; some widgets need it
  const handled = await locator.evaluate((el, val) => {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    if (!('value' in input)) return false;
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : input instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    if (!proto) return false;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) return false;
    setter.call(input, ''); // clear-then-set: number inputs otherwise append
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, value);
  if (!handled) {
    // contenteditable or non-standard widget — fall back to Playwright fill
    await locator.fill(value);
  }
}

/**
 * Select an option and fire change through the native setter, for React
 * controlled <select> elements.
 */
export async function reactSafeSelect(locator: Locator, value: string): Promise<string[]> {
  const result = await locator.selectOption({ label: value }).catch(() => null);
  if (result) return result;
  return locator.selectOption(value); // fall back to value/index matching
}

/**
 * Hover with synthetic mouse events for autocomplete/listbox widgets that key
 * off mouseenter rather than CSS :hover.
 */
export async function syntheticHover(locator: Locator): Promise<void> {
  await locator.hover().catch(() => {});
  await locator.evaluate((el) => {
    for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter' }));
    }
  });
}

/**
 * HTML5 drag-and-drop fallback: dispatch a full dragstart/dragover/drop
 * sequence with a shared DataTransfer, for libraries that implement DnD on
 * the HTML5 events with custom payloads (where Playwright's mouse-based
 * dragTo doesn't trigger the drop handler).
 */
export async function html5DragDrop(source: Locator, target: Locator): Promise<void> {
  const page = source.page();
  const sourceHandle = await source.elementHandle();
  const targetHandle = await target.elementHandle();
  if (!sourceHandle || !targetHandle) throw new Error('drag source or target not found');
  await page.evaluate(
    ([src, dst]) => {
      const dataTransfer = new DataTransfer();
      const fire = (el: Element, type: string) => {
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            dataTransfer,
          }),
        );
      };
      fire(src, 'dragstart');
      fire(dst, 'dragenter');
      fire(dst, 'dragover');
      fire(dst, 'drop');
      fire(src, 'dragend');
    },
    [sourceHandle, targetHandle] as const,
  );
}
