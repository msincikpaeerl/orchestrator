import { schema } from '@orchestrator/db';
import {
  ACTIVE_RUN_STATUSES,
  CiAcceptedLater,
  CiResult,
  CiRound,
  CiRoundRefusal,
  type CiCheck,
  type CiCheckView,
  type CiNotSent,
  type RunCiHistory,
  type RunCiOutcome,
  SubmissionRecord,
  FailureReason,
  type TicketCi,
} from '@orchestrator/protocol';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Executor } from '../database.js';
import type { RunRow } from './model.js';

// What a run's wait for CI came to, for the screens (02, sections 4, 6.4 and 7; owner's answers,
// lot 3 step G2c), read from what the run keeps: its wait (`ci_commit` and after), its rounds, the
// machine's latest refusal of a round, its end and the work accepted later by **Check CI again**.

const ACTIVE = new Set<string>(ACTIVE_RUN_STATUSES);

export type CiRunRow = Pick<
  RunRow,
  | 'status'
  | 'failureReason'
  | 'ciCommit'
  | 'ciWaitStartedAt'
  | 'ciWaitTimeoutMinutes'
  | 'ciResult'
  | 'ciCheckedAt'
  | 'ciRounds'
  | 'ciRoundRefusal'
  | 'maxCiFailures'
  | 'ciPullRequestHead'
  | 'ciAcceptedLater'
  | 'baseBranch'
>;

function view(checks: CiCheck[]): CiCheckView[] {
  return checks.map(({ kind, name, state, url }) => ({ kind, name, state, url }));
}

/** The rounds kept on the run, oldest first. */
export function roundsOf(run: Pick<RunRow, 'ciRounds'>): CiRound[] {
  return z.array(CiRound).parse(run.ciRounds);
}

/**
 * Why the failure or conflict of a run ended `ci_timeout` did not reach the agent, in the order
 * of the run's end detail: a round not confirmed, then a round refused, else read too late.
 */
function notSent(run: CiRunRow, rounds: CiRound[]): CiNotSent {
  const last = rounds.at(-1);
  if (last !== undefined && last.confirmedAt === null && last.commit === run.ciCommit) {
    return { why: 'not_confirmed', message: null };
  }
  if (run.ciRoundRefusal !== null) {
    return { why: 'refused', message: CiRoundRefusal.parse(run.ciRoundRefusal).message };
  }
  return { why: 'read_late', message: null };
}

/** What the run's CI came to; null when the run never waited for CI. */
export function ciOutcome(run: CiRunRow): RunCiOutcome | null {
  const rounds = roundsOf(run);
  const confirmed = rounds.filter((round) => round.confirmedAt !== null);
  const result = run.ciResult === null ? null : CiResult.parse(run.ciResult);
  const acceptedLater =
    run.ciAcceptedLater === null ? null : CiAcceptedLater.parse(run.ciAcceptedLater);
  const base = {
    at: run.ciCheckedAt?.toISOString() ?? null,
    checks: view(result?.checks ?? []),
    conflict: result?.state === 'conflict',
    notSent: null,
    failures: 0,
    anyConflict: false,
    round: null,
    pullRequestHead: null,
    pullRequestOpened: run.ciWaitStartedAt !== null,
    acceptedLater,
  };

  if (run.ciCommit === null) {
    // The wait went with a confirmed round: the run worked again, and ended without handing in.
    const last = confirmed.at(-1);
    if (last === undefined || ACTIVE.has(run.status)) return null;
    return {
      ...base,
      kind: 'after_round',
      commit: last.commit,
      at: last.readAt,
      checks: view(last.result.checks),
      conflict: last.kind === 'conflict',
      round: last.round,
      pullRequestOpened: true,
    };
  }
  const commit = run.ciCommit;
  if (ACTIVE.has(run.status)) return { ...base, kind: 'waiting', commit };
  if (run.status === 'succeeded') {
    return { ...base, kind: result?.state === 'no_ci' ? 'no_ci' : 'passed', commit };
  }
  switch (run.failureReason) {
    case 'ci_failed':
      return {
        ...base,
        kind: 'too_many',
        commit,
        failures: confirmed.length + 1,
        anyConflict: base.conflict || confirmed.some((round) => round.kind === 'conflict'),
      };
    case 'ci_timeout': {
      const pending = rounds.at(-1);
      const refusal = run.ciRoundRefusal === null ? null : CiRoundRefusal.parse(run.ciRoundRefusal);
      const unconfirmed =
        pending !== undefined && pending.confirmedAt === null && pending.commit === commit
          ? pending
          : null;
      const kind = unconfirmed?.kind ?? refusal?.kind ?? result?.state;
      if (kind === 'failed') {
        return { ...base, kind: 'not_received', commit, notSent: notSent(run, rounds) };
      }
      if (kind === 'conflict') {
        return {
          ...base,
          kind: 'conflict',
          commit,
          conflict: true,
          notSent: notSent(run, rounds),
        };
      }
      return { ...base, kind: 'not_finished', commit };
    }
    case 'ci_cancelled':
      return { ...base, kind: 'cancelled', commit, pullRequestHead: run.ciPullRequestHead };
    default:
      return { ...base, kind: 'ended', commit };
  }
}

