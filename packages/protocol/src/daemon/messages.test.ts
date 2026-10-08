import { describe, expect, it } from 'vitest';
import { FIRST_MESSAGE_MAX_BYTES } from '../api/agents.js';
import { TEXT_CEILING } from '../text-limits.js';
import { DaemonMessage, ServerMessage } from './messages.js';

const id = '5f0c7c1e-8a3b-4c1d-9e2f-0a1b2c3d4e5f';
const runId = '0d9a5b1c-2e3f-4a5b-8c7d-9e0f1a2b3c4d';
const sessionId = '7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';
const hash = 'a'.repeat(40);
const at = '2026-09-25T10:00:00.000Z';
const build = '0123456789abcdef';

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
      protocolVersion: 2,
      daemonVersion: '0.4.0',
      daemonBuild: build,
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
  'machine.doctor': {
    type: 'machine.doctor',
    id,
    payload: {
      doctor: [
        {
          name: 'Process scopes',
          status: 'error',
          message: 'Process scopes cannot be created (systemd-run was not found)',
          link: 'https://orchestrator.local/help/machines#process-scopes',
        },
      ],
    },
  },
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
      push: { status: 'pushed', head: hash },
      headMoved: null,
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
      workspace: {
        clean: true,
        branch,
        push: { status: 'pushed', head: hash },
        changedFiles: {
          listed: ['docs/user/contact-form.md', 'src/contact/ContactForm.tsx'],
          count: 2,
        },
      },
    },
  },
  'git.credential_request': {
    type: 'git.credential_request',
    id,
    payload: { runId, repository: { owner: 'owner-login', name: 'bakery' }, command: 'push' },
  },
} as const;

