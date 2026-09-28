import { RunRefusal, type MachineUnavailable } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { runRefusalText, unavailableText } from './text';

const account = { id: '3f1e0e8c-1111-4000-8000-000000000000', label: 'Personal' };
const machine = { id: '3f1e0e8c-2222-4000-8000-000000000000', name: 'Laptop' };
const until = '2026-09-28T15:45:00.000Z';

const unavailable: {
  [Why in MachineUnavailable['why']]: Extract<MachineUnavailable, { why: Why }>;
} = {
  waiting_enrollment: { why: 'waiting_enrollment' },
  offline: { why: 'offline' },
  disabled: { why: 'disabled' },
  revoked: { why: 'revoked' },
  daemon_incompatible: { why: 'daemon_incompatible' },
  unusable: {
    why: 'unusable',
    reasons: [{ type: 'claude_code_unsupported', version: '2.1.100', minimum: '2.1.280' }],
  },
  missing_capabilities: { why: 'missing_capabilities', capabilities: ['android-sdk'] },
  account_limited: { why: 'account_limited', account, until },
  account_busy: { why: 'account_busy', account, maxConcurrentRuns: 2 },
};

const refusals: { [Reason in RunRefusal['reason']]: Extract<RunRefusal, { reason: Reason }> } = {
  ticket_not_todo: { reason: 'ticket_not_todo', status: 'in_progress' },
  no_assignee: { reason: 'no_assignee' },
  blocked: { reason: 'blocked', tickets: ['WEB-3', 'WEB-4'] },
  project_archived: { reason: 'project_archived' },
  project_not_ready: { reason: 'project_not_ready' },
  github_not_connected: { reason: 'github_not_connected' },
  github_token_unreadable: { reason: 'github_token_unreadable' },
  github_token_invalid: { reason: 'github_token_invalid' },
  github_account_unknown: { reason: 'github_account_unknown' },
  first_message_too_large: { reason: 'first_message_too_large', maxBytes: 100_000 },
  machine_unavailable: {
    reason: 'machine_unavailable',
    machine,
    commits: 2,
    unavailable: { why: 'offline' },
  },
  no_machine: {
    reason: 'no_machine',
    machines: Object.values(unavailable).map((entry) => ({ machine, unavailable: entry })),
  },
  run_not_paused: { reason: 'run_not_paused', status: 'running' },
  account_limited: { reason: 'account_limited', account, until },
  account_busy: { reason: 'account_busy', account, maxConcurrentRuns: 1 },
};

describe('run refusals in plain words (07, section 3)', () => {
  it.each(Object.keys(refusals))('explains %s without codes', (reason) => {
    const refusal = refusals[reason as RunRefusal['reason']];
    expect(RunRefusal.safeParse(refusal).success).toBe(true);
    const text = runRefusalText(refusal);
    expect(text).toMatch(/^[A-Z].*\.$/s);
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b|undefined|null|\[object/);
  });

  it('states the values a refusal depends on', () => {
    expect(runRefusalText(refusals.account_busy)).toContain('its maximum of 1 run at a time');
    expect(unavailableText(unavailable.account_busy)).toContain('its maximum of 2 runs at a time');
    expect(runRefusalText(refusals.machine_unavailable)).toBe(
      "The ticket's work (2 commits) is on machine Laptop, and it is offline. The run can only continue there.",
    );
    expect(runRefusalText(refusals.blocked)).toBe(
      'This ticket waits for WEB-3, WEB-4, which are not done yet.',
    );
  });
});
