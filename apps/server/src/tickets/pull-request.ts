import { schema } from '@orchestrator/db';
import {
  DodReport,
  PullRequestFailure,
  maskSecrets,
  type PullRequestFailureReason,
} from '@orchestrator/protocol';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Templates } from '../agents/files.js';
import type { Database } from '../database.js';
import { recordEvent } from '../events.js';
import type { GitHubRefusal, GitHubResult } from '../github/answers.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import {
  findPullRequests,
  openPullRequest,
  reopenPullRequest,
  updatePullRequest,
  type PullRequest,
} from '../github/pull-requests.js';
import { pullRequestBody, pullRequestTitle, ticketLink } from '../github/pull-request-text.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { acceptanceCriteria, ticketEntity, ticketReference } from './model.js';

// The ticket's pull request (04, section 3.1; lot 3 step F3), opened or updated after an accepted
// submission, never inside the agent's tool call. The submission marks the ticket "pull request
// wanted"; this task, one per ticket at a time, then finds the pull request by its branch and
// opens, reopens or updates it, and records the result. It runs again on **Try again** and once
// for every ticket still waiting at each server start.

const FINISHED = ['done', 'cancelled'];

export interface PullRequestOpenerOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  publicUrl: string;
  templates: () => Promise<Templates>;
  now?: () => Date;
}

type Done =
  | { action: 'opened'; pull: PullRequest; notReopened?: number }
  | { action: 'reopened' | 'updated'; pull: PullRequest };

type Outcome = { ok: true; done: Done } | { ok: false; failure: Omit<PullRequestFailure, 'at'> };

/** The failure to keep for a refusal of GitHub's: its words, masked, and what the owner can do. */
export function failureOf(
  refusal: GitHubRefusal,
  repo: { owner: string; name: string },
): Omit<PullRequestFailure, 'at'> {
  const base = { message: maskSecrets(refusal.message), permission: null, fields: [] };
  const reason: Record<GitHubRefusal['kind'], PullRequestFailureReason> = {
    token_invalid: 'token_invalid',
    permission_missing: 'permission_missing',
    rate_limited: 'rate_limited',
    unreadable: 'unreadable',
    not_found: 'refused',
    invalid: 'refused',
    unexpected: 'refused',
  };
  switch (refusal.kind) {
    case 'permission_missing': {
      // Every request of this task is a pull request one: a refusal naming no permission is too.
      const named =
        refusal.permissions.length === 0 ||
        refusal.permissions.some((permission) => permission.startsWith('pull_requests='));
      return { ...base, reason: 'permission_missing', permission: named ? 'pull_requests' : null };
    }
    case 'unreadable':
      return { ...base, reason: 'unreadable', fields: refusal.fields };
    case 'not_found':
      return {
        ...base,
        reason: 'refused',
        message: `GitHub answered "${base.message}" for the repository ${repo.owner}/${repo.name}: it was deleted or renamed, or the saved token cannot see it`,
      };
    default:
      return { ...base, reason: reason[refusal.kind] };
  }
}

export class PullRequestOpener {
  private readonly queues = new Map<string, { again: boolean; done: Promise<void> }>();