/** The run page's CI: its rounds and its outcome; null when the run never waited for CI. */
export function ciHistory(run: CiRunRow): RunCiHistory | null {
  const rounds = roundsOf(run);
  const outcome = ciOutcome(run);
  if (outcome === null && rounds.length === 0) return null;
  return {
    maxCiFailures: run.maxCiFailures,
    waitMinutes: run.ciWaitTimeoutMinutes,
    base: run.baseBranch,
    rounds: rounds.map((round) => ({
      round: round.round,
      kind: round.kind,
      commit: round.commit,
      readAt: round.readAt,
      confirmedAt: round.confirmedAt,
      checks: view(round.result.checks),
    })),
    outcome,
  };
}

/**
 * **Check CI again** is offered (owner's answers, lot 3 steps G2b and G2c): after `ci_timeout`
 * without a conflict, and after `ci_failed` on a failure, not accepted since.
 */
export function checkCiAgainOffered(outcome: RunCiOutcome): boolean {
  if (outcome.acceptedLater !== null) return false;
  return (
    outcome.kind === 'not_finished' ||
    outcome.kind === 'not_received' ||
    (outcome.kind === 'too_many' && !outcome.conflict)
  );
}

/**
 * The ticket's run the CI line is about (owner's answer 3g, lot 3 step G2c): its latest run that
 * had a wait for CI (one ended after a confirmed round counts); none while a later run is active
 * without having handed work in. Review runs are passed over (lot 3 step H1).
 */
export async function ciSourceRun(executor: Executor, ticketId: string): Promise<RunRow | null> {
  const runs = await executor
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.ticketId, ticketId))
    .orderBy(desc(schema.runs.createdAt));
  for (const run of runs) {
    // A review run never waits for CI nor hands work in: the line stays on the work reviewed.
    if (run.purpose === 'review') continue;
    const had = run.ciCommit !== null || roundsOf(run).some((round) => round.confirmedAt !== null);
    if (had) return ciOutcome(run) === null ? null : run;
    if (ACTIVE.has(run.status)) return null;
  }
  return null;
}

/**
 * The ticket page's CI line (owner's answers, lot 3 step G2c), from `ciSourceRun`; **Check CI
 * again** offered only while the ticket is back in `todo` (no run active).
 */
export async function ticketCi(
  executor: Executor,
  ticket: { id: string; status: string },
): Promise<TicketCi | null> {
  const run = await ciSourceRun(executor, ticket.id);
  const outcome = run === null ? null : ciOutcome(run);
  if (run === null || outcome === null) return null;
  const [machine] = await executor
    .select({ id: schema.machines.id, name: schema.machines.name })
    .from(schema.machines)
    .where(eq(schema.machines.id, run.machineId));
  if (!machine) return null;
  return {
    runId: run.id,
    attempt: run.attempt,
    machine,
    failureReason: run.failureReason === null ? null : FailureReason.parse(run.failureReason),
    endedAt: run.endedAt?.toISOString() ?? null,
    submittedAt: run.submission === null ? null : SubmissionRecord.parse(run.submission).at,
    waitMinutes: run.ciWaitTimeoutMinutes,
    maxCiFailures: run.maxCiFailures,
    base: run.baseBranch,
    outcome,
    checkCiAgain: ticket.status === 'todo' && checkCiAgainOffered(outcome),
  };
}
