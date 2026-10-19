import type { schema } from '@orchestrator/db';
import {
  TicketStatus,
  type AccountToday,
  type Capability,
  type MachineUnavailable,
  type RunRefusal,
} from '@orchestrator/protocol';
import {
  capabilityLists,
  effectiveCapabilities,
  machineState,
  unusableReasons,
  type MachineRow,
} from '../machines/model.js';
import type { ProjectRow } from '../projects/model.js';
import { isLimited, reportedCommits, type AccountRow, type RunRow } from '../runs/model.js';
import { commitsNotOnGitHub, runReport } from '../tickets/branch.js';
import { ticketStop } from '../tickets/changes.js';
import type { TicketRow } from '../tickets/model.js';

// The checks a start goes through (07, sections 2 to 4), shared by **Run now**, **Resume**, **Start
// review** and the scheduler's queue, so all of them refuse for the same reasons in the same words
// (lot 4 step D1). Pure: the callers read the rows, locked or not, and act on the answer.

type ConnectionRow = typeof schema.githubConnection.$inferSelect;

/** The GitHub connection's refusals that need no request to GitHub (02, section 3.2). */
export function githubRefusal(connection: ConnectionRow | undefined): RunRefusal | null {
  if (!connection) return { reason: 'github_not_connected' };
  if (connection.unreadableSince) return { reason: 'github_token_unreadable' };
  if (connection.invalidSince) return { reason: 'github_token_invalid' };
  return null;
}

/** An archived project, or one whose repository setup is not finished. */
export function projectRefusal(
  project: Pick<ProjectRow, 'status' | 'setupStatus' | 'defaultBranch'>,
): RunRefusal | null {
  if (project.status === 'archived') return { reason: 'project_archived' };
  if (project.setupStatus !== 'ready' || project.defaultBranch === null) {
    return { reason: 'project_not_ready' };
  }
  return null;
}

/** A ticket another one waits for, not done: its reference and whether it is cancelled. */
export interface Blocker {
  reference: string;
  cancelled: boolean;
}

/**
 * Whether the ticket can take a builder run (01, section 3.4): in `todo`, with an assignee, not
 * stopped by the retry policy (04, section 5), waiting for no ticket (`blockers`: those not done).
 * A cancelled blocker still blocks, and the refusal names it apart (owner, review of lot 4 D1).
 */
export function ticketRefusal(
  ticket: Pick<TicketRow, 'status' | 'assigneeProfileId' | 'stopped'>,
  blockers: readonly Blocker[],
): RunRefusal | null {
  if (ticket.status !== 'todo') {
    return { reason: 'ticket_not_todo', status: TicketStatus.parse(ticket.status) };
  }
  if (ticket.assigneeProfileId === null) return { reason: 'no_assignee' };
  const stop = ticketStop(ticket);
  if (stop !== null) {
    return { reason: 'ticket_stopped', cause: stop.cause, count: stop.count, limit: stop.limit };
  }
  if (blockers.length > 0) {
    const tickets = blockers.map((blocker) => blocker.reference).sort();
    const cancelled = blockers.flatMap((blocker) => (blocker.cancelled ? [blocker.reference] : []));
    return {
      reason: 'blocked',
      tickets,
      ...(cancelled.length > 0 ? { cancelled: cancelled.sort() } : {}),
    };
  }
  return null;
}

/**
 * Why the account cannot start a run now, or null (07, section 2, step 1): paused by the owner,
 * limited, then, for the scheduler only (`day`), outside its windows or its daily budget used, then
 * at its maximum. `busy` is its runs counted now (waiting for CI included, 07 section 3).
 */
export function accountUnavailable(
  account: AccountRow,
  busy: number,
  now: Date,
  day?: AccountToday,
): MachineUnavailable | null {
  const accountRef = { id: account.id, label: account.label };
  // Paused first: the owner's choice, until Resume (07, section 5.5; owner's answer 5, lot 4).
  if (account.state === 'paused_manual') return { why: 'account_paused', account: accountRef };
  if (isLimited(account, now) && account.limitedUntil) {
    return {
      why: 'account_limited',
      account: accountRef,
      until: account.limitedUntil.toISOString(),
    };
  }
  // Run now ignores windows and the budget (owner's answer 5, lot 4 step A).
  if (day?.window.state === 'outside') {
    return { why: 'account_outside_window', account: accountRef, next: day.window.next };
  }
  if (day?.budgetUsed) {
    return { why: 'account_budget_used', account: accountRef, until: day.dayEndsAt };
  }
  if (busy >= account.maxConcurrentRuns) {
    return {
      why: 'account_busy',
      account: accountRef,
      maxConcurrentRuns: account.maxConcurrentRuns,
    };
  }
  return null;
}

