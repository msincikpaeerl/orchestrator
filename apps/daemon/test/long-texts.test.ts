import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FIRST_MESSAGE_MAX_BYTES,
  INSTRUCTIONS_MAX_BYTES,
  RunInput,
  RunResume,
  RunStart,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { Tmux, sessionName } from '../src/tmux.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  messagesReceived,
  start,
  states,
  tmux,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// Texts far above the 16 KB a tmux command can hold (lot 5 step 5bis C, ART-14's review): the
// instructions and the message reach the fake `claude` whole, at launch, at a resume and in an
// open session; a launch the machine cannot do ends `launch_failed`.

useRunnerHarness();

const PIECE =
  'Ligne «été» 漢字 🙂 "double" \'single\' $HOME ${PATH} $(id) `id` \\back\\slash %s *glob* ~!\n';

/** A text of exactly `bytes` UTF-8 bytes, with every character a shell could take for its own. */
function text(bytes: number): string {
  let result = '';
  while (Buffer.byteLength(result + PIECE) < bytes) result += PIECE;
  while (Buffer.byteLength(result) < bytes - 1) result += 'a';
  return `${result}.`;
}

/** The arguments of each launch of the fake `claude`. */
async function launches(): Promise<string[][]> {
  return (await fake.log()).flatMap((entry) => (entry.event === 'start' ? [entry.args] : []));
}

const after = (args: readonly string[] | undefined, option: string) =>
  args?.[args.indexOf(option) + 1];

describe('texts above what a tmux command holds', () => {
  it(
    'launches with instructions and a first message at their limits, byte for byte',
    async () => {
      const manager = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const instructions = text(INSTRUCTIONS_MAX_BYTES);
      const initialPrompt = text(FIRST_MESSAGE_MAX_BYTES);
      const run = await start(manager, {
        initialPrompt,
        profile: {
          key: 'web_dev',
          version: 1,
          instructions,
          model: 'sonnet',
          allowedTools: ['Bash(git commit *)'],
        },
      });
      // What the server can send: the protocol keeps both texts as they are.
      const parsed = RunStart.shape.payload.parse(run);
      expect(parsed.profile.instructions).toBe(instructions);
      expect(parsed.initialPrompt).toBe(initialPrompt);

      await waitFor(
        () => states(run.runId).some((state) => state.state === 'working'),
        20_000,
        'the session working',
      );
      const [args] = await launches();
      expect(after(args, '--append-system-prompt')).toBe(instructions);
      expect(args?.at(-1)).toBe(initialPrompt);
      await waitFor(
        async () => (await messagesReceived()).length === 1,
        20_000,
        'the first message read',
      );
      expect(await messagesReceived()).toEqual([initialPrompt]);
      // The texts stay in the run's folder, the owner's only, removed with it.
      const folder = join(home.paths.home, 'runs', run.runId);
      expect((await stat(join(folder, 'message.md'))).mode & 0o777).toBe(0o600);
      expect((await stat(join(folder, 'system-prompt.md'))).mode & 0o777).toBe(0o600);

      await manager.handle({
        type: 'run.stop',
        id: randomUUID(),
        payload: { runId: run.runId, reason: 'owner_stopped' },
      });
      expect((await ended(run.runId)).reason).toBe('stopped');
    },
    TIMEOUT,
  );

  it(
    'resumes a closed session with a message at its limit, byte for byte',
    async () => {
      const manager = daemon();
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
      const run = await start(manager, {
        limits: { maxNudgesPerRun: 2, sessionStartTimeoutSeconds: 600 },
      });
      await waitFor(
        () => states(run.runId).at(-1)?.state === 'quota_paused',
        30_000,
        'the run paused on the usage limit',
      );
      const sessionId = states(run.runId).at(-1)?.claudeSessionId ?? '';
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const message = text(FIRST_MESSAGE_MAX_BYTES);
      const resume = {
        type: 'run.resume' as const,
        id: randomUUID(),
        payload: { runId: run.runId, claudeSessionId: sessionId, message },
      };
      expect(RunResume.parse(resume).payload.message).toBe(message);
      expect(await manager.handle(resume)).toEqual({ ok: true });
      await waitFor(
        async () => (await messagesReceived()).length === 2,
        20_000,
        'the message after --resume',
      );
      expect(await messagesReceived()).toEqual([run.initialPrompt, message]);
      const second = (await launches())[1];
      expect(after(second, '--resume')).toBe(sessionId);
      expect(second?.at(-1)).toBe(message);

      await manager.handle({
        type: 'run.stop',
        id: randomUUID(),
        payload: { runId: run.runId, reason: 'owner_stopped' },
      });
      expect((await ended(run.runId)).reason).toBe('stopped');
    },
    TIMEOUT,
  );

  it(
    'pastes a message of 150,000 bytes into the open session, byte for byte',
    async () => {
      const manager = daemon();
      await fake.play({ turns: [{ steps: [{ do: 'sleep', ms: 2500 }] }] });
      const run = await start(manager, { limits: { maxNudgesPerRun: 0 } });
      await waitFor(() => states(run.runId).some((state) => state.state === 'working'), 20_000);
      const message = text(150_000);
      const input = {
        type: 'run.input' as const,
        id: randomUUID(),
        payload: { runId: run.runId, text: message },
      };
      expect(RunInput.parse(input).payload.text).toBe(message);
      expect(await manager.handle(input)).toEqual({ ok: true });
      expect((await ended(run.runId)).reason).toBe('nudges_exhausted');
      expect(await messagesReceived()).toEqual([run.initialPrompt, message]);
    },
    TIMEOUT,
  );
});

/** A tmux whose new sessions fail, as when its server cannot start on the machine. */
class BrokenTmux extends Tmux {
  override newSession(): Promise<void> {
    return Promise.reject(new Error('tmux new-session failed: no server running'));
  }
}

describe('a launch the machine cannot do', () => {
  it(
    'ends the run launch_failed, in plain words, without a session',
    async () => {
      const manager = daemon({ tmux: new BrokenTmux(join(home.bin, 'tmux'), home.env) });
      const run = await start(manager);
      const end = await ended(run.runId);
      expect(end).toMatchObject({ reason: 'launch_failed', sessionAlive: false });
      expect(end.detail).toBe(
        "Claude Code could not be started on this machine (tmux new-session failed: no server running). Running it again on this machine will not help until that is fixed, and it is not the ticket's fault.",
      );
      expect(await launches()).toEqual([]);
      expect(await tmux.hasSession(sessionName(run.runId))).toBe(false);
    },
    TIMEOUT,
  );
});
