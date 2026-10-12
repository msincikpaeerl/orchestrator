import { randomUUID } from 'node:crypto';
import { schema } from '@orchestrator/db';
import {
  BranchCleanUpFailure,
  BranchCleanUpState,
  BranchKeptReason,
  BranchPushedAgain,
  PROTOCOL_VERSION,
  ServerMessage,
  isTicketBranchName,
  type BranchCleanUpWait,
  type BranchDeleteResult,
  type MachineBranchCleanUp,
  type MachineCleanUpWait,
  type TicketBranchCleanUp,
} from '@orchestrator/protocol';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { retryAt, type GitHubRefusal } from '../github/answers.js';
import { GitHubUnreachableError, type GitHubClient } from '../github/client.js';
import { storedTokenClient } from '../github/connection.js';
import {
  listOpenPullRequestsUsing,
  readBranchRef,
  readPullRequest,
} from '../github/pull-requests.js';
import { notifyChange } from '../realtime/changes.js';
import { SecretUnreadableError, type SecretKey } from '../secrets.js';
import { resolveSettings } from '../settings/store.js';
import { deleteMergedTicketBranch, ownRefusal, type OwnRefusal } from './branch-delete.js';
import { ticketEntity, ticketReference, type TicketRow } from './model.js';

// The clean-up after a merge on GitHub (04, section 4; owner's answer 5 of lot 3 step J and the
// answers of step J2). A merge into the default branch recorded with the ticket `done` (or done
// already) writes "clean-up wanted" in the same transaction, with its own copy of the merge's
// facts; at every **GitHub check interval**, after the CI waits, each one wanted is tried again
// from fresh reads: nothing is decided from what an earlier try saw. It waits first for the end
// of every run of the ticket that could still push. Any doubt or failed read keeps the branch.
// On the machines (step J2b), one row per machine whose runs had the branch: once that machine's
// runs of the ticket reported their end, it gets `branch.delete` while connected, the same
// message each time until it answers; the daemon checks everything again itself.

type ProjectRow = typeof schema.projects.$inferSelect;
type CleanUpRow = typeof schema.branchCleanUps.$inferSelect;
type MachineRow = typeof schema.machines.$inferSelect;

/** The merge's facts the clean-up keeps its own copy of. */
export interface RecordedMerge {
  number: number;
  head: string;
  into: string;
}

/**
 * "Clean-up wanted" for the ticket's recorded merge into the default branch, in the caller's
 * transaction: once per recorded merge, whoever asks twice (the database's uniqueness, owner's
 * addition). Nothing for a merge into another base, or a ticket without a branch.
 */
export async function cleanUpWanted(
  tx: Executor,
  project: Pick<ProjectRow, 'defaultBranch'>,
  ticket: Pick<TicketRow, 'id' | 'branchName'>,
  merge: RecordedMerge,
): Promise<void> {
  if (project.defaultBranch === null || merge.into !== project.defaultBranch) return;
  if (ticket.branchName === null) return;
  const facts = {
    ticketId: ticket.id,
    pullRequestNumber: merge.number,
    branch: ticket.branchName,
    mergedHead: merge.head,
    mergedInto: merge.into,
    defaultBranch: project.defaultBranch,
  };
  await tx
    .insert(schema.branchCleanUps)
    .values({ ...facts, target: 'github' })
    .onConflictDoNothing();
  // Every machine where a run of the ticket that works on its branch started: the run stopped by
  // the merge reports the branch only at its end, which the machine's row waits for.
  const started = await tx
    .select({ id: schema.runs.machineId })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.ticketId, ticket.id),
        ne(schema.runs.purpose, 'review'),
        isNotNull(schema.runs.acknowledgedAt),
      ),
    );
  const machines = [...new Set(started.map((run) => run.id))];
  if (machines.length === 0) return;
  await tx
    .insert(schema.branchCleanUps)
    .values(machines.map((machineId) => ({ ...facts, target: 'machine', machineId })))
    .onConflictDoNothing();
}

