import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { McpToolName, type DodReport, type RunEvents } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { REASONS } from '../src/permissions.js';
import { sessionName } from '../src/tmux.js';
import {
  TIMEOUT,
  answerTools,
  daemon,
  ended,
  fake,
  home,
  messagesReceived,
  sent,
  start,
  states,
  tmux,
  toolCalls,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// Permission enforcement through the real hook, the agent's tool calls through the real
// SDK-based relay, and the decision tools, with the real tmux and the fake `claude`
// (05, sections 4.6 and 4.8; 06, section 1).

useRunnerHarness();

const SUBMISSION: DodReport = {
  criteria: [{ index: 0, status: 'met', justification: 'Notes are saved, see notes.test.ts' }],
  tests: { paths: ['notes.test.ts'], justification: null },
  docs: { paths: [], justification: 'No user-visible change.' },
  adrs: [],
  summary: 'Adds notes.',
};

async function denials() {
  return (await fake.log()).flatMap((entry) =>
    entry.event === 'denied' ? [{ tool: entry.tool, reason: entry.reason }] : [],
  );
}

describe('permission rules through the PreToolUse hook', () => {
  it(
    'refuses every rule with its reason and lets allowed calls through',
    async () => {
      const manager = daemon();
      const userHome = home.env.HOME ?? '';
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: 'cat ~/.orchestrator/config.json' },
              { do: 'bash', command: `cat ${home.paths.config}` },
              { do: 'tool', name: 'Read', input: { file_path: join(userHome, '.claude.json') } },
              {
                do: 'tool',
                name: 'Read',
                input: { file_path: join(home.paths.claudeConfig, '.credentials.json') },
              },
              { do: 'bash', command: 'git push origin HEAD' },
              { do: 'bash', command: 'git fetch origin' },
              { do: 'bash', command: 'gh pr list' },
              { do: 'bash', command: 'curl -s https://api.github.com/user' },
              { do: 'bash', command: 'tmux -L orchestrator ls' },
              { do: 'tool', name: 'Write', input: { file_path: '.claude/settings.json' } },
              { do: 'bash', command: 'cat /var/log/syslog' },
              { do: 'tool', name: 'Read', input: { file_path: '/etc/hostname' } },
              // Allowed: work in the worktree, and WebFetch on a public GitHub page.
              { do: 'bash', command: 'git status --short > /dev/null && echo allowed' },
              { do: 'tool', name: 'Read', input: { file_path: 'README.md' } },
              { do: 'tool', name: 'WebFetch', input: { url: 'https://github.com/owner/notes' } },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await ended(run.runId);

      expect(await denials()).toEqual([
        { tool: 'Bash', reason: REASONS.home },
        { tool: 'Bash', reason: REASONS.daemonFolder },
        { tool: 'Read', reason: REASONS.claudeConfig },
        { tool: 'Read', reason: REASONS.claudeConfig },
        { tool: 'Bash', reason: REASONS.remote },
        { tool: 'Bash', reason: REASONS.remote },
        { tool: 'Bash', reason: REASONS.remote },
        { tool: 'Bash', reason: REASONS.github },
        { tool: 'Bash', reason: REASONS.tmux },
        { tool: 'Write', reason: REASONS.claudeFolder },
        { tool: 'Bash', reason: REASONS.bashPath },
        { tool: 'Read', reason: REASONS.outside },
      ]);
      // Only the allowed command ran.
      const commands = (await fake.log()).flatMap((entry) =>
        entry.event === 'bash' ? [entry] : [],
      );
      expect(commands).toEqual([
        expect.objectContaining({
          command: expect.stringContaining('echo allowed') as unknown,
          exitCode: 0,
        }),
      ]);
    },
    TIMEOUT,
  );

  it(
    'writes the allowlist and the deny rules into the run settings',
    async () => {
      const manager = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await start(manager, {
        profile: {
          key: 'web_dev',
          version: 1,
          instructions: 'Rules.',
          model: 'sonnet',
          allowedTools: ['Bash(pnpm test *)', 'Read'],
        },
      });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      const settings = JSON.parse(
        await readFile(join(home.paths.home, 'runs', run.runId, 'settings.json'), 'utf8'),
      ) as { permissions: { allow: string[]; deny: string[] } };
      expect(settings.permissions.allow).toEqual([
        'Bash(pnpm test *)',
        'Read',
        'ToolSearch',
        'mcp__orchestrator',
      ]);
      expect(settings.permissions.deny).toContain(`Read(/${home.paths.config})`);
      expect(settings.permissions.deny).toContain(`Edit(/${home.env.HOME ?? ''}/.claude/**)`);
      expect(settings.permissions.deny).toContain(`Read(/${home.paths.claudeConfig}/**)`);
      expect(settings.permissions.deny.join()).not.toContain('worktrees');
    },
    TIMEOUT,
  );
});