/** Why the machine cannot take a run now (07, section 4), its account's checks last; or null. */
export function machineUnavailable(
  machine: MachineRow,
  account: AccountRow,
  busy: number,
  required: readonly string[],
  now: Date,
  day?: AccountToday,
): MachineUnavailable | null {
  const state = machineState(machine);
  if (state === 'revoked') return { why: 'revoked' };
  if (state === 'waiting_enrollment') return { why: 'waiting_enrollment' };
  if (state === 'disabled') return { why: 'disabled' };
  if (state === 'offline') return { why: 'offline' };
  if (machine.daemonIncompatibleSince) return { why: 'daemon_incompatible' };
  const reasons = unusableReasons(machine);
  if (reasons.length > 0) return { why: 'unusable', reasons };
  const capabilities = new Set(effectiveCapabilities(capabilityLists(machine)));
  const missing = required.filter((tag) => !capabilities.has(tag));
  if (missing.length > 0) return { why: 'missing_capabilities', capabilities: missing };
  return accountUnavailable(account, busy, now, day);
}

/** The machines and accounts as a start sees them, with each account's runs counted now. */
export interface Fleet {
  machines: readonly MachineRow[];
  accounts: ReadonlyMap<string, AccountRow>;
  busy: ReadonlyMap<string, number>;
  now: Date;
  /** Each account's day, for the scheduler's checks of windows and budget; none for Run now. */
  days?: ReadonlyMap<string, AccountToday>;
}

export function fleetVerdict(
  fleet: Fleet,
  machine: MachineRow,
  required: readonly string[],
): MachineUnavailable | null {
  const account = fleet.accounts.get(machine.accountId);
  if (!account) throw new Error(`account of machine ${machine.id} not found`);
  return machineUnavailable(
    machine,
    account,
    fleet.busy.get(account.id) ?? 0,
    required,
    fleet.now,
    fleet.days?.get(account.id),
  );
}

/**
 * The ticket's work and where it is (07, section 3; lot 3 step D3), from its runs newest first:
 * the runs that worked on it (never a review run, which reports GitHub's head and never holds
 * work), the latest that reported commits, how many of them are not on GitHub, and the run whose
 * machine holds them, when no later run moved the work to another machine.
 */
export function ticketWork<
  Run extends Pick<
    RunRow,
    'purpose' | 'commits' | 'notOnGitHub' | 'branchHead' | 'createdAt' | 'machineId'
  >,
>(ticket: Pick<TicketRow, 'githubBranchCommits' | 'pullRequestHead'>, earlier: readonly Run[]) {
  const worked = earlier.filter((run) => run.purpose !== 'review');
  const withCommits = worked.find((run) => (reportedCommits(run)?.length ?? 0) > 0);
  const held = withCommits ? commitsNotOnGitHub(ticket, runReport(withCommits)).count : 0;
  const holding =
    withCommits &&
    held > 0 &&
    !worked.some(
      (run) => run.createdAt > withCommits.createdAt && run.machineId !== withCommits.machineId,
    )
      ? withCommits
      : undefined;
  return { worked, withCommits, held, holding };
}

export type MachineChoice =
  | { refusal: RunRefusal }
  | {
      refusal: null;
      /** The machines that can take the run: only the holder's, when one holds the work. */
      machines: MachineRow[];
      lostWork: { machine: MachineRow; commits: number } | undefined;
    };

/**
 * The machines a run can start on (07, sections 3 and 4): the machine holding the ticket's commits
 * not on GitHub when there is one (`holding`), refused with why when it cannot take it; else every
 * machine that can, or the refusal listing each machine not revoked with why. A holder revoked
 * gives `lostWork`.
 */
export function machineChoice(
  fleet: Fleet,
  input: {
    required: readonly Capability[];
    holding: { machineId: string; commits: number } | null;
    /**
     * The scheduler only: the machines left out for this ticket after a failure they caused (07,
     * section 4), given after the machine's own state and before its account's.
     */
    leftOut?: ReadonlyMap<string, MachineUnavailable>;
  },
): MachineChoice {
  const { required, holding } = input;
  const verdict = (machine: MachineRow): MachineUnavailable | null => {
    const unavailable = fleetVerdict(fleet, machine, required);
    const left = input.leftOut?.get(machine.id);
    return left && (unavailable === null || unavailable.why.startsWith('account_'))
      ? left
      : unavailable;
  };
  const holder = holding && fleet.machines.find((machine) => machine.id === holding.machineId);
  if (holding && holder && !holder.revokedAt) {
    const unavailable = verdict(holder);
    if (unavailable) {
      return {
        refusal: {
          reason: 'machine_unavailable',
          machine: { id: holder.id, name: holder.name },
          commits: holding.commits,
          unavailable,
        },
      };
    }
    return { refusal: null, machines: [holder], lostWork: undefined };
  }
  const lostWork = holding && holder ? { machine: holder, commits: holding.commits } : undefined;
  const candidates = fleet.machines.filter((machine) => !machine.revokedAt);
  const verdicts = candidates.map((machine) => ({
    machine,
    unavailable: verdict(machine),
  }));
  const available = verdicts.filter((entry) => entry.unavailable === null);
  if (available.length === 0) {
    const machines = verdicts
      .map(({ machine, unavailable }) => ({
        machine: { id: machine.id, name: machine.name },
        unavailable: unavailable as MachineUnavailable,
      }))
      .sort((a, b) => a.machine.name.localeCompare(b.machine.name));
    return { refusal: { reason: 'no_machine', machines } };
  }
  return { refusal: null, machines: available.map((entry) => entry.machine), lostWork };
}

