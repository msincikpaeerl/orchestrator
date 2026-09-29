import {
  BLOCKABLE_STATUSES,
  type AgentLink,
  type TicketLink,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
  type TimelineEntry,
} from '@orchestrator/protocol';

export const statusLabel: Record<TicketStatus, string> = {
  proposed: 'Proposed',
  todo: 'To do',
  in_progress: 'In progress',
  waiting_human: 'Waiting for you',
  in_review: 'In review',
  awaiting_merge: 'Awaiting merge',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const typeLabel: Record<TicketType, string> = {
  feature: 'Feature',
  bug: 'Bug',
  chore: 'Chore',
  docs: 'Documentation',
  spike: 'Spike',
};

export const priorityLabel: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

/** The assignee as the screens show it: the profile's name. */
export function assigneeLabel(assignee: AgentLink | null): string {
  return assignee?.name ?? 'No assignee';
}

/** `WEB-12`: how every screen names a ticket. */
export function ticketRef(projectKey: string, number: number): string {
  return `${projectKey}-${String(number)}`;
}

export function ticketPath(projectKey: string, number: number): string {
  return `/projects/${encodeURIComponent(projectKey)}/tickets/${String(number)}`;
}

/**
 * Whether the owner is shown "Blocked": only before work starts, while dependencies can still
 * change (04, section 1; owner's decision, lot 1 step F).
 */
export function showsBlocked(ticket: { status: TicketStatus; blocked: boolean }): boolean {
  return ticket.blocked && BLOCKABLE_STATUSES.includes(ticket.status);
}

/** Why a ticket is blocked, and what the owner can do about a cancelled blocker (01, 3.4). */
export function blockedExplanation(
  projectKey: string,
  blockedBy: readonly TicketLink[],
): { waitingFor: string; cancelled: string | null } {
  const open = blockedBy.filter((link) => link.status !== 'done');
  const cancelled = open.filter((link) => link.status === 'cancelled');
  const name = (link: TicketLink) => ticketRef(projectKey, link.number);
  const list = (links: TicketLink[]) => links.map(name).join(', ');
  return {
    waitingFor: `It waits for ${list(open)}, which ${open.length === 1 ? 'is' : 'are'} not done yet. Work on it can start only once every ticket it waits for is done.`,
    cancelled:
      cancelled.length === 0
        ? null
        : `${list(cancelled)} ${cancelled.length === 1 ? 'is' : 'are'} cancelled, so this ticket stays blocked. Remove the dependency below if this ticket no longer needs ${cancelled.length === 1 ? 'it' : 'them'}, or reopen ${list(cancelled)}.`,
  };
}

/**
 * Warning of **Mark as done manually** when the ticket still waits for tickets that are not done
 * (02, section 6.4), naming each with its state; `null` when it waits for nothing.
 */
export function markDoneWarning(
  projectKey: string,
  number: number,
  blockedBy: readonly TicketLink[],
): string | null {
  const open = blockedBy.filter((link) => link.status !== 'done');
  if (open.length === 0) return null;
  const names = open.map(
    (link) => `${ticketRef(projectKey, link.number)} (${statusLabel[link.status]})`,
  );
  const last = names.pop() ?? '';
  const list = names.length === 0 ? last : `${names.join(', ')} and ${last}`;
  return `${ticketRef(projectKey, number)} still waits for ${list}, which ${open.length === 1 ? 'is' : 'are'} not done. Mark it as done anyway only if its work no longer needs ${open.length === 1 ? 'it' : 'them'}.`;
}

/** A status change of the timeline, in words. */
export function statusChangeText(entry: Extract<TimelineEntry, { type: 'status_change' }>): string {
  const who =
    entry.actor === 'owner' ? 'You' : entry.actor === 'agent' ? 'The agent' : 'The Orchestrator';
  if (entry.to === 'done' && entry.actor === 'owner') {
    return `${who} marked it as done manually (it was ${statusLabel[entry.from]}).`;
  }
  if (entry.to === 'cancelled') return `${who} cancelled it (it was ${statusLabel[entry.from]}).`;
  if (entry.from === 'cancelled' && entry.to === 'todo') return `${who} reopened it.`;
  if (entry.from === 'in_review' && entry.to === 'todo' && entry.actor === 'owner') {
    return `${who} requested changes: it went back to ${statusLabel.todo}.`;
  }
  return `${who} moved it from ${statusLabel[entry.from]} to ${statusLabel[entry.to]}.`;
}
