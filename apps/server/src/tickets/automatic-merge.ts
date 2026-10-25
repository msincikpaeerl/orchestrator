import { schema } from '@orchestrator/db';
import {
  AUTOMATIC_MERGE_METHOD,
  AutomaticMerge,
  maskSecrets,
  type AutomaticMergeFailureReason,
  type AutomaticMergeView,
} from '@orchestrator/protocol';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { retryAt, type GitHubRefusal } from '../github/answers.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import { mergePullRequest, readPullRequest, type PullRequest } from '../github/pull-requests.js';
import type { RepositoryRef } from '../github/repositories.js';
import type { CiRead } from '../runs/ci-wait.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { ticketEntity, ticketReference, type TicketRow } from './model.js';

// The automatic merge (04, section 4; lot 5 step 5bis B). On a project with **Merge
// automatically** on, Quality's approval marks the merge wanted in its transaction, with the
// approved commit; this task, one at a time per ticket, checks that the ticket, the pull request
// and CI on that commit still allow it, then sends GitHub's merge with that commit as `sha`, at
// most once per approval: "sent" is recorded before the request, and a lost answer is settled by
// reading the pull request. The merge found is handed to the merge detection (`seen`), which
// makes the ticket done exactly once. Before anything is sent, GitHub unreachable or its request
// limit leave the merge wanted for the next GitHub check, and **Stop new runs** on any Claude
// account holds it (owner's answer 7); any other problem fails it, with no retry.

export interface AutomaticMergerOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  /** CI on a commit read again, as the CI wait reads it (`CiWatcher.readCommit`). */
  readCommit: (
    repo: RepositoryRef,
    commit: string,
    pullRequest: number,
    startWaitOver: boolean,
  ) => Promise<CiRead>;
  /** The merge detection's record of a pull request read (`PullRequestWatcher.seen`). */
  pullRequestSeen: (ticketId: string, pull: PullRequest) => Promise<void>;
  now?: () => Date;
}

type ProjectRow = typeof schema.projects.$inferSelect;
type Failure = {
  reason: AutomaticMergeFailureReason;
  message: string;
  permission?: 'contents' | 'workflows';
};
/** What one step of a try came to: go on, wait for the next check, fail, or end quietly. */
type Step<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'wait'; message: string; until: Date | null }
  | { kind: 'fail'; failure: Failure }
  | { kind: 'drop' };

const UNREACHABLE = 'GitHub could not be reached, or answered with a server error';
const short = (commit: string) => commit.slice(0, 7);

/** The Claude accounts whose **Stop new runs** holds every automatic merge, by label. */
export async function mergesHeldBy(executor: Executor): Promise<string[]> {
  const rows = await executor
    .select({ label: schema.claudeAccounts.label })
    .from(schema.claudeAccounts)
    .where(eq(schema.claudeAccounts.state, 'paused_manual'))
    .orderBy(asc(schema.claudeAccounts.label));
  return rows.map((row) => row.label);
}

/**
 * The automatic merge as the screens show it (02, sections 4 and 6.4): once merged, and on
 * **Awaiting merge** (with what holds it while it is wanted or sent); null otherwise.
 */
export async function automaticMergeView(
  executor: Executor,
  ticket: Pick<TicketRow, 'automaticMerge' | 'status'>,
): Promise<AutomaticMergeView | null> {
  const merge = storedAutomaticMerge(ticket);
  if (merge === null) return null;
  if (merge.state === 'merged') return { merge, heldBy: [] };
  if (ticket.status !== 'awaiting_merge') return null;
  const waiting = merge.state === 'wanted' || merge.state === 'sent';
  return { merge, heldBy: waiting ? await mergesHeldBy(executor) : [] };
}

/** The stored automatic merge, or null. */
export function storedAutomaticMerge(
  ticket: Pick<TicketRow, 'automaticMerge'>,
): AutomaticMerge | null {
  return ticket.automaticMerge === null ? null : AutomaticMerge.parse(ticket.automaticMerge);
}

export class AutomaticMerger {
  private readonly queues = new Map<string, Promise<Date | null>>();

