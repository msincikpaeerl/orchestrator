// Budgets of a submission's facts and of a run's end report (04, section 8; lot 3 step F). They
// share out `DAEMON_MESSAGE_MAX_BYTES`, the transport limit both sides know before any setting is
// exchanged, so that a `ticket_submit` and an end report always fit in one message: code
// constants, not settings, for the same reason as that limit. Each part is measured on its JSON
// encoding, the form it travels in, so a character JSON escapes counts for its escape.

const KIB = 1024;

/** The DoD report an agent sends with `ticket_submit`; a larger one is refused by the daemon. */
export const SUBMISSION_REPORT_MAX_BYTES = 256 * KIB;

/** A branch report's commits (`commitsAhead`): the newest that fit, all counted elsewhere. */
export const BRANCH_REPORT_COMMITS_MAX_BYTES = 256 * KIB;

/** A commit's subject in a branch report, cut with a marker. */
export const COMMIT_SUBJECT_MAX_CHARACTERS = 1_000;

/** The files a branch changed (`changedFiles.listed`): the first that fit, all counted. */
export const CHANGED_FILES_MAX_BYTES = 256 * KIB;

/** A failed push's message, keeping its end (GitHub's and Git's last lines say why). */
export const PUSH_MESSAGE_MAX_CHARACTERS = 4_000;

/** Each plain-words text of an end report: its detail and the restored Git configuration. */
export const END_REPORT_TEXT_MAX_CHARACTERS = 2_000;

/** Longest branch name the daemon is given or reports (Git's limit for one ref file name). */
export const GIT_BRANCH_NAME_MAX_CHARACTERS = 255;

/** Longest run token: the server makes 47-character ones. */
export const RUN_TOKEN_MAX_CHARACTERS = 200;

/** Ends (or starts) a text that was cut. */
export const CUT_MARKER = '…';

const encoder = new TextEncoder();

/** Bytes of `value`'s JSON encoding, as it travels on the daemon connection. */
export function encodedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * `text` in at most `max` characters (UTF-16 units, as Zod counts them), never splitting a
 * surrogate pair. A cut text keeps its start and ends with the marker, or keeps its end and
 * starts with it.
 */
export function cutText(text: string, max: number, keep: 'start' | 'end' = 'start'): string {
  if (text.length <= max) return text;
  const room = max - CUT_MARKER.length;
  if (keep === 'start') {
    const part = text.slice(0, room);
    return (/[\uD800-\uDBFF]$/.test(part) ? part.slice(0, -1) : part) + CUT_MARKER;
  }
  const part = text.slice(text.length - room);
  return CUT_MARKER + (/^[\uDC00-\uDFFF]/.test(part) ? part.slice(1) : part);
}

/** The first `items`, in their order, whose JSON array fits in `maxBytes`. */
export function fitList<T>(items: readonly T[], maxBytes: number): T[] {
  let bytes = 2;
  const kept: T[] = [];
  for (const item of items) {
    const size = encodedBytes(item) + (kept.length > 0 ? 1 : 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.push(item);
  }
  return kept;
}
