import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  ChangeRequest,
  ReviewDecision,
  TicketStatus,
  type RunCiOutcome,
} from '@orchestrator/protocol';
import { and, desc, eq, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import type { GitHubRefusal } from '../github/answers.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import {
  listOpenPullRequests,
  readPullRequest,
  type PullRequest,
  type PullRequestSummary,
} from '../github/pull-requests.js';
import { notifyChange } from '../realtime/changes.js';
import { ciOutcome } from '../runs/ci-outcome.js';
import { ticketReview } from '../runs/review-view.js';
import type { RunService } from '../runs/service.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import {
  mergeComment,
  mergedAfterCancelComment,
  mergedAfterDoneComment,
  type MergeReview,
} from './merge-comment.js';
import { ticketEntity, ticketReference, type TicketRow } from './model.js';
import { applyRunAction } from './transitions.js';

// The ticket's pull request watched on GitHub (04, section 2; owner's answers 1 to 3, lot 3 step
// J1). At every **GitHub check interval**, before the CI waits, the CI loop asks this watcher to
// look at every pull request it still watches: open ones, and those closed without merging on
// tickets neither `done` nor `cancelled` (the owner can reopen one on GitHub, or reopen and merge
// it there). Per project with an open one, its list of open pull requests, every page; a pull
// request missing from the list, or closed, is read by itself. Only that read decides: a pull
// request missing from the list never does by itself, and a list that fails decides nothing for
// its project. Every read of a ticket's pull request (this one and the CI wait's) refreshes the
// stored state and head, and a merge into the default branch moves the ticket to `done`, exactly
// once: the merge's transaction locks the ticket and reads its state again.

/** A pull request as read: in a list (no `merged`), or by itself. */
export type PullRequestRead = PullRequestSummary | PullRequest;

export interface PullRequestWatcherOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  runs: Pick<RunService, 'endForTicket'>;
  now?: () => Date;
}

/** The first moment GitHub allows requests again, as its refusal says; null when it does not. */
function retryAt(refusal: GitHubRefusal, now: Date): Date | null {
  if (refusal.kind !== 'rate_limited') return null;
  if (refusal.retry === null) return null;
  return 'afterSeconds' in refusal.retry
    ? new Date(now.getTime() + refusal.retry.afterSeconds * 1000)
    : new Date(refusal.retry.resetAtSeconds * 1000);
}

