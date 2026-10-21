import {
  BlockingItem,
  HoldCause,
  MachineFailureCause,
  QueueReason,
  type AccountToday,
  type MachineUnavailable,
  type QueueAccount,
  type QueueCandidate,
  type RunRefusal,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../github/text';
import { queueRefreshMs } from '../queries';
import {
  accountLineText,
  accountUnavailableText,
  candidateFactsText,
  candidateReasonText,
  candidateStartOffered,
} from './queue-text';

// Activity > Queue in words (02, section 7; 07, section 7; lot 4 step H): every line the owner may
// see overnight, each reason of D1 and those added since (Most resumes per run, the machine
// holding the work offline since a time, a suspected limit's next resume).

const account = { id: '3f1e0e8c-1111-4000-8000-000000000000', label: 'Personal' };
const machine = { id: '3f1e0e8c-2222-4000-8000-000000000000', name: 'Laptop' };
const at = '2026-10-21T05:00:00.000Z';
const time = formatDateTime(at);

const candidate = (fields: Partial<QueueCandidate> = {}): QueueCandidate => ({
  kind: 'implement',
  ticket: {
    projectKey: 'TESTB',
    number: 4,
    title: 'Add a CONTRIBUTING.md file',
    priority: 'normal',
  },
  runId: null,
  blocks: 0,
  afterFailure: false,
  since: '2026-10-20T18:00:00.000Z',
  reason: null,
  machine: null,
  ...fields,
});
const line = (reason: QueueReason | null, kind: QueueCandidate['kind'] = 'implement') =>
  candidateReasonText(
    candidate({
      kind,
      reason,
      runId: kind === 'resume' ? '3f1e0e8c-3333-4000-8000-000000000000' : null,
    }),
  );

// Every reason a machine or an account can have: a new one fails the type check here.
const unavailable: {
  [Why in MachineUnavailable['why']]: Extract<MachineUnavailable, { why: Why }>[];
} = {
  waiting_enrollment: [{ why: 'waiting_enrollment' }],
  offline: [
    { why: 'offline', since: null },
    { why: 'offline', since: at },
  ],
  disabled: [{ why: 'disabled' }],
  revoked: [{ why: 'revoked' }],
  daemon_incompatible: [{ why: 'daemon_incompatible' }],
  unusable: [
    {
      why: 'unusable',
      reasons: [{ type: 'claude_code_unsupported', version: null, minimum: '2.1.280' }],
    },
  ],
  missing_capabilities: [{ why: 'missing_capabilities', capabilities: ['android-sdk'] }],
  account_limited: [{ why: 'account_limited', account, until: at }],
  account_paused: [{ why: 'account_paused', account }],
  account_busy: [
    { why: 'account_busy', account, maxConcurrentRuns: 1 },
    { why: 'account_busy', account, maxConcurrentRuns: 2 },
  ],
  account_outside_window: [
    { why: 'account_outside_window', account, next: at },
    { why: 'account_outside_window', account, next: null },
  ],
  account_budget_used: [{ why: 'account_budget_used', account, until: at }],
  left_out: MachineFailureCause.options.map((cause) => ({ why: 'left_out' as const, cause, at })),
};
const everyUnavailable = Object.values(unavailable).flat();

// Every refusal Run now and Resume give: a new one fails the type check here.
const refusals: { [Reason in RunRefusal['reason']]: Extract<RunRefusal, { reason: Reason }>[] } = {
  ticket_not_todo: [{ reason: 'ticket_not_todo', status: 'in_progress' }],
  no_assignee: [{ reason: 'no_assignee' }],
  ticket_stopped: [
    { reason: 'ticket_stopped', cause: 'failed_attempts', count: 3, limit: 3 },
    { reason: 'ticket_stopped', cause: 'review_rounds', count: 3, limit: 2 },
  ],
  blocked: [
    { reason: 'blocked', tickets: ['TESTB-3'] },
    { reason: 'blocked', tickets: ['TESTB-3', 'TESTB-6'], cancelled: ['TESTB-6'] },
  ],
  project_archived: [{ reason: 'project_archived' }],
  project_not_ready: [{ reason: 'project_not_ready' }],
  github_not_connected: [{ reason: 'github_not_connected' }],
  github_token_unreadable: [{ reason: 'github_token_unreadable' }],
  github_token_invalid: [{ reason: 'github_token_invalid' }],
  github_account_unknown: [{ reason: 'github_account_unknown' }],
  first_message_too_large: [{ reason: 'first_message_too_large', maxBytes: 100_000 }],
  // The machine holding the ticket's commits, or a paused run's own machine (`commits` null).
  machine_unavailable: everyUnavailable.flatMap((entry) =>
    [null, 1, 2].map((commits) => ({
      reason: 'machine_unavailable' as const,
      machine,
      commits,
      unavailable: entry,
    })),
  ),
  no_machine: [
    { reason: 'no_machine', machines: [] },
    ...everyUnavailable.map((entry) => ({
      reason: 'no_machine' as const,
      machines: [{ machine, unavailable: entry }],
    })),
  ],
  run_not_paused: [{ reason: 'run_not_paused', status: 'running' }],
  account_limited: [{ reason: 'account_limited', account, until: at }],
  account_paused: [{ reason: 'account_paused', account }],
  account_busy: [{ reason: 'account_busy', account, maxConcurrentRuns: 1 }],
  ticket_not_in_review: [{ reason: 'ticket_not_in_review', status: 'todo' }],
  no_pull_request: [{ reason: 'no_pull_request' }],
  review_active: [{ reason: 'review_active' }],
  review_head_moved: [
    { reason: 'review_head_moved', commit: 'a'.repeat(40), head: 'b'.repeat(40) },
  ],
  pull_request_not_open: [
    { reason: 'pull_request_not_open', pullRequest: 12, merged: false },
    { reason: 'pull_request_not_open', pullRequest: 12, merged: true },
  ],
  github_problem: [{ reason: 'github_problem', message: 'GitHub could not be reached.' }],
};

const everyReason: QueueReason[] = [
  ...Object.values(refusals).flat(),
  ...HoldCause.options.map((cause) => ({ reason: 'held' as const, cause })),
  ...BlockingItem.options.flatMap((item) =>
    [null, machine].map((on) => ({ reason: 'needs_you' as const, item, machine: on })),
  ),
  { reason: 'reviews_off' },
  { reason: 'quota_wait', until: at, minutes: 60 },
  { reason: 'quota_wait', until: at, minutes: 90 },
];

describe('every queue line in plain words (lot 4 step H)', () => {
  it.each(
    everyReason.flatMap((reason) =>
      (['implement', 'resume'] as const).map(
        (kind) => [`${reason.reason} (${kind})`, reason, kind] as const,
      ),
    ),
  )('words %s as a sentence without codes', (_, reason, kind) => {
    expect(QueueReason.safeParse(reason).success).toBe(true);
    const text = line(reason, kind);
    expect(text).toMatch(/^[A-Z].*\.$/s);
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b|undefined|null|NaN|Invalid Date|\[object/);
  });

  it('says when a candidate that can start starts, and where', () => {
    expect(candidateReasonText(candidate({ machine }))).toBe(
      'The scheduler starts it at its next check, on machine Laptop.',
    );
    expect(candidateReasonText(candidate({ kind: 'resume', machine }))).toBe(
      'The scheduler resumes it at its next check, on machine Laptop.',
    );
  });

  // The lines of step L's night (lot 4 plan) and of the reasons added after D1, word for word.
  it('words the overnight lines exactly', () => {
    const expected: [QueueReason, QueueCandidate['kind'], string][] = [
      [
        {
          reason: 'no_machine',
          machines: [
            { machine, unavailable: { why: 'account_outside_window', account, next: at } },
          ],
        },
        'implement',
        `No machine can take the run: Laptop: its Claude account Personal is outside its window until ${time}.`,
      ],
      [
        { reason: 'blocked', tickets: ['TESTB-3'] },
        'implement',
        'This ticket waits for TESTB-3, which is not done yet.',
      ],
      [
        { reason: 'held', cause: 'stop_run' },
        'implement',
        'Held: you stopped its run. Run now releases it and starts it.',
      ],
      [
        { reason: 'held', cause: 'stop_review' },
        'review',
        'Held: you stopped its review. Start review releases it and starts it.',
      ],
      [
        {
          reason: 'no_machine',
          machines: [{ machine, unavailable: { why: 'account_limited', account, until: at } }],
        },
        'implement',
        `No machine can take the run: Laptop: its Claude account Personal reached its usage limit, until ${time}.`,
      ],
      [
        { reason: 'account_limited', account, until: at },
        'resume',
        `The Claude account Personal reached its usage limit. You can resume after ${time}.`,
      ],
      [
        {
          reason: 'no_machine',
          machines: [
            { machine, unavailable: { why: 'account_busy', account, maxConcurrentRuns: 1 } },
          ],
        },
        'implement',
        'No machine can take the run: Laptop: its Claude account Personal already runs its maximum of 1 run at a time.',
      ],
      [
        {
          reason: 'no_machine',
          machines: [{ machine, unavailable: { why: 'account_budget_used', account, until: at } }],
        },
        'implement',
        `No machine can take the run: Laptop: its Claude account Personal has used its daily budget for today, until ${time}.`,
      ],
      // A suspected limit's next resume (step E).
      [
        { reason: 'quota_wait', until: at, minutes: 120 },
        'resume',
        `Paused on a possible usage limit: the scheduler resumes it at ${time}, 2 hours after it paused.`,
      ],
      // Most resumes per run reached (step G).
      [
        { reason: 'needs_you', item: 'run_resumes_used', machine: null },
        'resume',
        'Waiting for you in Needs you: the scheduler resumed its run as many times as Most resumes per run allows, and it still hits a usage limit.',
      ],
      // The machine holding the work, offline since a time (step G).
      [
        {
          reason: 'machine_unavailable',
          machine,
          commits: 2,
          unavailable: { why: 'offline', since: at },
        },
        'implement',
        `The ticket's branch has 2 commits not on GitHub, only on machine Laptop, and it is offline since ${time}. The run can only continue there.`,
      ],
      [
        {
          reason: 'machine_unavailable',
          machine,
          commits: null,
          unavailable: { why: 'offline', since: at },
        },
        'resume',
        `This run can only continue on machine Laptop, and it is offline since ${time}.`,
      ],
      [
        {
          reason: 'no_machine',
          machines: [{ machine, unavailable: { why: 'offline', since: at } }],
        },
        'implement',
        `No machine can take the run: Laptop: it is offline since ${time}.`,
      ],
      // A machine that could not start it twice in a row (step D2b).
      [
        { reason: 'needs_you', item: 'machine_failures', machine },
        'implement',
        'Waiting for you in Needs you: it could not start on Laptop.',
      ],
      [
        {
          reason: 'no_machine',
          machines: [{ machine, unavailable: { why: 'left_out', cause: 'dispatch_timeout', at } }],
        },
        'implement',
        `No machine can take the run: Laptop: it is left out for this ticket since ${time}, when the machine did not confirm the start in time, until it connects again or you use Run now.`,
      ],
      [
        {
          reason: 'machine_unavailable',
          machine,
          commits: null,
          unavailable: { why: 'left_out', cause: 'dispatch_refused', at },
        },
        'resume',
        `This run can only continue on machine Laptop, which did not take its latest resume at ${time} (it refused it): the scheduler resumes it again once the machine connects again, or use Resume.`,
      ],
      [
        { reason: 'reviews_off' },
        'review',
        "Start reviews by themselves is off in this project's settings: the review waits for you to use Start review.",
      ],
    ];
    for (const [reason, kind, text] of expected) expect(line(reason, kind)).toBe(text);
  });
});

describe("a candidate's place in the order (07, sections 3 and 6)", () => {
  it('says what it starts, its priority, the tickets waiting for it and a failed attempt', () => {
    expect(candidateFactsText(candidate())).toBe('Implement');
    expect(
      candidateFactsText(
        candidate({
          kind: 'fix_review',
          ticket: { projectKey: 'TESTB', number: 3, title: 'x', priority: 'high' },
          blocks: 1,
          afterFailure: true,
        }),
      ),
    ).toBe(
      'Fix after review · high priority · 1 ticket waits for it · after a failed attempt: behind the others of its kind',
    );
    expect(candidateFactsText(candidate({ kind: 'review', blocks: 2 }))).toBe(
      'Review by Quality · 2 tickets wait for it',
    );
    expect(
      candidateFactsText(
        candidate({
          kind: 'resume',
          ticket: { projectKey: 'TESTB', number: 3, title: 'x', priority: 'low' },
        }),
      ),
    ).toBe('Resume its paused run · low priority');
  });
});

describe("an account's line (02, section 7)", () => {
  const today = (fields: Partial<AccountToday> = {}): AccountToday => ({
    window: { state: 'always' },
    usage: { runs: 2, workingMs: 30 * 60_000, estimatedUsageUsd: 0.8, runsWithoutEstimate: 0 },
    budgetUsed: false,
    dayEndsAt: at,
    ...fields,
  });
  const accountLine = (
    fields: Partial<QueueAccount> = {},
    status: Partial<QueueAccount['status']> = {},
  ) =>
    accountLineText({
      account,
      status: {
        state: 'available',
        limitedUntil: null,
        limitedUntilEstimated: false,
        dailyBudget: { kind: 'estimated_usage', usd: 5 },
        today: today(),
        ...status,
      },
      active: 0,
      maxConcurrentRuns: 1,
      unavailable: null,
      ...fields,
    });

  it('gives its state, window, runs against its maximum and its day against its budget', () => {
    expect(accountLine({}, { today: today({ window: { state: 'inside', until: at } }) })).toEqual({
      title: `Personal: Available · in its window until ${time} · 0 of 1 run at a time`,
      today: 'Today: working 30 min · estimated usage $0.80 of $5.00 · 2 runs.',
      unavailable: null,
    });
  });

  it('says why it starts no run: its window, budget, Stop new runs, limit or maximum', () => {
    expect(
      accountLine(
        { unavailable: { why: 'account_outside_window', account, next: at } },
        { today: today({ window: { state: 'outside', next: at } }) },
      ),
    ).toEqual({
      title: 'Personal: Available · 0 of 1 run at a time',
      today: 'Today: working 30 min · estimated usage $0.80 of $5.00 · 2 runs.',
      unavailable: `Starts no run by itself until its window opens at ${time}. Run now still starts one.`,
    });
    expect(
      accountLine({ unavailable: { why: 'account_paused', account } }, { state: 'paused_manual' })
        .title,
    ).toBe('Personal: Paused · 0 of 1 run at a time');
    expect(
      accountLine(
        { unavailable: { why: 'account_limited', account, until: at } },
        { state: 'limited', limitedUntil: at, limitedUntilEstimated: true },
      ).title,
    ).toBe(`Personal: Limited until ${time} (estimated) · 0 of 1 run at a time`);
    expect(
      accountLine({
        active: 2,
        maxConcurrentRuns: 2,
        unavailable: { why: 'account_busy', account, maxConcurrentRuns: 2 },
      }).title,
    ).toBe('Personal: Available · 2 of 2 runs at a time');
  });

  it.each(everyUnavailable.map((entry) => [entry.why, entry] as const))(
    'words %s on the line, or nothing for a machine reason',
    (why, entry) => {
      const text = accountUnavailableText(entry);
      if (!why.startsWith('account_')) {
        expect(text).toBeNull();
        return;
      }
      expect(text).toMatch(/^Starts no .*\.$/);
      expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b|undefined|null|NaN|Invalid Date/);
    },
  );

  it('words each account reason exactly', () => {
    expect(accountUnavailableText({ why: 'account_limited', account, until: at })).toBe(
      'Starts no run until its usage limit resets.',
    );
    expect(accountUnavailableText({ why: 'account_paused', account })).toBe(
      'Starts no run: you stopped new runs on it. Resume it to let the scheduler start runs again.',
    );
    expect(accountUnavailableText({ why: 'account_busy', account, maxConcurrentRuns: 1 })).toBe(
      'Starts no other run: it already runs its maximum of 1 run at a time.',
    );
    expect(accountUnavailableText({ why: 'account_outside_window', account, next: null })).toBe(
      'Starts no run by itself: outside its windows, and none opens within a week. Run now still starts one.',
    );
    expect(accountUnavailableText({ why: 'account_budget_used', account, until: at })).toBe(
      `Starts no run by itself: its daily budget is used for today, until ${time}. Run now still starts one.`,
    );
  });
});

