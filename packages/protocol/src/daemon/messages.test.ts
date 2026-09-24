import { describe, expect, it } from 'vitest';
import { TEXT_CEILING } from '../text-limits.js';
import { DaemonMessage, ServerMessage } from './messages.js';

const id = '5f0c7c1e-8a3b-4c1d-9e2f-0a1b2c3d4e5f';
const runId = '0d9a5b1c-2e3f-4a5b-8c7d-9e0f1a2b3c4d';
const sessionId = '7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';
const hash = 'a'.repeat(40);
const at = '2026-09-25T10:00:00.000Z';

const branch = {
  name: 't/12-contact-form',
  head: hash,
  commitsAhead: [{ hash, subject: 'Add the contact form' }],
};

/** One valid example of every message a daemon sends. */
const daemonExamples = {
  hello: {
    type: 'hello',
    id,
    payload: {
      protocolVersion: 1,
      daemonVersion: '0.3.0',
      claudeCodeVersion: '2.1.282',
      os: 'wsl',
      capabilities: ['git', 'node', 'android-sdk'],
      doctor: [
        { name: 'tmux', status: 'ok', message: 'tmux 3.6', link: null },
        {
          name: 'WSL idle timeout',
          status: 'check_yourself',
          message: 'Set instanceIdleTimeout=-1 in .wslconfig',
          link: 'https://orchestrator.local/help/machines',
        },
      ],
      runs: [{ runId, state: 'waiting_human', claudeSessionId: sessionId }],
    },
  },
  heartbeat: { type: 'heartbeat', id, payload: {} },
  ack: { type: 'ack', id, payload: { ok: true } },
  'run.state': {
    type: 'run.state',
    id,
    payload: {
      runId,
      at,
      state: 'ended',
      claudeSessionId: sessionId,
      sessionAlive: false,
      reason: 'submitted',
      detail: null,
      branch,
    },
  },
  'run.events': {
    type: 'run.events',
    id,
    payload: {
      runId,
      events: [
        { seq: 0, at, kind: 'agent_text', tool: null, text: 'Reading CLAUDE.md' },
        { seq: 1, at, kind: 'tool_call', tool: 'Bash', text: 'pnpm test' },
      ],
      estimatedUsageUsd: 0.42,
    },
  },
  'run.quota_limited': {
    type: 'run.quota_limited',
    id,
    payload: {
      runId,
      kind: 'detected',
      resetsAt: '2026-09-25T15:45:00.000Z',
      evidence: {
        signal: 'stop_failure',
        error: 'rate_limit',
        message: "You've hit your session limit · resets 3:45pm",
        statusLine: null,
      },
    },
  },
  'mcp.call': {
    type: 'mcp.call',
    id,
    payload: {
      tool: 'ticket_submit',
      runToken: 'run-token',
      input: { summary: 'Adds a contact form.' },
      workspace: { clean: true, branch },
    },
  },
  'git.credential_request': {
    type: 'git.credential_request',
    id,
    payload: { runId, repository: { owner: 'owner-login', name: 'bakery' }, command: 'fetch' },
  },
} as const;

/** One valid example of every message the server sends. */
const serverExamples = {
  welcome: {
    type: 'welcome',
    id,
    payload: { accepted: true, protocolVersion: 1, heartbeatIntervalSeconds: 15 },
  },
  ack: { type: 'ack', id, payload: { ok: false, message: 'Unknown run' } },
  'run.start': {
    type: 'run.start',
    id,
    payload: {
      runId,
      purpose: 'implement',
      subject: { kind: 'ticket', id: runId, number: 'WEB-12' },
      repository: {
        owner: 'owner-login',
        name: 'bakery',
        cloneUrl: 'https://github.com/owner-login/bakery.git',
        baseBranch: 'main',
        ticketBranch: 't/12-contact-form',
      },
      commitAuthor: {
        name: 'Web Dev (Orchestrator)',
        email: '123+owner-login@users.noreply.github.com',
      },
      profile: {
        key: 'web_dev',
        version: 1,
        instructions: 'You build web features.',
        model: 'sonnet',
        allowedTools: ['Read', 'Bash(pnpm test *)', 'mcp__orchestrator__ticket_submit'],
      },
      runToken: 'run-token',
      initialPrompt: 'Implement WEB-12.',
      limits: {
        maxRunDurationMinutes: 90,
        idleTimeoutMinutes: 10,
        maxNudgesPerRun: 2,
        waitingRunLifetimeMinutes: 30,
        sessionStartTimeoutSeconds: 30,
        mcpCallTimeoutSeconds: 30,
        claudeCodeMcpToolTimeoutSeconds: 120,
      },
      resumeSessionId: null,
    },
  },
  'run.input': { type: 'run.input', id, payload: { runId, text: 'Use blue.\nNot red.' } },
  'run.resume': {
    type: 'run.resume',
    id,
    payload: { runId, claudeSessionId: sessionId, message: 'Use blue.' },
  },
  'run.stop': { type: 'run.stop', id, payload: { runId, reason: 'owner_stopped' } },
  'mcp.result': {
    type: 'mcp.result',
    id,
    payload: {
      ok: false,
      error: {
        code: 'DOD_FAILED',
        message: 'The submission checks failed.',
        details: [{ check: 'worktree_clean', message: 'Commit your changes first.' }],
      },
    },
  },
  'git.credential': {
    type: 'git.credential',
    id,
    payload: { ok: true, username: 'x-access-token', password: 'github_pat_x' },
  },
} as const;

