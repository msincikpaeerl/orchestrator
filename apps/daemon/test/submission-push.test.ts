import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SUBMISSION_REPORT_MAX_BYTES, encodedBytes, type DodReport } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { findExecutable } from '../src/exec.js';
import { bareClonePath } from '../src/workspace.js';
import { gitIn } from './remote.js';
import {
  TIMEOUT,
  cloneUrl,
  daemon,
  ended,
  fake,
  home,
  start,
  toolCalls,
  useRunnerHarness,
} from './runner-harness.js';
import { fakeExecutable } from './testing.js';
import { answerTools } from './runner-harness.js';

// The push at `ticket_submit` (05, section 4.9; lot 3 step D1), with the real tmux and Git and
// the fake `claude`: only the ticket branch, by an explicit refspec, and the head read for the
// facts is the one pushed and reported.

useRunnerHarness();

const SUBMISSION: DodReport = {
  criteria: [{ number: 1, status: 'met', justification: 'Notes are saved.' }],
  tests: { paths: [], justification: 'No code.' },
  docs: { paths: [], justification: 'No user-visible change.' },
  adrs: [],
  summary: 'Adds notes.',
};

const COMMIT = 'echo notes > notes.md && git add notes.md && git commit -q -m "Add notes"';

function remoteRefs(): string[] {
  const remote = cloneUrl.replace(/^file:\/\//, '');
  return gitIn(remote, ['for-each-ref', '--format=%(refname)'], home.env)
    .split('\n')
    .filter(Boolean);
}

function remoteHead(ref: string): string {
  return gitIn(cloneUrl.replace(/^file:\/\//, ''), ['rev-parse', ref], home.env).trim();
}

describe('the push at ticket_submit', () => {
  it(
    'pushes only the ticket branch: no branch or annotated tag the agent made, even with push.followTags',
    async () => {
      // Tags follow pushed commits when this is read: in the owner's global configuration...
      await appendFile(join(home.env.HOME ?? '', '.gitconfig'), '[push]\n\tfollowTags = true\n');
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              {
                do: 'bash',
                // ...and in the bare clone's, written by the agent's own `git config`.
                command: `${COMMIT} && git branch agent-branch && git tag -a v1 -m "On the ticket's own commit" && git config push.followTags true`,
              },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
              { do: 'text', text: 'Submitted.' },
            ],
          },
        ],
      });
      const run = await start(manager);
      expect((await ended(run.runId)).reason).toBe('submitted');
      const call = toolCalls[0];
      if (call?.tool !== 'ticket_submit') throw new Error('no ticket_submit');
      const head = call.workspace.branch.head;
      expect(call.workspace.push).toEqual({ status: 'pushed', head });
      expect(remoteHead('refs/heads/t/1-add-notes')).toBe(head);
      expect(remoteRefs().sort()).toEqual(['refs/heads/main', 'refs/heads/t/1-add-notes']);
      // The tag is there, on the pushed commit, and stayed local.
      const bare = bareClonePath(home.paths, run.repository);
      expect(gitIn(bare, ['rev-parse', 'v1^{commit}'], home.env).trim()).toBe(head);
    },
    TIMEOUT,
  );

  it(
    'pushes and reports the head read for the facts, even when the branch moves before the push',
    async () => {
      // Git as the daemon finds it, moving the ticket branch back to main just before the push.
      const real = findExecutable('git', process.env.PATH) ?? 'git';
      const bare = join(home.paths.home, 'repos', 'owner', 'notes.git');
      const marker = join(home.root, 'moved');
      await rm(join(home.bin, 'git'));
      await fakeExecutable(
        home.bin,
        'git',
        [
          'case " $* " in',
          `  *" push "*) if [ ! -e '${marker}' ]; then : > '${marker}'; '${real}' --git-dir='${bare}' update-ref refs/heads/t/1-add-notes refs/remotes/origin/main; fi ;;`,
          'esac',
          `exec '${real}' "$@"`,
        ].join('\n'),
      );
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
            ],
          },
        ],
      });
      const run = await start(manager);
      expect((await ended(run.runId)).reason).toBe('submitted');
      const call = toolCalls[0];
      if (call?.tool !== 'ticket_submit') throw new Error('no ticket_submit');
      const head = call.workspace.branch.head;
      expect(call.workspace.branch.commitsAhead.map((commit) => commit.hash)).toEqual([head]);
      // Read with the facts, before the push: the commit about to be pushed (lot 3 step D3).
      expect(call.workspace.branch.notOnGitHub).toEqual({ listed: [head], count: 1 });
      expect(call.workspace.push).toEqual({ status: 'pushed', head });
      expect(remoteHead('refs/heads/t/1-add-notes')).toBe(head);
      // The branch did move meanwhile.
      expect(gitIn(bare, ['rev-parse', 'refs/heads/t/1-add-notes'], home.env).trim()).toBe(
        remoteHead('refs/heads/main'),
      );
    },
    TIMEOUT,
  );

  it(
    'pushes nothing when the worktree has changes not committed',
    async () => {
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: `${COMMIT} && echo draft > draft.md` },
              { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
              { do: 'mcp', tool: 'ticket_give_up', arguments: { reason: 'Stop.', tried: 'This.' } },
            ],
          },
        ],
      });
      const run = await start(manager);
      const end = await ended(run.runId);
      expect(toolCalls[0]).toMatchObject({ workspace: { clean: false, push: null } });
      // The commit reaches GitHub only with the end push of the run that gave up (lot 3 step D2).
      expect(end).toMatchObject({ reason: 'gave_up', push: { status: 'pushed' } });
      expect(remoteRefs()).toEqual(['refs/heads/main', 'refs/heads/t/1-add-notes']);
    },
    TIMEOUT,
  );
});