  constructor(private readonly options: AutomaticMergerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Tries the ticket's merge when it is still wanted, or settles one sent; resolves with when
   * GitHub allows requests again after its request limit (else null), never rejects.
   */
  request(ticketId: string): Promise<Date | null> {
    const before = this.queues.get(ticketId) ?? Promise.resolve(null);
    const done = before
      .then(() => this.attempt(ticketId))
      .catch((error: unknown) => {
        this.options.log.error({ err: error, ticketId }, 'automatic merge crashed');
        return null;
      })
      .finally(() => {
        if (this.queues.get(ticketId) === done) this.queues.delete(ticketId);
      });
    this.queues.set(ticketId, done);
    return done;
  }

  /**
   * At start, at each GitHub check and when an account is resumed: every merge wanted or sent,
   * one at a time; the request limit stops it.
   */
  async check(): Promise<Date | null> {
    const rows = await this.options.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(sql`${schema.tickets.automaticMerge}->>'state' IN ('wanted', 'sent')`)
      .orderBy(asc(schema.tickets.updatedAt));
    for (const { id } of rows) {
      const until = await this.request(id);
      if (until !== null) return until;
    }
    return null;
  }

  /** Resolves when no try is running. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  private async attempt(ticketId: string): Promise<Date | null> {
    const row = await this.read(ticketId);
    if (row === null) return null;
    const { ticket, project, merge } = row;
    if (merge.state !== 'wanted' && merge.state !== 'sent') return null;
    const log = this.options.log.child({
      ticket: ticketReference(project.key, ticket.number),
      pullRequest: merge.pullRequest,
    });
    const repo = { owner: project.repoOwner, name: project.repoName };
    if (merge.state === 'wanted') {
      if (!stillWanted(ticket, project, merge)) {
        await this.drop(ticketId, merge);
        return null;
      }
      if ((await mergesHeldBy(this.options.db)).length > 0) return null;
    }
    const client = await this.client();
    if (client.kind !== 'ok') {
      // Nothing can be read: a merge sent waits for a token to read it with.
      if (merge.state === 'sent') return null;
      await this.fail(ticketId, merge, client.failure);
      return null;
    }
    if (merge.state === 'sent') return this.settle(ticketId, client.value, repo, merge, log);

    const checked = await this.checked(client.value, repo, project, merge);
    if (checked.kind !== 'ok') return this.ended(ticketId, merge, checked, log);
    if (!(await this.markSent(ticketId, merge))) return null;
    const sent = { ...merge, state: 'sent' as const, sentAt: this.now().toISOString() };
    log.info({ commit: merge.commit }, 'automatic merge sent');
    try {
      const merged = await mergePullRequest(client.value, repo, merge.pullRequest, {
        sha: merge.commit,
        method: AUTOMATIC_MERGE_METHOD,
      });
      if (merged.ok && merged.value.merged) {
        await this.recordMerged(ticketId, sent, merged.value.mergeCommit);
        log.info({ mergeCommit: merged.value.mergeCommit }, 'merged automatically');
        await this.hand(ticketId, client.value, repo, merge.pullRequest);
        return null;
      }
      // An answer that cannot be read, or one saying it did not merge: the pull request tells.
      if (merged.ok || merged.refusal.kind === 'unreadable') {
        return await this.settle(ticketId, client.value, repo, sent, log);
      }
      await this.fail(ticketId, sent, mergeRefusal(merged.refusal, merge.commit));
      log.warn({ status: merged.refusal.status }, 'automatic merge refused');
      return null;
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      if (!error.sent) {
        // Never left: nothing to settle, the next check tries again.
        await this.unsent(ticketId, sent);
        return null;
      }
      return this.settle(ticketId, client.value, repo, sent, log);
    }
  }

  private async read(ticketId: string) {
    const [row] = await this.options.db
      .select({ ticket: schema.tickets, project: schema.projects })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .where(eq(schema.tickets.id, ticketId));
    if (!row) return null;
    const merge = storedAutomaticMerge(row.ticket);
    return merge === null ? null : { ...row, merge };
  }

  private async client(): Promise<
    { kind: 'ok'; value: GitHubClient } | { kind: 'fail'; failure: Failure }
  > {
    try {
      const client = await storedTokenClient({ ...this.options, log: this.options.log });
      if (client !== null) return { kind: 'ok', value: client };
      return {
        kind: 'fail',
        failure: {
          reason: 'token',
          message: 'no GitHub token is saved: connect GitHub in Settings',
        },
      };
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return {
        kind: 'fail',
        failure: {
          reason: 'token',
          message:
            'the saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings',
        },
      };
    }
  }

  /** The pull request read by itself, then CI on the approved commit read again. */
  private async checked(
    client: GitHubClient,
    repo: RepositoryRef,
    project: ProjectRow,
    merge: AutomaticMerge,
  ): Promise<Step<PullRequest>> {
    const read = await this.readPull(client, repo, merge.pullRequest);
    if (read.kind !== 'ok') return read;
    const pull = read.value;
    // Merged or closed meanwhile: the merge detection and the closed item say what follows.
    if (pull.merged || pull.state === 'closed') return { kind: 'drop' };
    const base = project.defaultBranch;
    if (pull.baseBranch !== base) {
      return fail(
        'base_changed',
        `pull request #${String(pull.number)} now goes into ${pull.baseBranch}, not the project's default branch ${base ?? ''}`,
      );
    }
    if (pull.defaultBranch !== base) {
      return fail(
        'base_changed',
        `the repository's default branch on GitHub is now ${pull.defaultBranch}, not the project's ${base}`,
      );
    }
    if (pull.headRepository?.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) {
      return fail(
        'not_project_repository',
        `pull request #${String(pull.number)} does not come from the project's repository ${repo.owner}/${repo.name}`,
      );
    }
    if (pull.headSha !== merge.commit) {
      return fail(
        'head_moved',
        `the pull request's head on GitHub (${short(pull.headSha)}) is no longer the commit Quality approved (${short(merge.commit)})`,
      );
    }
    if (pull.mergeable === false) {
      return fail('conflict', `GitHub says it conflicts with ${pull.baseBranch}`);
    }
    const ci = await this.options.readCommit(repo, merge.commit, merge.pullRequest, true);
    if (!ci.ok) {
      const { reason, message } = ci.failure;
      if (reason === 'unreachable') return { kind: 'wait', message: UNREACHABLE, until: null };
      if (reason === 'rate_limited') {
        return { kind: 'wait', message, until: ci.retryAt ?? null };
      }
      return fail(reason === 'token' ? 'token' : 'refused', `CI could not be read: ${message}`);
    }
    const { state, checks } = ci.result;
    const commit = short(merge.commit);
    if (state === 'passed') return { kind: 'ok', value: pull };
    if (state === 'no_ci') return fail('no_ci', `nothing on GitHub tested commit ${commit}`);
    if (state === 'conflict') {
      return fail('conflict', `GitHub says it conflicts with ${pull.baseBranch}`);
    }
    if (state === 'pending') {
      return fail('ci_not_passed', `CI no longer passes on commit ${commit}: it is running again`);
    }
    const failed = checks.filter((check) => check.state === 'failed').map((check) => check.name);
    return fail(
      'ci_not_passed',
      `CI no longer passes on commit ${commit}${failed.length > 0 ? `: ${failed.join(', ')} failed` : ''}`,
    );
  }

  private async readPull(
    client: GitHubClient,
    repo: RepositoryRef,
    number: number,
  ): Promise<Step<PullRequest>> {
    try {
      const read = await readPullRequest(client, repo, number);
      if (read.ok) return { kind: 'ok', value: read.value };
      return readRefusal(read.refusal, this.now());
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      return { kind: 'wait', message: UNREACHABLE, until: null };
    }
  }

  /** A merge sent whose answer was lost: the pull request read by itself decides. */
  private async settle(
    ticketId: string,
    client: GitHubClient,
    repo: RepositoryRef,
    merge: Extract<AutomaticMerge, { state: 'sent' }>,
    log: FastifyBaseLogger,
  ): Promise<Date | null> {
    const read = await this.readPull(client, repo, merge.pullRequest);
    if (read.kind === 'wait') return read.until;
    if (read.kind !== 'ok') {
      // The read was refused: whether GitHub merged it stays unknown until a read works.
      return null;
    }
    const pull = read.value;
    if (pull.merged && pull.headSha === merge.commit) {
      await this.recordMerged(ticketId, merge, null);
      log.info('merged automatically, found after a lost answer');
      await this.options.pullRequestSeen(ticketId, pull);
      return null;
    }
    await this.fail(ticketId, merge, {
      reason: 'answer_lost',
      message: "GitHub's answer to the merge was lost and the pull request is not merged",
    });
    // A pull request merged by someone else, or closed: the merge detection records it.
    if (pull.merged || pull.state === 'closed') await this.options.pullRequestSeen(ticketId, pull);
    return null;
  }

  /** After the merge: the pull request read and handed to the merge detection. */
  private async hand(ticketId: string, client: GitHubClient, repo: RepositoryRef, number: number) {
    const read = await this.readPull(client, repo, number);
    // Not read: the next GitHub check finds the merge, as for the owner's.
    if (read.kind === 'ok') await this.options.pullRequestSeen(ticketId, read.value);
  }

  private async ended(
    ticketId: string,
    merge: Extract<AutomaticMerge, { state: 'wanted' }>,
    step: Exclude<Step<unknown>, { kind: 'ok' }>,
    log: FastifyBaseLogger,
  ): Promise<Date | null> {
    if (step.kind === 'drop') {
      await this.drop(ticketId, merge);
      return null;
    }
    if (step.kind === 'wait') {
      await this.waiting(ticketId, merge, step.message);
      log.info({ until: step.until }, 'automatic merge waits for GitHub');
      return step.until;
    }
    await this.fail(ticketId, merge, step.failure);
    log.warn({ reason: step.failure.reason }, 'automatic merge failed');
    return null;
  }

  /**
   * Updates the stored merge in a transaction holding the project's and the ticket's locks, when
   * it is still the one read; `change` writes what follows and says whether it applied.
   */
  private async locked(
    ticketId: string,
    merge: AutomaticMerge,
    change: (tx: Executor, ticket: TicketRow, project: ProjectRow) => Promise<boolean>,
  ): Promise<boolean> {
    return this.options.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ projectId: schema.tickets.projectId })
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId));
      if (!current) return false;
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
      if (!project || !ticket) return false;
      const stored = storedAutomaticMerge(ticket);
      if (stored?.state !== merge.state || stored.wantedAt !== merge.wantedAt) return false;
      return change(tx, ticket, project);
    });
  }

  private async store(tx: Executor, ticketId: string, merge: AutomaticMerge | null) {
    await tx
      .update(schema.tickets)
      .set({ automaticMerge: merge === null ? null : AutomaticMerge.parse(merge) })
      .where(eq(schema.tickets.id, ticketId));
  }

  /** The owner changed something since the approval: the try ends with no event. */
  private async drop(ticketId: string, merge: AutomaticMerge): Promise<void> {
    await this.locked(ticketId, merge, async (tx) => {
      await this.store(tx, ticketId, null);
      return true;
    });
  }

  private async waiting(
    ticketId: string,
    merge: Extract<AutomaticMerge, { state: 'wanted' }>,
    message: string,
  ) {
    await this.locked(ticketId, merge, async (tx) => {
      await this.store(tx, ticketId, {
        ...merge,
        waiting: { message, at: this.now().toISOString() },
      });
      return true;
    });
  }

  /** "Sent", checked again under the locks, before the request leaves. */
  private async markSent(
    ticketId: string,
    merge: Extract<AutomaticMerge, { state: 'wanted' }>,
  ): Promise<boolean> {
    return this.locked(ticketId, merge, async (tx, ticket, project) => {
      if (!stillWanted(ticket, project, merge)) {
        await this.store(tx, ticketId, null);
        return false;
      }
      if ((await mergesHeldBy(tx)).length > 0) return false;
      const facts = factsOf(merge);
      await this.store(tx, ticketId, {
        ...facts,
        state: 'sent',
        sentAt: this.now().toISOString(),
      });
      return true;
    });
  }

  /** The request never left: wanted again, for the next check. */
  private async unsent(ticketId: string, merge: Extract<AutomaticMerge, { state: 'sent' }>) {
    await this.locked(ticketId, merge, async (tx) => {
      const facts = factsOf(merge);
      await this.store(tx, ticketId, {
        ...facts,
        state: 'wanted',
        waiting: { message: UNREACHABLE, at: this.now().toISOString() },
      });
      return true;
    });
  }

  private async recordMerged(
    ticketId: string,
    merge: Extract<AutomaticMerge, { state: 'sent' }>,
    mergeCommit: string | null,
  ): Promise<void> {
    await this.locked(ticketId, merge, async (tx, ticket, project) => {
      const at = this.now();
      const facts = factsOf(merge);
      await this.store(tx, ticketId, {
        ...facts,
        state: 'merged',
        method: AUTOMATIC_MERGE_METHOD,
        mergeCommit,
        at: at.toISOString(),
      });
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.merged_automatically',
        payload: {
          project: project.key,
          ticket: ticketReference(project.key, ticket.number),
          pullRequest: merge.pullRequest,
          commit: merge.commit,
          method: AUTOMATIC_MERGE_METHOD,
          mergeCommit,
        },
        at,
      });
      return true;
    });
  }

  private async fail(ticketId: string, merge: AutomaticMerge, failure: Failure): Promise<void> {
    await this.locked(ticketId, merge, async (tx, ticket, project) => {
      const at = this.now();
      const message = maskSecrets(failure.message);
      await this.store(tx, ticketId, {
        state: 'failed',
        pullRequest: merge.pullRequest,
        commit: merge.commit,
        wantedAt: merge.wantedAt,
        sentAt: merge.state === 'sent' ? merge.sentAt : null,
        reason: failure.reason,
        message,
        permission: failure.permission ?? null,
        at: at.toISOString(),
      });
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.automatic_merge_failed',
        payload: {
          project: project.key,
          ticket: ticketReference(project.key, ticket.number),
          pullRequest: merge.pullRequest,
          commit: merge.commit,
          reason: failure.reason,
          message,
        },
        at,
      });
      return true;
    });
  }
}