/**
 * The ticket's runs that could still push the branch, which the clean-up waits for (owner's
 * answer 1): started (acknowledged by their machine), not review runs, their end not reported
 * and not reported missing by their machine at its reconnection, on a machine neither revoked
 * nor enrolled again since the run started (such a run never gets a push credential again).
 */
export async function runsThatCanPush(
  db: Executor,
  ticketId: string,
  machineId?: string,
): Promise<BranchCleanUpWait[]> {
  const rows = await db
    .select({
      runId: schema.runs.id,
      machineId: schema.machines.id,
      name: schema.machines.name,
      status: schema.machines.status,
      lastHeartbeatAt: schema.machines.lastHeartbeatAt,
    })
    .from(schema.runs)
    .innerJoin(schema.machines, eq(schema.machines.id, schema.runs.machineId))
    .where(
      and(
        eq(schema.runs.ticketId, ticketId),
        ...(machineId === undefined ? [] : [eq(schema.runs.machineId, machineId)]),
        ne(schema.runs.purpose, 'review'),
        isNotNull(schema.runs.acknowledgedAt),
        isNull(schema.runs.endReportedAt),
        isNull(schema.runs.endMissingAt),
        isNull(schema.machines.revokedAt),
        isNotNull(schema.machines.enrolledAt),
        lte(schema.machines.enrolledAt, schema.runs.createdAt),
      ),
    )
    .orderBy(asc(schema.runs.createdAt));
  return rows.map((row) => ({
    runId: row.runId,
    machine: { id: row.machineId, name: row.name },
    offlineSince: row.status === 'online' ? null : (row.lastHeartbeatAt?.toISOString() ?? null),
  }));
}

/** The ticket page's facts: the clean-up of the latest recorded merge; null when none. */
export async function ticketBranchCleanUp(
  db: Executor,
  ticketId: string,
): Promise<TicketBranchCleanUp | null> {
  const [row] = await db
    .select()
    .from(schema.branchCleanUps)
    .where(
      and(eq(schema.branchCleanUps.ticketId, ticketId), eq(schema.branchCleanUps.target, 'github')),
    )
    .orderBy(desc(schema.branchCleanUps.createdAt))
    .limit(1);
  if (!row) return null;
  const state = BranchCleanUpState.parse(row.state);
  return {
    branch: row.branch,
    pullRequest: row.pullRequestNumber,
    mergedHead: row.mergedHead,
    state,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason === null ? null : BranchKeptReason.parse(row.reason),
    waitingFor: state === 'wanted' ? await runsThatCanPush(db, ticketId) : [],
    failure:
      state === 'wanted' && row.failure !== null ? BranchCleanUpFailure.parse(row.failure) : null,
    pushedAgain: row.pushedAgain === null ? null : BranchPushedAgain.parse(row.pushedAgain),
    machines: await machineCleanUps(db, ticketId, row.pullRequestNumber),
  };
}

/** The same merge's clean-up on each machine, by machine name (lot 3 step J2b). */
async function machineCleanUps(
  db: Executor,
  ticketId: string,
  pullRequest: number,
): Promise<MachineBranchCleanUp[]> {
  const rows = await db
    .select({ cleanUp: schema.branchCleanUps, machine: schema.machines })
    .from(schema.branchCleanUps)
    .innerJoin(schema.machines, eq(schema.machines.id, schema.branchCleanUps.machineId))
    .where(
      and(
        eq(schema.branchCleanUps.ticketId, ticketId),
        eq(schema.branchCleanUps.target, 'machine'),
        eq(schema.branchCleanUps.pullRequestNumber, pullRequest),
      ),
    )
    .orderBy(asc(schema.machines.name));
  const found: MachineBranchCleanUp[] = [];
  for (const { cleanUp, machine } of rows) {
    const state = BranchCleanUpState.parse(cleanUp.state);
    const wanted = state === 'wanted';
    const offline = wanted && machine.status !== 'online';
    found.push({
      machine: { id: machine.id, name: machine.name },
      state,
      decidedAt: cleanUp.decidedAt?.toISOString() ?? null,
      reason: cleanUp.reason === null ? null : BranchKeptReason.parse(cleanUp.reason),
      waiting: wanted ? await machineWait(db, ticketId, cleanUp, machine) : null,
      offlineSince: offline ? (machine.lastHeartbeatAt?.toISOString() ?? null) : null,
      sentAt: cleanUp.sentAt?.toISOString() ?? null,
    });
  }
  return found;
}