/** GitHub refusing every push, as a remote's pre-receive hook. */
async function refusePushes(): Promise<void> {
  const hook = join(cloneUrl.replace(/^file:\/\//, ''), 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho "refused by the test" >&2\nexit 1\n', { mode: 0o755 });
}

describe('a push that failed at ticket_submit (lot 3 step F)', () => {
  for (const answer of ['accepted', 'refused'] as const) {
    it(
      `ends the run at the turn's end with push_failed, the server's answer ${answer}, and still tries the end push`,
      async () => {
        await refusePushes();
        if (answer === 'refused') {
          answerTools(() => ({
            ok: false,
            error: { code: 'DOD_FAILED', message: 'The push failed: end your turn.' },
          }));
        }
        const manager = daemon();
        await fake.play({
          turns: [
            {
              steps: [
                { do: 'bash', command: COMMIT },
                { do: 'mcp', tool: 'ticket_submit', arguments: SUBMISSION },
                { do: 'text', text: 'The push failed: ending my turn.' },
              ],
            },
          ],
        });
        const run = await start(manager);
        const end = await ended(run.runId);
        const call = toolCalls[0];
        if (call?.tool !== 'ticket_submit') throw new Error('no ticket_submit');
        expect(call.workspace.push).toMatchObject({ status: 'failed', reason: 'refused' });
        expect(end).toMatchObject({ reason: 'push_failed', push: { status: 'failed' } });
        expect(remoteRefs()).toEqual(['refs/heads/main']);
      },
      TIMEOUT,
    );
  }

  it(
    'refuses a DoD report above its budget before pushing, with both sizes',
    async () => {
      const summary = 'x'.repeat(SUBMISSION_REPORT_MAX_BYTES);
      const report = { ...SUBMISSION, summary };
      const manager = daemon();
      await fake.play({
        turns: [
          {
            steps: [
              { do: 'bash', command: COMMIT },
              { do: 'mcp', tool: 'ticket_submit', arguments: report },
              { do: 'mcp', tool: 'ticket_give_up', arguments: { reason: 'Stop.', tried: 'This.' } },
            ],
          },
        ],
      });
      const run = await start(manager);
      const end = await ended(run.runId);
      expect(toolCalls.map((call) => call.tool)).toEqual(['ticket_give_up']);
      const refusal = JSON.stringify(
        (await fake.log()).find((entry) => entry.event === 'mcp' && entry.tool === 'ticket_submit'),
      );
      expect(refusal).toContain('VALIDATION_FAILED');
      expect(refusal).toContain(`${String(encodedBytes(report))} bytes`);
      expect(refusal).toContain(`${String(SUBMISSION_REPORT_MAX_BYTES)} bytes`);
      // Nothing was pushed for the refused call: the branch reached GitHub with the end push.
      expect(end).toMatchObject({ reason: 'gave_up', push: { status: 'pushed' } });
    },
    TIMEOUT,
  );
});