type Json = Record<string, unknown>;

/** A deep copy of `value` with `change` applied to its payload. */
function withPayload(value: Json, change: (payload: Json) => void): Json {
  const copy = structuredClone(value);
  change(copy.payload as Json);
  return copy;
}

const directions = [
  { name: 'DaemonMessage', schema: DaemonMessage, examples: daemonExamples },
  { name: 'ServerMessage', schema: ServerMessage, examples: serverExamples },
] as const;

describe.each(directions)('$name', ({ schema, examples }) => {
  it('has an example of every message type', () => {
    const types = schema.options.map((option) => option.shape.type.value);
    expect(Object.keys(examples).sort()).toEqual([...types].sort());
  });

  it.each(Object.entries(examples))('accepts a valid %s', (_, example) => {
    expect(schema.safeParse(example).success).toBe(true);
  });

  it.each(Object.entries(examples))('refuses %s without its id or payload', (_, example) => {
    for (const field of ['id', 'payload']) {
      const copy = Object.fromEntries(
        Object.entries(example as Json).filter(([key]) => key !== field),
      );
      expect(schema.safeParse(copy).success).toBe(false);
    }
    expect(schema.safeParse({ ...example, id: 'not-a-uuid' }).success).toBe(false);
  });

  it('refuses an unknown type, and a message of the other direction', () => {
    expect(schema.safeParse({ type: 'run.pause', id, payload: {} }).success).toBe(false);
    const other = schema === DaemonMessage ? serverExamples['run.stop'] : daemonExamples.hello;
    expect(schema.safeParse(other).success).toBe(false);
  });
});

