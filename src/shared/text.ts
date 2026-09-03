/** `text` cut to `max` characters with an ellipsis, or unchanged when it fits. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

/**
 * Clock and calendar tokens are the RECORDING's moment, not part of what a
 * page element IS: kanboard names its due-date textbox after the current
 * minute ("09/03/2026 07:22") and labels a summary row "Due date:
 * 12/31/2026 07:40". Recorded verbatim, such a name matches nothing nine
 * minutes later. maskVolatile() turns each token into the `{{*}}` wildcard
 * for stored expectations; volatileMatcher() turns a recorded locator name
 * into a RegExp that treats the same tokens as wildcards.
 */
export const WILDCARD = '{{*}}';
const VOLATILE_TOKEN = /\b\d{1,2}:\d{2}(?::\d{2})?\b|\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/g;

export function maskVolatile(line: string): string {
  return line.replace(VOLATILE_TOKEN, WILDCARD);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The recorded string itself when it carries no volatile token, else an
 * anchored RegExp in which each token matches any token of the same shape —
 * another time, another date — and nothing else, so the rest of the name is
 * still matched exactly.
 */
const TOKEN_SHAPE = '(?:\\d{1,2}:\\d{2}(?::\\d{2})?|\\d{1,4}[/.-]\\d{1,2}[/.-]\\d{1,4})';
export function volatileMatcher(text: string): string | RegExp {
  const masked = maskVolatile(text);
  if (masked === text) return text;
  return new RegExp(`^${masked.split(WILDCARD).map(escapeRe).join(TOKEN_SHAPE)}$`);
}