/** What a machine's clean-up still wanted waits for, as the ticket page says it. */
async function machineWait(
  db: Executor,
  ticketId: string,
  cleanUp: CleanUpRow,
  machine: MachineRow,
): Promise<MachineCleanUpWait> {
  if ((await runsThatCanPush(db, ticketId, machine.id)).length > 0) return 'runs_ending';
  if (outdated(machine)) return 'daemon_outdated';
  if (machine.revokedAt === null && machine.status !== 'online') return 'offline';
  return cleanUp.sentAt === null ? 'next_check' : 'answer';
}

/** A daemon of an earlier protocol, which does not know `branch.delete` (0.3.0). */
function outdated(machine: MachineRow): boolean {
  return machine.protocolVersion === null || machine.protocolVersion < PROTOCOL_VERSION;
}

/**
 * A push of the ticket branch recorded (a submission's or a run end's), in its transaction: when
 * the branch was deleted on GitHub after the ticket's merge (or found gone) and the ticket is
 * still done with that merge, the branch is on GitHub again. It is kept and never deleted a
 * second time, with its event (owner's answer 2).
 */
export async function branchPushedAgain(
  tx: Executor,
  input: {
    project: { key: string };
    ticketId: string;
    branch: string;
    machine: string;
    head: string;
    now: Date;
  },
): Promise<void> {
  const [ticket] = await tx
    .select()
    .from(schema.tickets)
    .where(eq(schema.tickets.id, input.ticketId));
  if (ticket?.status !== 'done' || ticket.pullRequestNumber === null) return;
  const [row] = await tx
    .select()
    .from(schema.branchCleanUps)
    .where(
      and(
        eq(schema.branchCleanUps.ticketId, ticket.id),
        eq(schema.branchCleanUps.target, 'github'),
        eq(schema.branchCleanUps.pullRequestNumber, ticket.pullRequestNumber),
        eq(schema.branchCleanUps.branch, input.branch),
        inArray(schema.branchCleanUps.state, ['deleted', 'already_gone']),
        isNull(schema.branchCleanUps.pushedAgain),
      ),
    )
    .for('update');
  if (!row) return;
  const pushedAgain: BranchPushedAgain = {
    machine: input.machine,
    head: input.head,
    at: input.now.toISOString(),
  };
  await tx
    .update(schema.branchCleanUps)
    .set({ pushedAgain })
    .where(eq(schema.branchCleanUps.id, row.id));
  await recordEvent(tx, {
    actor: 'system',
    ...ticketEntity(ticket),
    type: 'ticket.branch_pushed_again',
    payload: {
      project: input.project.key,
      ticket: ticketReference(input.project.key, ticket.number),
      branch: row.branch,
      pullRequest: row.pullRequestNumber,
      machine: input.machine,
      head: input.head,
    },
    at: input.now,
  });
}

/** The daemon connections, which `branch.delete` goes through (the daemon gateway). */
export interface DaemonLink {
  send(machineId: string, message: ServerMessage): boolean;
  isConnected(machineId: string): boolean;
}

export interface BranchCleanUpOptions {
  db: Database;
  key: SecretKey;
  apiUrl: string;
  log: FastifyBaseLogger;
  /** Without it, nothing is sent to the machines (tests of the GitHub side alone). */
  daemons?: DaemonLink;
  now?: () => Date;
}

