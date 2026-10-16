import { schema } from '@orchestrator/db';
import { runDownload } from './download.js';
import {
  ACTIVE_RUN_STATUSES,
  FailureReason,
  ReviewDecision,
  ReviewMoved,
  ReviewPost,
  type ReviewEnd,
  type ReviewPostView,
  type RunCiOutcome,
  type RunReview,
  type TicketReview,
  type TicketReviewLatest,
} from '@orchestrator/protocol';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { maskStrings } from '../event-log.js';
import type { ReviewCi } from '../agents/review-message.js';
import { ciOutcome, ciSourceRun } from './ci-outcome.js';
import type { RunRow } from './model.js';

// Reviews as the screens show them (02, sections 4, 6.4 and 7; owner's answers 2 to 5, lot 3
// steps H and H4): facts only, worded by the UI. Quality's texts are agent text, masked.

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);
const ENDED = new Set(['succeeded', 'failed', 'cancelled']);

/** What a review is told about CI, from the outcome of the work in review; null for none. */
export function reviewCiOf(outcome: RunCiOutcome | null): ReviewCi | null {
  if (outcome === null) return null;
  if (outcome.acceptedLater !== null) {
    return outcome.acceptedLater.state === 'passed' ? 'passed_later' : 'no_ci';
  }
  if (outcome.kind === 'passed') return 'passed';
  if (outcome.kind === 'no_ci') return 'no_ci';
  return null;
}

function decisionOf(run: RunRow): ReviewDecision | null {
  return run.reviewDecision === null ? null : maskStrings(ReviewDecision.parse(run.reviewDecision));
}

/** Why a review run ended without its decision applied; null while active, or once applied. */
export function reviewEnd(run: RunRow): ReviewEnd | null {
  if (run.purpose !== 'review' || !ENDED.has(run.status) || run.reviewAppliedAt !== null) {
    return null;
  }
  if (run.failureReason === null) return null;
  const failureReason = FailureReason.parse(run.failureReason);
  switch (failureReason) {
    case 'agent_gave_up':
      return { why: 'gave_up', reason: run.outcome === null ? null : maskStrings(run.outcome) };
    case 'cancelled':
      return { why: 'stopped' };
    case 'review_branch_moved': {
      const where = run.reviewMoved === null ? null : ReviewMoved.parse(run.reviewMoved);
      if (where === 'before_start') {
        return { why: 'moved_before_start', head: run.reviewMovedHead };
      }
      if (where === 'github') return { why: 'moved_on_github', head: run.reviewMovedHead };
      return { why: 'moved_on_machine' };
    }
    case 'download_failed':
      return { why: 'download_failed', download: runDownload(run) };
    default:
      return { why: 'failed', failureReason };
  }
}

/** The post as shown: its outcome, or "posting" while it is wanted. */
function postOf(run: RunRow): ReviewPostView | null {
  if (run.reviewPost !== null) return ReviewPost.parse(run.reviewPost);
  if (run.reviewPostWantedAt !== null && run.reviewPostPullRequest !== null) {
    return { state: 'posting', pullRequest: run.reviewPostPullRequest };
  }
  return null;
}

/** A review run's card (02, section 7); null for other runs. */
export function runReview(run: RunRow, pullRequest: number | null): RunReview | null {
  if (run.purpose !== 'review') return null;
  return {
    commit: run.reviewCommit,
    pullRequest: run.reviewPostPullRequest ?? pullRequest,
    decision: decisionOf(run),
    applied: run.reviewAppliedAt !== null,
    notApplied: reviewEnd(run),
    post: postOf(run),
  };
}

/** What "Ready for review" says of the work in review (owner's answer 4, lot 3 step H). */
export interface ReadyWork {
  commit: string;
  ci: ReviewCi;
  checkedAgainAt: string | null;
  /** When the work entered review: its acceptance. */
  since: string;
}

/**
 * The ticket's latest review and the work in review (owner's answer 4 and its change, lot 3 step
 * H4): a review run or the owner's **Skip review**, newest first. A review run the owner stopped
 * before any decision is passed over; one that did not finish counts only while the ticket is in
 * review and it reviewed the work in review.
 */
export async function ticketReview(
  executor: Executor,
  ticket: { id: string; status: string; pullRequestNumber: number | null; updatedAt: Date },
): Promise<{ review: TicketReview; ready: ReadyWork | null }> {
  const runs = await executor
    .select({ run: schema.runs, machine: { id: schema.machines.id, name: schema.machines.name } })
    .from(schema.runs)
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(eq(schema.runs.ticketId, ticket.id))
    .orderBy(desc(schema.runs.createdAt));
  const skips = await executor
    .select({ at: schema.events.createdAt })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.entityType, 'ticket'),
        eq(schema.events.entityId, ticket.id),
        eq(schema.events.type, 'ticket.status_changed'),
        sql`${schema.events.payload}->>'action' = 'skip_review'`,
      ),
    )
    .orderBy(desc(schema.events.id));

  const source = await ciSourceRun(executor, ticket.id);
  const outcome = source === null ? null : ciOutcome(source);
  const ci = reviewCiOf(outcome);
  const inReview = ticket.status === 'in_review';
  const ready: ReadyWork | null =
    inReview && source !== null && outcome !== null && ci !== null
      ? {
          commit: outcome.commit,
          ci,
          checkedAgainAt: outcome.acceptedLater?.at ?? null,
          since: outcome.acceptedLater?.at ?? (source.endedAt ?? ticket.updatedAt).toISOString(),
        }
      : null;

  const candidates = [
    ...runs
      .filter(({ run }) => run.purpose === 'review')
      .map((row) => ({ at: row.run.createdAt.getTime(), row, skip: null })),
    ...skips.map((skip) => ({ at: skip.at.getTime(), row: null, skip })),
  ].sort((a, b) => b.at - a.at);
  let latest: TicketReviewLatest | null = null;
  for (const candidate of candidates) {
    if (candidate.skip) {
      latest = { kind: 'skipped', at: candidate.skip.at.toISOString() };
      break;
    }
    const { run, machine } = candidate.row;
    if (ACTIVE.has(run.status)) {
      latest = { kind: 'in_progress', runId: run.id, machine };
      break;
    }
    const decision = decisionOf(run);
    if (run.reviewAppliedAt !== null && decision !== null) {
      latest = { kind: 'decision', runId: run.id, decision, post: postOf(run) };
      break;
    }
    const end = reviewEnd(run);
    // The owner's Stop run with no decision: plain "Ready for review" again (answer 5).
    if (end === null || (end.why === 'stopped' && decision === null)) continue;
    if (ready === null || run.reviewCommit !== ready.commit || run.endedAt === null) continue;
    latest = {
      kind: 'not_finished',
      runId: run.id,
      machine,
      decision,
      end,
      endedAt: run.endedAt.toISOString(),
    };
    break;
  }

  const earlier =
    ready !== null &&
    latest !== null &&
    (latest.kind === 'decision'
      ? latest.decision.commit !== ready.commit
      : latest.kind === 'skipped' && latest.at < ready.since);
  const active = runs.some(({ run }) => ACTIVE.has(run.status));
  return {
    review: {
      latest,
      current: ready === null ? null : { commit: ready.commit, earlier },
      offered: ready !== null && ticket.pullRequestNumber !== null && !active,
    },
    ready,
  };
}
