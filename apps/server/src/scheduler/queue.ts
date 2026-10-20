import { schema } from '@orchestrator/db';
import {
  ACCOUNT_BUSY_RUN_STATUSES,
  Capability,
  FailureReason,
  type MachineUnavailable,
  TicketPriority,
  type AccountToday,
  type BlockingItem,
  type QueueAccount,
  type QueueCandidate,
  type QueueKind,
  type QueueReason,
  type QueueResponse,
} from '@orchestrator/protocol';
import { count, desc, eq, inArray, max } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database.js';
import { accountToday, accountUsage, todayKey } from '../machines/account-day.js';
import type { MachineRow } from '../machines/model.js';
import {
  ciCancelledItems,
  ciTimeoutItems,
  downloadFailedItems,
  machineFailureItems,
  pushFailedItems,
} from '../needs-you.js';
import type { ProjectRow } from '../projects/model.js';
import { isCounted } from '../runs/model.js';
import { ticketReview } from '../runs/review-view.js';
import { readTimeZone } from '../settings/time-zone.js';
import { standingRequest } from '../tickets/changes.js';
import { applyingHold, leftOutMachines, machineFailures } from '../tickets/holds.js';
import { ticketReference } from '../tickets/model.js';
import {
  accountUnavailable,
  githubRefusal,
  machineChoice,
  preferredMachine,
  projectRefusal,
  resumeRefusal,
  ticketRefusal,
  ticketWork,
  type Blocker,
  type Fleet,
} from './checks.js';
import { runsToday } from './facts.js';

// The scheduler's queue (07, sections 2, 3 and 7; lot 4 step D1): every candidate at `now`, in the
// order the loop takes them, and for each one that cannot start the reason, with the checks Run now
// uses. It reads and never writes: nothing starts a run here.
//
// The candidates are walked in order as the loop will start them, one account place each: a
// candidate that could start takes its account's place and its machine's "run today", so the next
// ones are told the account is at its maximum once it is full. A candidate without a reason is
// what the loop would start now, on `machine`.

const KIND_ORDER: Record<QueueKind, number> = { resume: 0, review: 1, fix_review: 2, implement: 3 };
const PRIORITY_ORDER: Record<TicketPriority, number> = { high: 0, normal: 1, low: 2 };
const CLOSED = new Set(['done', 'cancelled']);

const ticketColumns = {
  id: schema.tickets.id,
  projectId: schema.tickets.projectId,
  number: schema.tickets.number,
  title: schema.tickets.title,
  priority: schema.tickets.priority,
  status: schema.tickets.status,
  assigneeProfileId: schema.tickets.assigneeProfileId,
  stopped: schema.tickets.stopped,
  held: schema.tickets.held,
  machineFailures: schema.tickets.machineFailures,
  changeRequest: schema.tickets.changeRequest,
  changeRequestAnsweredAt: schema.tickets.changeRequestAnsweredAt,
  githubBranchCommits: schema.tickets.githubBranchCommits,
  pullRequestHead: schema.tickets.pullRequestHead,
  pullRequestNumber: schema.tickets.pullRequestNumber,
  createdAt: schema.tickets.createdAt,
  updatedAt: schema.tickets.updatedAt,
};
type TicketFacts = {
  [Key in keyof typeof ticketColumns]: (typeof schema.tickets.$inferSelect)[Key];
};

const runColumns = {
  id: schema.runs.id,
  ticketId: schema.runs.ticketId,
  purpose: schema.runs.purpose,
  status: schema.runs.status,
  failureReason: schema.runs.failureReason,
  machineId: schema.runs.machineId,
  accountId: schema.runs.accountId,
  createdAt: schema.runs.createdAt,
  endedAt: schema.runs.endedAt,
  statusSince: schema.runs.statusSince,
  commits: schema.runs.commits,
  notOnGitHub: schema.runs.notOnGitHub,
  branchHead: schema.runs.branchHead,
  acknowledgedAt: schema.runs.acknowledgedAt,
  reviewCommit: schema.runs.reviewCommit,
};
type RunFacts = { [Key in keyof typeof runColumns]: (typeof schema.runs.$inferSelect)[Key] };

/** A candidate before the walk: what it starts, its order, and a reason found before machines. */
interface Draft {
  kind: QueueKind;
  ticket: TicketFacts;
  project: ProjectRow;
  /** The paused run of a resume. */
  run: RunFacts | null;
  blocks: number;
  afterFailure: boolean;
  since: Date;
  early: QueueReason | null;
  required: Capability[];
  holding: { machineId: string; commits: number } | null;
  /** The machine of the ticket's latest run, preferred among equals (07, section 4). */
  last: string | undefined;
  /** The machines left out for this ticket after a failure they caused (07, section 4). */
  leftOut: ReadonlyMap<string, MachineUnavailable>;
}

