import { schema } from '@orchestrator/db';
import {
  RequestStatus,
  RequestStop,
  TicketMachineFailures,
  type FailureReason,
  type RunChangeCause,
  type RunStatus,
} from '@orchestrator/protocol';
import { eq } from 'drizzle-orm';
import type { Executor } from '../database.js';
import { recordEvent } from '../events.js';
import { failureWords, isCounted } from '../runs/model.js';
import { resolveSettings } from '../settings/store.js';
import { machineFailureOf } from '../tickets/holds.js';
import {
  changeRequestStatus,
  requestEntity,
  requestProjectKey,
  requestSystemComment,
  type RequestRow,
} from './model.js';

// The end of a planning run, for its request (01, section 3.2; owner's answers 3 to 9, lot 5 step
// E2): in the run's end transaction, with the request locked before the run. A run that planned
// it (the request still `planning`) puts it back to `open` with a `system` comment; a counted
// failure raises `attempt_count` and, at **Failed attempts before asking you**, stops it; the
// owner's **Stop run** stops it too. A failure its machine caused leaves that machine out for the
// request until it connects again, as for tickets (07, section 4); any other end clears them.

/** The stop of a request, as stored; null when it is not stopped. */
export function requestStop(row: Pick<RequestRow, 'stopped'>): RequestStop | null {
  return row.stopped === null ? null : RequestStop.parse(row.stopped);
}

export function requestMachineFailures(
  row: Pick<RequestRow, 'machineFailures'>,
): TicketMachineFailures {
  return TicketMachineFailures.parse(row.machineFailures);
}

const COUNTED = 'It counts as a failed attempt.';
const TRY_AGAIN = 'Use Try again to let the Project Manager plan it again.';

/** Applies the end of the request's planning run; returns the request as changed. */
export async function planningRunEnded(
  tx: Executor,
  input: {
    request: RequestRow;
    run: { id: string; attempt: number };
    machine: { id: string; name: string };
    to: RunStatus;
    cause: RunChangeCause;
    failureReason?: FailureReason;
    detail?: string;
    /** False when the caller writes its own comment (an answer that could not reach the run). */
    comment: boolean;
    at: Date;
  },
): Promise<RequestRow> {
  const { run, machine, cause, failureReason, at } = input;
  let request = await keepMachineFailure(tx, input.request, {
    machineId: machine.id,
    runId: run.id,
    failure:
      input.to === 'succeeded' ? null : machineFailureOf('plan', cause, failureReason ?? null),
    at,
  });
  // Only the run that was planning it: one ending after its plan leaves the request as it is.
  if (input.to === 'succeeded' || RequestStatus.parse(request.status) !== 'planning') {
    return request;
  }
  request = await changeRequestStatus(tx, {
    request,
    to: 'open',
    cause: 'run_ended',
    runId: run.id,
    failureReason,
    at,
  });

  const counted = failureReason !== undefined && isCounted(failureReason);
  const ownerStopped = cause === 'owner_stopped';
  let stop: RequestStop | null = null;
  if (counted) {
    const count = request.attemptCount + 1;
    const { maxFailedAttempts } = await resolveSettings(
      tx,
      ['maxFailedAttempts'],
      request.projectId ?? undefined,
    );
    if (request.stopped === null && count >= maxFailedAttempts) {
      stop = { cause: 'failed_attempts', count, limit: maxFailedAttempts, at: at.toISOString() };
    }
    request = await update(tx, request, {
      attemptCount: count,
      ...(stop ? { stopped: stop } : {}),
    });
  } else if (ownerStopped && request.stopped === null) {
    stop = { cause: 'stop_run', runId: run.id, at: at.toISOString() };
    request = await update(tx, request, { stopped: stop });
  }

  if (input.comment) {
    const words = failureReason === undefined ? 'it ended' : failureWords(failureReason);
    const detail = input.detail ? ` (${input.detail})` : '';
    const body = ownerStopped
      ? failureReason === 'machine_offline'
        ? `Planning run stopped by the owner while machine ${machine.name} was offline: it failed as "machine offline" and does not count as a failed attempt. The request is stopped. ${TRY_AGAIN}`
        : `Planning run stopped by the owner. It does not count as a failed attempt. The request is stopped. ${TRY_AGAIN}`
      : counted
        ? `Planning attempt ${String(run.attempt)} failed on machine ${machine.name}: ${words}${detail}. ${
            stop?.cause === 'failed_attempts'
              ? `It counts as a failed attempt: ${String(stop.count)} failed attempt${stop.count === 1 ? '' : 's'}, ${stop.count > stop.limit ? 'more than' : 'as many as'} Failed attempts before asking you allows (${String(stop.limit)}), so the request is stopped. ${TRY_AGAIN}`
              : COUNTED
          }`
        : `The planning run on machine ${machine.name} ended: ${words}${detail}. It does not count as a failed attempt.`;
    await requestSystemComment(tx, request, body, at);
  }
  if (stop) {
    await recordEvent(tx, {
      actor: ownerStopped ? 'owner' : 'system',
      ...requestEntity(request),
      type: 'request.stopped',
      payload: {
        request: request.number,
        project: await requestProjectKey(tx, request),
        cause: stop.cause,
        ...(stop.cause === 'failed_attempts' ? { count: stop.count, limit: stop.limit } : {}),
        runId: run.id,
      },
      at,
    });
  }
  return request;
}

async function update(
  tx: Executor,
  request: RequestRow,
  set: Partial<typeof schema.requests.$inferInsert>,
): Promise<RequestRow> {
  const [updated] = await tx
    .update(schema.requests)
    .set(set)
    .where(eq(schema.requests.id, request.id))
    .returning();
  if (!updated) throw new Error(`request ${request.id} disappeared`);
  return updated;
}

/**
 * A failure its machine caused adds to that machine's failures in a row; any other end clears
 * them all (07, section 4). Never an item: `asked` stays null for requests.
 */
async function keepMachineFailure(
  tx: Executor,
  request: RequestRow,
  input: {
    machineId: string;
    runId: string;
    failure: ReturnType<typeof machineFailureOf>;
    at: Date;
  },
): Promise<RequestRow> {
  const current = requestMachineFailures(request);
  if (input.failure === null) {
    return current.length === 0 ? request : update(tx, request, { machineFailures: [] });
  }
  const entry = current.find((each) => each.machineId === input.machineId);
  const next: TicketMachineFailures = [
    ...current.filter((each) => each.machineId !== input.machineId),
    {
      machineId: input.machineId,
      failures: [
        ...(entry?.failures ?? []),
        { cause: input.failure, at: input.at.toISOString(), runId: input.runId },
      ],
      asked: null,
    },
  ];
  return update(tx, request, { machineFailures: next });
}