describe('tool calls through the relay', () => {
  it(
    "reach the server with the run token, from the fake's own MCP client to the SDK relay",
    async () => {
      const manager = daemon();
      answerTools((call) =>
        call.tool === 'ticket_comment'
          ? { ok: false, error: { code: 'VALIDATION_FAILED', message: 'body is too long' } }
          : { ok: true, output: { tickets: [], next_cursor: null } },
      );
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'mcp', tool: 'ticket_list', arguments: { status: ['todo'] } },
              { do: 'mcp', tool: 'ticket_comment', arguments: { body: 'x' } },
              { do: 'mcp', tool: 'no_such_tool', arguments: {} },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await ended(run.runId);

      const log = await fake.log();
      const listed = log.find((entry) => entry.event === 'mcp_tools');
      // Only the run's tools (owner's answer 1, lot 3 step H): an implement run has no review tool.
      expect(listed?.event === 'mcp_tools' && listed.tools.map((tool) => tool.name)).toEqual(
        run.mcpTools,
      );
      expect(run.mcpTools).toEqual(
        McpToolName.options.filter((name) => !name.startsWith('review_')),
      );
      const create =
        listed?.event === 'mcp_tools' ? listed.tools.find((t) => t.name === 'ticket_create') : null;
      expect(create?.inputSchema).toMatchObject({
        type: 'object',
        properties: { title: { type: 'string' } },
        additionalProperties: false,
      });
      // The relay passes the arguments as they are; the daemon adds the run token.
      expect(toolCalls).toEqual([
        { tool: 'ticket_list', runToken: run.runToken, input: { status: ['todo'] } },
        { tool: 'ticket_comment', runToken: run.runToken, input: { body: 'x' } },
      ]);
      const results = log.flatMap((entry) => (entry.event === 'mcp' ? [entry.result] : []));
      expect(results[0]).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ tickets: [], next_cursor: null }) }],
      });
      expect(results[1]).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ code: 'VALIDATION_FAILED', message: 'body is too long' }),
          },
        ],
        isError: true,
      });
      expect(results[2]).toMatchObject({ isError: true });
      expect(JSON.stringify(results[2])).toContain('Unknown tool');
    },
    TIMEOUT,
  );
});

describe("the run's tool list", () => {
  it(
    'lists only the tools run.start names, and still passes any call on to the server',
    async () => {
      const manager = daemon();
      answerTools(() => ({ ok: false, error: { code: 'FORBIDDEN', message: 'not yours' } }));
      await fake.play({
        turns: [{ steps: [{ do: 'mcp', tool: 'review_approve', arguments: { summary: 'x' } }] }],
      });
      const run = await start(manager, {
        mcpTools: ['ticket_get', 'ticket_give_up'],
        limits: { maxNudgesPerRun: 0 },
      });
      await ended(run.runId);

      const listed = (await fake.log()).find((entry) => entry.event === 'mcp_tools');
      expect(listed?.event === 'mcp_tools' && listed.tools.map((tool) => tool.name)).toEqual([
        'ticket_get',
        'ticket_give_up',
      ]);
      // The server decides: a tool the run does not list still reaches it, and it refuses.
      expect(toolCalls).toEqual([
        { tool: 'review_approve', runToken: run.runToken, input: { summary: 'x' } },
      ]);
    },
    TIMEOUT,
  );
});

