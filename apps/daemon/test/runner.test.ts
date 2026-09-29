import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { sessionName } from '../src/tmux.js';
import { gitIn } from './remote.js';
import {
  TIMEOUT,
  cloneUrl,
  daemon,
  ended,
  fake,
  home,
  logEvents,
  messagesReceived,
  sent,
  start,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { runStartPayload } from './run-start.js';
import { waitFor } from './testing.js';

// The runner with the real tmux and the fake `claude` (ADR 0027): the session's start, input,
// nudges, timeouts, the end with the branch, and a daemon restart. The server is a recorder
// that acknowledges every report.

useRunnerHarness();

describe('runner', () => {
  it(
    'launches Claude Code as 05 section 4.3 says, up to SessionStart',
    async () => {
      const manager = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'sleep', ms: 60_000 }] }] });
      // A key written there by Claude Code itself is kept.
      await mkdir(home.paths.claudeConfig, { recursive: true });
      await writeFile(
        join(home.paths.claudeConfig, 'settings.json'),
        JSON.stringify({ theme: 'dark', autoContinueAtUsageLimit: true }),
      );
      const run = await start(manager);
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);

      expect(states(run.runId).map((state) => state.state)).toEqual([
        'preparing',
        'starting',
        'working',
      ]);
      expect(states(run.runId)[1]).toMatchObject({ claudeCodeVersion: '2.1.282 (Claude Code)' });
      const working = states(run.runId)[2];
      expect(working?.sessionAlive).toBe(true);
      expect(working?.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(manager.list()).toEqual([
        {
          runId: run.runId,
          state: 'working',
          claudeSessionId: working?.claudeSessionId,
          ticket: 'NOTES-1',
          repository: 'owner/notes',
          branch: 't/1-add-notes',
        },
      ]);

      const [launch] = (await fake.log()).filter((entry) => entry.event === 'start');
      const folder = join(home.paths.home, 'runs', run.runId);
      expect(launch).toMatchObject({
        cwd: join(home.paths.home, 'worktrees', run.runId),
        env: { CLAUDE_CONFIG_DIR: home.paths.claudeConfig, TMUX: null, TMUX_PANE: null },
        args: [
          '--mcp-config',
          join(folder, 'mcp.json'),
          '--strict-mcp-config',
          '--setting-sources',
          'user',
          '--settings',
          join(folder, 'settings.json'),
          '--permission-mode',
          'dontAsk',
          '--model',
          'sonnet',
          '--append-system-prompt',
          'Common rules and role instructions.',
          '--',
          'Implement ticket NOTES-1.',
        ],
      });
      expect((await fake.log()).some((entry) => entry.event === 'arguments_refused')).toBe(false);
      const settings = JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8')) as {
        autoContinueAtUsageLimit: boolean;
        hooks: Record<string, unknown>;
      };
      expect(settings.autoContinueAtUsageLimit).toBe(false);
      // The key's documented scope is "User or managed": the dedicated user settings carry it too.
      expect(
        JSON.parse(await readFile(join(home.paths.claudeConfig, 'settings.json'), 'utf8')),
      ).toEqual({ theme: 'dark', autoContinueAtUsageLimit: false });
      expect(Object.keys(settings.hooks)).toEqual([
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'StopFailure',
        'Notification',
        'SessionEnd',
      ]);
      const mcp = JSON.parse(await readFile(join(folder, 'mcp.json'), 'utf8')) as {
        mcpServers: { orchestrator: { args: string[]; timeout: number } };
      };
      expect(mcp.mcpServers.orchestrator.args.slice(-3)).toEqual(['mcp', '--run', run.runId]);
      expect(mcp.mcpServers.orchestrator.timeout).toBe(120_000);
      // Trust of the bare clone, where Claude Code looks for a worktree's trust.
      const config = JSON.parse(
        await readFile(join(home.paths.claudeConfig, '.claude.json'), 'utf8'),
      ) as { projects: Record<string, { hasTrustDialogAccepted: boolean }> };
      expect(
        config.projects[join(home.paths.home, 'repos', 'owner', 'notes.git')]
          ?.hasTrustDialogAccepted,
      ).toBe(true);
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(true);
      await waitFor(() => logEvents(run.runId).length > 0, 5000, 'the first log entry');
      expect(logEvents(run.runId)[0]).toMatchObject({
        seq: 0,
        kind: 'input',
        text: 'Implement ticket NOTES-1.',
      });

      expect(
        await manager.handle({
          type: 'run.stop',
          id: randomUUID(),
          payload: { runId: run.runId, reason: 'owner_stopped' },
        }),
      ).toEqual({ ok: true });
      expect(await ended(run.runId)).toMatchObject({ reason: 'stopped', sessionAlive: false });
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'fails a session that never reports its start, naming the likely cause',
    async () => {
      const manager = daemon({ secondMs: 100 });
      await fake.play({ noSessionStart: true });
      const run = await start(manager, { limits: { sessionStartTimeoutSeconds: 5 } });
      const end = await ended(run.runId);
      expect(end.reason).toBe('session_start_timeout');
      expect(end.detail).toMatch(/workspace trust or startup dialog suspected/);
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'nudges an idle turn twice, then ends the run',
    async () => {
      const manager = daemon();
      const run = await start(manager, { limits: { maxNudgesPerRun: 2 } });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      expect(await messagesReceived()).toEqual([
        'Implement ticket NOTES-1.',
        run.nudgeMessage,
        run.nudgeMessage,
      ]);
      expect(
        logEvents(run.runId)
          .filter((event) => event.kind === 'input')
          .map((event) => event.text),
      ).toEqual([run.initialPrompt, run.nudgeMessage, run.nudgeMessage]);
      expect(logEvents(run.runId).filter((event) => event.kind === 'agent_text')).toHaveLength(3);
      const shown = states(run.runId).map((state) => state.state);
      expect(shown.filter((state) => state === 'idle')).toHaveLength(3);
    },
    TIMEOUT,
  );

  it(
    'stops a run at the maximum duration',
    async () => {
      const manager = daemon({ secondMs: 20 });
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await start(manager, {
        limits: {
          maxRunDurationMinutes: 1,
          idleTimeoutMinutes: 120,
          sessionStartTimeoutSeconds: 600,
        },
      });
      const end = await ended(run.runId);
      expect(end.reason).toBe('max_duration');
      expect(end.detail).toMatch(/1 minutes, the "Longest run" setting/);
    },
    TIMEOUT,
  );

  it(
    'stops a run without activity at the idle timeout, never while a command runs',
    async () => {
      const manager = daemon({ secondMs: 20 });
      // One minute lasts 1.2 s: the command takes longer, then the session hangs.
      await fake.play({
        turns: [{ steps: [{ do: 'bash', command: 'sleep 2.5' }, { do: 'hang' }] }],
      });
      const run = await start(manager, {
        limits: { idleTimeoutMinutes: 1, sessionStartTimeoutSeconds: 600 },
      });
      const end = await ended(run.runId);
      expect(end.reason).toBe('idle_timeout');
      expect((await fake.log()).some((entry) => entry.event === 'bash')).toBe(true);
      // No nudge: the agent never finished a turn.
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.']);
    },
    TIMEOUT,
  );

  it(
    'delivers a three-line input as one message, queued until the turn ends',
    async () => {
      const manager = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'sleep', ms: 2500 }] }] });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      const text = 'First line of the answer\nsecond line with "quotes" and $HOME\nthird line';
      expect(
        await manager.handle({
          type: 'run.input',
          id: randomUUID(),
          payload: { runId: run.runId, text },
        }),
      ).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      expect(await messagesReceived()).toEqual(['Implement ticket NOTES-1.', text]);
    },
    TIMEOUT,
  );

  it(
    'removes the worktree at the end and keeps the branch with its commits',
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
              { do: 'text', text: 'Committed.' },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      const end = await ended(run.runId);
      expect(end.reason).toBe('nudges_exhausted');
      expect(end.branch).toMatchObject({
        name: 't/1-add-notes',
        commitsAhead: [{ subject: 'Add notes' }],
      });
      await expect(stat(join(home.paths.home, 'worktrees', run.runId))).rejects.toThrow();
      const bare = join(home.paths.home, 'repos', 'owner', 'notes.git');
      expect(gitIn(bare, ['log', '-1', '--format=%an|%s', 't/1-add-notes'], home.env).trim()).toBe(
        'Web Developer (Orchestrator)|Add notes',
      );
      // Every report acknowledged: the run's folder is gone.
      await waitFor(
        async () =>
          !(await stat(join(home.paths.home, 'runs', run.runId)).then(
            () => true,
            () => false,
          )),
        5000,
        'the run folder removed',
      );
      expect(manager.list()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'finds a live session again after a daemon restart, with its unacknowledged reports',
    async () => {
      const first = daemon({ acknowledge: false });
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'sleep', ms: 4000 },
              { do: 'text', text: 'Still here.' },
            ],
          },
        ],
      });
      const run = await start(first, { limits: { maxNudgesPerRun: 0 } });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      await first.shutdown();
      const before = sent.length;

      const second = daemon();
      await second.recover();
      expect(second.list()).toEqual([
        {
          runId: run.runId,
          state: 'working',
          claudeSessionId: expect.any(String) as unknown,
          ticket: 'NOTES-1',
          repository: 'owner/notes',
          branch: 't/1-add-notes',
        },
      ]);
      // Reports the first daemon never had acknowledged are sent again, in order.
      second.outbox.resend();
      expect(
        sent
          .slice(before)
          .filter((message): message is RunState => message.type === 'run.state')
          .map((message) => message.payload.state),
      ).toEqual(['preparing', 'starting', 'working']);

      // The session's next hooks reach the new daemon, which ends the run.
      const end = await ended(run.runId);
      expect(end.reason).toBe('nudges_exhausted');
      expect(logEvents(run.runId).map((event) => event.text)).toContain('Still here.');
    },
    TIMEOUT,
  );

  it(
    'fails a run whose session ended while the daemon was stopped',
    async () => {
      const first = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const run = await start(first);
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      await first.shutdown();
      await tmux.killSession(sessionName(run.runId));
      const second = daemon();
      await second.recover();
      expect((await ended(run.runId)).detail).toMatch(/ended while the daemon was stopped/);
      expect(second.list()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'refuses to launch a Claude Code older than the minimum',
    async () => {
      const manager = daemon();
      await fake.play({ version: '2.1.100 (Claude Code)' });
      const run = await start(manager);
      const end = await ended(run.runId);
      expect(end.reason).toBe('claude_code_unsupported');
      expect(end.detail).toMatch(/2\.1\.100 \(Claude Code\) is older than 2\.1\.280/);
      expect(states(run.runId)[1]).toMatchObject({
        state: 'starting',
        claudeCodeVersion: '2.1.100 (Claude Code)',
      });
      expect((await fake.log()).some((entry) => entry.event === 'start')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'shows skipped transcript lines as a warning and masks credentials in the log',
    async () => {
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'transcript', line: 'not json' },
              { do: 'transcript', line: '{"type":"mystery-entry"}' },
              { do: 'text', text: `The token is ghp_${'x'.repeat(36)}.` },
            ],
          },
        ],
      });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await ended(run.runId);
      const events = logEvents(run.runId);
      expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      expect(events.find((event) => event.kind === 'warning')?.text).toMatch(
        /^2 transcript line\(s\) could not be read and were skipped \(2 in this run\)/,
      );
      expect(events.map((event) => event.text)).toContain('The token is [hidden].');
    },
    TIMEOUT,
  );

  it(
    'handles a duplicate command once',
    async () => {
      const manager = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const payload = runStartPayload(cloneUrl);
      const command = { type: 'run.start' as const, id: randomUUID(), payload };
      expect(await manager.handle(command)).toEqual({ ok: true });
      expect(await manager.handle(command)).toEqual({ ok: true });
      await waitFor(() => states(payload.runId).some((state) => state.state === 'working'), 20_000);
      expect((await fake.log()).filter((entry) => entry.event === 'start')).toHaveLength(1);
      expect(
        await manager.handle({
          type: 'run.input',
          id: randomUUID(),
          payload: { runId: randomUUID(), text: 'Hello' },
        }),
      ).toEqual({ ok: false, message: 'No such run on this machine.' });
    },
    TIMEOUT,
  );
});