/** The queue at `now`: each account's line, then every candidate in the scheduler's order. */
export async function computeQueue(db: Database, now: Date): Promise<QueueResponse> {
  const [connection] = await db.select().from(schema.githubConnection);
  const github = githubRefusal(connection);
  const { timeZone } = await readTimeZone(db);

  const projects = new Map(
    (await db.select().from(schema.projects)).map((project) => [project.id, project]),
  );
  const machines = await db.select().from(schema.machines);
  const accountRows = await db
    .select()
    .from(schema.claudeAccounts)
    .orderBy(schema.claudeAccounts.label);
  const accounts = new Map(accountRows.map((account) => [account.id, account]));
  const busy = new Map(
    (
      await db
        .select({ accountId: schema.runs.accountId, busy: count() })
        .from(schema.runs)
        .where(inArray(schema.runs.status, [...ACCOUNT_BUSY_RUN_STATUSES]))
        .groupBy(schema.runs.accountId)
    ).map((row) => [row.accountId, row.busy]),
  );
  const usage = await accountUsage(db, [...accounts.keys()], timeZone, now);
  const today = todayKey(timeZone, now);
  const days = new Map<string, AccountToday>(
    accountRows.map((account) => [
      account.id,
      accountToday(account, usage.get(account.id)?.get(today), timeZone, now),
    ]),
  );

  // Every ticket's number and status, for the dependencies; the candidates' facts in full.
  const allTickets = new Map(
    (
      await db
        .select({
          id: schema.tickets.id,
          projectId: schema.tickets.projectId,
          number: schema.tickets.number,
          status: schema.tickets.status,
        })
        .from(schema.tickets)
    ).map((ticket) => [ticket.id, ticket]),
  );
  const paused = await db
    .select(runColumns)
    .from(schema.runs)
    .where(eq(schema.runs.status, 'paused_quota'));
  const pausedTickets = paused.flatMap((run) => (run.ticketId === null ? [] : [run.ticketId]));
  const tickets = await db
    .select(ticketColumns)
    .from(schema.tickets)
    .where(inArray(schema.tickets.status, ['todo', 'in_review']));
  if (pausedTickets.length > 0) {
    const known = new Set(tickets.map((ticket) => ticket.id));
    const more = pausedTickets.filter((id) => !known.has(id));
    if (more.length > 0) {
      tickets.push(
        ...(await db
          .select(ticketColumns)
          .from(schema.tickets)
          .where(inArray(schema.tickets.id, more))),
      );
    }
  }
  const ticketIds = tickets.map((ticket) => ticket.id);
  const runsByTicket = new Map<string, RunFacts[]>();
  if (ticketIds.length > 0) {
    const rows = await db
      .select(runColumns)
      .from(schema.runs)
      .where(inArray(schema.runs.ticketId, ticketIds))
      .orderBy(desc(schema.runs.createdAt));
    for (const run of rows) {
      if (run.ticketId === null) continue;
      const list = runsByTicket.get(run.ticketId) ?? [];
      list.push(run);
      runsByTicket.set(run.ticketId, list);
    }
  }

  // Dependencies: what each ticket waits for, and the tickets waiting on it (07, section 3).
  const dependencies = await db.select().from(schema.ticketDependencies);
  const waitsFor = new Map<string, string[]>();
  const waitedBy = new Map<string, string[]>();
  for (const { ticketId, blockedById } of dependencies) {
    waitsFor.set(ticketId, [...(waitsFor.get(ticketId) ?? []), blockedById]);
    waitedBy.set(blockedById, [...(waitedBy.get(blockedById) ?? []), ticketId]);
  }
  const blocks = (ticketId: string): number => {
    const seen = new Set<string>();
    const next = [...(waitedBy.get(ticketId) ?? [])];
    while (next.length > 0) {
      const id = next.pop() as string;
      if (seen.has(id) || id === ticketId) continue;
      seen.add(id);
      next.push(...(waitedBy.get(id) ?? []));
    }
    return [...seen].filter((id) => !CLOSED.has(allTickets.get(id)?.status ?? 'done')).length;
  };
  // As Run now: a blocker counts until it is done (07, section 3).
  const blockers = (ticketId: string, projectKey: string): Blocker[] =>
    (waitsFor.get(ticketId) ?? [])
      .map((id) => allTickets.get(id))
      .filter((blocker) => blocker !== undefined && blocker.status !== 'done')
      .map((blocker) => ({
        reference: ticketReference(projectKey, blocker?.number ?? 0),
        cancelled: blocker?.status === 'cancelled',
      }));

  // The blocking "Needs you" items, as "Needs you" finds them (04, section 5.1).
  const items = new Map<
    string,
    { item: BlockingItem; machine: { id: string; name: string } | null }
  >();
  for (const item of [
    ...(await pushFailedItems(db)),
    ...(await ciTimeoutItems(db)),
    ...(await downloadFailedItems(db)),
    ...(await ciCancelledItems(db)),
    ...(await machineFailureItems(db)),
  ]) {
    if (
      item.type !== 'push_failed' &&
      item.type !== 'ci_timeout' &&
      item.type !== 'download_failed' &&
      item.type !== 'ci_cancelled' &&
      item.type !== 'machine_failures'
    ) {
      continue;
    }
    const key = ticketReference(item.ticket.projectKey, item.ticket.number);
    if (!items.has(key)) items.set(key, { item: item.type, machine: item.machine });
  }

  const profiles = new Map(
    (await db.select().from(schema.agentProfiles)).map((profile) => [profile.id, profile]),
  );
  const quality = [...profiles.values()].find((profile) => profile.key === 'quality');
  const capabilities = (profileId: string | null | undefined): Capability[] => {
    const profile = profileId ? profiles.get(profileId) : undefined;
    return profile ? z.array(Capability).parse(profile.requiredCapabilities) : [];
  };

  const drafts: Draft[] = [];
  for (const ticket of tickets) {
    const project = projects.get(ticket.projectId);
    if (!project) continue;
    const reference = ticketReference(project.key, ticket.number);
    const earlier = runsByTicket.get(ticket.id) ?? [];
    const base = {
      ticket,
      project,
      blocks: blocks(ticket.id),
      last: earlier[0]?.machineId,
      leftOut: leftOutMachines(machineFailures(ticket), machines),
    };
    const resumes = paused.filter((run) => run.ticketId === ticket.id);
    for (const run of resumes) {
      drafts.push({
        ...base,
        kind: 'resume',
        run,
        afterFailure: false,
        since: run.statusSince,
        early: projectRefusal(project),
        required: [],
        holding: null,
      });
    }
    if (resumes.length > 0) continue;

    if (ticket.status === 'todo') {
      const { worked, holding, held } = ticketWork(ticket, earlier);
      const latest = worked[0];
      const request = standingRequest(ticket);
      const failed =
        latest?.status === 'failed' &&
        latest.failureReason !== null &&
        isCounted(FailureReason.parse(latest.failureReason));
      const item = items.get(reference);
      const since = Math.max(
        ticket.createdAt.getTime(),
        earlier[0]?.endedAt?.getTime() ?? 0,
        request === null ? 0 : Date.parse(request.at),
      );
      // Held after the owner's Stop run or Request changes's box, until Run now (07, section 1).
      const hold = applyingHold(ticket);
      drafts.push({
        ...base,
        kind: request === null ? 'implement' : 'fix_review',
        run: null,
        afterFailure: failed,
        since: new Date(since),
        early:
          github ??
          projectRefusal(project) ??
          ticketRefusal(ticket, blockers(ticket.id, project.key)) ??
          (hold ? { reason: 'held', cause: hold.cause } : null) ??
          (item ? { reason: 'needs_you', item: item.item, machine: item.machine } : null),
        required: capabilities(ticket.assigneeProfileId),
        holding: holding ? { machineId: holding.machineId, commits: held } : null,
      });
      continue;
    }

    // In review: a review to start, while "Ready for review" is offered (lot 3 step H); with the
    // project's Start reviews by themselves off, only Start review starts it (lot 4 step D3).
    if (ticket.pullRequestNumber === null) continue;
    const { review, ready } = await ticketReview(db, ticket);
    if (!review.offered || ready === null) continue;
    const latest = review.latest;
    const item = items.get(reference);
    // A review of this work stopped by the owner holds it until Start review (07, section 1).
    const hold = applyingHold(ticket, ready.commit);
    drafts.push({
      ...base,
      kind: 'review',
      run: null,
      afterFailure: false,
      since: new Date(ready.since),
      early:
        github ??
        projectRefusal(project) ??
        (hold ? { reason: 'held', cause: hold.cause } : null) ??
        (latest?.kind === 'not_finished'
          ? { reason: 'needs_you', item: 'review_not_finished', machine: latest.machine }
          : item
            ? { reason: 'needs_you', item: item.item, machine: item.machine }
            : null) ??
        (project.reviewsAutomatic ? null : { reason: 'reviews_off' }),
      required: capabilities(quality?.id),
      holding: null,
    });
  }

  // Projects served in turn (07, section 3): at each level, the project whose latest run started
  // longest ago first (none before any), then one candidate of each project after the other.
  const served = new Map(
    (
      await db
        .select({ projectId: schema.runs.projectId, at: max(schema.runs.createdAt) })
        .from(schema.runs)
        .groupBy(schema.runs.projectId)
    ).map((row) => [row.projectId, row.at?.getTime() ?? 0]),
  );
  const ordered = order(drafts, served);

  // The walk, as the loop starts them: one account place per candidate that can start.
  const cloned = new Map<string, Set<string>>();
  for (const row of await db
    .selectDistinct({ projectId: schema.runs.projectId, machineId: schema.runs.machineId })
    .from(schema.runs)) {
    cloned.set(row.projectId, (cloned.get(row.projectId) ?? new Set()).add(row.machineId));
  }
  const started = await runsToday(
    db,
    machines.map((machine) => machine.id),
    now,
  );
  const places = new Map(busy);
  const fleet: Fleet = { machines, accounts, busy: places, now, days };
  const candidates: QueueCandidate[] = ordered.map((draft) => {
    let reason = draft.early;
    let machine: MachineRow | undefined;
    if (reason === null && draft.run !== null) {
      const own = machines.find((row) => row.id === draft.run?.machineId);
      const account = accounts.get(draft.run.accountId);
      if (!own || !account) throw new Error(`machine or account of run ${draft.run.id} not found`);
      reason = resumeRefusal(own, account, places.get(account.id) ?? 0, now, days.get(account.id));
      if (reason === null) machine = own;
    } else if (reason === null) {
      const choice = machineChoice(fleet, {
        required: draft.required,
        holding: draft.holding,
        leftOut: draft.leftOut,
      });
      if (choice.refusal !== null) reason = choice.refusal;
      else {
        const [only] = choice.machines;
        machine =
          choice.machines.length === 1 && only?.id === draft.holding?.machineId
            ? only
            : preferredMachine(choice.machines, {
                cloned: cloned.get(draft.project.id) ?? new Set(),
                today: started,
                last: draft.last,
              });
      }
    }
    if (machine) {
      places.set(machine.accountId, (places.get(machine.accountId) ?? 0) + 1);
      started.set(machine.id, (started.get(machine.id) ?? 0) + 1);
    }
    return {
      kind: draft.kind,
      ticket: {
        projectKey: draft.project.key,
        number: draft.ticket.number,
        title: draft.ticket.title,
        priority: TicketPriority.parse(draft.ticket.priority),
      },
      runId: draft.run?.id ?? null,
      blocks: draft.blocks,
      afterFailure: draft.afterFailure,
      since: draft.since.toISOString(),
      reason,
      machine: machine ? { id: machine.id, name: machine.name } : null,
    };
  });

  const lines: QueueAccount[] = accountRows.map((account) => ({
    account: { id: account.id, label: account.label },
    active: busy.get(account.id) ?? 0,
    maxConcurrentRuns: account.maxConcurrentRuns,
    unavailable: accountUnavailable(account, busy.get(account.id) ?? 0, now, days.get(account.id)),
  }));
  return { at: now.toISOString(), accounts: lines, candidates };
}