describe('payload checks', () => {
  const refused: [string, Json, (payload: Json) => void][] = [
    ['hello without its protocol version', daemonExamples.hello, (p) => delete p.protocolVersion],
    ['hello with a text protocol version', daemonExamples.hello, (p) => (p.protocolVersion = '1')],
    ['hello with an unknown OS', daemonExamples.hello, (p) => (p.os = 'windows')],
    [
      'hello with a bad capability',
      daemonExamples.hello,
      (p) => (p.capabilities = ['Android SDK']),
    ],
    ['run.state without its state', daemonExamples['run.state'], (p) => delete p.state],
    ['an ended run.state without its reason', daemonExamples['run.state'], (p) => delete p.reason],
    [
      'run.state with a short hash',
      daemonExamples['run.state'],
      (p) => ((p.branch as Json).head = 'abc123'),
    ],
    ['run.events with no event', daemonExamples['run.events'], (p) => (p.events = [])],
    [
      'run.events with an oversized text',
      daemonExamples['run.events'],
      (p) =>
        (p.events = [
          { seq: 0, at, kind: 'input', tool: null, text: 'x'.repeat(TEXT_CEILING + 1) },
        ]),
    ],
    [
      'run.quota_limited of an unknown kind',
      daemonExamples['run.quota_limited'],
      (p) => (p.kind = 'maybe'),
    ],
    [
      'mcp.call of ticket_submit without workspace facts',
      daemonExamples['mcp.call'],
      (p) => delete p.workspace,
    ],
    ['mcp.call of an unknown tool', daemonExamples['mcp.call'], (p) => (p.tool = 'ticket_push')],
    [
      'mcp.call with an input that is not an object',
      daemonExamples['mcp.call'],
      (p) => (p.input = 'hello'),
    ],
    [
      'git.credential_request for a push (lot 3)',
      daemonExamples['git.credential_request'],
      (p) => (p.command = 'push'),
    ],
    [
      'git.credential_request for a ../ repository',
      daemonExamples['git.credential_request'],
      (p) => ((p.repository as Json).name = '..'),
    ],
    [
      'run.start with a token in the clone URL',
      serverExamples['run.start'],
      (p) => ((p.repository as Json).cloneUrl = 'https://x-access-token:secret@github.com/o/r.git'),
    ],
    [
      'run.start with an ssh clone URL',
      serverExamples['run.start'],
      (p) => ((p.repository as Json).cloneUrl = 'ssh://git@github.com/o/r.git'),
    ],
    [
      'run.start with a branch read as an option',
      serverExamples['run.start'],
      (p) => ((p.repository as Json).ticketBranch = '--upload-pack=x'),
    ],
    [
      'run.start with a branch leaving its folder',
      serverExamples['run.start'],
      (p) => ((p.repository as Json).ticketBranch = 't/../main'),
    ],
    [
      'run.start with an owner leaving its folder',
      serverExamples['run.start'],
      (p) => ((p.repository as Json).owner = '..'),
    ],
    ['run.start without limits', serverExamples['run.start'], (p) => delete p.limits],
    [
      'run.start with a negative nudge count',
      serverExamples['run.start'],
      (p) => ((p.limits as Json).maxNudgesPerRun = -1),
    ],
    [
      'run.start with an empty first message',
      serverExamples['run.start'],
      (p) => (p.initialPrompt = '  '),
    ],
    [
      'run.start with an oversized first message',
      serverExamples['run.start'],
      (p) => (p.initialPrompt = 'x'.repeat(TEXT_CEILING + 1)),
    ],
    ['run.input with a number as text', serverExamples['run.input'], (p) => (p.text = 42)],
    [
      'run.resume without the session id',
      serverExamples['run.resume'],
      (p) => delete p.claudeSessionId,
    ],
    ['run.stop with an unknown reason', serverExamples['run.stop'], (p) => (p.reason = 'bored')],
    ['a refusing ack without its message', serverExamples.ack, (p) => delete p.message],
    [
      'mcp.result with an unknown error code',
      serverExamples['mcp.result'],
      (p) => ((p.error as Json).code = 'OOPS'),
    ],
    [
      'git.credential without its password',
      serverExamples['git.credential'],
      (p) => delete p.password,
    ],
  ];

  it.each(refused)('refuses %s', (_, example, change) => {
    const changed = withPayload(example, change);
    expect(
      DaemonMessage.safeParse(changed).success || ServerMessage.safeParse(changed).success,
    ).toBe(false);
  });

  it('accepts a refusing welcome, a suspected limit and a call of another tool', () => {
    expect(
      ServerMessage.safeParse({
        type: 'welcome',
        id,
        payload: {
          accepted: false,
          reason: 'protocol_incompatible',
          message: 'Update the daemon.',
        },
      }).success,
    ).toBe(true);
    expect(
      DaemonMessage.safeParse({
        type: 'run.quota_limited',
        id,
        payload: {
          runId,
          kind: 'suspected',
          evidence: {
            signal: 'stop_failure',
            error: 'overloaded',
            message: null,
            statusLine: null,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      DaemonMessage.safeParse({
        type: 'mcp.call',
        id,
        payload: { tool: 'ticket_progress', runToken: 'run-token', input: { text: 'Testing' } },
      }).success,
    ).toBe(true);
  });

  it('accepts local test remotes and a running state without end details', () => {
    for (const cloneUrl of ['file:///tmp/remote.git', 'http://127.0.0.1:9418/o/r.git']) {
      const start = withPayload(
        serverExamples['run.start'],
        (p) => ((p.repository as Json).cloneUrl = cloneUrl),
      );
      expect(ServerMessage.safeParse(start).success).toBe(true);
    }
    expect(
      DaemonMessage.safeParse({
        type: 'run.state',
        id,
        payload: { runId, at, state: 'working', claudeSessionId: sessionId, sessionAlive: true },
      }).success,
    ).toBe(true);
  });
});