describe('when the queue is read again (lot 4 step H)', () => {
  const now = Date.parse('2026-10-21T04:59:30.000Z');
  const queue = (candidates: QueueCandidate[]) => ({
    at: '2026-10-21T04:59:30.000Z',
    accounts: [],
    candidates,
  });

  it('just after the soonest time it names that is still to come', () => {
    expect(
      queueRefreshMs(
        queue([candidate({ reason: { reason: 'quota_wait', until: at, minutes: 60 } })]),
        now,
      ),
    ).toBe(31_000);
  });

  it('at least once a minute, past times and none counting for nothing', () => {
    expect(queueRefreshMs(queue([]), now)).toBe(60_000);
    expect(queueRefreshMs(queue([candidate({ since: '2026-10-20T18:00:00.000Z' })]), now)).toBe(
      60_000,
    );
  });
});

// The line's start (Run now, Start review, Resume), with or without it per reason (owner, review
// of lot 4 step H): shown where it starts the line or lifts what stops it, hidden where only
// another action of the owner, elsewhere, can. A new reason fails the type check here.
describe('the start offered on a queue line (review of lot 4 step H)', () => {
  const offered: { [Reason in QueueReason['reason']]: boolean | 'machine' } = {
    held: true,
    quota_wait: true,
    reviews_off: true,
    machine_unavailable: 'machine',
    no_machine: 'machine',
    blocked: false,
    no_assignee: false,
    project_archived: false,
    project_not_ready: false,
    github_not_connected: false,
    github_token_unreadable: false,
    github_token_invalid: false,
    github_account_unknown: false,
    ticket_stopped: false,
    needs_you: false,
    first_message_too_large: false,
    account_limited: false,
    account_paused: false,
    account_busy: false,
    ticket_not_todo: false,
    run_not_paused: false,
    ticket_not_in_review: false,
    no_pull_request: false,
    review_active: false,
    review_head_moved: false,
    pull_request_not_open: false,
    github_problem: false,
  };
  // Run now ignores windows and the budget and releases a machine left out (07, sections 3 to 5).
  const machineOffered: { [Why in MachineUnavailable['why']]: boolean } = {
    account_outside_window: true,
    account_budget_used: true,
    left_out: true,
    waiting_enrollment: false,
    offline: false,
    disabled: false,
    revoked: false,
    daemon_incompatible: false,
    unusable: false,
    missing_capabilities: false,
    account_limited: false,
    account_paused: false,
    account_busy: false,
  };

  it('offers it on a candidate that can start', () => {
    expect(candidateStartOffered(candidate({ machine }))).toBe(true);
    expect(candidateStartOffered(candidate({ kind: 'review', machine }))).toBe(true);
  });

  it.each(everyReason.map((reason) => [JSON.stringify(reason), reason] as const))(
    'offers it or not on %s',
    (_, reason) => {
      const rule = offered[reason.reason];
      const expected =
        rule !== 'machine'
          ? rule
          : reason.reason === 'machine_unavailable'
            ? machineOffered[reason.unavailable.why]
            : reason.reason === 'no_machine' &&
              reason.machines.some(({ unavailable }) => machineOffered[unavailable.why]);
      for (const kind of ['implement', 'fix_review', 'review', 'resume'] as const) {
        expect(candidateStartOffered(candidate({ kind, reason }))).toBe(expected);
      }
    },
  );

  it('words the overnight lines with or without it', () => {
    const outside = { why: 'account_outside_window' as const, account, next: at };
    // Step L's evening: TESTB-4 and TESTB-3 waiting for the window, TESTB-5 blocked by TESTB-3.
    expect(
      candidateStartOffered(
        candidate({
          reason: { reason: 'no_machine', machines: [{ machine, unavailable: outside }] },
        }),
      ),
    ).toBe(true);
    expect(
      candidateStartOffered(candidate({ reason: { reason: 'blocked', tickets: ['TESTB-3'] } })),
    ).toBe(false);
    // One machine not enrolled and one outside its window: Run now can start on the second.
    expect(
      candidateStartOffered(
        candidate({
          reason: {
            reason: 'no_machine',
            machines: [
              { machine, unavailable: { why: 'waiting_enrollment' } },
              { machine: { ...machine, name: 'Desktop' }, unavailable: outside },
            ],
          },
        }),
      ),
    ).toBe(true);
    // Every machine offline: nothing the line can do.
    expect(
      candidateStartOffered(
        candidate({
          reason: {
            reason: 'no_machine',
            machines: [{ machine, unavailable: { why: 'offline', since: at } }],
          },
        }),
      ),
    ).toBe(false);
  });
});