/** How a try ended: a decision, a failure tried again at the next check, or a wait. */
type Outcome =
  | { decided: 'deleted' | 'already_gone' }
  | { decided: 'kept'; reason: BranchKeptReason }
  | { failure: Omit<BranchCleanUpFailure, 'at'>; until?: Date | null }
  | { waiting: true };

const OWN_REASONS: Record<OwnRefusal, BranchKeptReason> = {
  default_branch: { kind: 'protected_name', which: 'default_branch' },
  base: { kind: 'protected_name', which: 'base' },
  not_a_ticket_branch: { kind: 'not_a_ticket_branch' },
  // The ticket's merge is no longer recorded as it was: another pull request's now, or none.
  merge_not_recorded: { kind: 'another_pull_request', number: null },
};

const kept = (reason: BranchKeptReason): Outcome => ({ decided: 'kept', reason });

/**
 * Whether the ticket is no longer done with the merge the row was written for: the reason to keep
 * the branch, or null when it still is.
 */
function ticketChanged(
  ticket: TicketRow | undefined,
  cleanUp: CleanUpRow,
): BranchKeptReason | null {
  if (!ticket || ticket.status !== 'done') return { kind: 'ticket_reopened' };
  if (
    ticket.pullRequestNumber !== cleanUp.pullRequestNumber ||
    ticket.pullRequestMergedAt === null ||
    ticket.pullRequestMergedHead !== cleanUp.mergedHead ||
    ticket.pullRequestMergedInto !== cleanUp.mergedInto
  ) {
    return {
      kind: 'another_pull_request',
      number:
        ticket.pullRequestNumber === cleanUp.pullRequestNumber ? null : ticket.pullRequestNumber,
    };
  }
  return null;
}

/** A machine's answer as the row keeps it. */
function machineOutcome(answer: BranchDeleteResult['payload']): MachineDecision {
  switch (answer.outcome) {
    case 'deleted':
      return { decided: 'deleted', notFound: null };
    case 'not_found':
      return { decided: 'already_gone', notFound: answer.what };
    case 'kept':
      return { decided: 'kept', reason: { kind: 'local_head_differs', head: answer.head } };
    case 'in_use':
      return { decided: 'kept', reason: { kind: 'in_use', by: answer.by } };
    case 'not_a_ticket_branch':
      return { decided: 'kept', reason: { kind: 'not_a_ticket_branch' } };
  }
}

/** How a machine's clean-up ended. */
type MachineDecision =
  | { decided: 'deleted' | 'already_gone'; notFound: 'repository' | 'branch' | null }
  | { decided: 'kept'; reason: BranchKeptReason };

interface MachineCleanUpRow {
  cleanUp: CleanUpRow;
  project: ProjectRow;
  machine: MachineRow;
}

