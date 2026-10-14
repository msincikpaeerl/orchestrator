import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  ChangeRequest,
  PullRequestFailure,
  type HeadComparison,
  PullRequestWatchFailure,
  ReviewDecision,
  TicketStatus,
  type PullRequestReopenFailure,
  type RunCiOutcome,
} from '@orchestrator/protocol';
import { and, desc, eq, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { retryAt, type GitHubRefusal, type GitHubResult } from '../github/answers.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { compareCommits, type CommitComparison } from '../github/compare.js';
import { storedTokenClient } from '../github/connection.js';
import {
  closePullRequest,
  listOpenPullRequests,
  readBranchRef,
  readPullRequest,
  reopenPullRequest,
  type PullRequest,
  type PullRequestSummary,
} from '../github/pull-requests.js';
import { notifyChange } from '../realtime/changes.js';
import { ciOutcome } from '../runs/ci-outcome.js';
import { failureOf as checkFailureOf } from '../runs/ci-wait.js';
import { ticketReview } from '../runs/review-view.js';
import type { RunService } from '../runs/service.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import {
  mergeComment,
  mergedAfterCancelComment,
  mergedAfterDoneComment,
  type MergeReview,
} from './merge-comment.js';
import { cleanUpWanted } from './branch-clean-up.js';
import { ticketEntity, ticketReference, type TicketRow } from './model.js';
import { failureOf as pullRequestFailureOf } from './pull-request.js';
import {
  comparisonResult,
  conflictAfter,
  failedComparison,
  headMoved,
  storedConflict,
} from './pull-request-facts.js';
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

type WatchFound = Omit<PullRequestWatchFailure, 'since' | 'at'>;
type ProjectRow = typeof schema.projects.$inferSelect;
type Repo = { owner: string; name: string };

/** GitHub not reached, in the words a failed check keeps. */
const UNREACHABLE = 'GitHub could not be reached, or answered with a server error';

/**
 * What one check of a project's pull requests could not read (owner's note on step J1, lot 3 step
 * J3a): the first failure's reason, and every watched pull request left unread.
 */
class ProjectWatch {
  private readonly read = new Set<number>();
  private readonly unread = new Set<number>();
  private first: Omit<WatchFound, 'pullRequests'> | null = null;

  constructor(private readonly numbers: readonly number[]) {}

  seen(number: number): void {
    this.read.add(number);
  }

  /** A read failed: for `numbers`, or for every one not read yet when the check stops there. */
  failed(failure: Omit<WatchFound, 'pullRequests'>, numbers: readonly number[] | 'rest'): void {
    this.first ??= failure;
    const left = numbers === 'rest' ? this.numbers.filter((n) => !this.read.has(n)) : numbers;
    for (const number of left) this.unread.add(number);
  }

  get failure(): WatchFound | null {
    if (this.first === null) return null;
    return { ...this.first, pullRequests: [...this.unread].sort((a, b) => a - b) };
  }
}

/** Who saw the pull request reopened: on GitHub, or the owner's **Reopen pull request**. */
type ReopenedBy = 'github' | 'owner';

