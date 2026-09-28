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