/**
 * Among machines that can take the run (07, section 4): the one with the project's repository
 * already cloned, then the one that ran the ticket last, then the fewest runs today, then by name.
 */
export function preferredMachine(
  available: readonly MachineRow[],
  facts: {
    cloned: ReadonlySet<string>;
    today: ReadonlyMap<string, number>;
    last: string | undefined;
  },
): MachineRow {
  const { cloned, today, last } = facts;
  const sorted = [...available].sort(
    (a, b) =>
      Number(cloned.has(b.id)) - Number(cloned.has(a.id)) ||
      Number(b.id === last) - Number(a.id === last) ||
      (today.get(a.id) ?? 0) - (today.get(b.id) ?? 0) ||
      a.name.localeCompare(b.name),
  );
  const [first] = sorted;
  if (!first) throw new Error('no machine to prefer');
  return first;
}

/**
 * **Resume**'s checks of a paused run (07, section 3, lot 2): its account paused, limited or at
 * its maximum, then its own machine, the only one it can continue on (capabilities and the account
 * were checked when it started). `day` adds the scheduler's windows and budget.
 */
export function resumeRefusal(
  machine: MachineRow,
  account: AccountRow,
  busy: number,
  now: Date,
  day?: AccountToday,
): RunRefusal | null {
  const accountRef = { id: account.id, label: account.label };
  if (account.state === 'paused_manual') return { reason: 'account_paused', account: accountRef };
  if (isLimited(account, now) && account.limitedUntil) {
    return {
      reason: 'account_limited',
      account: accountRef,
      until: account.limitedUntil.toISOString(),
    };
  }
  if (busy >= account.maxConcurrentRuns) {
    return {
      reason: 'account_busy',
      account: accountRef,
      maxConcurrentRuns: account.maxConcurrentRuns,
    };
  }
  const unavailable = machineUnavailable(machine, account, 0, [], now, day);
  if (unavailable) {
    return {
      reason: 'machine_unavailable',
      machine: { id: machine.id, name: machine.name },
      commits: null,
      unavailable,
    };
  }
  return null;
}

/** The message of a refusal these checks give, for the API's error and the logs. */
export function refusalMessage(refusal: RunRefusal): string {
  switch (refusal.reason) {
    case 'github_not_connected':
      return 'GitHub is not connected';
    case 'github_token_unreadable':
      return 'The saved GitHub token cannot be read';
    case 'github_token_invalid':
      return 'GitHub does not accept the saved token';
    case 'project_archived':
      return 'The project is archived';
    case 'project_not_ready':
      return 'The repository setup is not finished';
    case 'ticket_not_todo':
      return `Run now needs a ticket in todo; it is ${refusal.status}`;
    case 'no_assignee':
      return 'The ticket has no assignee';
    case 'ticket_stopped':
      return `The ticket is stopped after ${String(refusal.count)} ${refusal.cause === 'review_rounds' ? 'review rounds' : 'failed attempts'} (limit ${String(refusal.limit)}): Try again first`;
    case 'blocked':
      return blockedMessage(refusal.tickets, refusal.cancelled ?? []);
    case 'machine_unavailable':
      return refusal.commits === null
        ? `The run's machine ${refusal.machine.name} cannot take it now (${refusal.unavailable.why})`
        : `The ticket's branch has commits not on GitHub on machine ${refusal.machine.name}, which cannot take the run now (${refusal.unavailable.why})`;
    case 'no_machine':
      return 'No machine can take the run';
    case 'account_paused':
      return `The account ${refusal.account.label} is paused: new runs are stopped on it`;
    case 'account_limited':
      return `The account ${refusal.account.label} is limited until ${refusal.until}`;
    case 'account_busy':
      return `The account ${refusal.account.label} already runs its maximum of ${String(refusal.maxConcurrentRuns)}`;
    default:
      throw new Error(`no message for the refusal ${refusal.reason}`);
  }
}

/** "The ticket waits for WEB-2; blocked by WEB-3 (cancelled): remove the dependency to let it start". */
function blockedMessage(tickets: readonly string[], cancelled: readonly string[]): string {
  const waiting = tickets.filter((ticket) => !cancelled.includes(ticket));
  const parts = [
    ...(waiting.length > 0 ? [`the ticket waits for ${waiting.join(', ')}`] : []),
    ...(cancelled.length > 0
      ? [
          `blocked by ${cancelled.map((ticket) => `${ticket} (cancelled)`).join(', ')}: remove the ${cancelled.length === 1 ? 'dependency' : 'dependencies'} to let it start`,
        ]
      : []),
  ];
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