export interface PullRequestWatcherOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  runs: Pick<RunService, 'endForTicket'>;
  now?: () => Date;
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
      const watch = new ProjectWatch(rows.flatMap(({ ticket }) => ticket.pullRequestNumber ?? []));
      let limited: Date | null = null;
      let checked = true;
      try {
        limited = await this.checkProject(client, project, rows, watch);
      } catch (error) {
        if (error instanceof GitHubUnreachableError) {
          // Unreachable: nothing decided for this project, the next tick reads it again.
          log.warn({ project: project.key }, 'pull requests not checked: GitHub unreachable');
          watch.failed(
            { reason: 'unreachable', message: UNREACHABLE, fields: [], retryAt: null },
            'rest',
          );
        } else {
          // Any other error stops this project only: the others, and the CI waits, go on. It is
          // not GitHub's: the watch's stored failure is left as it was.
          log.error({ err: error, project: project.key }, 'pull requests not checked');
          checked = false;
        }
      }
      if (checked) {
        await this.recordWatch(project.id, watch.failure).catch((error: unknown) => {
          log.error({ err: error, project: project.key }, 'pull request watch not recorded');
        });
      }
      if (limited !== null) return limited;
    }
    return null;
  }

  /**
   * The watch's failure kept on the project, as the CI wait keeps its failed check (owner's note
   * on step J1, lot 3 step J3a): its first time and its latest, one event when it starts failing
   * or its reason changes, and one when a check reads every pull request again.
   */
  private async recordWatch(projectId: string, found: WatchFound | null): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId))
        .for('no key update');
      if (!project) return;
      const previous =
        project.pullRequestWatchFailure === null
          ? null
          : PullRequestWatchFailure.parse(project.pullRequestWatchFailure);
      const now = this.now();
      const entity = { entityType: 'project' as const, entityId: project.id, projectId };
      if (found === null) {
        if (previous === null) return;
        await tx
          .update(schema.projects)
          .set({ pullRequestWatchFailure: null })
          .where(eq(schema.projects.id, projectId));
        await recordEvent(tx, {
          actor: 'system',
          ...entity,
          type: 'project.pull_request_watch_recovered',
          payload: { key: project.key },
          at: now,
        });
        return;
      }
      const same = previous !== null && previous.reason === found.reason;
      const failure: PullRequestWatchFailure = {
        ...found,
        since: same ? previous.since : now.toISOString(),
        at: now.toISOString(),
      };
      await tx
        .update(schema.projects)
        .set({ pullRequestWatchFailure: failure })
        .where(eq(schema.projects.id, projectId));
      if (same) {
        // Repeated failures are quiet; the pages read it again when the unread ones change.
        if (previous.pullRequests.join() !== failure.pullRequests.join()) {
          await notifyChange(tx, { entity: 'project', id: projectId, projectId });
        }
        return;
      }
      await recordEvent(tx, {
        actor: 'system',
        ...entity,
        type: 'project.pull_request_watch_failed',
        payload: {
          key: project.key,
          reason: failure.reason,
          message: failure.message,
          pullRequests: failure.pullRequests,
        },
        at: now,
      });
    });
  }

  private async checkProject(
    client: GitHubClient,
    project: ProjectRow,
    rows: { ticket: TicketRow }[],
    watch: ProjectWatch,
  ): Promise<Date | null> {
    const repo = { owner: project.repoOwner, name: project.repoName };
    const refused: Refused = (refusal, what, numbers) => {
      this.options.log.warn(
        { project: project.key, reason: refusal.kind, message: refusal.message },
        `pull requests not checked: ${what}`,
      );
      const until = retryAt(refusal, this.now());
      // The request limit holds the whole tick: every pull request after it is left unread.
      watch.failed(
        { ...checkFailureOf(refusal), retryAt: until?.toISOString() ?? null },
        until === null ? numbers : 'rest',
      );
      return until;
    };
    let open: Map<number, PullRequestSummary> | null = null;
    if (rows.some(({ ticket }) => ticket.pullRequestState === 'open')) {
      const listed = await listOpenPullRequests(client, repo);
      // A list that fails decides nothing for the project (owner's addition).
      if (!listed.ok) return refused(listed.refusal, 'the list of open pull requests', 'rest');
      open = new Map(listed.value.map((pull) => [pull.number, pull]));
    }
    for (const { ticket } of rows) {
      try {
        const limited = await this.checkTicket(client, repo, ticket, open, refused, watch);
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

  /**
   * One watched ticket's pull request: found in the list, or read by itself; then **Cancel**'s
   * close of it, when it is wanted.
   */
  private async checkTicket(
    client: GitHubClient,
    repo: Repo,
    ticket: TicketRow,
    open: Map<number, PullRequestSummary> | null,
    refused: Refused,
    watch: ProjectWatch,
  ): Promise<Date | null> {
    const number = ticket.pullRequestNumber;
    if (number === null) return null;
    const listed = open?.get(number);
    // On **Awaiting merge**, read by itself for `mergeable`, which the list does not give (M in
    // the cost of owner's answer 1, lot 3 step J3b): one read, also when it left the list.
    if (listed && ticket.status !== 'awaiting_merge') {
      await this.seen(ticket.id, listed);
    } else {
      // Missing from the list, or closed: only its own read decides.
      const read = await readPullRequest(client, repo, number);
      if (!read.ok) return refused(read.refusal, `pull request #${String(number)}`, [number]);
      await this.seen(ticket.id, read.value);
    }
    watch.seen(number);
    const compared = await this.compareMovedHead(client, repo, ticket.id);
    if (compared !== null) return compared;
    // Read first: a pull request found merged is never closed (the cancel race, answer 2).
    if (ticket.pullRequestCloseWantedAt === null) return null;
    return this.closeWith(client, repo, ticket.id);
  }

  /**
   * The head moved after the approval or the skip, on **Awaiting merge** (owner's answer 3 of
   * step J, lot 3 step J3b): one comparison of that commit with the head, made once for the two
   * commits, whatever GitHub answers; never tried again for them. Returns when GitHub allows
   * requests again after its request limit.
   */
  private async compareMovedHead(
    client: GitHubClient,
    repo: Repo,
    ticketId: string,
  ): Promise<Date | null> {
    const row = await this.ticketWithProject(ticketId);
    if (!row) return null;
    const moved = await headMoved(this.options.db, row.ticket);
    if (moved === null || moved.comparison !== null) return null;
    let read: GitHubResult<CommitComparison> | 'unreachable';
    try {
      read = await compareCommits(client, repo, moved.commit, moved.head);
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      read = 'unreachable';
    }
    const result =
      read === 'unreachable' ? failedComparison('unreachable') : comparisonResult(read);
    const at = this.now();
    await this.options.db.transaction(async (tx) => {
      const locked = await lockTicket(tx, ticketId);
      // The head moved again meanwhile: the next check compares the new one.
      if (!locked || locked.ticket.pullRequestHead !== moved.head) return;
      const comparison: HeadComparison = {
        approved: moved.commit,
        head: moved.head,
        at: at.toISOString(),
        result,
      };
      await tx
        .update(schema.tickets)
        .set({ pullRequestComparison: comparison })
        .where(eq(schema.tickets.id, ticketId));
      await notifyChange(tx, {
        entity: 'ticket',
        id: ticketId,
        projectId: locked.ticket.projectId,
      });
    });
    if (result.kind === 'failed') {
      this.options.log.warn(
        { ticketId, reason: result.reason, message: result.message },
        'moved head not compared',
      );
    }
    return read !== 'unreachable' && !read.ok ? retryAt(read.refusal, at) : null;
  }

  /**
   * **Cancel**'s close of the ticket's pull request (04, section 2; lot 3 step J3a): one attempt,
   * made after the cancel's transaction; a failure is kept on the ticket and tried again at each
   * check, until it is closed, found merged, or the ticket is reopened. Never throws.
   */
  async close(ticketId: string): Promise<void> {
    try {
      const row = await this.ticketWithProject(ticketId);
      if (!row || !wantsClose(row.ticket)) return;
      const client = await this.clientFor();
      if ('failure' in client) {
        await this.closeFailed(ticketId, client.failure);
        return;
      }
      await this.closeWith(client.client, repoOf(row.project), ticketId);
    } catch (error) {
      this.options.log.error({ err: error, ticketId }, 'pull request not closed');
    }
  }

  private async closeWith(
    client: GitHubClient,
    repo: Repo,
    ticketId: string,
  ): Promise<Date | null> {
    const row = await this.ticketWithProject(ticketId);
    if (!row || !wantsClose(row.ticket) || row.ticket.pullRequestNumber === null) return null;
    const number = row.ticket.pullRequestNumber;
    let closed: GitHubResult<PullRequest>;
    try {
      closed = await closePullRequest(client, repo, number);
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      await this.closeFailed(ticketId, unreachableFailure());
      return null;
    }
    // Closed, or merged already (GitHub leaves a merged one as it is): the read decides.
    if (closed.ok) {
      await this.seen(ticketId, closed.value);
      return null;
    }
    if (closed.refusal.kind === 'invalid') {
      // GitHub may refuse to close a merged pull request: its own read records the merge.
      const read = await readPullRequest(client, repo, number);
      if (read.ok && read.value.state === 'closed') {
        await this.seen(ticketId, read.value);
        return null;
      }
    }
    await this.closeFailed(ticketId, pullRequestFailureOf(closed.refusal, repo));
    return retryAt(closed.refusal, this.now());
  }

  /** The latest failed close kept on the ticket, with one event when it starts or changes. */
  private async closeFailed(
    ticketId: string,
    found: Omit<PullRequestFailure, 'at' | 'since'>,
  ): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      const locked = await lockTicket(tx, ticketId);
      if (!locked || !wantsClose(locked.ticket) || locked.ticket.pullRequestNumber === null) return;
      const { project, ticket } = locked;
      const now = this.now();
      const previous =
        ticket.pullRequestCloseFailure === null
          ? null
          : PullRequestFailure.parse(ticket.pullRequestCloseFailure);
      const failure: PullRequestFailure = {
        ...found,
        at: now.toISOString(),
        since: previous?.since ?? previous?.at ?? now.toISOString(),
      };
      await tx
        .update(schema.tickets)
        .set({ pullRequestCloseFailure: failure, updatedAt: now })
        .where(eq(schema.tickets.id, ticketId));
      if (previous?.reason === failure.reason) return;
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_not_closed',
        payload: {
          project: project.key,
          ticket: ticketReference(project.key, ticket.number),
          number: ticket.pullRequestNumber,
          reason: failure.reason,
          message: failure.message,
        },
        at: now,
      });
    });
  }

  /**
   * **Reopen pull request** (lot 3 step J3a): one attempt. Reopened, the pull request is open
   * again at once; refused, GitHub's reason is kept on the ticket, with whether its branch is gone
   * (the next accepted submission then opens a new pull request). Returns the failure, or null.
   */
  async reopen(ticketId: string): Promise<PullRequestReopenFailure | null> {
    const row = await this.ticketWithProject(ticketId);
    if (!row || row.ticket.pullRequestNumber === null) return null;
    const { project, ticket } = row;
    const number = row.ticket.pullRequestNumber;
    const repo = repoOf(project);
    const client = await this.clientFor();
    let failure: PullRequestReopenFailure | null;
    if ('failure' in client) {
      failure = { ...client.failure, branchGone: false, at: this.now().toISOString() };
    } else {
      try {
        failure = await this.reopenWith(client.client, repo, ticket, number);
      } catch (error) {
        if (!(error instanceof GitHubUnreachableError)) throw error;
        failure = { ...unreachableFailure(), branchGone: false, at: this.now().toISOString() };
      }
    }
    if (failure !== null) await this.reopenFailed(ticketId, number, failure);
    return failure;
  }

  private async reopenWith(
    client: GitHubClient,
    repo: Repo,
    ticket: TicketRow,
    number: number,
  ): Promise<PullRequestReopenFailure | null> {
    const reopened = await reopenPullRequest(client, repo, number);
    if (reopened.ok) {
      await this.seen(ticket.id, reopened.value, 'owner');
      return null;
    }
    let branchGone = false;
    if (reopened.refusal.kind === 'invalid') {
      // Merged meanwhile (GitHub never reopens a merged one): its read records the merge.
      const read = await readPullRequest(client, repo, number);
      if (read.ok && read.value.merged) {
        await this.seen(ticket.id, read.value);
        return null;
      }
      if (read.ok) {
        const branch = await readBranchRef(client, repo, read.value.headBranch);
        branchGone = branch.ok && branch.value === null;
      }
    }
    return {
      ...pullRequestFailureOf(reopened.refusal, repo),
      branchGone,
      at: this.now().toISOString(),
    };
  }

  private async reopenFailed(
    ticketId: string,
    number: number,
    failure: PullRequestReopenFailure,
  ): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      const locked = await lockTicket(tx, ticketId);
      if (!locked || locked.ticket.pullRequestNumber !== number) return;
      const { project, ticket } = locked;
      await tx
        .update(schema.tickets)
        .set({ pullRequestReopenFailure: failure, updatedAt: this.now() })
        .where(eq(schema.tickets.id, ticketId));
      await recordEvent(tx, {
        actor: 'owner',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_not_reopened',
        payload: {
          project: project.key,
          ticket: ticketReference(project.key, ticket.number),
          number,
          reason: failure.reason,
          message: failure.message,
          branchGone: failure.branchGone,
        },
        at: this.now(),
      });
    });
  }

  private async ticketWithProject(
    ticketId: string,
  ): Promise<{ ticket: TicketRow; project: ProjectRow } | undefined> {
    const [row] = await this.options.db
      .select({ ticket: schema.tickets, project: schema.projects })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .where(eq(schema.tickets.id, ticketId));
    return row;
  }

  /** The stored token's client, or why there is none, as a failed attempt keeps it. */
  private async clientFor(): Promise<
    { client: GitHubClient } | { failure: Omit<PullRequestFailure, 'at' | 'since'> }
  > {
    try {
      const client = await storedTokenClient({ ...this.options, log: this.options.log });
      if (client !== null) return { client };
      return {
        failure: {
          reason: 'no_token',
          message: 'No GitHub token is saved: connect GitHub in Settings',
          permission: null,
          fields: [],
        },
      };
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return {
        failure: {
          reason: 'token_unreadable',
          message:
            'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings',
          permission: null,
          fields: [],
        },
      };
    }
  }

  /**
   * A read of the ticket's pull request (this watcher's, or the CI wait's): the stored state and
   * head refreshed, and a merge or a close decided, in one transaction that locks the ticket.
   */
  async seen(ticketId: string, pull: PullRequestRead, by: ReopenedBy = 'github'): Promise<void> {
    const after = await this.options.db.transaction((tx) => this.apply(tx, ticketId, pull, by));
    await after();
  }

  private async apply(
    tx: Executor,
    ticketId: string,
    pull: PullRequestRead,
    by: ReopenedBy,
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
    // GitHub's conflict fact (lot 3 step J3b), from every read that gives `mergeable`.
    const conflictBefore = storedConflict(ticket);
    const conflict = conflictAfter(ticket, pull, now);
    const conflictChanged = JSON.stringify(conflictBefore) !== JSON.stringify(conflict);
    if (ticket.pullRequestState === state && !moved && !conflictChanged) return nothing;
    const closing = ticket.pullRequestState === 'open' && state === 'closed';
    const reopening = ticket.pullRequestState === 'closed' && state === 'open';
    // Closed while **Cancel** wants it closed: the Orchestrator's close, done (lot 3 step J3a).
    const closedBy = ticket.pullRequestCloseWantedAt === null ? 'github' : 'orchestrator';
    await tx
      .update(schema.tickets)
      .set({
        pullRequestState: state,
        pullRequestHead: pull.headSha,
        pullRequestConflict: conflict,
        ...(closing
          ? {
              pullRequestClosedAt: pull.closedAt === null ? now : new Date(pull.closedAt),
              pullRequestClosedBy: closedBy,
              pullRequestCloseWantedAt: null,
              pullRequestCloseFailure: null,
            }
          : {}),
        ...(reopening
          ? {
              pullRequestClosedAt: null,
              pullRequestClosedBy: null,
              pullRequestReopenFailure: null,
              // Open again: **Check CI again**'s "No CI found" counts from now (lot 3 step G2c).
              pullRequestOpenedAt: now,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(schema.tickets.id, ticket.id));
    if (conflictChanged && conflict !== null && conflict.head !== conflictBefore?.head) {
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_conflict',
        payload: { ...facts, head: conflict.head, base: conflict.base },
        at: now,
      });
    } else if (conflictChanged && conflict === null && conflictBefore !== null) {
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_conflict_gone',
        payload: {
          ...facts,
          head: conflictBefore.head,
          base: conflictBefore.base,
          // Mergeable now, or another head GitHub has not said anything of yet.
          headMoved: conflictBefore.head !== pull.headSha,
        },
        at: now,
      });
    }
    if (closing) {
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_closed',
        payload: { ...facts, by: closedBy },
        at: now,
      });
    } else if (reopening) {
      await recordEvent(tx, {
        actor: by === 'owner' ? 'owner' : 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_reopened',
        payload: by === 'owner' ? { ...facts, owner: true } : { ...facts, seen: true },
        at: now,
      });
    } else if (!conflictChanged) {
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
        pullRequestConflict: null,
        // Merged: nothing is left to close or reopen (the cancel race, owner's answer 2).
        pullRequestClosedAt: null,
        pullRequestClosedBy: null,
        pullRequestCloseWantedAt: null,
        pullRequestCloseFailure: null,
        pullRequestReopenFailure: null,
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
    const merge = { number: pull.number, head, into: pull.baseBranch };
    if (project.defaultBranch === null || pull.baseBranch !== project.defaultBranch) {
      // Merged into another base (its base changed by hand on GitHub): the ticket is unchanged,
      // and step J3's item says where it went (owner's answer 1).
      outcome = 'other_base';
    } else if (status === 'done') {
      outcome = 'already_done';
      commentId = await comment(mergedAfterDoneComment(words));
      await cleanUpWanted(tx, project, ticket, merge);
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
      // The branch's clean-up, in the merge's transaction: once per recorded merge (step J2).
      await cleanUpWanted(tx, project, ticket, merge);
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

type Refused = (
  refusal: GitHubRefusal,
  what: string,
  numbers: readonly number[] | 'rest',
) => Date | null;

function repoOf(project: ProjectRow): Repo {
  return { owner: project.repoOwner, name: project.repoName };
}

/** **Cancel** wants the pull request closed, and nothing has changed that (lot 3 step J3a). */
function wantsClose(ticket: TicketRow): boolean {
  return (
    ticket.pullRequestCloseWantedAt !== null &&
    ticket.status === 'cancelled' &&
    ticket.pullRequestState === 'open'
  );
}

function unreachableFailure(): Omit<PullRequestFailure, 'at' | 'since'> {
  return { reason: 'unreachable', message: UNREACHABLE, permission: null, fields: [] };
}

/** The project's row lock, then the ticket's: the order of every ticket change. */
async function lockTicket(
  tx: Executor,
  ticketId: string,
): Promise<{ ticket: TicketRow; project: ProjectRow } | undefined> {
  const [current] = await tx
    .select({ projectId: schema.tickets.projectId })
    .from(schema.tickets)
    .where(eq(schema.tickets.id, ticketId));
  if (!current) return undefined;
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
  return project && ticket ? { project, ticket } : undefined;
}