export class BranchCleanUp {
  constructor(private readonly options: BranchCleanUpOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /**
   * One try of every clean-up wanted, oldest first. Returns when GitHub allows requests again
   * after its request limit, which holds the tick; null otherwise.
   */
  async check(): Promise<Date | null> {
    await this.machines();
    const { db, log } = this.options;
    const wanted = await db
      .select({
        cleanUp: schema.branchCleanUps,
        ticket: schema.tickets,
        project: schema.projects,
      })
      .from(schema.branchCleanUps)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.branchCleanUps.ticketId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .where(
        and(
          eq(schema.branchCleanUps.target, 'github'),
          eq(schema.branchCleanUps.state, 'wanted'),
          // Archived projects change nothing, as for the merges: tried once unarchived.
          eq(schema.projects.status, 'active'),
        ),
      )
      .orderBy(asc(schema.branchCleanUps.createdAt));
    if (wanted.length === 0) return null;
    let client: GitHubClient | null;
    try {
      client = await storedTokenClient({ ...this.options, log });
    } catch (error) {
      if (!(error instanceof SecretUnreadableError)) throw error;
      return null;
    }
    // No token: nothing can be read; "Needs you" already says so.
    if (client === null) return null;
    for (const row of wanted) {
      const reference = ticketReference(row.project.key, row.ticket.number);
      let outcome: Outcome;
      try {
        outcome = await this.attempt(client, row);
      } catch (error) {
        if (!(error instanceof GitHubUnreachableError)) {
          // One clean-up never blocks the others: logged with its ticket, tried at the next check.
          log.error({ err: error, ticket: reference }, 'branch clean-up not tried');
          continue;
        }
        outcome = { failure: { reason: 'unreachable', message: error.message } };
      }
      try {
        await this.record(row, outcome);
      } catch (error) {
        log.error({ err: error, ticket: reference }, 'branch clean-up not recorded');
      }
      if ('failure' in outcome) {
        if (outcome.until) return outcome.until;
        // GitHub cannot be reached: the next ones would not either.
        if (outcome.failure.reason === 'unreachable') return null;
      }
    }
    return null;
  }

  /** One try, every condition checked again (owner's answer 5 and the answers of step J2). */
  private async attempt(
    client: GitHubClient,
    row: { cleanUp: CleanUpRow; ticket: TicketRow; project: ProjectRow },
  ): Promise<Outcome> {
    const { cleanUp, project } = row;
    // The ticket as it is now, read again: not the row read at the tick's start.
    const [ticket] = await this.options.db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, cleanUp.ticketId));
    const changed = ticketChanged(ticket, cleanUp);
    if (changed !== null || !ticket) return kept(changed ?? { kind: 'ticket_reopened' });
    // The stopped runs' end first (end push included): no request until then.
    if ((await runsThatCanPush(this.options.db, ticket.id)).length > 0) return { waiting: true };

    const repo = { owner: project.repoOwner, name: project.repoName };
    const branch = cleanUp.branch;
    const pull = await readPullRequest(client, repo, cleanUp.pullRequestNumber);
    if (!pull.ok) return this.failed(pull.refusal, 'pull_request');
    const read = pull.value;
    if (
      !read.merged ||
      project.defaultBranch === null ||
      read.baseBranch !== project.defaultBranch
    ) {
      return kept({ kind: 'not_merged_into_default', merged: read.merged, base: read.baseBranch });
    }
    if (read.headBranch !== branch) {
      return kept({ kind: 'head_branch_differs', headBranch: read.headBranch });
    }
    if (
      read.headRepository === null ||
      read.headRepository.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()
    ) {
      return kept({ kind: 'fork', headRepository: read.headRepository });
    }
    if (read.defaultBranch !== project.defaultBranch) {
      return kept({
        kind: 'default_branch_changed',
        github: read.defaultBranch,
        stored: project.defaultBranch,
      });
    }
    const own = ownRefusal({
      branch,
      base: read.baseBranch,
      ticket,
      defaultBranch: project.defaultBranch,
    });
    if (own !== null) return kept(OWN_REASONS[own]);

    // No open pull request uses it, as head nor as base: each one returned is checked here,
    // since GitHub ignores a malformed head filter and returns every open pull request.
    const heads = await listOpenPullRequestsUsing(client, repo, 'head', branch);
    if (!heads.ok) return this.failed(heads.refusal, 'open_pull_requests');
    const head = heads.value.find((other) => other.headBranch === branch);
    if (head) return kept({ kind: 'used_as_head', pullRequest: head.number });
    const bases = await listOpenPullRequestsUsing(client, repo, 'base', branch);
    if (!bases.ok) return this.failed(bases.refusal, 'open_pull_requests');
    const base = bases.value.find((other) => other.baseBranch === branch);
    if (base) return kept({ kind: 'used_as_base', pullRequest: base.number });

    // Still at the merged head: exactly this branch, never a longer name (A37).
    const ref = await readBranchRef(client, repo, branch);
    if (!ref.ok) return this.failed(ref.refusal, 'branch');
    if (ref.value === null) return { decided: 'already_gone' };
    if (ref.value.ref !== `refs/heads/${branch}`) {
      return kept({ kind: 'ref_differs', ref: ref.value.ref });
    }
    if (ref.value.sha !== cleanUp.mergedHead) return kept({ kind: 'moved', head: ref.value.sha });