/**
 * Whether Quality's approval still wants the merge: the ticket on **Awaiting merge** with that
 * pull request open, no request for changes standing, the option on and the project active.
 */
function stillWanted(ticket: TicketRow, project: ProjectRow, merge: AutomaticMerge): boolean {
  return (
    ticket.status === 'awaiting_merge' &&
    ticket.pullRequestNumber === merge.pullRequest &&
    ticket.pullRequestState === 'open' &&
    (ticket.changeRequest === null || ticket.changeRequestAnsweredAt !== null) &&
    project.mergesAutomatic &&
    project.status === 'active'
  );
}

/** What every state of the merge keeps: the pull request, the approved commit, when wanted. */
function factsOf(merge: AutomaticMerge) {
  return { pullRequest: merge.pullRequest, commit: merge.commit, wantedAt: merge.wantedAt };
}

function fail(reason: AutomaticMergeFailureReason, message: string): Step<never> {
  return { kind: 'fail', failure: { reason, message } };
}

/** A read GitHub refused, before anything was sent: its request limit waits, else it fails. */
function readRefusal(refusal: GitHubRefusal, now: Date): Step<never> {
  const words = maskSecrets(refusal.message);
  switch (refusal.kind) {
    case 'rate_limited':
      return { kind: 'wait', message: words, until: retryAt(refusal, now) };
    case 'token_invalid':
      return fail('token', `GitHub refused the saved token: ${words}`);
    case 'permission_missing':
      return fail('permission_missing', `GitHub refused to read the pull request: ${words}`);
    default:
      return fail('refused', `GitHub refused to read the pull request: ${words}`);
  }
}

/** GitHub refused the merge itself: never sent again. */
function mergeRefusal(refusal: GitHubRefusal, commit: string): Failure {
  const words = maskSecrets(refusal.message);
  if (refusal.status === 409) {
    return {
      reason: 'head_moved',
      message: `the pull request's head on GitHub changed just before the merge: it is no longer the commit Quality approved (${short(commit)})`,
    };
  }
  if (refusal.status === 405) {
    return { reason: 'not_mergeable', message: `GitHub refused the merge: ${words}` };
  }
  switch (refusal.kind) {
    case 'permission_missing': {
      const workflows = refusal.permissions.some((permission) =>
        permission.startsWith('workflows='),
      );
      return {
        reason: 'permission_missing',
        message: `the token lacks ${workflows ? 'Workflows' : 'Contents'} (Read and write)`,
        permission: workflows ? 'workflows' : 'contents',
      };
    }
    case 'token_invalid':
      return { reason: 'token', message: `GitHub refused the saved token: ${words}` };
    case 'rate_limited':
      return { reason: 'rate_limited', message: `GitHub's request limit was reached: ${words}` };
    default:
      return { reason: 'refused', message: `GitHub refused the merge: ${words}` };
  }
}
