import { schema } from '@orchestrator/db';
import {
  ReviewDecision,
  ReviewPost,
  maskSecrets,
  type PullRequestFailure,
  type PullRequestFailureReason,
} from '@orchestrator/protocol';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Templates } from '../agents/files.js';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import type { GitHubRefusal, GitHubResult } from '../github/answers.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import { ticketLink } from '../github/pull-request-text.js';
import {
  findReview,
  postReview,
  readPullRequest,
  type PullRequestReview,
} from '../github/pull-requests.js';
import type { RepositoryRef } from '../github/repositories.js';
import { REVIEW_MARK_PATTERN, reviewCommentBody } from '../github/review-comment-text.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { failureOf } from '../tickets/pull-request.js';
import { ticketEntity, ticketReference } from '../tickets/model.js';

// Quality's comment review on GitHub (06, section 4.5; owner's answers 1 to 4, lot 3 step H3),
// posted at most once after the decision is applied. The transaction applying the decision marks
// the post wanted; this task, one at a time per run, posts it and records what became of it. It
// runs again at each server start for every run still marked. "Post started" is recorded before
// the request: a start finding it started, or an answer lost after the request left, reads the
// pull request's reviews for the hidden mark before deciding, so a review is never posted twice,
// and never called "Not posted" when GitHub may hold it. No retry, no "Needs you" item.

export interface ReviewPosterOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  publicUrl: string;
  templates: () => Promise<Templates>;
  now?: () => Date;
}

/** A problem that is not GitHub's answer: kept with the pull request's failure words. */
type Problem = Omit<PullRequestFailure, 'at' | 'since'>;

/** What became of the post, before its time and pull request are added. */
type Outcome =
  | { state: 'posted'; review: PullRequestReview }
  | { state: 'not_posted'; problem: NotPostedProblem; head: string | null }
  | { state: 'not_found'; checkedAt: Date }
  | { state: 'not_checked'; afterRestart: boolean; problem: Problem };

type NotPostedProblem = Omit<Problem, 'reason'> & {
  reason: Extract<ReviewPost, { state: 'not_posted' }>['reason'];
};

/** GitHub's 422 for content created too fast ("the endpoint has been spammed"): its request limit. */
const TOO_FAST = /secondary rate limit|too quickly|spammed/i;

function problem(reason: PullRequestFailureReason, message: string): Problem {
  return { reason, message, permission: null, fields: [] };
}

const UNREACHABLE = problem(
  'unreachable',
  'GitHub could not be reached, or answered with a server error',
);

export class ReviewPoster {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: ReviewPosterOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Posts the run's review when it is still wanted; resolves when that is done, never rejects. A
   * request while one runs waits for it, then finds the post no longer wanted.
   */
  request(runId: string): Promise<void> {
    const before = this.queues.get(runId) ?? Promise.resolve();
    const done = before
      .then(() => this.attempt(runId))
      .catch((error: unknown) => {
        this.options.log.error({ err: error, runId }, 'review post crashed');
      })
      .finally(() => {
        if (this.queues.get(runId) === done) this.queues.delete(runId);
      });
    this.queues.set(runId, done);
    return done;
  }