/** One valid example of every message the server sends. */
const serverExamples = {
  welcome: {
    type: 'welcome',
    id,
    payload: { accepted: true, protocolVersion: 2, heartbeatIntervalSeconds: 15 },
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
      nudgeMessage: 'Continue, or end the run with ticket_submit, ticket_ask or ticket_give_up.',
      limits: {
        maxRunDurationMinutes: 90,
        idleTimeoutMinutes: 10,
        maxNudgesPerRun: 2,
        waitingRunLifetimeMinutes: 30,
        sessionStartTimeoutSeconds: 30,
        mcpCallTimeoutSeconds: 30,
        claudeCodeMcpToolTimeoutSeconds: 120,
        pushTimeoutSeconds: 60,
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
      'git.credential_request for a forced push',
      daemonExamples['git.credential_request'],
      (p) => (p.command = 'force-push'),
    ],
    ['hello with a short build', daemonExamples.hello, (p) => (p.daemonBuild = '0123abc')],
    [
      'hello with a build in capitals',
      daemonExamples.hello,
      (p) => (p.daemonBuild = '0123456789ABCDEF'),
    ],
    [
      'run.state of an unknown end reason',
      daemonExamples['run.state'],
      (p) => (p.reason = 'merged'),
    ],
    [
      'run.state pushed without its head',
      daemonExamples['run.state'],
      (p) => (p.push = { status: 'pushed' }),
    ],
    [
      'run.state with a push failed for an unknown reason',
      daemonExamples['run.state'],
      (p) => (p.push = { status: 'failed', reason: 'forced', message: 'x' }),
    ],
    [
      'run.state with a failed push without its message',
      daemonExamples['run.state'],
      (p) => (p.push = { status: 'failed', reason: 'refused' }),
    ],
    [
      'run.state with "head moved" as text',
      daemonExamples['run.state'],
      (p) => (p.headMoved = 'yes'),
    ],
    [
      'mcp.call of ticket_submit with changed files as text',
      daemonExamples['mcp.call'],
      (p) => ((p.workspace as Json).changedFiles = 'src/a.ts'),
    ],
    [
      'mcp.call of ticket_submit with an empty changed path',
      daemonExamples['mcp.call'],
      (p) => ((p.workspace as Json).changedFiles = { listed: [''], count: 1 }),
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
      'run.start without its nudge message',
      serverExamples['run.start'],
      (p) => delete p.nudgeMessage,
    ],
    [
      'run.start with an empty nudge message',
      serverExamples['run.start'],
      (p) => (p.nudgeMessage = ' '),
    ],
    [
      'run.start with an oversized nudge message',
      serverExamples['run.start'],
      (p) => (p.nudgeMessage = 'x'.repeat(TEXT_CEILING + 1)),
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
    [
      'run.start with a first message over the byte budget of one argument',
      serverExamples['run.start'],
      // Fewer characters than the text ceiling, but three bytes each in UTF-8.
      (p) => (p.initialPrompt = '€'.repeat(Math.floor(FIRST_MESSAGE_MAX_BYTES / 3) + 1)),
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

  it('accepts the protocol 2 additions', () => {
    for (const reason of ['ci_failed', 'ci_timeout', 'review_branch_moved']) {
      const ended = withPayload(daemonExamples['run.state'], (p) => {
        p.reason = reason;
        p.push = { status: 'failed', reason: 'diverged', message: 'rejected: non-fast-forward' };
        p.headMoved = reason === 'review_branch_moved';
      });
      expect(DaemonMessage.safeParse(ended).success).toBe(true);
    }
    for (const purpose of ['review', 'fix_review']) {
      const start = withPayload(serverExamples['run.start'], (p) => (p.purpose = purpose));
      expect(ServerMessage.safeParse(start).success).toBe(true);
    }
    const completed = withPayload(serverExamples['run.stop'], (p) => (p.reason = 'completed'));
    expect(ServerMessage.safeParse(completed).success).toBe(true);
    const waiting = {
      runId,
      at,
      state: 'waiting_ci',
      claudeSessionId: sessionId,
      sessionAlive: true,
    };
    expect(DaemonMessage.safeParse({ type: 'run.state', id, payload: waiting }).success).toBe(true);
    for (const tool of ['review_approve', 'review_request_changes', 'ci_status']) {
      const call = { tool, runToken: 'run-token', input: {} };
      expect(DaemonMessage.safeParse({ type: 'mcp.call', id, payload: call }).success).toBe(true);
    }
    // A daemon run from its sources has no build.
    const sources = withPayload(daemonExamples.hello, (p) => (p.daemonBuild = null));
    expect(DaemonMessage.safeParse(sources).success).toBe(true);
  });

  it('reads the messages of a protocol 1 daemon, the protocol 2 facts null (09, section 6)', () => {
    const hello = DaemonMessage.parse(
      withPayload(daemonExamples.hello, (p) => {
        p.protocolVersion = 1;
        delete p.daemonBuild;
      }),
    );
    expect(hello.payload).toMatchObject({ protocolVersion: 1, daemonBuild: null });
    const ended = DaemonMessage.parse(
      withPayload(daemonExamples['run.state'], (p) => {
        delete p.push;
        delete p.headMoved;
      }),
    );
    expect(ended.payload).toMatchObject({ push: null, headMoved: null });
    const submit = DaemonMessage.parse(
      withPayload(daemonExamples['mcp.call'], (p) => (p.workspace = { clean: true, branch })),
    );
    expect(submit.payload).toMatchObject({ workspace: { push: null, changedFiles: null } });
  });

  it('carries the Claude Code version with the starting state only', () => {
    const starting = (payload: Json) =>
      DaemonMessage.safeParse({
        type: 'run.state',
        id,
        payload: {
          runId,
          at,
          state: 'starting',
          claudeSessionId: null,
          sessionAlive: false,
          ...payload,
        },
      }).success;
    expect(starting({ claudeCodeVersion: '2.1.282 (Claude Code)' })).toBe(true);
    expect(starting({ claudeCodeVersion: null })).toBe(true);
    expect(starting({})).toBe(false);
  });
});