export class PullRequestWatcher {
  constructor(private readonly options: PullRequestWatcherOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * One look at every watched pull request. Returns when GitHub allows requests again after its
   * request limit, which holds the whole tick (owner's answer 1); null otherwise.
   */
  async check(): Promise<Date | null> {
    const { db, log } = this.options;
    const watched = await db
      .select({ ticket: schema.tickets, project: schema.projects })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .where(
        and(
          // Archived projects change nothing; their merges are found once unarchived.
          eq(schema.projects.status, 'active'),
          isNotNull(schema.tickets.pullRequestNumber),
          or(
            eq(schema.tickets.pullRequestState, 'open'),
            and(
              eq(schema.tickets.pullRequestState, 'closed'),
              notInArray(schema.tickets.status, ['done', 'cancelled']),
            ),
          ),
        ),
      )
      .orderBy(schema.tickets.projectId, schema.tickets.number);
    if (watched.length === 0) return null;
    let client: GitHubClient | null;
    try {
      client = await storedTokenClient({ ...this.options, log });
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return null;
    }
    // No token: nothing can be read; the CI wait and "Needs you" already say so.
    if (client === null) return null;

    const byProject = new Map<string, typeof watched>();
    for (const row of watched) {
      byProject.set(row.project.id, [...(byProject.get(row.project.id) ?? []), row]);
    }
    for (const rows of byProject.values()) {
      const project = rows[0]?.project;
      if (!project) continue;
      try {
        const limited = await this.checkProject(client, project, rows);
        if (limited !== null) return limited;
      } catch (error) {
        if (error instanceof GitHubUnreachableError) {
          // Unreachable: nothing decided for this project, the next tick reads it again.
          log.warn({ project: project.key }, 'pull requests not checked: GitHub unreachable');
        } else {
          // Any other error stops this project only: the others, and the CI waits, go on.
          log.error({ err: error, project: project.key }, 'pull requests not checked');
        }
      }
    }
    return null;
  }

  private async checkProject(
    client: GitHubClient,
    project: typeof schema.projects.$inferSelect,
    rows: { ticket: TicketRow }[],
  ): Promise<Date | null> {
    const repo = { owner: project.repoOwner, name: project.repoName };
    const refused = (refusal: GitHubRefusal, what: string): Date | null => {
      this.options.log.warn(
        { project: project.key, reason: refusal.kind, message: refusal.message },
        `pull requests not checked: ${what}`,
      );
      return retryAt(refusal, this.now());
    };
    let open: Map<number, PullRequestSummary> | null = null;
    if (rows.some(({ ticket }) => ticket.pullRequestState === 'open')) {
      const listed = await listOpenPullRequests(client, repo);
      // A list that fails decides nothing for the project (owner's addition).
      if (!listed.ok) return refused(listed.refusal, 'the list of open pull requests');
      open = new Map(listed.value.map((pull) => [pull.number, pull]));
    }
    for (const { ticket } of rows) {
      try {
        const limited = await this.checkTicket(client, repo, ticket, open, refused);
        if (limited !== null) return limited;
      } catch (error) {
        if (error instanceof GitHubUnreachableError) throw error;
        // One ticket never blocks the others (owner's correction, lot 3 step J1): a stored value
        // that no longer reads, for example, is logged with its ticket, at each tick.
        this.options.log.error(
          { err: error, ticket: ticketReference(project.key, ticket.number) },
          'pull request not checked',
        );
      }
    }
    return null;
  }

  /** One watched ticket's pull request: found in the list, or read by itself. */
  private async checkTicket(
    client: GitHubClient,
    repo: { owner: string; name: string },
    ticket: TicketRow,
    open: Map<number, PullRequestSummary> | null,
    refused: (refusal: GitHubRefusal, what: string) => Date | null,
  ): Promise<Date | null> {
    const number = ticket.pullRequestNumber;
    if (number === null) return null;
    const listed = open?.get(number);
    if (listed) {
      await this.seen(ticket.id, listed);
      return null;
    }
    // Missing from the list, or closed: only its own read decides.
    const read = await readPullRequest(client, repo, number);
    if (!read.ok) return refused(read.refusal, `pull request #${String(number)}`);
    await this.seen(ticket.id, read.value);
    return null;
  }

  /**
   * A read of the ticket's pull request (this watcher's, or the CI wait's): the stored state and
   * head refreshed, and a merge or a close decided, in one transaction that locks the ticket.
   */
  async seen(ticketId: string, pull: PullRequestRead): Promise<void> {
    const after = await this.options.db.transaction((tx) => this.apply(tx, ticketId, pull));
    await after();
  }

  private async apply(
    tx: Executor,
    ticketId: string,
    pull: PullRequestRead,
  ): Promise<() => Promise<void>> {
    const nothing = () => Promise.resolve();
    const [current] = await tx
      .select({ projectId: schema.tickets.projectId })
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId));
    if (!current) return nothing;
    // The project's row lock first, then the ticket's: the order of every ticket change.
    const [project] = await tx
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, current.projectId))
      .for('no key update');
    const [ticket] = await tx
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, ticketId))
      .for('update');
    if (!project || !ticket) return nothing;
    // Another pull request is the ticket's now (a new one opened since the read).
    if (ticket.pullRequestNumber !== pull.number) return nothing;
    const now = this.now();
    const facts = {
      project: project.key,
      ticket: ticketReference(project.key, ticket.number),
      number: pull.number,
      url: pull.url,
    };
    const merged = 'merged' in pull ? pull.merged : pull.mergedAt !== null;
    if (merged) {
      // Exactly once: a merge already recorded (its stored time, which only this watcher writes)
      // is never recorded again; `pull_request_state` alone is not the mark.
      if (ticket.pullRequestMergedAt !== null) return nothing;
      return this.merged(tx, project, ticket, pull, now);
    }
    const state = pull.state;
    const moved = ticket.pullRequestHead !== pull.headSha;
    if (ticket.pullRequestState === state && !moved) return nothing;
    await tx
      .update(schema.tickets)
      .set({ pullRequestState: state, pullRequestHead: pull.headSha, updatedAt: now })
      .where(eq(schema.tickets.id, ticket.id));
    if (ticket.pullRequestState === 'open' && state === 'closed') {
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_closed',
        payload: facts,
        at: now,
      });
    } else if (ticket.pullRequestState === 'closed' && state === 'open') {
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_reopened',
        payload: { ...facts, seen: true },
        at: now,
      });
    } else {
      // Only the head moved: the ticket page reads it again.
      await notifyChange(tx, { entity: 'ticket', id: ticket.id, projectId: ticket.projectId });
    }
    return nothing;
  }

  /** The pull request found merged: recorded once, with what it does to the ticket. */
  private async merged(
    tx: Executor,
    project: typeof schema.projects.$inferSelect,
    ticket: TicketRow,
    pull: PullRequestRead,
    now: Date,
  ): Promise<() => Promise<void>> {
    const reference = ticketReference(project.key, ticket.number);
    // GitHub's time; the event keeps the time the server found it (owner's answer 1).
    const mergedAt = pull.mergedAt === null ? now : new Date(pull.mergedAt);
    const head = pull.headSha;
    await tx
      .update(schema.tickets)
      .set({
        pullRequestState: 'merged',
        pullRequestHead: head,
        pullRequestMergedAt: mergedAt,
        pullRequestMergedHead: head,
        pullRequestMergedInto: pull.baseBranch,
        updatedAt: now,
      })
      .where(eq(schema.tickets.id, ticket.id));
    const status = TicketStatus.parse(ticket.status);
    const comment = async (body: string) => {
      const [row] = await tx
        .insert(schema.comments)
        .values({
          ticketId: ticket.id,
          author: 'system',
          kind: 'status_change',
          body,
          createdAt: now,
        })
        .returning({ id: schema.comments.id });
      if (!row) throw new Error('comment not inserted');
      return row.id;
    };
    let after: () => Promise<void> = () => Promise.resolve();
    let outcome: 'done' | 'already_done' | 'cancelled' | 'other_base';
    let commentId: string | null = null;
    const words = { number: pull.number, reference, mergedAt, head };
    if (project.defaultBranch === null || pull.baseBranch !== project.defaultBranch) {
      // Merged into another base (its base changed by hand on GitHub): the ticket is unchanged,
      // and step J3's item says where it went (owner's answer 1).
      outcome = 'other_base';
    } else if (status === 'done') {
      outcome = 'already_done';
      commentId = await comment(mergedAfterDoneComment(words));
    } else if (status === 'cancelled') {
      // The cancel race (B): the ticket stays cancelled (owner's answer 2).
      outcome = 'cancelled';
      commentId = await comment(mergedAfterCancelComment(words));
    } else {
      outcome = 'done';
      const [active] = await tx
        .select({ run: schema.runs, machine: schema.machines.name })
        .from(schema.runs)
        .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
        .where(
          and(
            eq(schema.runs.ticketId, ticket.id),
            inArray(schema.runs.status, [...ACTIVE_RUN_STATUSES]),
          ),
        );
      // Read before the run is stopped: its decision not applied yet, and CI as it stood.
      const body = mergeComment({
        ...words,
        stoppedOn: active?.machine ?? null,
        ci: await latestCi(tx, ticket.id, head),
        review: await reviewOf(tx, ticket, active?.run ?? null),
      });
      after = await this.options.runs.endForTicket(tx, project, ticket, 'pull_request_merged');
      const updated = await applyRunAction(tx, {
        projectKey: project.key,
        ticket,
        action: 'pull_request_merged',
        actor: 'system',
        runId: active?.run.id ?? null,
        comment: body,
        now,
      });
      if (updated === null) throw new Error(`ticket ${reference} not moved to done`);
      // The stop of the retry policy goes with it: nothing is left to try again.
      if (ticket.stopped !== null) {
        await tx
          .update(schema.tickets)
          .set({ stopped: null })
          .where(eq(schema.tickets.id, ticket.id));
      }
    }
    await recordEvent(tx, {
      actor: 'system',
      ...ticketEntity(ticket),
      type: 'ticket.pull_request_merged',
      payload: {
        project: project.key,
        ticket: reference,
        number: pull.number,
        url: pull.url,
        mergedAt: mergedAt.toISOString(),
        head,
        into: pull.baseBranch,
        outcome,
        commentId,
      },
      at: now,
    });
    this.options.log.info(
      { ticket: reference, pullRequest: pull.number, into: pull.baseBranch, outcome },
      'pull request merged on GitHub',
    );
    return after;
  }
}

