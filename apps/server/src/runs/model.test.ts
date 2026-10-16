import { FailureReason } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { isCounted, statusTimes } from './model.js';

// Working and waiting times of a run (01, section 3.7; owner's decision, lot 2 step L).

const since = new Date('2026-09-29T10:00:00Z');
const now = new Date('2026-09-29T10:01:30Z');

function leaving(status: string) {
  return statusTimes({ status, statusSince: since, workingMs: 1000, waitingMs: 2000 }, now);
}

describe('statusTimes', () => {
  it('adds the time since the last change to working for starting and running', () => {
    expect(leaving('starting')).toEqual({ statusSince: now, workingMs: 91_000, waitingMs: 2000 });
    expect(leaving('running')).toEqual({ statusSince: now, workingMs: 91_000, waitingMs: 2000 });
  });

  it('adds it to waiting for waiting_human and paused_quota', () => {
    expect(leaving('waiting_human')).toEqual({
      statusSince: now,
      workingMs: 1000,
      waitingMs: 92_000,
    });
    expect(leaving('paused_quota')).toEqual({
      statusSince: now,
      workingMs: 1000,
      waitingMs: 92_000,
    });
  });

  it('counts queued and dispatched in neither', () => {
    expect(leaving('queued')).toEqual({ statusSince: now, workingMs: 1000, waitingMs: 2000 });
    expect(leaving('dispatched')).toEqual({ statusSince: now, workingMs: 1000, waitingMs: 2000 });
  });

  it('never subtracts when the clock went back', () => {
    const earlier = new Date('2026-09-29T09:00:00Z');
    expect(
      statusTimes(
        { status: 'running', statusSince: since, workingMs: 1000, waitingMs: 0 },
        earlier,
      ),
    ).toEqual({ statusSince: earlier, workingMs: 1000, waitingMs: 0 });
  });
});

// Which failures count as a failed attempt (04, section 5; owner's decisions, lot 2 steps A, C,
// J and M2, lot 3 steps A and G2b): every reason is listed, so a new one must be decided here.
describe('isCounted', () => {
  const decided: Record<FailureReason, boolean> = {
    timeout: true,
    crash: true,
    agent_gave_up: true,
    dod_failed: true,
    ci_failed: true,
    machine_offline: false,
    machine_revoked: false,
    claude_code_unsupported: false,
    machine_problem: false,
    cancelled: false,
    ci_timeout: false,
    review_branch_moved: false,
    push_failed: false,
    ci_cancelled: false,
  };

  it.each(FailureReason.options)('%s as decided', (reason) => {
    expect(isCounted(reason)).toBe(decided[reason]);
  });
});
