import type {
  NeedsYouItem,
  ReviewDecision,
  ReviewEnd,
  ReviewStart,
  RunReview,
  TicketReview,
  WorkflowFlag,
} from '@orchestrator/protocol';
import { formatDate, formatDateTime } from '../github/text';
import { downloadReason } from '../runs/download-text';
import { REVIEWS_OFF, failureText } from '../runs/text';
import { sentence } from '../projects/text';
import { ticketRef } from './text';

// Reviews in the owner's words (02, sections 4, 6.4 and 7; owner's answers 2 to 5, lot 3 steps H
// and H4), made from the facts the API gives: "Ready for review", "Review did not finish", the
// ticket page's review section and the run page's review card. The post's note is in
// `review-post-text.ts`.

export const REVIEW_COST =
  'A review by Quality uses one Claude Code session; Skip review uses none.';

/**
 * Whether the review starts by itself (02, sections 4 and 6.4; lot 4 step D3), said after the
 * cost: the scheduler's promise, or what waits for the owner.
 */
export const reviewStartText: Record<ReviewStart, string> = {
  by_itself:
    'The review starts by itself as soon as a machine and its Claude account can take it. Start review starts it now; Skip review before then if you want none.',
  held: 'The review does not start by itself: you stopped its review run. Start review starts it again.',
  not_finished:
    'The review does not start again by itself after a review that did not finish: use Start review to try again, or Skip review.',
  switch_off: REVIEWS_OFF,
};

function short(commit: string): string {
  return commit.slice(0, 7);
}

function points(count: number): string {
  return `${String(count)} point${count === 1 ? '' : 's'}`;
}

/**
 * The CI line of "Ready for review" (owner's answer 4, lot 3 step H) and of a pull request to
 * merge (step J4a): with workflow files changed, "No CI found" says it in the same sentence.
 */
export function ciLine(
  ci: 'passed' | 'passed_later' | 'no_ci',
  fullCommit: string,
  checkedAgainAt: string | null,
  workflowFlag: WorkflowFlag | null,
): string {
  const commit = short(fullCommit);
  const again =
    checkedAgainAt === null ? '' : ` (checked again by you at ${formatDateTime(checkedAgainAt)})`;
  if (ci === 'no_ci') {
    return workflowFlag === 'changed'
      ? `No CI found for commit ${commit}${again}, and this work changed files under .github/workflows/: it may have removed or weakened CI. Read them before reviewing or merging.`
      : `No CI found for commit ${commit}${again}`;
  }
  return `CI passed on GitHub for commit ${commit}${again}`;
}

/** The workflow line, on its own unless the CI line already says it. */
export function workflowLine(flag: WorkflowFlag | null, saidWithCi: boolean): string | null {
  if (flag === null || saidWithCi) return null;
  const look = 'Look at them on the pull request before reviewing or merging.';
  return flag === 'changed'
    ? `Workflow files changed: this work changes files under .github/workflows/, which decide what CI checks on GitHub. ${look}`
    : `Workflow files may have changed: the list of files this work changed was cut or not sent, so a change under .github/workflows/ cannot be ruled out. ${look}`;
}

export function readyForReviewText(item: Extract<NeedsYouItem, { type: 'ready_for_review' }>): {
  title: string;
  ci: string;
  workflows: string | null;
  cost: string;
  start: string;
} {
  return {
    title: `Ready for review: ${ticketRef(item.ticket.projectKey, item.ticket.number)} ${item.ticket.title}`,
    ci: ciLine(item.ci, item.commit, item.checkedAgainAt, item.workflowFlag),
    workflows: workflowLine(
      item.workflowFlag,
      item.ci === 'no_ci' && item.workflowFlag === 'changed',
    ),
    cost: REVIEW_COST,
    start: reviewStartText[item.start],
  };
}

/** Why a review run ended without a decision (answer 5): the end of a sentence. */
function withoutDecision(end: ReviewEnd, machine: string): string {
  switch (end.why) {
    case 'gave_up':
      return end.reason === null || end.reason.trim() === ''
        ? 'Quality gave up'
        : `Quality gave up: ${end.reason.trim().replace(/\.$/, '')}`;
    case 'moved_before_start':
      return `the pull request changed on GitHub before the review started${end.head === null ? '' : ` (now ${short(end.head)})`}`;
    case 'moved_on_github':
      return `the pull request changed on GitHub during the review${end.head === null ? '' : ` (now ${short(end.head)})`}`;
    case 'moved_on_machine':
      return 'the branch changed on the machine during the review';
    case 'stopped':
      return 'you stopped the run';
    case 'download_failed':
      return `the project could not be downloaded from GitHub at its start, because ${downloadReason(end.download, machine)}`;
    case 'failed':
      return failureText[end.failureReason];
  }
}

/** Why a decision made was not applied (owner's answer 2, lot 3 step H4). */
function notAppliedWhy(end: ReviewEnd, machine: string): string {
  switch (end.why) {
    case 'stopped':
      return 'you stopped the run before it ended';
    case 'moved_on_machine':
      return 'the branch changed on the machine before the run ended';
    case 'failed':
      return end.failureReason === 'machine_offline'
        ? `machine ${machine} went offline before the run ended`
        : `${failureText[end.failureReason]} before the run ended`;
    default:
      // A decision ends the agent's turn: no give-up or GitHub move can follow it.
      return withoutDecision(end, machine);
  }
}