/**
 * The CI outcome of the ticket's latest work with one; review runs never hold work. With `head`,
 * the latest outcome whose commit is that head comes first: work pushed after a merge has a newer
 * outcome, which says nothing of the merged head.
 */
async function latestCi(
  tx: Executor,
  ticketId: string,
  head?: string,
): Promise<RunCiOutcome | null> {
  const runs = await tx
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.ticketId, ticketId))
    .orderBy(desc(schema.runs.createdAt));
  const outcomes = runs
    .filter((run) => run.purpose !== 'review')
    .flatMap((run) => ciOutcome(run) ?? []);
  return outcomes.find((outcome) => outcome.commit === head) ?? outcomes[0] ?? null;
}

/** Quality's review of the work merged, as the merge found it (owner's answer 2). */
async function reviewOf(
  tx: Executor,
  ticket: TicketRow,
  active: typeof schema.runs.$inferSelect | null,
): Promise<MergeReview> {
  if (
    active?.purpose === 'review' &&
    active.reviewDecision !== null &&
    active.reviewAppliedAt === null
  ) {
    return { kind: 'not_applied', decision: ReviewDecision.parse(active.reviewDecision) };
  }
  if (ticket.changeRequest !== null && ticket.changeRequestAnsweredAt === null) {
    return { kind: 'request_standing', request: ChangeRequest.parse(ticket.changeRequest) };
  }
  if (ticket.status === 'awaiting_merge') {
    const { latest } = (await ticketReview(tx, ticket)).review;
    if (latest?.kind === 'decision' && latest.decision.kind === 'approved') {
      return { kind: 'approved', commit: latest.decision.commit };
    }
    if (latest?.kind === 'skipped') {
      return { kind: 'skipped', commit: (await latestCi(tx, ticket.id))?.commit ?? null };
    }
  }
  return { kind: 'none' };
}
