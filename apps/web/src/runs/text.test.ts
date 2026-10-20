import {
  BlockingItem,
  HoldCause,
  MachineFailureCause,
  QueueReason,
  RunRefusal,
  type MachineUnavailable,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import {
  acceptedAfterText,
  machineFailureText,
  queueReasonText,
  resumeText,
  runBranchText,
  runRefusalText,
  ticketUsageText,
  unavailableText,
} from './text';

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
  account_paused: { why: 'account_paused', account },
  account_busy: { why: 'account_busy', account, maxConcurrentRuns: 2 },
  account_outside_window: { why: 'account_outside_window', account, next: until },
  account_budget_used: { why: 'account_budget_used', account, until },
  left_out: { why: 'left_out', cause: 'dispatch_timeout', at: until },
};

const refusals: { [Reason in RunRefusal['reason']]: Extract<RunRefusal, { reason: Reason }> } = {
  ticket_not_todo: { reason: 'ticket_not_todo', status: 'in_progress' },
  no_assignee: { reason: 'no_assignee' },
  ticket_stopped: { reason: 'ticket_stopped', cause: 'review_rounds', count: 3, limit: 2 },
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
  account_paused: { reason: 'account_paused', account },
  account_busy: { reason: 'account_busy', account, maxConcurrentRuns: 1 },
  ticket_not_in_review: { reason: 'ticket_not_in_review', status: 'todo' },
  no_pull_request: { reason: 'no_pull_request' },
  review_active: { reason: 'review_active' },
  review_head_moved: { reason: 'review_head_moved', commit: 'a'.repeat(40), head: 'b'.repeat(40) },
  pull_request_not_open: { reason: 'pull_request_not_open', pullRequest: 12, merged: false },
  github_problem: { reason: 'github_problem', message: 'GitHub could not be reached' },
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
      "The ticket's branch has 2 commits not on GitHub, only on machine Laptop, and it is offline. The run can only continue there.",
    );
    expect(runRefusalText(refusals.blocked)).toBe(
      'This ticket waits for WEB-3, WEB-4, which are not done yet.',
    );
    // A cancelled blocker: how to let the ticket start (owner, review of lot 4 step D1).
    expect(runRefusalText({ reason: 'blocked', tickets: ['WEB-3'], cancelled: ['WEB-3'] })).toBe(
      'Blocked by WEB-3 (cancelled): remove the dependency to let it start.',
    );
    expect(
      runRefusalText({
        reason: 'blocked',
        tickets: ['WEB-3', 'WEB-4'],
        cancelled: ['WEB-3', 'WEB-4'],
      }),
    ).toBe(
      'Blocked by WEB-3 (cancelled), WEB-4 (cancelled): remove the dependencies to let it start.',
    );
    expect(
      runRefusalText({ reason: 'blocked', tickets: ['WEB-3', 'WEB-4'], cancelled: ['WEB-4'] }),
    ).toBe(
      'This ticket waits for WEB-3, which is not done yet. Blocked by WEB-4 (cancelled): remove the dependency to let it start.',
    );
    expect(queueReasonText({ reason: 'blocked', tickets: ['WEB-3'], cancelled: ['WEB-3'] })).toBe(
      'Blocked by WEB-3 (cancelled): remove the dependency to let it start.',
    );
    // Owner's answer 3, lot 3 step K: the setting and its value.
    for (const [count, words] of [
      [2, '2 failed attempts'],
      [1, '1 failed attempt'],
    ] as const) {
      expect(
        runRefusalText({ reason: 'ticket_stopped', cause: 'failed_attempts', count, limit: count }),
      ).toBe(
        `This ticket is stopped after ${words} (Failed attempts before asking you: ${String(count)}): use Try again, Cancel or Mark as done manually.`,
      );
    }
    // "Reopen it first" (owner's answer 3 of step J4, lot 3 step J4b).
    expect(runRefusalText(refusals.pull_request_not_open)).toBe(
      'Pull request #12 is closed on GitHub, so there is nothing to review. Reopen it first, with Reopen pull request on the ticket page or in Needs you.',
    );
  });
});

