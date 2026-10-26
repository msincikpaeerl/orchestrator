import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FIRST_MESSAGE_MAX_BYTES } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { UserSystemd, unitPrefix } from '../src/systemd.js';
import { installFakeSystemd } from './fake-systemd/install.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  messagesReceived,
  start,
  states,
  useRunnerHarness,
} from './runner-harness.js';
import { fakeExecutable, waitFor } from './testing.js';

// A launch through the process scopes, the path of the service (lot 5 step 5bis D, ART-13's
// reviews): systemd-run 254 and later expand `${…}` in a scope's command, which emptied the
// launcher's texts, and Claude Code started without its instructions or its message. With the
// fake `systemd-run` doing what systemd does, the texts arrive whole at a first launch and a
// resume; a text that reads as empty starts no Claude Code.

useRunnerHarness();

const PIECE =
  'Rules «été» 漢字 🙂 "double" \'single\' $HOME ${PATH} ${i%x} $$ $(id) `id` \\back\\slash ~!\n';
const INSTRUCTIONS = `${PIECE.repeat(200)}End of the rules.`;

async function scopedDaemon(version = 259) {
  await installFakeSystemd(home.bin, version);
  const found = await UserSystemd.detect(home.env.PATH ?? '', home.env, unitPrefix(home.paths));
  if (!found.systemd) throw new Error(`no scopes: ${found.problem}`);
  return daemon({ systemd: found.systemd });
}

async function launches(): Promise<string[][]> {
  return (await fake.log()).flatMap((entry) => (entry.event === 'start' ? [entry.args] : []));
}

const after = (args: readonly string[] | undefined, option: string) =>
  args?.[args.indexOf(option) + 1];

const profile = (instructions: string) => ({
  key: 'quality',
  version: 1,
  instructions,
  model: 'sonnet',
  allowedTools: ['Bash(git commit *)'],
});

describe('a launch in a process scope', () => {
  it.each([259, 252])(
    'gives Claude Code its instructions and its messages whole, at launch and at a resume (systemd %i)',
    async (version) => {
      const manager = await scopedDaemon(version);
      await fake.play({
        turns: [
          {
            steps: [{ do: 'text', text: 'Working.' }],
            end: {
              kind: 'stopFailure',
              error: 'rate_limit',
              message: "You've hit your session limit · resets 3:45pm",
            },
          },
        ],
      });
      const initialPrompt = `Review ${PIECE.repeat(100)}`;
      const run = await start(manager, {
        initialPrompt,
        profile: profile(INSTRUCTIONS),
        limits: { maxNudgesPerRun: 2, sessionStartTimeoutSeconds: 600 },
      });
      await waitFor(
        () => states(run.runId).at(-1)?.state === 'quota_paused',
        30_000,
        'the run paused on the usage limit',
      );
      const [first] = await launches();
      expect(after(first, '--append-system-prompt')).toBe(INSTRUCTIONS);
      expect(first?.at(-1)).toBe(initialPrompt);
      expect(await messagesReceived()).toEqual([initialPrompt]);

      const sessionId = states(run.runId).at(-1)?.claudeSessionId ?? '';
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const message = `Go on: ${PIECE.repeat(Math.floor(FIRST_MESSAGE_MAX_BYTES / 200))}`;
      expect(
        await manager.handle({
          type: 'run.resume',
          id: randomUUID(),
          payload: { runId: run.runId, claudeSessionId: sessionId, message },
        }),
      ).toEqual({ ok: true });
      await waitFor(
        async () => (await messagesReceived()).length === 2,
        20_000,
        'the message after --resume',
      );
      const second = (await launches())[1];
      expect(after(second, '--append-system-prompt')).toBe(INSTRUCTIONS);
      expect(after(second, '--resume')).toBe(sessionId);
      expect(second?.at(-1)).toBe(message);
      expect(await messagesReceived()).toEqual([initialPrompt, message]);

      await manager.handle({
        type: 'run.stop',
        id: randomUUID(),
        payload: { runId: run.runId, reason: 'owner_stopped' },
      });
      expect((await ended(run.runId)).reason).toBe('stopped');
    },
    TIMEOUT,
  );
});

describe('a launch without its texts', () => {
  it(
    'is refused by the daemon when the instructions are empty: launch_failed, no session',
    async () => {
      const manager = await scopedDaemon();
      const run = await start(manager, { profile: profile(' \n') });
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'launch_failed', sessionAlive: false });
      expect(end.detail).toBe('Claude Code was not started: the run has no instructions.');
      expect(await launches()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'is stopped by the launcher when a text reads as empty: launch_failed, no Claude Code',
    async () => {
      // A `cat` that reads nothing: the launcher finds its `cat` in the daemon's PATH.
      await fakeExecutable(home.bin, 'cat', 'exit 0');
      const manager = await scopedDaemon();
      const run = await start(manager, { profile: profile(INSTRUCTIONS) });
      const end = await ended(run.runId);
      const folder = join(home.paths.home, 'runs', run.runId);
      expect(end).toMatchObject({ reason: 'launch_failed', sessionAlive: false });
      expect(end.detail).toBe(
        `Claude Code was not started: the instructions (${join(folder, 'system-prompt.md')}) read as empty. Running it again on this machine will not help until that is fixed, and it is not the ticket's fault.`,
      );
      expect(await launches()).toEqual([]);
    },
    TIMEOUT,
  );
});
