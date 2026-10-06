import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bareClonePath, worktreePath } from '../src/workspace.js';
import { gitIn } from './remote.js';
import {
  TIMEOUT,
  answerTools,
  cloneUrl,
  daemon,
  ended,
  fake,
  home,
  start,
  states,
  useRunnerHarness,
} from './runner-harness.js';
import { waitFor } from './testing.js';

// The bare clone's Git configuration and hooks restored at a run's end (05, section 7.1; lot 3
// step D2), with the real tmux and Git and the fake `claude`: what an agent changed is put back
// and named in the end report, without values; a waiting run of the same repository keeps its
// worktree and its commit author.

useRunnerHarness();

const GIVE_UP = {
  do: 'mcp',
  tool: 'ticket_give_up',
  arguments: { reason: 'Stop.', tried: 'This.' },
} as const;

describe('the Git configuration at a run end', () => {
  it(
    'is restored with what changed named, and a waiting run of the same repository keeps working',
    async () => {
      const manager = daemon();
      answerTools(() => ({ ok: true, output: {} }));
      const waitingId = randomUUID();
      const changingId = randomUUID();
      const marker = join(home.root, 'hook-ran');
      await fake.play(
        {
          turns: [
            { steps: [{ do: 'mcp', tool: 'ticket_ask', arguments: { question: 'Which?' } }] },
            {
              steps: [
                { do: 'bash', command: 'git commit -q --allow-empty -m "After the answer"' },
                GIVE_UP,
              ],
            },
          ],
        },
        waitingId,
      );
      const common = '"$(git rev-parse --git-common-dir)"';
      await fake.play(
        {
          turns: [
            {
              steps: [
                {
                  do: 'bash',
                  command: [
                    'git config core.hooksPath .husky',
                    'git config alias.secret "!echo ghp_NotAValue0000000000000000000000000000"',
                    'git config remote.origin.url https://planted.example/x.git',
                    'git config --add credential.helper "!planted"',
                    `printf '#!/bin/sh\\ntouch ${marker}\\n' > ${common}/hooks/post-commit`,
                    `chmod +x ${common}/hooks/post-commit`,
                  ].join(' && '),
                },
                GIVE_UP,
              ],
            },
          ],
        },
        changingId,
      );
      const waiting = await start(manager, { runId: waitingId });
      await waitFor(
        () => states(waiting.runId).some((state) => state.state === 'waiting_human'),
        20_000,
        'the waiting run',
      );
      const changing = await start(manager, {
        runId: changingId,
        subject: { kind: 'ticket', id: randomUUID(), number: 'NOTES-2' },
        repository: { ticketBranch: 't/2-other' },
      });
      const end = await ended(changing.runId);
      expect(end.gitConfigRestored).toBe(
        'Settings added during the run, removed: alias.secret, core.hookspath. Settings changed, set back: credential.helper, remote.origin.url. Hook files added, removed: post-commit.',
      );

      const bare = bareClonePath(home.paths, changing.repository);
      const config = gitIn(bare, ['config', '--file', 'config', '--list'], home.env);
      expect(config).not.toMatch(/hookspath|alias|planted/);
      expect(config).toContain(`remote.origin.url=${cloneUrl}`);
      expect(await readdir(join(bare, 'hooks'))).not.toContain('post-commit');

      // The waiting run is answered: its worktree is there, and it commits with its author.
      expect(existsSync(worktreePath(home.paths, waiting.runId))).toBe(true);
      expect(
        await manager.handle({
          type: 'run.input',
          id: randomUUID(),
          payload: { runId: waiting.runId, text: 'This one.' },
        }),
      ).toEqual({ ok: true });
      expect(await ended(waiting.runId)).toMatchObject({
        reason: 'gave_up',
        gitConfigRestored: null,
      });
      expect(
        gitIn(
          bare,
          ['log', '-1', '--format=%an <%ae>|%s', 'refs/heads/t/1-add-notes'],
          home.env,
        ).trim(),
      ).toBe('Web Developer (Orchestrator) <1+owner@users.noreply.github.com>|After the answer');
      expect(existsSync(marker)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'reports nothing when nothing changed',
    async () => {
      const manager = daemon();
      await fake.play({ turns: [{ steps: [GIVE_UP] }] });
      const run = await start(manager);
      expect(await ended(run.runId)).toMatchObject({ reason: 'gave_up', gitConfigRestored: null });
    },
    TIMEOUT,
  );
});
