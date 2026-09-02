/** `text` cut to `max` characters with an ellipsis, or unchanged when it fits. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}