describe('decision tools', () => {
  it(
    'ends the run after an accepted ticket_submit, with the worktree facts sent, and no nudge',
    async () => {
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              {
                do: 'bash',
                command:
                  'echo notes > notes.md && git add notes.md && git commit -q -m "Add notes"',
              },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
              { do: 'text', text: 'Submitted.' },
            ],
          },
        ],
      });
      const run = await start(manager);
      const end = await ended(run.runId);
      expect(end.reason).toBe('submitted');
      expect(toolCalls[0]).toMatchObject({
        tool: 'ticket_submit',
        input: SUBMISSION,
        workspace: {
          clean: true,
          branch: { name: 't/1-add-notes', commitsAhead: [{ subject: 'Add notes' }] },
        },
      });
      expect(await messagesReceived()).toEqual([run.initialPrompt]);
    },
    TIMEOUT,
  );

  it(
    'reports uncommitted work to the server, and nudges after a refused submission',
    async () => {
      const manager = daemon();
      answerTools(() => ({
        ok: false,
        error: { code: 'DOD_FAILED', message: 'Commit your changes first.' },
      }));
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: 'echo draft > draft.md' },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 1 } });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      expect(toolCalls[0]).toMatchObject({ workspace: { clean: false } });
      expect(await messagesReceived()).toEqual([run.initialPrompt, run.nudgeMessage]);
    },
    TIMEOUT,
  );

  it(
    'ends the run after an accepted ticket_give_up',
    async () => {
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              {
                do: 'mcp',
                tool: 'ticket_give_up',
                arguments: { reason: 'Impossible.', tried: 'Everything.' },
              },
            ],
          },
        ],
      });
      const run = await start(manager);
      expect((await ended(run.runId)).reason).toBe('gave_up');
      expect(await messagesReceived()).toEqual([run.initialPrompt]);
    },
    TIMEOUT,
  );

  it(
    'waits for the answer after ticket_ask, without a nudge, and sends it to the live session',
    async () => {
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [{ do: 'mcp', tool: 'ticket_ask', arguments: { question: 'Which colour?' } }],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await waitFor(() => states(run.runId).at(-1)?.state === 'waiting_human', 20_000);
      expect(states(run.runId).at(-1)).toMatchObject({ sessionAlive: true });
      expect(await messagesReceived()).toEqual([run.initialPrompt]);

      const answer = 'The owner answered: blue.';
      expect(
        await manager.handle({
          type: 'run.input',
          id: randomUUID(),
          payload: { runId: run.runId, text: answer },
        }),
      ).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      expect(await messagesReceived()).toEqual([run.initialPrompt, answer]);
    },
    TIMEOUT,
  );

  it(
    'closes the session after the waiting run lifetime, keeping the worktree, then resumes it',
    async () => {
      // One minute lasts 1.2 s.
      const manager = daemon({ secondMs: 20 });
      await fake.play({
        turns: [
          {
            steps: [{ do: 'mcp', tool: 'ticket_ask', arguments: { question: 'Which colour?' } }],
          },
        ],
      });
      const run = await start(manager, {
        limits: {
          waitingRunLifetimeMinutes: 1,
          sessionStartTimeoutSeconds: 600,
          maxNudgesPerRun: 0,
        },
      });
      await waitFor(
        () => states(run.runId).some((s) => s.state === 'waiting_human' && !s.sessionAlive),
        20_000,
        'the session closed',
      );
      const waiting = states(run.runId).at(-1);
      expect(waiting).toMatchObject({ state: 'waiting_human', sessionAlive: false });
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
      await stat(join(home.paths.home, 'worktrees', run.runId));
      expect(manager.list()).toEqual([
        {
          runId: run.runId,
          state: 'waiting_human',
          claudeSessionId: waiting?.claudeSessionId,
          ticket: 'NOTES-1',
          repository: 'owner/notes',
          branch: 't/1-add-notes',
        },
      ]);
      expect(
        await manager.handle({
          type: 'run.input',
          id: randomUUID(),
          payload: { runId: run.runId, text: 'Blue.' },
        }),
      ).toEqual({ ok: false, message: 'session closed: use run.resume' });

      await fake.play({ turns: [{ steps: [{ do: 'text', text: 'Using blue.' }] }] });
      const answer = 'The owner answered: blue.';
      expect(
        await manager.handle({
          type: 'run.resume',
          id: randomUUID(),
          payload: {
            runId: run.runId,
            claudeSessionId: waiting?.claudeSessionId ?? '',
            message: answer,
          },
        }),
      ).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      const launches = (await fake.log()).filter((entry) => entry.event === 'start');
      expect(launches).toHaveLength(2);
      expect(launches[1]?.event === 'start' && launches[1].args.slice(-4)).toEqual([
        '--resume',
        waiting?.claudeSessionId,
        '--',
        answer,
      ]);
      // A resumed session sets its permission mode too, so Claude Code's own default (auto mode
      // from 2.1.288) never applies to an agent (lot 2 step N).
      for (const { args } of launches) {
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
      }
      expect((await fake.log()).some((entry) => entry.event === 'arguments_refused')).toBe(false);
    },
    TIMEOUT,
  );
});

describe('status line', () => {
  it(
    'gives the estimated usage of the run',
    async () => {
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'statusLine', input: { cost: { total_cost_usd: 0.42 } } },
              { do: 'text', text: 'Working.' },
              { do: 'sleep', ms: 2500 },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await ended(run.runId);
      const usage = sent
        .filter((message): message is RunEvents => message.type === 'run.events')
        .map((message) => message.payload.estimatedUsageUsd);
      expect(usage).toContain(0.42);
    },
    TIMEOUT,
  );
});
