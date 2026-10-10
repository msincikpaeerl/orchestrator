import {
  EVENT_QUOTE_MAX_LENGTH,
  EventPayloads,
  EventType,
  type EventLogEntry,
  type EventPayload,
} from '@orchestrator/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { EventText } from './event-text';
import { eventText, plainText, type Piece } from './text';

const COMMENT_ID = '3f1e0e8c-1111-4000-8000-000000000000';
const PROJECT_ID = '3f1e0e8c-2222-4000-8000-000000000000';

/** A payload of each type, as the server writes it. */
const examples: { [T in EventType]: EventPayload<T> } = {
  'owner.created': { username: 'owner' },
  'owner.login_throttled': {
    scope: 'address',
    address: '192.168.1.50',
    failures: 6,
    delaySeconds: 20,
  },
  'owner.password_reset': { revokedSessions: 2 },
  'session.created': { expiresAt: '2026-10-24T10:00:00.000Z' },
  'session.revoked': { reason: 'logout' },
  'github.token_saved': { account: 'octo-owner', expiresOn: '2027-09-23' },
  'github.token_checked': { permissions: { contents: 'ok', workflows: 'missing' } },
  'github.token_rejected': { request: 'GET /user' },
  'github.token_unreadable': {},
  'github.permission_refused': {
    permissions: ['administration=write'],
    request: 'POST /repos/octo-owner/shop/rulesets',
  },
  'project.created': {
    key: 'WEB',
    name: 'Web shop',
    kind: 'web_app',
    origin: 'created',
    repository: 'octo-owner/web-shop',
    private: true,
  },
  'project.updated': { key: 'WEB', name: 'Online shop', description: 'Sells things' },
  'project.setup_step': {
    key: 'WEB',
    step: 'branch_protection',
    branchProtection: 'not_available',
  },
  'project.setup_failed': { key: 'WEB', step: 'repository', reason: 'GitHub could not be reached' },
  'project.setup_retried': { key: 'WEB', step: 'repository' },
  'project.ready': { key: 'WEB' },
  'project.harness_checked': { key: 'WEB', missing: ['claude_md', 'adrs'] },
  'project.archived': { key: 'WEB' },
  'project.unarchived': { key: 'WEB' },
  'ticket.created': {
    project: 'WEB',
    ticket: 'WEB-12',
    type: 'bug',
    title: 'Checkout fails',
    priority: 'high',
    status: 'todo',
    blockedBy: ['WEB-3'],
    assignee: 'web_dev',
    assigneeName: 'Web Developer',
  },
  'ticket.updated': {
    project: 'WEB',
    ticket: 'WEB-12',
    fields: ['title', 'acceptanceCriteria'],
    title: 'Checkout fails on phones',
  },
  'ticket.status_changed': {
    project: 'WEB',
    ticket: 'WEB-12',
    from: 'todo',
    to: 'done',
    action: 'mark_done',
    commentId: COMMENT_ID,
  },
  'ticket.dependency_added': { project: 'WEB', ticket: 'WEB-12', blockedBy: 'WEB-3' },
  'ticket.dependency_removed': { project: 'WEB', ticket: 'WEB-12', blockedBy: 'WEB-3' },
  'ticket.commented': { project: 'WEB', ticket: 'WEB-12', commentId: COMMENT_ID, kind: 'note' },
  'setting.changed': {
    name: 'ciWaitTimeoutMinutes',
    scope: 'project',
    projectId: PROJECT_ID,
    projectKey: 'WEB',
    previous: null,
    value: 30,
  },
  'setting.reset': { name: 'sessionLifetimeDays', scope: 'global', previous: 7 },
  'account.created': { label: 'Personal Max', plan: 'max_5x', maxConcurrentRuns: 1 },
  'account.updated': {
    label: 'Work Max',
    fields: ['label', 'maxConcurrentRuns'],
    previousLabel: 'Personal Max',
    maxConcurrentRuns: 2,
  },
  'machine.created': { name: 'Laptop', account: 'Personal Max' },
  'machine.enrollment_code_created': { name: 'Laptop', expiresAt: '2026-09-25T10:15:00.000Z' },
  'machine.enrolled': { name: 'Laptop' },
  'machine.enrollment_throttled': { address: '192.168.1.50', failures: 5, delaySeconds: 10 },
  'machine.online': {
    name: 'Laptop',
    daemonVersion: '0.3.0',
    claudeCodeVersion: '2.1.279',
    detected: ['docker', 'git'],
    unusable: ['claude_code_unsupported'],
  },
  'machine.offline': { name: 'Laptop', reason: 'silent' },
  'machine.daemon_incompatible': { name: 'Laptop', daemonVersion: '0.9.0', protocolVersion: 3 },
  'machine.disabled': { name: 'Laptop' },
  'machine.enabled': { name: 'Laptop' },
  'machine.revoked': { name: 'Laptop' },
  'machine.capabilities_changed': { name: 'Laptop', capabilities: ['git', 'node'] },
  'machine.doctor_changed': { name: 'Laptop', errors: ['Process scopes'] },
  'machine.claude_code_unsupported': { name: 'Laptop', version: '2.1.100', minimum: '2.1.280' },
  'account.limited': {
    label: 'Personal',
    until: '2026-09-24T15:45:00.000Z',
    source: 'fallback',
    fallbackMinutes: 60,
  },
  'account.available': { label: 'Personal' },
  'run.created': {
    project: 'WEB',
    ticket: 'WEB-12',
    purpose: 'implement',
    machine: 'Laptop',
    account: 'Personal',
    profile: 'web_dev',
    profileName: 'Web Developer',
    profileVersion: 2,
    attempt: 1,
  },
  'run.status_changed': {
    project: 'WEB',
    ticket: 'WEB-12',
    machine: 'Laptop',
    from: 'running',
    to: 'failed',
    cause: 'daemon',
    failureReason: 'timeout',
    endReason: 'idle_timeout',
  },
  'run.progress': {
    project: 'WEB',
    ticket: 'WEB-12',
    agent: 'web_dev',
    agentName: 'Web Developer',
    runId: '00000000-0000-4000-8000-000000000001',
    text: 'Writing tests for the contact form',
  },
  'run.git_config_restored': {
    project: 'WEB',
    ticket: 'WEB-12',
    machine: 'Laptop',
    repository: 'octo-owner/web-shop',
    changes:
      'Found changed when the run ended (by this run or an earlier one of the project on this machine), and restored. Settings added, removed: core.hookspath. Hook files added, removed: pre-commit.',
  },
  'run.branch_pushed': {
    project: 'WEB',
    ticket: 'WEB-12',
    machine: 'Laptop',
    branch: 't/12-contact-form',
    head: 'a'.repeat(40),
    at: 'submission',
  },
  'run.branch_push_failed': {
    project: 'WEB',
    ticket: 'WEB-12',
    machine: 'Laptop',
    branch: 't/12-contact-form',
    at: 'end',
    reason: 'unreachable',
    message: 'Could not resolve host: github.com',
  },
  'run.ci_waiting': {
    project: 'WEB',
    ticket: 'WEB-12',
    commit: 'c'.repeat(40),
    pullRequest: 4,
  },
  'run.ci_result': {
    project: 'WEB',
    ticket: 'WEB-12',
    commit: 'c'.repeat(40),
    state: 'no_ci',
    checks: 0,
    failed: [],
    workflowChanges: 'changed',
    baseBranch: 'main',
    pullRequestHead: null,
  },
  'run.ci_check_failed': {
    project: 'WEB',
    ticket: 'WEB-12',
    reason: 'unreachable',
    message: 'GitHub could not be reached, or answered with a server error',
  },
  'run.ci_check_recovered': { project: 'WEB', ticket: 'WEB-12' },
  'run.ci_round_sent': {
    project: 'WEB',
    ticket: 'WEB-12',
    commit: 'c'.repeat(40),
    kind: 'failed',
    round: 1,
    of: 2,
  },
  'run.ci_round_not_taken': {
    project: 'WEB',
    ticket: 'WEB-12',
    commit: 'c'.repeat(40),
    kind: 'conflict',
    message: 'Downloading main from GitHub failed: GitHub could not be reached',
  },
  'ticket.submitted': {
    project: 'WEB',
    ticket: 'WEB-12',
    agent: 'web_dev',
    agentName: 'Web Developer',
    runId: '00000000-0000-4000-8000-000000000001',
    criteria: 3,
  },
  'ticket.submission_refused': {
    project: 'WEB',
    ticket: 'WEB-12',
    agent: 'web_dev',
    agentName: 'Web Developer',
    runId: '00000000-0000-4000-8000-000000000001',
    failed: ['criteria_met', 'paths_changed'],
  },
  'ticket.pull_request_opened': {
    project: 'WEB',
    ticket: 'WEB-12',
    number: 4,
    url: 'u',
    notReopened: 3,
  },
  'ticket.pull_request_reopened': { project: 'WEB', ticket: 'WEB-12', number: 4, url: 'u' },
  'ticket.pull_request_updated': { project: 'WEB', ticket: 'WEB-12', number: 4, url: 'u' },
  'ticket.pull_request_not_opened': {
    project: 'WEB',
    ticket: 'WEB-12',
    reason: 'unreachable',
    message: 'GitHub could not be reached',
  },
  'ticket.ci_checked_again': {
    project: 'WEB',
    ticket: 'WEB-12',
    runId: '3f1e0e8c-3333-4000-8000-000000000000',
    commit: 'abc1234def5678abc1234def5678abc1234def56',
    outcome: 'accepted',
    state: 'passed',
    attemptTakenBack: true,
  },
  'agent_profile.created': { key: 'web_dev', name: 'Web Developer', version: 1 },
  'agent_profile.updated': {
    key: 'web_dev',
    name: 'Web Developer',
    previousVersion: 1,
    version: 2,
  },
};