  constructor(private readonly options: PullRequestOpenerOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * Starts an attempt for the ticket, or one more after the one running (a later submission, a
   * **Try again**). Resolves when the ticket has no attempt left to make; never rejects.
   */
  request(ticketId: string): Promise<void> {
    const queued = this.queues.get(ticketId);
    if (queued) {
      queued.again = true;
      return queued.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    // Set by a request while an attempt runs.
    const again = () => entry.again;
    this.queues.set(ticketId, entry);
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await this.attempt(ticketId).catch((error: unknown) => {
            this.options.log.error({ err: error, ticketId }, 'pull request attempt crashed');
          });
        } while (again());
      } finally {
        this.queues.delete(ticketId);
      }
    })();
    return entry.done;
  }

  /** At start: one attempt for every ticket still waiting for its pull request, one at a time. */
  async retryWanted(): Promise<void> {
    const waiting = await this.options.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(
        and(
          isNotNull(schema.tickets.pullRequestWantedSince),
          notInArray(schema.tickets.status, FINISHED),
        ),
      );
    for (const { id } of waiting) await this.request(id);
  }

  /** Resolves when no attempt is running. */
  async idle(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()].map((q) => q.done));
  }

  private async attempt(ticketId: string): Promise<void> {
    const { db } = this.options;
    const [row] = await db
      .select({ ticket: schema.tickets, project: schema.projects })
      .from(schema.tickets)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .where(eq(schema.tickets.id, ticketId));
    if (!row) return;
    const { ticket, project } = row;
    const wanted = ticket.pullRequestWantedSince;
    if (wanted === null || FINISHED.includes(ticket.status)) return;
    const reference = ticketReference(project.key, ticket.number);
    const log = this.options.log.child({ ticket: reference });
    const report = DodReport.safeParse(ticket.dodReport);
    if (!report.success || ticket.branchName === null || project.defaultBranch === null) {
      log.error('pull request wanted without a report, a branch or a default branch');
      return;
    }
    const templates = await this.options.templates();
    const template = templates['pull-request'];
    const title = pullRequestTitle(template, { number: reference, title: ticket.title });
    const body = pullRequestBody(template, {
      number: reference,
      criteria: acceptanceCriteria(ticket),
      report: report.data,
      workflowChanges: ticket.workflowChanges === true,
      link: ticketLink(this.options.publicUrl, project.key, ticket.number),
    });
    const outcome = await this.openOrUpdate(
      { owner: project.repoOwner, name: project.repoName },
      { branch: ticket.branchName, base: project.defaultBranch, title, body },
    );
    if (outcome.ok) {
      log.info(
        { pullRequest: outcome.done.pull.number, action: outcome.done.action },
        'pull request done',
      );
    } else {
      log.warn(
        { reason: outcome.failure.reason, fields: outcome.failure.fields },
        'pull request not opened',
      );
    }
    await this.record(ticketId, wanted, outcome);
  }

  /** Finds the pull request by its branch, then updates, reopens or opens one. */
  private async openOrUpdate(
    repo: { owner: string; name: string },
    pull: { branch: string; base: string; title: string; body: string },
  ): Promise<Outcome> {
    let client: GitHubClient | null;
    try {
      client = await storedTokenClient({ ...this.options, log: this.options.log });
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return {
        ok: false,
        failure: {
          reason: 'token_unreadable',
          message:
            'The saved GitHub token cannot be decrypted (ORCHESTRATOR_SECRET_KEY changed): save the token again in Settings',
          permission: null,
          fields: [],
        },
      };
    }
    if (client === null) {
      return {
        ok: false,
        failure: {
          reason: 'no_token',
          message: 'No GitHub token is saved: connect GitHub in Settings',
          permission: null,
          fields: [],
        },
      };
    }
    try {
      return await this.withClient(client, repo, pull);
    } catch (error) {
      if (!(error instanceof GitHubUnreachableError)) throw error;
      return {
        ok: false,
        failure: {
          reason: 'unreachable',
          message: 'GitHub could not be reached, or answered with a server error',
          permission: null,
          fields: [],
        },
      };
    }
  }

  private async withClient(
    client: GitHubClient,
    repo: { owner: string; name: string },
    pull: { branch: string; base: string; title: string; body: string },
  ): Promise<Outcome> {
    const failed = (refusal: GitHubRefusal): Outcome => ({
      ok: false,
      failure: failureOf(refusal, repo),
    });
    const update = async (number: number, action: 'reopened' | 'updated'): Promise<Outcome> => {
      const updated = await updatePullRequest(client, repo, number, {
        title: pull.title,
        body: pull.body,
      });
      return updated.ok
        ? { ok: true, done: { action, pull: updated.value } }
        : failed(updated.refusal);
    };
    // GitHub's "already exists" means one was opened meanwhile: look again, once.
    for (let look = 0; look < 2; look++) {
      const found = await findPullRequests(client, repo, pull.branch, 'all');
      if (!found.ok) return failed(found.refusal);
      const open = found.value.find((each) => each.state === 'open');
      if (open) return update(open.number, 'updated');
      // Only the newest counts (owner's answer 1, lot 3 step F3).
      const newest = [...found.value].sort((a, b) => b.number - a.number)[0];
      let notReopened: number | undefined;
      if (newest && newest.mergedAt === null) {
        const reopened: GitHubResult<PullRequest> = await reopenPullRequest(
          client,
          repo,
          newest.number,
        );
        if (reopened.ok) return update(newest.number, 'reopened');
        if (reopened.refusal.kind !== 'invalid') return failed(reopened.refusal);
        // GitHub refused to reopen it: a new one (owner's answer 2).
        notReopened = newest.number;
      }
      const opened = await openPullRequest(client, repo, {
        head: pull.branch,
        base: pull.base,
        title: pull.title,
        body: pull.body,
      });
      if (opened.ok) {
        return {
          ok: true,
          done: {
            action: 'opened',
            pull: opened.value,
            ...(notReopened === undefined ? {} : { notReopened }),
          },
        };
      }
      const exists =
        opened.refusal.kind === 'invalid' && /already exists/i.test(opened.refusal.message);
      if (!exists) return failed(opened.refusal);
    }
    return {
      ok: false,
      failure: {
        reason: 'refused',
        message:
          'GitHub says a pull request already exists for the branch, but none was found by it',
        permission: null,
        fields: [],
      },
    };
  }

  /** Keeps the result on the ticket, with its event. */
  private async record(ticketId: string, wanted: Date, outcome: Outcome): Promise<void> {
    const at = this.now();
    await this.options.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ ticket: schema.tickets, projectKey: schema.projects.key })
        .from(schema.tickets)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
        .where(eq(schema.tickets.id, ticketId));
      if (!current) return;
      // The project's row lock first, then the ticket's: the order of every ticket change.
      await tx
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, current.ticket.projectId))
        .for('no key update');
      const [ticket] = await tx
        .select()
        .from(schema.tickets)
        .where(eq(schema.tickets.id, ticketId))
        .for('update');
      if (!ticket) return;
      const facts = {
        project: current.projectKey,
        ticket: ticketReference(current.projectKey, ticket.number),
      };
      if (outcome.ok) {
        const { pull } = outcome.done;
        // A later submission wants it again: its own attempt follows.
        const same = ticket.pullRequestWantedSince?.getTime() === wanted.getTime();
        await tx
          .update(schema.tickets)
          .set({
            pullRequestNumber: pull.number,
            pullRequestUrl: pull.url,
            pullRequestState: pull.merged ? 'merged' : pull.state,
            pullRequestHead: pull.headSha,
            pullRequestFailure: null,
            ...(same ? { pullRequestWantedSince: null } : {}),
            updatedAt: at,
          })
          .where(eq(schema.tickets.id, ticketId));
        const payload = { ...facts, number: pull.number, url: pull.url };
        await recordEvent(tx, {
          actor: 'system',
          ...ticketEntity(ticket),
          ...(outcome.done.action === 'opened'
            ? {
                type: 'ticket.pull_request_opened',
                payload: {
                  ...payload,
                  ...(outcome.done.notReopened === undefined
                    ? {}
                    : { notReopened: outcome.done.notReopened }),
                },
              }
            : outcome.done.action === 'reopened'
              ? { type: 'ticket.pull_request_reopened', payload }
              : { type: 'ticket.pull_request_updated', payload }),
          at,
        });
        return;
      }
      // Done or cancelled meanwhile: nothing more to ask of the owner.
      if (ticket.pullRequestWantedSince === null || FINISHED.includes(ticket.status)) return;
      const failure: PullRequestFailure = { ...outcome.failure, at: at.toISOString() };
      await tx
        .update(schema.tickets)
        .set({ pullRequestFailure: failure, updatedAt: at })
        .where(eq(schema.tickets.id, ticketId));
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.pull_request_not_opened',
        payload: { ...facts, reason: failure.reason, message: failure.message },
        at,
      });
    });
  }
}