    const deleted = await deleteMergedTicketBranch(this.options.db, client, {
      ticketId: ticket.id,
      branch,
      base: read.baseBranch,
    });
    if (deleted.ok) return { decided: deleted.value };
    if ('own' in deleted) return kept(OWN_REASONS[deleted.own]);
    return this.failed(deleted.refusal, 'delete');
  }

  /**
   * A refusal: the request limit, the token or a missing permission (the GitHub item says so) are
   * tried again at the next check, as GitHub unreachable or answering a server error (the client
   * throws for those); any other refusal keeps the branch for good, a read's as a failed read,
   * the deletion's in GitHub's words (a protected branch).
   */
  private failed(
    refusal: GitHubRefusal,
    what: 'pull_request' | 'open_pull_requests' | 'branch' | 'delete',
  ): Outcome {
    const { message } = refusal;
    switch (refusal.kind) {
      case 'rate_limited':
        return {
          failure: { reason: 'rate_limited', message },
          until: retryAt(refusal, this.now()),
        };
      case 'token_invalid':
        return { failure: { reason: 'token', message } };
      case 'permission_missing':
        return { failure: { reason: 'permission_missing', message } };
      default:
        break;
    }
    return what === 'delete'
      ? kept({ kind: 'refused', message })
      : kept({ kind: 'read_failed', what, message });
  }

  /** The try's outcome stored on its row, with its event for a decision. */
  private async record(
    row: { cleanUp: CleanUpRow; ticket: TicketRow; project: ProjectRow },
    outcome: Outcome,
  ): Promise<void> {
    if ('waiting' in outcome) return;
    const now = this.now();
    const { cleanUp, ticket, project } = row;
    await this.options.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ state: schema.branchCleanUps.state })
        .from(schema.branchCleanUps)
        .where(eq(schema.branchCleanUps.id, cleanUp.id))
        .for('update');
      if (current?.state !== 'wanted') return;
      if ('failure' in outcome) {
        const failure: BranchCleanUpFailure = { ...outcome.failure, at: now.toISOString() };
        await tx
          .update(schema.branchCleanUps)
          .set({ failure, triedAt: now })
          .where(eq(schema.branchCleanUps.id, cleanUp.id));
        await notifyChange(tx, { entity: 'ticket', id: ticket.id, projectId: ticket.projectId });
        this.options.log.warn(
          { ticket: ticketReference(project.key, ticket.number), reason: failure.reason },
          `branch ${cleanUp.branch} not cleaned up on GitHub yet: ${failure.message}`,
        );
        return;
      }
      const reason = outcome.decided === 'kept' ? outcome.reason : null;
      await tx
        .update(schema.branchCleanUps)
        .set({ state: outcome.decided, reason, failure: null, triedAt: now, decidedAt: now })
        .where(eq(schema.branchCleanUps.id, cleanUp.id));
      const facts = {
        project: project.key,
        ticket: ticketReference(project.key, ticket.number),
        branch: cleanUp.branch,
        pullRequest: cleanUp.pullRequestNumber,
        head: cleanUp.mergedHead,
      };
      if (reason === null) {
        await recordEvent(tx, {
          actor: 'system',
          ...ticketEntity(ticket),
          type: 'ticket.branch_deleted',
          payload: { ...facts, alreadyGone: outcome.decided === 'already_gone' },
          at: now,
        });
      } else {
        await recordEvent(tx, {
          actor: 'system',
          ...ticketEntity(ticket),
          type: 'ticket.branch_kept',
          payload: { ...facts, reason },
          at: now,
        });
      }
      this.options.log.info(
        { ticket: facts.ticket, branch: cleanUp.branch, outcome: outcome.decided, reason },
        'branch clean-up on GitHub',
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // On the machines (lot 3 step J2b)

  /**
   * Every machine clean-up wanted (`where` narrows them): decided when the machine was revoked or
   * the ticket changed, else sent once nothing is left to wait for.
   */
  async machines(where?: SQL, reconnected = false): Promise<void> {
    try {
      await this.machinesWanted(where, reconnected);
    } catch (error) {
      // Never thrown to the caller (an end report, a `hello`): tried again at the next check.
      this.options.log.error({ err: error }, 'branch clean-ups on the machines not tried');
    }
  }

  private async machinesWanted(where: SQL | undefined, reconnected: boolean): Promise<void> {
    if (!this.options.daemons) return;
    const rows = await this.options.db
      .select({
        cleanUp: schema.branchCleanUps,
        project: schema.projects,
        machine: schema.machines,
      })
      .from(schema.branchCleanUps)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.branchCleanUps.ticketId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .innerJoin(schema.machines, eq(schema.machines.id, schema.branchCleanUps.machineId))
      .where(
        and(
          eq(schema.branchCleanUps.target, 'machine'),
          eq(schema.branchCleanUps.state, 'wanted'),
          eq(schema.projects.status, 'active'),
          where,
        ),
      )
      .orderBy(asc(schema.branchCleanUps.createdAt));
    for (const row of rows) {
      try {
        await this.tryMachine(row, reconnected);
      } catch (error) {
        // One clean-up never blocks the others: tried again at the next check.
        this.options.log.error(
          { err: error, machine: row.machine.name, branch: row.cleanUp.branch },
          'branch clean-up on a machine not tried',
        );
      }
    }
  }

  /**
   * A machine connected (after `hello`): an offline machine gets its messages now, and a message
   * sent before, maybe on the connection that was lost, is sent again at once, the same one.
   */
  machineConnected(machineId: string): Promise<void> {
    return this.machines(eq(schema.branchCleanUps.machineId, machineId), true);
  }

  /** A run of the ticket reported its end: its machine's message may go now. */
  runEnded(ticketId: string): Promise<void> {
    return this.machines(eq(schema.branchCleanUps.ticketId, ticketId));
  }

  /** The daemon's answer to a `branch.delete`: stored once, with its event. */
  async answered(machineId: string, result: BranchDeleteResult): Promise<void> {
    const [row] = await this.options.db
      .select({
        cleanUp: schema.branchCleanUps,
        project: schema.projects,
        machine: schema.machines,
      })
      .from(schema.branchCleanUps)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.branchCleanUps.ticketId))
      .innerJoin(schema.projects, eq(schema.projects.id, schema.tickets.projectId))
      .innerJoin(schema.machines, eq(schema.machines.id, schema.branchCleanUps.machineId))
      .where(
        and(
          eq(schema.branchCleanUps.messageId, result.id),
          eq(schema.branchCleanUps.machineId, machineId),
        ),
      );
    // An answer to nothing sent, or a copy of one stored already: nothing changes.
    if (row?.cleanUp.state !== 'wanted') return;
    await this.recordMachine(row, machineOutcome(result.payload));
  }

  private async tryMachine(row: MachineCleanUpRow, reconnected: boolean): Promise<void> {
    const { db, daemons } = this.options;
    const { cleanUp, project, machine } = row;
    // A revoked machine gets nothing (owner's answer 5 of step J2).
    if (machine.revokedAt !== null) {
      await this.recordMachine(row, { decided: 'kept', reason: { kind: 'machine_revoked' } });
      return;
    }
    const [ticket] = await db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.id, cleanUp.ticketId));
    const changed = ticketChanged(ticket, cleanUp);
    if (changed !== null || !ticket) {
      await this.recordMachine(row, {
        decided: 'kept',
        reason: changed ?? { kind: 'ticket_reopened' },
      });
      return;
    }
    if (!isTicketBranchName(cleanUp.branch, ticket.number)) {
      await this.recordMachine(row, { decided: 'kept', reason: { kind: 'not_a_ticket_branch' } });
      return;
    }
    // Once every run of the ticket on that machine reported its end (its end push included).
    if ((await runsThatCanPush(db, ticket.id, machine.id)).length > 0) return;
    // A 0.3.0 daemon would ignore the message: it is sent once the daemon is updated.
    if (outdated(machine) || !daemons?.isConnected(machine.id)) return;
    const now = this.now();
    // Sent and not answered: the same message again after **Machine answer timeout**.
    if (cleanUp.sentAt !== null && !reconnected) {
      const { dispatchAckTimeoutSeconds } = await resolveSettings(db, [
        'dispatchAckTimeoutSeconds',
      ]);
      if (now.getTime() - cleanUp.sentAt.getTime() < dispatchAckTimeoutSeconds * 1000) return;
    }
    // One id for the row, whoever sends first: a copy is applied once by the daemon.
    const [stored] = await db
      .update(schema.branchCleanUps)
      .set({ messageId: sql`coalesce(${schema.branchCleanUps.messageId}, ${randomUUID()})` })
      .where(
        and(eq(schema.branchCleanUps.id, cleanUp.id), eq(schema.branchCleanUps.state, 'wanted')),
      )
      .returning({ messageId: schema.branchCleanUps.messageId });
    if (!stored?.messageId) return;
    const message = ServerMessage.safeParse({
      type: 'branch.delete',
      id: stored.messageId,
      payload: {
        repository: { owner: project.repoOwner, name: project.repoName },
        ticket: ticketReference(project.key, ticket.number),
        branch: cleanUp.branch,
        mergedHead: cleanUp.mergedHead,
      },
    });
    if (!message.success) {
      this.options.log.error(
        { machine: machine.name, branch: cleanUp.branch, issues: message.error.issues },
        'branch.delete not sent: its facts do not fit the message',
      );
      return;
    }
    if (!daemons.send(machine.id, message.data)) return;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.branchCleanUps)
        .set({ sentAt: now, triedAt: now })
        .where(eq(schema.branchCleanUps.id, cleanUp.id));
      await notifyChange(tx, { entity: 'ticket', id: ticket.id, projectId: ticket.projectId });
    });
    this.options.log.info(
      { ticket: ticketReference(project.key, ticket.number), machine: machine.name },
      `branch ${cleanUp.branch}: delete sent to the machine`,
    );
  }

  /** A machine's clean-up decided, with its event, once. */
  private async recordMachine(row: MachineCleanUpRow, outcome: MachineDecision): Promise<void> {
    const now = this.now();
    const { cleanUp, project, machine } = row;
    await this.options.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ state: schema.branchCleanUps.state })
        .from(schema.branchCleanUps)
        .where(eq(schema.branchCleanUps.id, cleanUp.id))
        .for('update');
      if (current?.state !== 'wanted') return;
      const [ticket] = await tx
        .select()
        .from(schema.tickets)
        .where(eq(schema.tickets.id, cleanUp.ticketId));
      if (!ticket) return;
      const reason = outcome.decided === 'kept' ? outcome.reason : null;
      await tx
        .update(schema.branchCleanUps)
        .set({ state: outcome.decided, reason, failure: null, triedAt: now, decidedAt: now })
        .where(eq(schema.branchCleanUps.id, cleanUp.id));
      const facts = {
        project: project.key,
        ticket: ticketReference(project.key, ticket.number),
        branch: cleanUp.branch,
        pullRequest: cleanUp.pullRequestNumber,
        head: cleanUp.mergedHead,
        machine: machine.name,
      };
      if (outcome.decided === 'kept') {
        await recordEvent(tx, {
          actor: 'system',
          ...ticketEntity(ticket),
          type: 'ticket.machine_branch_kept',
          payload: { ...facts, reason: outcome.reason },
          at: now,
        });
      } else {
        await recordEvent(tx, {
          actor: 'system',
          ...ticketEntity(ticket),
          type: 'ticket.machine_branch_deleted',
          payload: { ...facts, notFound: outcome.notFound },
          at: now,
        });
      }
      this.options.log.info(
        { ticket: facts.ticket, branch: cleanUp.branch, machine: machine.name, ...outcome },
        'branch clean-up on a machine',
      );
    });
  }
}
