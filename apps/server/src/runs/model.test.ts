import { FailureReason } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { isCounted, nextQuotaWait, statusTimes } from './model.js';

// Working and waiting times of a run (01, section 3.7; owner's decision, lot 2 step L).

const since = new Date('2026-09-29T10:00:00Z');
const now = new Date('2026-09-29T10:01:30Z');

const before = {
  workingMs: 1000,
  waitingMs: 2000,
  waitingOwnerMs: 500,
  waitingCiMs: 700,
  waitingQuotaMs: 800,
};

function leaving(status: string, ciWaitingSince: Date | null = null) {
  return statusTimes({ status, statusSince: since, ciWaitingSince, ...before }, now);
}

describe('statusTimes', () => {
  it('adds the time since the last change to working for starting and running', () => {
    expect(leaving('starting')).toEqual({ ...before, statusSince: now, workingMs: 91_000 });
    expect(leaving('running')).toEqual({ ...before, statusSince: now, workingMs: 91_000 });
  });

  // The waiting time split between the owner, CI and the quota (07, section 7; lot 4 step H).
  it('adds it to waiting for the owner in waiting_human', () => {
    expect(leaving('waiting_human')).toEqual({
      ...before,
      statusSince: now,
      waitingMs: 92_000,
      waitingOwnerMs: 90_500,
    });
  });

  it('adds it to waiting for the quota in paused_quota', () => {
    expect(leaving('paused_quota')).toEqual({
      ...before,
      statusSince: now,
      waitingMs: 92_000,
      waitingQuotaMs: 90_800,
    });
  });

  it('adds it to waiting for CI while running with its session idle waiting for CI', () => {
    expect(leaving('running', since)).toEqual({
      ...before,
      statusSince: now,
      waitingMs: 92_000,
      waitingCiMs: 90_700,
    });
  });

  it('counts queued and dispatched in neither', () => {
    expect(leaving('queued')).toEqual({ ...before, statusSince: now });
    expect(leaving('dispatched')).toEqual({ ...before, statusSince: now });
  });

  it('never subtracts when the clock went back', () => {
    const earlier = new Date('2026-09-29T09:00:00Z');
    expect(statusTimes({ status: 'running', statusSince: since, ...before }, earlier)).toEqual({
      ...before,
      statusSince: earlier,
    });
  });
});

// Which failures count as a failed attempt (04, section 5; owner's decisions, lot 2 steps A, C,
// J and M2, lot 3 steps A, G2b and K2): every reason is listed, so a new one must be decided here.
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
    download_failed: false,
  };

  it.each(FailureReason.options)('%s as decided', (reason) => {
    expect(isCounted(reason)).toBe(decided[reason]);
  });
});

describe('nextQuotaWait (07, section 5.2; lot 4 step E)', () => {
  const settings = { quotaFallbackDelayMinutes: 60, quotaFallbackMaxDelayMinutes: 240 };

  it('starts at Quota wait when the reset time is unknown, then doubles up to Longest quota wait', () => {
    const waits: number[] = [];
    let previous: number | null = null;
    for (let pause = 0; pause < 5; pause += 1) {
      previous = nextQuotaWait(previous, settings);
      waits.push(previous);
    }
    expect(waits).toEqual([60, 120, 240, 240, 240]);
  });

  it('follows the settings changed meanwhile', () => {
    expect(nextQuotaWait(30, settings)).toBe(60);
    expect(nextQuotaWait(240, { ...settings, quotaFallbackMaxDelayMinutes: 90 })).toBe(90);
  });
});