function entry(type: EventType, overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  const [kind] = type.split('.');
  const entityType =
    kind === 'github'
      ? 'github_connection'
      : kind === 'account'
        ? 'claude_account'
        : (kind as EventLogEntry['entityType']);
  const aboutProject =
    kind === 'project' || kind === 'ticket' || (kind === 'setting' && type === 'setting.changed');
  return {
    id: 1,
    at: '2026-09-24T10:00:00.000Z',
    actor: 'owner',
    entityType,
    type,
    project: aboutProject ? { key: 'WEB' } : null,
    ticket: kind === 'ticket' ? { number: 12 } : null,
    payload: examples[type],
    comment: type === 'ticket.commented' || type === 'ticket.status_changed' ? 'Works now' : null,
    ...overrides,
  };
}

function links(pieces: Piece[]) {
  return pieces.filter((piece) => typeof piece !== 'string');
}

describe('eventText', () => {
  // Every type of packages/protocol: a new event type without its own text fails here.
  it.each(EventType.options)('has its own plain-words text for %s', (type) => {
    expect(EventPayloads[type].safeParse(examples[type]).success).toBe(true);
    const text = plainText(eventText(entry(type)));
    expect(text).not.toContain(type);
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b|undefined|null|\[object/);
    expect(text).toMatch(/^[A-Z“]/);
  });

  it('says whether a pull request was not opened or not updated (step F4)', () => {
    const failed = { project: 'WEB', ticket: 'WEB-12', reason: 'unreachable', message: 'Gone' };
    const text = (payload: Record<string, unknown>) =>
      plainText(eventText(entry('ticket.pull_request_not_opened', { payload })));
    expect(text({ ...failed, openPullRequest: 4 })).toBe(
      'WEB-12: pull request #4 could not be updated on GitHub — Gone',
    );
    expect(text({ ...failed, openPullRequest: null })).toBe(
      'WEB-12: the pull request could not be opened on GitHub — Gone',
    );
    // Written before step F4: either.
    expect(text(failed)).toBe(
      'WEB-12: the pull request could not be opened or updated on GitHub — Gone',
    );
  });

  it('says the CI result in words, "No CI found" with the workflow flag (step G1a)', () => {
    const base = examples['run.ci_result'];
    const text = (payload: Record<string, unknown>) =>
      plainText(eventText(entry('run.ci_result', { payload: { ...base, ...payload } })));
    expect(text({})).toBe(
      'Run of WEB-12: no CI found on GitHub for the submitted commit ccccccc: no CI run or status appeared within "Wait for CI to start". This submission also changed workflow files, so the agent may have removed or weakened CI: look at the changed files of the pull request before merging',
    );
    expect(text({ workflowChanges: null })).toBe(
      'Run of WEB-12: no CI found on GitHub for the submitted commit ccccccc: no CI run or status appeared within "Wait for CI to start"',
    );
    expect(text({ state: 'conflict' })).toBe(
      'Run of WEB-12: the pull request conflicts with main, so GitHub started no CI for the submitted commit ccccccc: the submission does not pass',
    );
    expect(
      text({ state: 'failed', checks: 2, failed: ['CI'], pullRequestHead: 'd'.repeat(40) }),
    ).toBe(
      "Run of WEB-12: CI failed on GitHub for the submitted commit ccccccc (failed: CI). The pull request's latest commit is now ddddddd: this result is the submitted commit's",
    );
  });

  it('names the assignee of a ticket in words', () => {
    expect(plainText(eventText(entry('ticket.created')))).toBe(
      'WEB-12 created: “Checkout fails”, bug, high priority, to do, waits for WEB-3, assigned to “Web Developer”',
    );
    const assigned = { project: 'WEB', ticket: 'WEB-12', fields: ['assignee'] };
    expect(
      plainText(
        eventText(
          entry('ticket.updated', {
            payload: { ...assigned, assignee: 'architect', assigneeName: 'Architect' },
          }),
        ),
      ),
    ).toBe('WEB-12 edited: assignee; now assigned to “Architect”');
    expect(
      plainText(eventText(entry('ticket.updated', { payload: { ...assigned, assignee: null } }))),
    ).toBe('WEB-12 edited: assignee; no assignee now');
  });

  it('names the ticket and the comment of a Mark as done manually', () => {
    const pieces = eventText(entry('ticket.status_changed'));
    expect(plainText(pieces)).toBe('WEB-12 marked as done manually: “Works now”');
    expect(links(pieces)).toEqual([
      { text: 'WEB-12', to: '/projects/WEB/tickets/12' },
      { text: '“Works now”', to: '/projects/WEB/tickets/12' },
    ]);
  });

  it('says whether a run that ended counts as a failed attempt', () => {
    const payload = {
      project: 'WEB',
      ticket: 'WEB-12',
      from: 'in_progress',
      to: 'todo',
      action: 'run_ended',
      commentId: null,
      failureReason: 'machine_offline',
      attemptCounted: false,
    };
    expect(plainText(eventText(entry('ticket.status_changed', { payload, comment: null })))).toBe(
      'WEB-12 back to to do: its run ended, its machine was offline (not counted as a failed attempt)',
    );
  });

  it('says what Check CI again found (lot 3 step G2c)', () => {
    expect(plainText(eventText(entry('ticket.ci_checked_again')))).toBe(
      'WEB-12: you checked CI again for commit abc1234; CI passed, the work accepted without a session and its failed attempt taken back',
    );
    const refused = {
      ...examples['ticket.ci_checked_again'],
      outcome: 'refused' as const,
      refusal: 'run_active' as const,
      message: 'A run is working on WEB-12: its own submission will be checked.',
    };
    expect(plainText(eventText(entry('ticket.ci_checked_again', { payload: refused })))).toBe(
      'WEB-12: Check CI again refused — A run is working on WEB-12: its own submission will be checked.',
    );
  });

  it('shortens quoted content to one line, linking to the full text', () => {
    const title = `Line one\n\n${'long '.repeat(100)}`;
    const pieces = eventText(
      entry('ticket.created', { payload: { ...examples['ticket.created'], title } }),
    );
    const quoted = links(pieces).find((piece) => piece.text.startsWith('“'));
    expect(quoted?.to).toBe('/projects/WEB/tickets/12');
    // The quotes around it, at most the quote length inside.
    expect(Array.from(quoted?.text ?? '').length).toBeLessThanOrEqual(EVENT_QUOTE_MAX_LENGTH + 2);
    expect(Array.from(quoted?.text ?? '').length).toBeGreaterThan(EVENT_QUOTE_MAX_LENGTH - 5);
    expect(quoted?.text).toMatch(/^“Line one long long .*…”$/);
  });

  it('links a project name to the project page', () => {
    const pieces = eventText(entry('project.created'));
    expect(plainText(pieces)).toBe(
      'WEB created: “Web shop”, web app, new private repository octo-owner/web-shop',
    );
    expect(links(pieces)).toEqual([
      { text: 'WEB', to: '/projects/WEB' },
      { text: '“Web shop”', to: '/projects/WEB' },
    ]);
  });

  it('says what a setting became', () => {
    expect(plainText(eventText(entry('setting.changed')))).toBe(
      'CI wait at submission set to 30 minutes for WEB (was the global value)',
    );
    expect(plainText(eventText(entry('setting.reset')))).toBe(
      'Session lifetime reset to its default, 30 days',
    );
  });

  it('says why a connected machine cannot receive runs', () => {
    expect(plainText(eventText(entry('machine.online')))).toBe(
      'Machine “Laptop” connected: daemon 0.3.0, Claude Code 2.1.279, detected docker, git. It cannot receive runs: its Claude Code version is not supported',
    );
    expect(
      plainText(
        eventText(
          entry('machine.online', {
            payload: {
              name: 'Laptop',
              daemonVersion: '0.3.0',
              daemonBuild: null,
              claudeCodeVersion: '2.1.287',
              detected: [],
              unusable: ['daemon_outdated'],
            },
          }),
        ),
      ),
    ).toBe(
      'Machine “Laptop” connected: daemon 0.3.0, Claude Code 2.1.287, detected nothing. It cannot receive runs: its daemon is older than this Orchestrator',
    );
    expect(
      plainText(
        eventText(
          entry('machine.online', {
            payload: {
              name: 'Laptop',
              daemonVersion: '0.4.0',
              daemonBuild: 'fedcba9876543210',
              buildDiffers: true,
              claudeCodeVersion: '2.1.287',
              detected: ['git'],
              unusable: [],
            },
          }),
        ),
      ),
    ).toBe(
      'Machine “Laptop” connected: daemon 0.4.0 (build fedcba9876543210, not the one provided), Claude Code 2.1.287, detected git',
    );
    expect(plainText(eventText(entry('account.updated')))).toBe(
      'Claude account “Work Max” edited: renamed from “Personal Max”, 2 runs at a time',
    );
  });

  it('shows the event type and what it concerns when the payload is unreadable', () => {
    expect(plainText(eventText(entry('ticket.created', { payload: null })))).toBe(
      'Ticket created: WEB-12',
    );
    expect(plainText(eventText(entry('session.created', { payload: null })))).toBe('Logged in');
  });
});

describe('EventText', () => {
  it('shows Markdown and HTML from the owner as plain text', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(EventText, {
          entry: entry('ticket.created', {
            payload: {
              ...examples['ticket.created'],
              title: '<img src=x onerror=alert(1)> **bold** [link](javascript:alert(1))',
            },
          }),
        }),
      ),
    );
    expect(html).toContain(
      '“&lt;img src=x onerror=alert(1)&gt; **bold** [link](javascript:alert(1))”',
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<strong');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="/projects/WEB/tickets/12"');
  });
});
