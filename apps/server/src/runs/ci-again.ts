import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  ProjectKey,
  SubmissionRecord,
  maskSecrets,
  type CheckCiAgainRefusal,
  type CheckCiAgainResponse,
  type EventPayload,
} from '@orchestrator/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { timestamp } from '../agents/messages.js';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { GitHubUnreachableError } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import { readPullRequest } from '../github/pull-requests.js';
import { HttpError } from '../http.js';
import { notifyChange } from '../realtime/changes.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { ticketEntity, ticketReference, type TicketRow } from '../tickets/model.js';
import { applyRunAction } from '../tickets/transitions.js';
import { checkCiAgainOffered, ciOutcome, ciSourceRun } from './ci-outcome.js';
import type { CiRead } from './ci-wait.js';
import type { RunRow } from './model.js';

// **Check CI again** (04, section 3.1; owner's answer 6 of step G2 and answers of steps G2b and
// G2c): after `ci_timeout` without a conflict, or `ci_failed` on a failure, it reads the run's
// commit on GitHub once, even a finished result, so it also reads a re-run made by hand there.
// Passed or "No CI found" accept the stored submission without a session; anything else changes
// nothing. Each press writes `ticket.ci_checked_again`.

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);

export interface CiCheckAgainOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  /** The CI watcher's reading of a commit, as a check after **Wait for CI to start**. */
  readCommit: (
    repo: { owner: string; name: string },
    commit: string,
    pullRequest: number,
  ) => Promise<CiRead>;
  now?: () => Date;
}

type ProjectRow = typeof schema.projects.$inferSelect;
type Outcome = EventPayload<'ticket.ci_checked_again'>['outcome'];

class Refused extends Error {
  constructor(
    readonly refusal: CheckCiAgainRefusal,
    message: string,
  ) {
    super(message);
  }
}

const reference = (project: ProjectRow, ticket: TicketRow) =>
  ticketReference(project.key, ticket.number);

