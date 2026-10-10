import type { ReviewDecision } from '@orchestrator/protocol';
import type { Template } from '../agents/files.js';
import { fill, part } from '../agents/messages.js';
import { PULL_REQUEST_BODY_MAX_LENGTH, harmless } from './pull-request-text.js';

// Quality's comment review on GitHub (06, section 4.5; owner's answer 3, lot 3 step H), from the
// template `agents/templates/review-comment.md`. The agent's text is masked and made harmless as
// the pull request's description; each path sits in a code span it cannot close. The body ends
// with a mark GitHub does not show, by which a post whose answer was lost is found (step H3).

/**
 * The longest body: GitHub documents none for a review; the pull request description's (A27) is
 * used.
 */
export const REVIEW_BODY_MAX_LENGTH = PULL_REQUEST_BODY_MAX_LENGTH;

/** The hidden mark of the review posted for a run. The agent's `<` is escaped: it cannot forge one. */
export function reviewMark(runId: string): string {
  return `<!-- orchestrator-review run=${runId} -->`;
}

/** Finds a mark in a review's body; the first group is the run's id. */
export const REVIEW_MARK_PATTERN = /<!-- orchestrator-review run=([0-9a-f-]{36}) -->/;

export interface ReviewCommentInput {
  decision: ReviewDecision;
  /** `BAK-12`. */
  number: string;
  link: { url: string; loopback: boolean };
  runId: string;
}

/** `text` in a code span: a fence longer than any run of backticks in it. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(longest + 1);
  return longest === 0 ? `${fence}${text}${fence}` : `${fence} ${text} ${fence}`;
}

/**
 * `text` within `length`, cut at its last line break that leaves room for the marker (or where it
 * must, when it has none), the marker on a line of its own.
 */
function cutAtLine(text: string, length: number, marker: string): string {
  if (text.length <= length) return text;
  const room = length - marker.length - 1;
  if (room <= 0) return '';
  const head = text.slice(0, room);
  const lineEnd = head.lastIndexOf('\n');
  const kept = lineEnd > 0 ? head.slice(0, lineEnd) : head.replace(/[\ud800-\udbff]$/, '');
  return `${kept.trimEnd()}\n${marker}`;
}

/** A point's later lines indented under its number, so the list stays one item per point. */
function indented(text: string): string {
  return text.replace(/\n/g, '\n   ');
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

/** The comment review's body, at most `maxLength` characters, the mark included. */
export function reviewCommentBody(
  template: Template,
  input: ReviewCommentInput,
  maxLength = REVIEW_BODY_MAX_LENGTH,
): string {
  const { decision } = input;
  const commit = decision.commit.slice(0, 7);
  const approved = decision.kind === 'approved';
  const number = harmless(input.number);
  const link = input.link.loopback
    ? part(template, 'link-loopback', { url: input.link.url })
    : input.link.url;
  const heading = approved
    ? part(template, 'heading-approved', { commit })
    : part(template, 'heading-changes', { commit, count: plural(decision.points.length, 'point') });
  const footer = part(template, approved ? 'footer-approved' : 'footer-changes', { number, link });
  const marker = part(template, 'cut');
  const mark = reviewMark(input.runId);
  const whole = (text: string) =>
    `${fill(template, template.main, { heading, text, footer })}\n\n${mark}`;
  // What the text may take: the body less everything around it.
  const room = maxLength - whole('').length;

  if (approved) return whole(cutAtLine(harmless(decision.summary ?? ''), room, marker));

  const points = decision.points.map((point, index) => {
    const text = harmless(point.body);
    const values = { index: String(index + 1), text };
    if (point.file === null) return { values, file: null };
    const where = `${point.file}${point.line === null ? '' : `:${String(point.line)}`}`;
    return { values, file: codeSpan(harmless(where)) };
  });
  const line = (point: (typeof points)[number], text = point.values.text) =>
    indented(
      point.file === null
        ? part(template, 'point', { ...point.values, text })
        : part(template, 'point-file', { ...point.values, text, file: point.file }),
    );
  const more = (left: number) =>
    left === 0 ? '' : `\n${part(template, 'more-points', { more: plural(left, 'more point') })}`;
  const kept: string[] = [];
  for (const [index, point] of points.entries()) {
    const after = more(points.length - index - 1);
    const next = [...kept, line(point)].join('\n');
    if (next.length + after.length <= room) {
      kept.push(line(point));
      continue;
    }
    if (kept.length === 0) {
      // One point too long to fit alone is cut like the summary (owner's answer 4c, step H3).
      // Indenting adds to each line kept: the longest cut that fits, searched.
      const cutTo = (cap: number) => line(point, cutAtLine(point.values.text, cap, marker));
      let low = 0;
      let high = room;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (cutTo(middle).length + after.length <= room) low = middle;
        else high = middle - 1;
      }
      return whole(cutTo(low) + after);
    }
    return whole(kept.join('\n') + more(points.length - index));
  }
  return whole(kept.join('\n'));
}