/**
 * The scheduler's order (07, sections 3 and 6): by category; a candidate whose latest run failed
 * and counted behind the others of its category; then ticket priority; then projects in turn, each
 * project's candidates by the tickets they block (directly or through others), then oldest first.
 */
function order(drafts: readonly Draft[], served: ReadonlyMap<string, number>): Draft[] {
  const levels = new Map<string, Draft[]>();
  for (const draft of drafts) {
    const level = [
      KIND_ORDER[draft.kind],
      draft.afterFailure ? 1 : 0,
      PRIORITY_ORDER[TicketPriority.parse(draft.ticket.priority)],
    ].join('|');
    levels.set(level, [...(levels.get(level) ?? []), draft]);
  }
  const result: Draft[] = [];
  const keys = [...levels.keys()].sort((a, b) => {
    const [x, y] = [a.split('|').map(Number), b.split('|').map(Number)];
    return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
  });
  for (const key of keys) {
    const byProject = new Map<string, Draft[]>();
    for (const draft of levels.get(key) ?? []) {
      byProject.set(draft.project.id, [...(byProject.get(draft.project.id) ?? []), draft]);
    }
    const turns = [...byProject.entries()]
      .sort(
        ([a, first], [b, second]) =>
          (served.get(a) ?? 0) - (served.get(b) ?? 0) ||
          (first[0]?.project.key ?? '').localeCompare(second[0]?.project.key ?? ''),
      )
      .map(([, list]) =>
        list.sort(
          (a, b) =>
            b.blocks - a.blocks ||
            a.since.getTime() - b.since.getTime() ||
            a.ticket.number - b.ticket.number,
        ),
      );
    for (let index = 0; turns.some((list) => index < list.length); index += 1) {
      for (const list of turns) {
        const draft = list[index];
        if (draft) result.push(draft);
      }
    }
  }
  return result;
}