describe("the queue's reasons in plain words (07, section 7; lot 4 step D1)", () => {
  const queueReasons: QueueReason[] = [
    ...Object.values(refusals),
    ...HoldCause.options.map((cause) => ({ reason: 'held' as const, cause })),
    ...BlockingItem.options.map((item) => ({
      reason: 'needs_you' as const,
      item,
      machine: item === 'download_failed' || item === 'machine_failures' ? machine : null,
    })),
    { reason: 'reviews_off' },
    { reason: 'quota_wait', until, minutes: 120 },
  ];

  it.each(queueReasons.map((reason) => [reason.reason, reason] as const))(
    'explains %s without codes',
    (_, reason) => {
      expect(QueueReason.safeParse(reason).success).toBe(true);
      const text = queueReasonText(reason);
      expect(text).toMatch(/^[A-Z].*\.$/s);
      expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b|undefined|null|\[object/);
    },
  );

  it("says Run now's reasons in Run now's words", () => {
    for (const refusal of Object.values(refusals)) {
      expect(queueReasonText(refusal)).toBe(runRefusalText(refusal));
    }
  });

  it('names the account window, the budget and a machine left out (step A)', () => {
    const noMachine = (entry: MachineUnavailable) =>
      queueReasonText({ reason: 'no_machine', machines: [{ machine, unavailable: entry }] });
    expect(noMachine(unavailable.account_outside_window)).toBe(
      `No machine can take the run: Laptop: its Claude account Personal is outside its window until ${formatDateTime(until)}.`,
    );
    expect(noMachine({ why: 'account_outside_window', account, next: null })).toBe(
      'No machine can take the run: Laptop: its Claude account Personal is outside its windows.',
    );
    expect(noMachine(unavailable.account_budget_used)).toBe(
      `No machine can take the run: Laptop: its Claude account Personal has used its daily budget for today, until ${formatDateTime(until)}.`,
    );
    for (const cause of MachineFailureCause.options) {
      expect(noMachine({ why: 'left_out', cause, at: until })).toBe(
        `No machine can take the run: Laptop: it is left out for this ticket since ${formatDateTime(until)}, when ${machineFailureText[cause]}, until it connects again or you use Run now.`,
      );
    }
  });

  it('says how to release a held ticket, and which item it waits on', () => {
    expect(queueReasonText({ reason: 'held', cause: 'stop_run' })).toBe(
      'Held: you stopped its run. Run now releases it and starts it.',
    );
    expect(queueReasonText({ reason: 'held', cause: 'stop_review' })).toBe(
      'Held: you stopped its review. Start review releases it and starts it.',
    );
    expect(queueReasonText({ reason: 'held', cause: 'request_changes' })).toBe(
      'Held: you asked to edit its acceptance criteria first. Run now releases it and starts it.',
    );
    expect(queueReasonText({ reason: 'needs_you', item: 'machine_failures', machine })).toBe(
      'Waiting for you in Needs you: it could not start on Laptop.',
    );
    expect(queueReasonText({ reason: 'needs_you', item: 'ci_cancelled', machine: null })).toBe(
      'Waiting for you in Needs you: CI was cancelled on GitHub because the branch changed there.',
    );
  });

  it("says a review waits for Start review while the project's switch is off (step D3)", () => {
    expect(queueReasonText({ reason: 'reviews_off' })).toBe(
      "Start reviews by themselves is off in this project's settings: the review waits for you to use Start review.",
    );
  });
});

