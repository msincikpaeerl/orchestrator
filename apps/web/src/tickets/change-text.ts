import type {
  TicketChangeRequest,
  TicketReviewLatest,
  TicketStatus,
  TicketStop,
} from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';

// Changes after a review in the owner's words (02, sections 4 and 6.4; owner's answers 2, 6 and
// 7, lot 3 step I, and 2 to 4, step I2), made from the facts the API gives: the line in To do
// while a request stands, the review section after the owner's request on Awaiting merge, the
// Request changes dialog, and the stop with **Try again**.

/**
 * The line in To do while a request stands. Quality's request made before **Try again** or
 * **Reopen** (its round above the ticket's review rounds, which count from 0 again) has no round.
 */
export function todoRequestText(
  change: TicketChangeRequest | null,
  reviewRounds: number,
): string | null {
  if (change === null || !change.standing) return null;
  const { request } = change;
  if (request.by === 'owner') return 'Run now starts a run that addresses your request.';
  return request.round > reviewRounds
    ? "Run now starts a run that addresses Quality's points."
    : `Run now starts a run that addresses Quality's points (round ${String(request.round)} of at most ${String(change.limit)}).`;
}

/** Under the approval or the skip, while the owner's request on Awaiting merge stands. */
export function requestedAfterText(change: TicketChangeRequest | null): string | null {
  if (change === null || !change.standing || change.request.by !== 'owner') return null;
  const { after, at } = change.request;
  if (after === null) return null;
  return after === 'approved'
    ? `You requested changes after this approval, at ${formatDateTime(at)}.`
    : `You requested changes after skipping the review, at ${formatDateTime(at)}.`;
}

/** The Request changes dialog's text: on Awaiting merge, what the request comes after. */
export function requestChangesText(
  status: TicketStatus,
  latest: TicketReviewLatest | null,
): string {
  if (status !== 'awaiting_merge') {
    return 'The ticket goes back to To do with your comment. Its branch and commits are kept, and the next run continues from them with your comment in its instructions. This does not count as a failed attempt.';
  }
  const after =
    latest?.kind === 'decision'
      ? `Quality approved commit ${latest.decision.commit.slice(0, 7)}. `
      : latest?.kind === 'skipped'
        ? 'You skipped the review. '
        : '';
  return `${after}The ticket goes back to To do with your comment, and its next run addresses it; the pull request stays open.`;
}

/** The stop, the same on the ticket page and in "Needs you" (owner's answer 2, step I2). */
export function stopText(stop: Pick<TicketStop, 'cause' | 'count' | 'limit' | 'at'>): {
  title: string;
  detail: string;
  tryAgain: string;
  since: string;
} {
  const review = stop.cause === 'review_rounds';
  return {
    title: review ? 'Stopped after too many review rounds' : 'Stopped after repeated failures',
    detail: `${
      review
        ? `Quality requested changes ${String(stop.count)} times, more than Most review rounds per ticket allows (${String(stop.limit)}).`
        : `It failed ${String(stop.count)} times, more than Failed attempts before asking you allows (${String(stop.limit)}).`
    } Use Try again to let it continue, or Cancel it, or Mark it as done manually.`,
    tryAgain:
      'Try again starts no session: the review rounds and failed attempts count from 0 again, and Run now can start the next run.',
    since: `Since ${formatDateTime(stop.at)}`,
  };
}

/** The confirmation offering **Run now** after **Try again** (owner's answer 3, step I2). */
export const RUN_NOW_AFTER_TRY_AGAIN =
  'The review rounds and failed attempts count from 0 again. Start the next run now, or later from the ticket page.';