/** "Quality approved commit abc1234 at 14:52, but the approval was not applied: <why>". */
function decisionNotApplied(decision: ReviewDecision, end: ReviewEnd, machine: string): string {
  const why = notAppliedWhy(end, machine);
  const at = formatDateTime(decision.at);
  return decision.kind === 'approved'
    ? `Quality approved commit ${short(decision.commit)} at ${at}, but the approval was not applied: ${why}`
    : `Quality requested changes on commit ${short(decision.commit)} (${points(decision.points.length)}) at ${at}, but the request was not applied: ${why}`;
}

const NOT_COUNTED = 'It does not count as a failed attempt.';

/** "Review did not finish" in "Needs you" (owner's answers 2 and 5). */
export function reviewNotFinishedText(
  item: Extract<NeedsYouItem, { type: 'review_not_finished' }>,
): {
  title: string;
  detail: string;
} {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  return {
    title: `Review did not finish for ${ref}: ${item.ticket.title}`,
    detail:
      item.decision === null
        ? `The review run on ${item.machine.name} ended without a decision: ${withoutDecision(item.end, item.machine.name)}. ${NOT_COUNTED}`
        : `${decisionNotApplied(item.decision, item.end, item.machine.name)}. ${NOT_COUNTED}`,
  };
}

const HEAD_NOT_CHECKED = (commit: string) =>
  `The pull request's head could not be checked on GitHub when Quality decided: check it is still ${short(commit)} before merging.`;

/** A point of a request for changes: "src/contact.ts:42 — <point>". */
export function pointText(point: ReviewDecision['points'][number]): string {
  if (point.file === null) return point.body;
  return `${point.file}${point.line === null ? '' : `:${String(point.line)}`} — ${point.body}`;
}

/**
 * The ticket page's review section (owner's answers 4 and 5, and the change to answer 4): its
 * heading, the sentence saying the review is about an earlier submission, and "head not checked".
 */
export function ticketReviewText(review: TicketReview): {
  heading: string;
  earlier: string | null;
  headNotChecked: string | null;
} | null {
  const { latest, current } = review;
  if (latest === null) return null;
  const earlier =
    current?.earlier === true
      ? `The work now in review is commit ${short(current.commit)} and has not been reviewed yet.`
      : null;
  const mark = earlier === null ? '' : ', on an earlier submission.';
  switch (latest.kind) {
    case 'in_progress':
      return {
        heading: `Review in progress on ${latest.machine.name}`,
        earlier: null,
        headNotChecked: null,
      };
    case 'skipped':
      return {
        heading: `Review skipped by you on ${formatDate(latest.at.slice(0, 10))}${mark}`,
        earlier,
        headNotChecked: null,
      };
    case 'decision': {
      const { decision } = latest;
      const at = formatDateTime(decision.at);
      return {
        heading:
          decision.kind === 'approved'
            ? `Approved by Quality · commit ${short(decision.commit)} · ${at}${mark}`
            : `Changes requested by Quality · commit ${short(decision.commit)} · ${points(decision.points.length)} · ${at}${mark}`,
        earlier,
        headNotChecked: decision.headChecked ? null : HEAD_NOT_CHECKED(decision.commit),
      };
    }
    case 'not_finished':
      return {
        heading: `Review did not finish: ${sentence(
          latest.decision === null
            ? withoutDecision(latest.end, latest.machine.name)
            : decisionNotApplied(latest.decision, latest.end, latest.machine.name),
        )}`,
        earlier: null,
        headNotChecked: null,
      };
  }
}

/**
 * The line of a ticket on Awaiting merge (owner's answer 7, lot 3 step J1): the merge is found
 * at a check of GitHub, every **GitHub check interval**, whose value the page reads (null while
 * it loads): never a fixed time.
 */
export function awaitingMergeText(pullRequest: number, intervalSeconds: number | null): string {
  const every =
    intervalSeconds === null
      ? 'at each GitHub check interval (Settings > Limits)'
      : `every ${String(intervalSeconds)} seconds (GitHub check interval, in Settings > Limits)`;
  return `Merge pull request #${String(pullRequest)} on GitHub. The Orchestrator checks GitHub ${every} and moves the ticket to Done when it finds the merge.`;
}

/** The run page's review card (owner's answers 2, 5 and 5 of H4). */
export function runReviewText(
  review: RunReview,
  run: { machine: { name: string }; endedAt: string | null },
): {
  reviewed: string | null;
  decision: string;
  notApplied: string | null;
  headNotChecked: string | null;
} {
  const { decision } = review;
  return {
    reviewed:
      review.commit === null
        ? null
        : `Reviewed commit ${short(review.commit)}${review.pullRequest === null ? '' : ` (pull request #${String(review.pullRequest)})`}`,
    decision:
      decision === null
        ? run.endedAt === null
          ? 'Decision: none yet'
          : 'Decision: none, the run ended without one'
        : decision.kind === 'approved'
          ? 'Decision: approved'
          : `Decision: changes requested (${points(decision.points.length)})`,
    notApplied:
      decision === null || review.notApplied === null
        ? null
        : `Decision not applied: ${sentence(notAppliedWhy(review.notApplied, run.machine.name))}`,
    headNotChecked:
      decision === null || decision.headChecked ? null : HEAD_NOT_CHECKED(decision.commit),
  };
}