  /** At start: every review still wanted, one at a time. */
  async retryWanted(): Promise<void> {
    const wanted = await this.options.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(isNotNull(schema.runs.reviewPostWantedAt), isNull(schema.runs.reviewPost)));
    for (const { id } of wanted) await this.request(id);
  }

  /** Resolves when no post is running. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  private async attempt(runId: string): Promise<void> {
    const { db } = this.options;
    const [row] = await db
      .select({ run: schema.runs, ticket: schema.tickets, project: schema.projects })
      .from(schema.runs)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
      .where(eq(schema.runs.id, runId));
    if (!row) return;
    const { run, ticket, project } = row;
    const pullRequest = run.reviewPostPullRequest;
    if (run.reviewPostWantedAt === null || run.reviewPost !== null || pullRequest === null) return;
    const decision = ReviewDecision.parse(run.reviewDecision);
    const reference = ticketReference(project.key, ticket.number);
    const log = this.options.log.child({ ticket: reference, runId });
    const repo = { owner: project.repoOwner, name: project.repoName };
    const templates = await this.options.templates();
    const body = reviewCommentBody(templates['review-comment'], {
      decision,
      number: reference,
      link: ticketLink(this.options.publicUrl, project.key, ticket.number),
      runId,
    });
    const afterRestart = run.reviewPostStartedAt !== null;
    const outcome = await this.post(runId, repo, pullRequest, decision.commit, body, afterRestart);
    if (outcome === null) return;
    if (outcome.state === 'posted') {
      log.info({ pullRequest, review: outcome.review.id }, 'review posted');
    } else {
      log.warn(
        {
          pullRequest,
          state: outcome.state,
          ...('problem' in outcome ? { reason: outcome.problem.reason } : {}),
        },
        'review not known to be posted',
      );
    }
    await this.record(runId, pullRequest, decision.commit, outcome);
  }

  private async post(
    runId: string,
    repo: RepositoryRef,
    pullRequest: number,
    commit: string,
    body: string,
    afterRestart: boolean,
  ): Promise<Outcome | null> {
    let client: GitHubClient | null;
    try {
      client = await storedTokenClient({ ...this.options, log: this.options.log });
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      const unreadable = problem(
        'token_unreadable',
        'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings',
      );
      return afterRestart
        ? { state: 'not_checked', afterRestart, problem: unreadable }
        : { state: 'not_posted', problem: unreadable, head: null };
    }
    if (client === null) {
      const none = problem('no_token', 'No GitHub token is saved: connect GitHub in Settings');
      return afterRestart
        ? { state: 'not_checked', afterRestart, problem: none }
        : { state: 'not_posted', problem: none, head: null };
    }
    const found = (review: PullRequestReview) =>
      review.body.match(REVIEW_MARK_PATTERN)?.[1] === runId;

    // The server stopped while posting: post only when GitHub does not hold it.
    if (afterRestart) {
      const looked = await this.look(client, repo, pullRequest, found);
      if (!looked.ok) return { state: 'not_checked', afterRestart, problem: looked.problem };
      if (looked.review !== null) return { state: 'posted', review: looked.review };
    }

    // Recorded meanwhile: nothing more to do.
    if (!(await this.started(runId))) return null;
    let posted: GitHubResult<PullRequestReview>;
    try {
      posted = await postReview(client, repo, pullRequest, {
        event: 'COMMENT',
        body,
        commitId: commit,
      });
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      // Never left: GitHub cannot hold it.
      if (!error.sent) return { state: 'not_posted', problem: UNREACHABLE, head: null };
      return this.answerLost(client, repo, pullRequest, found);
    }
    if (posted.ok) return { state: 'posted', review: posted.value };
    // An answer GitHub gave but that cannot be read: it may hold the review.
    if (posted.refusal.kind === 'unreadable')
      return this.answerLost(client, repo, pullRequest, found);
    return this.refused(client, repo, pullRequest, commit, posted.refusal);
  }

  /** The answer was lost after the request left: the reviews say whether GitHub holds it. */
  private async answerLost(
    client: GitHubClient,
    repo: RepositoryRef,
    pullRequest: number,
    found: (review: PullRequestReview) => boolean,
  ): Promise<Outcome> {
    const looked = await this.look(client, repo, pullRequest, found);
    if (!looked.ok) return { state: 'not_checked', afterRestart: false, problem: looked.problem };
    if (looked.review !== null) return { state: 'posted', review: looked.review };
    return { state: 'not_found', checkedAt: this.now() };
  }

  /** Every page of the pull request's reviews, until ours. */
  private async look(
    client: GitHubClient,
    repo: RepositoryRef,
    pullRequest: number,
    found: (review: PullRequestReview) => boolean,
  ): Promise<{ ok: true; review: PullRequestReview | null } | { ok: false; problem: Problem }> {
    try {
      const result = await findReview(client, repo, pullRequest, found);
      if (result.ok) return { ok: true, review: result.value };
      return { ok: false, problem: failureOf(result.refusal, repo) };
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      return { ok: false, problem: UNREACHABLE };
    }
  }

  /** GitHub refused the post: a 422 is explained by one read of the pull request (answer 2). */
  private async refused(
    client: GitHubClient,
    repo: RepositoryRef,
    pullRequest: number,
    commit: string,
    refusal: GitHubRefusal,
  ): Promise<Outcome> {
    const failure = failureOf(refusal, repo);
    if (refusal.kind !== 'invalid') return { state: 'not_posted', problem: failure, head: null };
    if (TOO_FAST.test(refusal.message)) {
      return { state: 'not_posted', problem: { ...failure, reason: 'rate_limited' }, head: null };
    }
    const words = maskSecrets(refusal.message);
    try {
      const read = await readPullRequest(client, repo, pullRequest);
      if (read.ok) {
        const pull = read.value;
        if (pull.merged) {
          return {
            state: 'not_posted',
            problem: { ...failure, reason: 'pull_request_merged', message: words },
            head: null,
          };
        }
        if (pull.state === 'closed') {
          return {
            state: 'not_posted',
            problem: { ...failure, reason: 'pull_request_closed', message: words },
            head: null,
          };
        }
        if (pull.headSha !== commit) {
          return {
            state: 'not_posted',
            problem: { ...failure, reason: 'head_moved', message: words },
            head: pull.headSha,
          };
        }
      }
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
    }
    return { state: 'not_posted', problem: { ...failure, message: words }, head: null };
  }

  /** "Post started", in a transaction of its own; false when the post is no longer wanted. */
  private async started(runId: string): Promise<boolean> {
    const marked = await this.options.db
      .update(schema.runs)
      .set({ reviewPostStartedAt: this.now() })
      .where(
        and(
          eq(schema.runs.id, runId),
          isNotNull(schema.runs.reviewPostWantedAt),
          isNull(schema.runs.reviewPost),
        ),
      )
      .returning({ id: schema.runs.id });
    return marked.length > 0;
  }

  /** Keeps the outcome on the run, which clears the wanted mark, with its event. */
  private async record(
    runId: string,
    pullRequest: number,
    commit: string,
    outcome: Outcome,
  ): Promise<void> {
    const at = this.now().toISOString();
    const post: ReviewPost = ReviewPost.parse(
      outcome.state === 'posted'
        ? { state: 'posted', pullRequest, reviewId: outcome.review.id, url: outcome.review.url, at }
        : outcome.state === 'not_posted'
          ? { state: 'not_posted', pullRequest, ...outcome.problem, head: outcome.head, at }
          : outcome.state === 'not_found'
            ? { state: 'not_found', pullRequest, checkedAt: outcome.checkedAt.toISOString(), at }
            : {
                state: 'not_checked',
                pullRequest,
                afterRestart: outcome.afterRestart,
                ...outcome.problem,
                at,
              },
    );
    await this.options.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ run: schema.runs, ticket: schema.tickets, projectKey: schema.projects.key })
        .from(schema.runs)
        .innerJoin(schema.tickets, eq(schema.tickets.id, schema.runs.ticketId))
        .innerJoin(schema.projects, eq(schema.projects.id, schema.runs.projectId))
        .where(eq(schema.runs.id, runId));
      if (!row) return;
      const updated = await tx
        .update(schema.runs)
        .set({ reviewPost: post, reviewPostWantedAt: null })
        .where(and(eq(schema.runs.id, runId), isNull(schema.runs.reviewPost)))
        .returning({ id: schema.runs.id });
      if (updated.length === 0) return;
      const facts = {
        project: row.projectKey,
        ticket: ticketReference(row.projectKey, row.ticket.number),
        runId,
        commit,
        pullRequest,
      };
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(row.ticket),
        ...(post.state === 'posted'
          ? { type: 'ticket.review_posted', payload: { ...facts, url: post.url } }
          : {
              type: 'ticket.review_not_posted',
              payload: {
                ...facts,
                outcome: post.state,
                reason: post.state === 'not_found' ? null : post.reason,
                message: post.state === 'not_found' ? null : post.message,
              },
            }),
        at: new Date(at),
      });
    });
  }
}