describe('when the scheduler resumes a paused run (lot 4 step E)', () => {
  it("says its own wait after a suspected limit, its account's limit, or what else it waits for", () => {
    expect(queueReasonText({ reason: 'quota_wait', until, minutes: 120 })).toBe(
      `Paused on a possible usage limit: the scheduler resumes it at ${formatDateTime(until)}, 2 hours after it paused.`,
    );
    expect(resumeText({ reason: 'quota_wait', until, minutes: 60 })).toBe(
      `The scheduler resumes it by itself at ${formatDateTime(until)} (1 hour after it paused), if its Claude account and machine can take it then.`,
    );
    expect(resumeText({ reason: 'account_limited', account, until })).toBe(
      `The scheduler resumes it by itself once the limit resets, at ${formatDateTime(until)}.`,
    );
    expect(
      resumeText({
        reason: 'machine_unavailable',
        machine,
        commits: null,
        unavailable: unavailable.account_outside_window,
      }),
    ).toBe(
      `The scheduler resumes it by itself once this changes: This run can only continue on machine Laptop, and its Claude account Personal is outside its window until ${formatDateTime(until)}.`,
    );
    expect(resumeText({ reason: 'account_paused', account })).toBe(
      'The scheduler resumes it by itself once this changes: The Claude account Personal is paused: you stopped new runs on it. Resume the account in Machines first.',
    );
    expect(resumeText(null)).toBe('The scheduler resumes it by itself at its next check.');
  });

  it('says a machine that did not take the latest resume waits for its reconnection or Resume', () => {
    expect(
      runRefusalText({
        reason: 'machine_unavailable',
        machine,
        commits: null,
        unavailable: { why: 'left_out', cause: 'dispatch_refused', at: until },
      }),
    ).toBe(
      `This run can only continue on machine Laptop, which did not take its latest resume at ${formatDateTime(until)} (it refused it): the scheduler resumes it again once the machine connects again, or use Resume.`,
    );
  });
});

describe("acceptedAfterText (owner's correction, step F4)", () => {
  const refusedSubmission = { at: '2026-10-09T10:00:00.000Z' };
  it('says the work was accepted after the refused submission, with its date', () => {
    expect(
      acceptedAfterText({ refusedSubmission, acceptedSubmissionAt: '2026-10-09T10:05:00.000Z' }),
    ).toMatch(/^The agent then handed its work in again, and it was accepted on .+\.$/);
  });

  it('says nothing when the work was not accepted after it', () => {
    expect(acceptedAfterText({ refusedSubmission, acceptedSubmissionAt: null })).toBeNull();
    expect(
      acceptedAfterText({ refusedSubmission, acceptedSubmissionAt: '2026-10-09T09:00:00.000Z' }),
    ).toBeNull();
  });
});

describe('runBranchText (lot 3 step L, from step K2)', () => {
  const name = 't/1-contact-form';
  const head = 'c'.repeat(40);
  const run = (
    status: 'running' | 'failed' | 'succeeded',
    endReason: 'download_failed' | 'crashed' | 'submitted' | null,
    branchHead: string | null,
  ) => ({
    status,
    endReason,
    branch: { name, head: branchHead, commits: [] },
    machine: { name: 'Laptop' },
  });

  it('says no branch was made when the run failed at its download on a new machine', () => {
    expect(runBranchText(run('failed', 'download_failed', null))).toEqual({
      text: 'No branch was made on machine Laptop: the run ended before the project was downloaded.',
      commits: false,
    });
  });

  it('shows the branch as it was before the run when it failed at its download', () => {
    expect(runBranchText(run('failed', 'download_failed', head))).toEqual({
      text: `${name} on machine Laptop, as it was before this run: the run ended before the project was downloaded, so it never worked on the branch.`,
      commits: true,
    });
  });

  it('says the machine reported no branch for another end without one', () => {
    expect(runBranchText(run('failed', 'crashed', null))).toEqual({
      text: `Machine Laptop reported no branch ${name} at the end of this run.`,
      commits: false,
    });
  });

  it('keeps "as this run left it" for a run that worked on the branch, and no end for an active run', () => {
    expect(runBranchText(run('succeeded', 'submitted', head)).text).toBe(
      `${name} on machine Laptop, as this run left it`,
    );
    expect(runBranchText(run('running', null, null))).toEqual({
      text: `${name} on machine Laptop`,
      commits: true,
    });
  });
});

describe("a ticket's estimated usage (lot 4 step C)", () => {
  it('adds its runs, and names those without an estimate', () => {
    expect(ticketUsageText([{ estimatedUsageUsd: 0.5 }, { estimatedUsageUsd: 1.25 }])).toBe(
      'Estimated usage: $1.75 over 2 runs (estimated by Claude Code).',
    );
    expect(ticketUsageText([{ estimatedUsageUsd: 0.5 }, { estimatedUsageUsd: null }])).toBe(
      'Estimated usage: $0.50 over 2 runs (estimated by Claude Code); 1 of them has no estimate yet and counts as $0.00.',
    );
  });
});
