import { schema } from '@orchestrator/db';
import {
  TicketMachineFailures,
  type TicketHold,
  type FailureReason,
  type MachineFailureCause,
  type MachineUnavailable,
  type ReleaseAction,
  type RunChangeCause,
  type RunPurpose,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { resolveSettings } from '../settings/store.js';
import { storedHold, ticketEntity, ticketReference, type TicketRow } from './model.js';

export { applyingHold } from './model.js';

// What keeps a ticket from the scheduler besides its own state (lot 4 step D2b): the owner's hold
// (01, section 3.4; 07, section 1) and the failures its machines caused (07, section 4). Both live
// on the ticket and are changed in the transaction of what changes them.

type Project = { id: string; key: string };

/** Holds the ticket, with `ticket.held` (the owner's Stop run, or the Request changes box). */
export async function holdTicket(
  tx: Executor,
  project: Project,
  ticket: Pick<TicketRow, 'id' | 'projectId' | 'number'>,
  hold: TicketHold,
  at: Date,
): Promise<void> {
  await tx.update(schema.tickets).set({ held: hold }).where(eq(schema.tickets.id, ticket.id));
  await recordEvent(tx, {
    actor: 'owner',
    ...ticketEntity(ticket),
    type: 'ticket.held',
    payload: {
      project: project.key,
      ticket: ticketReference(project.key, ticket.number),
      cause: hold.cause,
      runId: hold.runId,
    },
    at,
  });
}

/** Clears the ticket's hold, if it has one, with `ticket.released`. */
export async function releaseHold(
  tx: Executor,
  project: Project,
  ticket: Pick<TicketRow, 'id' | 'projectId' | 'number' | 'held'>,
  action: ReleaseAction,
  at: Date,
): Promise<void> {
  const hold = storedHold(ticket);
  if (hold === null) return;
  await tx.update(schema.tickets).set({ held: null }).where(eq(schema.tickets.id, ticket.id));
  await recordEvent(tx, {
    actor: 'owner',
    ...ticketEntity(ticket),
    type: 'ticket.released',
    payload: {
      project: project.key,
      ticket: ticketReference(project.key, ticket.number),
      cause: hold.cause,
      action,
    },
    at,
  });
}

export function machineFailures(row: Pick<TicketRow, 'machineFailures'>): TicketMachineFailures {
  return TicketMachineFailures.parse(row.machineFailures);
}

/**
 * The machines left out for the ticket (07, section 4): each from its latest failure until it
 * connects again (`connectedAt` after that failure; a machine that never connected since stays
 * out). The owner's **Run now** clears the failures, and so releases them all.
 */
export function leftOutMachines(
  failures: TicketMachineFailures,
  machines: readonly { id: string; connectedAt: Date | null }[],
): Map<string, MachineUnavailable> {
  const left = new Map<string, MachineUnavailable>();
  for (const entry of failures) {
    const latest = entry.failures.at(-1);
    if (!latest) continue;
    const connectedAt = machines.find((machine) => machine.id === entry.machineId)?.connectedAt;
    if (connectedAt && connectedAt.getTime() > Date.parse(latest.at)) continue;
    left.set(entry.machineId, { why: 'left_out', cause: latest.cause, at: latest.at });
  }
  return left;
}

/** The machine whose failures reached the setting: the blocking item, while it stands. */
export function askedMachine(failures: TicketMachineFailures) {
  return failures.find((entry) => entry.asked !== null) ?? null;
}

/**
 * The failure a run's end is, when its machine caused it and no "Needs you" item of the ticket
 * follows from it (07, section 4): a start not confirmed or refused (a review's too), the machine
 * gone at the dispatch or while its answer waited, revoked, an unsupported Claude Code, or a
 * process scope error. The owner's **Stop run** of a run on an offline machine is not one, nor a
 * review run that failed after its start ("Review did not finish" is its item).
 */
export function machineFailureOf(
  purpose: RunPurpose,
  cause: RunChangeCause,
  failureReason: FailureReason | null,
): MachineFailureCause | null {
  if (cause === 'owner_stopped') return null;
  if (cause === 'dispatch_timeout' || cause === 'dispatch_refused') return cause;
  if (failureReason === 'cancelled') return cause === 'machine_offline' ? 'machine_offline' : null;
  if (purpose === 'review') return null;
  switch (failureReason) {
    case 'machine_offline':
    case 'machine_revoked':
    case 'claude_code_unsupported':
    case 'machine_problem':
      return failureReason;
    default:
      return null;
  }
}

/**
 * Keeps a run's end in the ticket's failures (07, section 4), in the end's transaction: a failure
 * its machine caused adds to that machine's failures in a row, and gives the blocking item once
 * they reach **Machine failures before asking you** (read now, with `ticket.could_not_start`);
 * any other end of a run of the ticket starts every count again.
 */
export async function recordRunEnd(
  tx: Executor,
  input: {
    project: Project;
    ticket: Pick<TicketRow, 'id' | 'projectId' | 'number' | 'machineFailures'>;
    machine: { id: string; name: string };
    runId: string;
    failure: MachineFailureCause | null;
    at: Date;
  },
): Promise<void> {
  const { project, ticket, machine, failure, at } = input;
  const current = machineFailures(ticket);
  if (failure === null) {
    if (current.length > 0) {
      await tx
        .update(schema.tickets)
        .set({ machineFailures: [] })
        .where(eq(schema.tickets.id, ticket.id));
    }
    return;
  }
  const entry = current.find((each) => each.machineId === machine.id);
  const failures = [
    ...(entry?.failures ?? []),
    { cause: failure, at: at.toISOString(), runId: input.runId },
  ];
  let asked = entry?.asked ?? null;
  if (asked === null) {
    const { maxMachineFailures } = await resolveSettings(tx, ['maxMachineFailures']);
    if (failures.length >= maxMachineFailures) {
      asked = { at: at.toISOString(), limit: maxMachineFailures };
      await recordEvent(tx, {
        actor: 'system',
        ...ticketEntity(ticket),
        type: 'ticket.could_not_start',
        payload: {
          project: project.key,
          ticket: ticketReference(project.key, ticket.number),
          machine: machine.name,
          count: failures.length,
          limit: maxMachineFailures,
          causes: failures.map((each) => each.cause),
        },
        at,
      });
    }
  }
  const next: TicketMachineFailures = [
    ...current.filter((each) => each.machineId !== machine.id),
    { machineId: machine.id, failures, asked },
  ];
  await tx
    .update(schema.tickets)
    .set({ machineFailures: next })
    .where(eq(schema.tickets.id, ticket.id));
}

/** The owner's start (**Run now**, **Start review**): every machine released, the item gone. */
export async function clearMachineFailures(
  tx: Executor,
  ticket: Pick<TicketRow, 'id' | 'machineFailures'>,
): Promise<void> {
  if (machineFailures(ticket).length === 0) return;
  await tx
    .update(schema.tickets)
    .set({ machineFailures: [] })
    .where(eq(schema.tickets.id, ticket.id));
}
