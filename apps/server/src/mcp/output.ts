import { MCP_OUTPUT_MAX_CHARACTERS } from '@orchestrator/protocol';

// What keeps a reading tool's output under Claude Code's MCP output limit (06, section 4.1): whole
// items while they fit, and a single text above the budget cut at a line boundary with a marker
// saying how much was left out (owner's decision, lot 2 step K).

/** Characters of `value` as JSON text, which is how the agent receives it (06, section 1). */
export function jsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * `text` cut at a line boundary so that it is at most `max` characters with its marker; the text
 * itself when it fits. The marker names the characters left out and where to read them.
 */
export function cutAtLine(text: string, max: number, where: string): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  let kept = '';
  for (const line of lines) {
    const next = kept === '' ? line : `${kept}\n${line}`;
    // Room for the marker, whose length grows with the number it gives.
    if (next.length + 200 > max) break;
    kept = next;
  }
  const left = text.length - kept.length;
  const marker = `[Cut here: ${String(left)} more characters are not shown because the answer would be too long for you. ${where}]`;
  return kept === '' ? marker : `${kept.trimEnd()}\n\n${marker}`;
}

/**
 * The items of a page that fit `budget` characters along with `overhead` characters of the rest
 * of the output: at least one, then more while they fit, at most `maxItems`.
 */
export function fitPage<T>(
  items: readonly T[],
  overhead: number,
  maxItems = Number.POSITIVE_INFINITY,
  budget = MCP_OUTPUT_MAX_CHARACTERS,
): T[] {
  const page: T[] = [];
  let used = overhead;
  for (const item of items) {
    if (page.length >= maxItems) break;
    const size = jsonLength(item) + 1;
    if (page.length > 0 && used + size > budget) break;
    page.push(item);
    used += size;
  }
  return page;
}

/**
 * `text` cut with `cutAtLine` so that `measure` of the result is at most `budget`: JSON escapes
 * (a line break is two characters) make the output longer than the text, so the cut is repeated
 * with the overflow taken off.
 */
export function cutToFit(
  text: string,
  budget: number,
  where: string,
  measure: (candidate: string) => number,
): string {
  let max = text.length;
  for (;;) {
    const candidate = cutAtLine(text, max, where);
    const size = measure(candidate);
    if (size <= budget || max <= 0) return candidate;
    max -= size - budget;
  }
}