export class CiCheckAgain {
  constructor(private readonly options: CiCheckAgainOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async check(projectKey: string, number: number, runId: string): Promise<CheckCiAgainResponse> {
    const { db } = this.options;
    const key = ProjectKey.safeParse(projectKey);
    const [project] = key.success
      ? await db.select().from(schema.projects).where(eq(schema.projects.key, key.data))
      : [];
    if (!project) throw new HttpError(404, 'project_not_found', 'No project with this key');
    if (project.status === 'archived') {
      throw new HttpError(
        409,
        'project_archived',
        'This project is archived and read-only: unarchive it first',
      );
    }
    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(and(eq(schema.tickets.projectId, project.id), eq(schema.tickets.number, number)));
    if (!ticket) {
      throw new HttpError(404, 'ticket_not_found', 'No ticket with this number in this project');
    }
    const [run] = await db
      .select()
      .from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.ticketId, ticket.id)));
    if (!run) throw new HttpError(404, 'run_not_found', 'No run with this id for this ticket');
    const commit = run.ciCommit ?? '';

    try {
      await this.refusal(db, project, ticket, run);
      const pullRequest = ticket.pullRequestNumber ?? 0;
      const read = await this.read(project, ticket, commit, pullRequest);
      if (read.outcome !== 'accepted') {
        await this.event(db, project, ticket, run, read.outcome, read.facts);
        return read.answer;
      }
      return await this.accept(project, ticket.id, run, read.state);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      await this.event(db, project, ticket, run, 'refused', {
        refusal: error.refusal,
        message: error.message,
      });
      throw new HttpError(409, 'ci_check_refused', error.message, { ciRefusal: error.refusal });
    }
  }

  /** The refusals that need no GitHub: a run active, newer work, not offered, no pull request. */
  private async refusal(
    executor: Executor,
    project: ProjectRow,
    ticket: TicketRow,
    run: RunRow,
  ): Promise<void> {
    const name = reference(project, ticket);
    const active = await executor
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.ticketId, ticket.id), inArray(schema.runs.status, [...ACTIVE])));
    if (active.length > 0) {
      throw new Refused(
        'run_active',
        `A run is working on ${name}: its own submission will be checked.`,
      );
    }
    const source = await ciSourceRun(executor, ticket.id);
    if (source !== null && source.id !== run.id && source.createdAt > run.createdAt) {
      const at = source.submission === null ? null : SubmissionRecord.parse(source.submission).at;
      if (at !== null) {
        throw new Refused(
          'newer_work',
          `${name} has newer work, accepted on ${timestamp(new Date(at))}: its own CI decides.`,
        );
      }
    }
    const outcome = ciOutcome(run);
    if (
      source?.id !== run.id ||
      outcome === null ||
      ticket.status !== 'todo' ||
      !checkCiAgainOffered(outcome)
    ) {
      throw new Refused(
        'not_offered',
        `Check CI again is offered only when CI did not finish or failed for ${name}'s latest work, not accepted since: Run now continues the work.`,
      );
    }
    if (ticket.pullRequestNumber === null || run.ciWaitStartedAt === null) {
      throw new Refused(
        'no_pull_request',
        `${name} has no pull request on GitHub yet: Try again in "Pull request not opened" opens it.`,
      );
    }
  }

  /** The pull request, then the commit's CI: what was found, or a refusal. */
  private async read(
    project: ProjectRow,
    ticket: TicketRow,
    commit: string,
    pullRequest: number,
  ): Promise<
    | { outcome: 'accepted'; state: 'passed' | 'no_ci' }
    | {
        outcome: Exclude<Outcome, 'accepted' | 'refused'>;
        answer: CheckCiAgainResponse;
        facts: { message?: string };
      }
  > {
    const problem = (message: string) => ({
      outcome: 'github_problem' as const,
      answer: { outcome: 'github_problem' as const, message },
      facts: { message },
    });
    const repo = { owner: project.repoOwner, name: project.repoName };
    let client;
    try {
      client = await storedTokenClient({ ...this.options, log: this.options.log });
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return problem(
        'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings',
      );
    }
    if (client === null) return problem('No GitHub token is saved: connect GitHub in Settings');
    let pull;
    try {
      pull = await readPullRequest(client, repo, pullRequest);
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      return problem('GitHub could not be reached, or answered with a server error');
    }
    if (!pull.ok) return problem(maskSecrets(pull.refusal.message));
    if (pull.value.merged) {
      throw new Refused(
        'pull_request_merged',
        `Pull request #${String(pullRequest)} was merged on GitHub. Use Mark as done manually.`,
      );
    }
    if (pull.value.state === 'closed') {
      throw new Refused(
        'pull_request_closed',
        `Pull request #${String(pullRequest)} is closed on GitHub, so the work cannot be accepted.`,
      );
    }
    if (pull.value.headSha !== commit) {
      throw new Refused(
        'branch_moved',
        `The branch changed on GitHub after commit ${commit.slice(0, 7)} (it is now ${pull.value.headSha.slice(0, 7)}), so this result would not be about the latest work. Run now hands the work in again.`,
      );
    }
    const read = await this.options.readCommit(repo, commit, pullRequest);
    if (!read.ok) return problem(read.failure.message);
    const { result } = read;
    switch (result.state) {
      case 'passed':
      case 'no_ci':
        return { outcome: 'accepted', state: result.state };
      case 'failed': {
        const checks = result.checks.map(({ kind, name, state, url }) => ({
          kind,
          name,
          state,
          url,
        }));
        return { outcome: 'failed', answer: { outcome: 'failed', checks }, facts: {} };
      }
      case 'conflict': {
        const base = project.defaultBranch ?? 'the base branch';
        return { outcome: 'conflict', answer: { outcome: 'conflict', base }, facts: {} };
      }
      case 'pending': {
        const total = result.checks.length;
        const finished = result.checks.filter((check) => check.state !== 'pending').length;
        return {
          outcome: 'not_finished',
          answer: { outcome: 'not_finished', finished, total, at: this.now().toISOString() },
          facts: {},
        };
      }
    }
  }

  /**
   * The stored submission accepted: the ticket to `in_review` with its comment, after `ci_failed`
   * that run's failed attempt taken back, the run marked accepted later. Checked again under the
   * project's lock: nothing changed since the reading.
   */
  private async accept(
    project: ProjectRow,
    ticketId: string,
    run: RunRow,
    state: 'passed' | 'no_ci',
  ): Promise<CheckCiAgainResponse> {
    return this.options.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, project.id))
        .for('no key update');
      const [ticket] = await tx
        .select()
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId));
      const [current] = await tx.select().from(schema.runs).where(eq(schema.runs.id, run.id));
      if (!ticket || !current) throw new Error('ticket or run disappeared');
      await this.refusal(tx, project, ticket, current);
      const now = this.now();
      const commit = current.ciCommit ?? '';
      const attemptTakenBack = current.failureReason === 'ci_failed';
      const workflow = state === 'no_ci' && ticket.workflowChanges;
      const comment = [
        state === 'passed'
          ? `CI passed on GitHub for commit ${commit.slice(0, 7)} (checked again by the owner at ${timestamp(now)}): the work was accepted without a session${attemptTakenBack ? ', and the failed attempt of that run no longer counts' : ''}.`
          : `No CI found on GitHub for commit ${commit.slice(0, 7)} (checked again by the owner at ${timestamp(now)}): the work was accepted without a session${attemptTakenBack ? ', and the failed attempt of that run no longer counts' : ''}.`,
        ...(workflow
          ? [
              'The work changed workflow files: the agent may have removed or weakened CI. Read the changes in .github/workflows/ before merging.',
            ]
          : []),
      ].join(' ');
      await tx
        .update(schema.runs)
        .set({
          ciAcceptedLater: { at: now.toISOString(), state, attemptTakenBack },
          updatedAt: now,
        })
        .where(eq(schema.runs.id, current.id));
      await notifyChange(tx, { entity: 'run', id: current.id, projectId: project.id });
      await applyRunAction(tx, {
        projectKey: project.key,
        ticket,
        action: 'ci_checked_again',
        actor: 'owner',
        runId: current.id,
        attemptTakenBack,
        comment,
        now,
      });
      await this.event(tx, project, ticket, current, 'accepted', { state, attemptTakenBack });
      this.options.log.info(
        { project: project.key, ticket: ticket.number, run: current.id, state },
        'work accepted by Check CI again',
      );
      return { outcome: 'accepted', state, attemptTakenBack };
    });
  }

  private async event(
    executor: Executor,
    project: ProjectRow,
    ticket: TicketRow,
    run: RunRow,
    outcome: Outcome,
    facts: Partial<EventPayload<'ticket.ci_checked_again'>>,
  ): Promise<void> {
    await recordEvent(executor, {
      actor: 'owner',
      ...ticketEntity(ticket),
      type: 'ticket.ci_checked_again',
      payload: {
        project: project.key,
        ticket: reference(project, ticket),
        runId: run.id,
        commit: run.ciCommit ?? ciOutcome(run)?.commit ?? '',
        outcome,
        ...facts,
      },
      at: this.now(),
    });
  }
}
