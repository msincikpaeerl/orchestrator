import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BranchDelete } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { branchDeletesPath } from '../src/branch-deletes.js';
import type { RunManager } from '../src/runs.js';
import { bareClonePath } from '../src/workspace.js';
import { gitIn } from './remote.js';
import {
  TIMEOUT,
  daemon,
  ended,
  fake,
  home,
  start,
  states,
  useRunnerHarness,
} from './runner-harness.js';
import { fakeExecutable, waitFor } from './testing.js';

// The local ticket branch deleted after its pull request's merge (05, section 4.11; lot 3 step
// J2b), with the real Git and tmux and the fake `claude`: the daemon checks the name, the bare
// clone's HEAD, its worktrees and its runs itself, deletes only with `update-ref` at the merged
// head, and applies each message once.

useRunnerHarness();

const BRANCH = 't/1-add-notes';
const COMMIT = 'echo notes > notes.md && git add notes.md && git commit -q -m "Add notes"';
const MORE = 'echo more >> notes.md && git commit -q -am "More notes"';
const GIVE_UP = {
  do: 'mcp' as const,
  tool: 'ticket_give_up',
  arguments: { reason: 'Stop.', tried: 'This.' },
};
const repository = { owner: 'owner', name: 'notes' };
const bare = () => bareClonePath(home.paths, repository);
const remote = () => join(home.root, 'remotes', 'owner', 'notes.git');

function head(ref: string, folder = bare()): string | null {
  try {
    return gitIn(folder, ['rev-parse', '--verify', '--quiet', ref], home.env).trim();
  } catch {
    return null;
  }
}

/** A run of NOTES-1 whose agent runs `commands`, then gives up: the branch stays local. */
async function workedOn(
  manager: RunManager,
  commands: string[] = [COMMIT],
  ticketBranch = BRANCH,
): Promise<void> {
  await fake.play({
    turns: [{ steps: [...commands.map((command) => ({ do: 'bash' as const, command })), GIVE_UP] }],
  });
  const run = await start(manager, { repository: { ticketBranch } });
  await ended(run.runId);
}

function deleteMessage(changes: Partial<BranchDelete['payload']> = {}): BranchDelete {
  return {
    type: 'branch.delete',
    id: randomUUID(),
    payload: {
      repository,
      ticket: 'NOTES-1',
      branch: BRANCH,
      mergedHead: head(`refs/heads/${BRANCH}`) ?? 'a'.repeat(40),
      ...changes,
    },
  };
}

/** The pull request merged on GitHub by a squash: one new commit on main, not the branch's. */
function squashMerged(local: string): void {
  gitIn(bare(), ['push', '--quiet', remote(), `${local}:refs/heads/${BRANCH}`], home.env);
  const main = head('refs/heads/main', remote()) ?? '';
  const squash = gitIn(
    remote(),
    ['commit-tree', `${local}^{tree}`, '-p', main, '-m', 'Add notes (#1)'],
    home.env,
  ).trim();
  gitIn(remote(), ['update-ref', 'refs/heads/main', squash, main], home.env);
}

describe('the local ticket branch after its merge', () => {
  it(
    'deletes it after a squash merge, never comparing it with the base branch, and applies a message once',
    async () => {
      const manager = daemon();
      await workedOn(manager);
      const merged = head(`refs/heads/${BRANCH}`) ?? '';
      squashMerged(merged);
      const message = deleteMessage({ mergedHead: merged });
      expect(await manager.branches.handle(message)).toEqual({ outcome: 'deleted' });
      expect(head(`refs/heads/${BRANCH}`)).toBeNull();
      // GitHub's branches and the bare clone's other refs are left alone.
      expect(head(`refs/heads/${BRANCH}`, remote())).toBe(merged);
      expect(head('refs/remotes/origin/main')).not.toBeNull();

      // The branch made again at the same head (a new run of the ticket), then the same message
      // again, even from a restarted daemon: answered as before, applied once.
      await workedOn(manager, [], BRANCH);
      gitIn(bare(), ['update-ref', `refs/heads/${BRANCH}`, merged], home.env);
      expect(await manager.branches.handle(message)).toEqual({ outcome: 'deleted' });
      const restarted = daemon();
      expect(await restarted.branches.handle(message)).toEqual({ outcome: 'deleted' });
      expect(head(`refs/heads/${BRANCH}`)).toBe(merged);
      expect(JSON.parse(await readFile(branchDeletesPath(home.paths), 'utf8'))).toEqual([
        { id: message.id, answer: { outcome: 'deleted' } },
      ]);
      // Another message is a new decision.
      expect(await restarted.branches.handle(deleteMessage({ mergedHead: merged }))).toEqual({
        outcome: 'deleted',
      });
    },
    TIMEOUT,
  );

  it(
    'keeps a branch with a commit not pushed, naming its head',
    async () => {
      const manager = daemon();
      await workedOn(manager, [COMMIT, MORE]);
      const local = head(`refs/heads/${BRANCH}`) ?? '';
      const merged = head(`refs/heads/${BRANCH}~1`) ?? '';
      expect(await manager.branches.handle(deleteMessage({ mergedHead: merged }))).toEqual({
        outcome: 'kept',
        head: local,
      });
      expect(head(`refs/heads/${BRANCH}`)).toBe(local);
    },
    TIMEOUT,
  );

  it(
    "keeps a branch that moved between the server's message and the deletion: update-ref compares",
    async () => {
      const manager = daemon();
      await workedOn(manager);
      const merged = head(`refs/heads/${BRANCH}`) ?? '';
      const moved = gitIn(
        bare(),
        ['commit-tree', `${merged}^{tree}`, '-p', merged, '-m', 'Moved meanwhile'],
        home.env,
      ).trim();
      // A Git that moves the branch just before the daemon's `update-ref` runs: every check
      // before it saw the merged head.
      const wrap = join(home.root, 'wrap');
      await mkdir(wrap);
      const real = join(home.bin, 'git');
      const git = await fakeExecutable(
        wrap,
        'git',
        [
          'for arg in "$@"; do [ "$arg" = update-ref ] && MOVE=1; done',
          `[ -n "$MOVE" ] && '${real}' -C '${bare()}' update-ref refs/heads/${BRANCH} ${moved}`,
          `exec '${real}' "$@"`,
        ].join('\n'),
      );
      const wrapped = daemon({ git });
      expect(await wrapped.branches.handle(deleteMessage({ mergedHead: merged }))).toEqual({
        outcome: 'kept',
        head: moved,
      });
      expect(head(`refs/heads/${BRANCH}`)).toBe(moved);
    },
    TIMEOUT,
  );

  it(
    "keeps a branch in use: checked out by a worktree, named by the bare clone's HEAD, or a run of the repository active",
    async () => {
      const manager = daemon();
      await workedOn(manager);
      const merged = head(`refs/heads/${BRANCH}`) ?? '';
      const message = () => deleteMessage({ mergedHead: merged });

      const left = join(home.root, 'left-worktree');
      gitIn(bare(), ['worktree', 'add', '--quiet', left, BRANCH], home.env);
      expect(await manager.branches.handle(message())).toEqual({
        outcome: 'in_use',
        by: 'worktree',
      });
      gitIn(bare(), ['worktree', 'remove', '--force', left], home.env);

      const before = gitIn(bare(), ['symbolic-ref', 'HEAD'], home.env).trim();
      gitIn(bare(), ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`], home.env);
      expect(await manager.branches.handle(message())).toEqual({
        outcome: 'in_use',
        by: 'bare_head',
      });
      gitIn(bare(), ['symbolic-ref', 'HEAD', before], home.env);

      // Another ticket's run of the same repository, working.
      await fake.play({ turns: [{ steps: [{ do: 'hang' }] }] });
      const other = await start(manager, {
        subject: { kind: 'ticket', id: randomUUID(), number: 'NOTES-2' },
        repository: { ticketBranch: 't/2-more' },
      });
      // Working, not preparing: a run stopped while it prepares is launched all the same, a
      // daemon issue of its own (reported to the owner in lot 3 step J2b).
      await waitFor(
        () => states(other.runId).some((reported) => reported.state === 'working'),
        20_000,
        'the other run working',
      );
      expect(await manager.branches.handle(message())).toEqual({ outcome: 'in_use', by: 'run' });
      expect(head(`refs/heads/${BRANCH}`)).toBe(merged);
      await manager.handle({
        type: 'run.stop',
        id: randomUUID(),
        payload: { runId: other.runId, reason: 'owner_stopped' },
      });
      await ended(other.runId);
      expect(await manager.branches.handle(message())).toEqual({ outcome: 'deleted' });
    },
    TIMEOUT,
  );

  it(
    "refuses a name that is not the ticket's branch name, and deletes t/1 with t/12 present",
    async () => {
      const manager = daemon();
      await workedOn(manager, [COMMIT], 't/1');
      const merged = head('refs/heads/t/1') ?? '';
      gitIn(bare(), ['update-ref', 'refs/heads/t/12', merged], home.env);
      gitIn(bare(), ['update-ref', 'refs/heads/t/1-something', merged], home.env);
      const main = head('refs/heads/main');

      for (const branch of ['main', 't/12', 'notes/t/1']) {
        expect(
          await manager.branches.handle(deleteMessage({ branch, mergedHead: merged })),
        ).toEqual({ outcome: 'not_a_ticket_branch' });
      }
      expect(
        await manager.branches.handle(
          deleteMessage({ ticket: 'NOTES-12', branch: 't/1', mergedHead: merged }),
        ),
      ).toEqual({ outcome: 'not_a_ticket_branch' });

      expect(
        await manager.branches.handle(deleteMessage({ branch: 't/1', mergedHead: merged })),
      ).toEqual({ outcome: 'deleted' });
      expect(head('refs/heads/t/1')).toBeNull();
      expect(head('refs/heads/t/12')).toBe(merged);
      expect(head('refs/heads/t/1-something')).toBe(merged);
      expect(head('refs/heads/main')).toBe(main);
    },
    TIMEOUT,
  );

  it(
    'answers not found without a bare clone of the repository or without the branch',
    async () => {
      const manager = daemon();
      expect(
        await manager.branches.handle(
          deleteMessage({ repository: { owner: 'owner', name: 'other' } }),
        ),
      ).toEqual({ outcome: 'not_found', what: 'repository' });
      await workedOn(manager);
      expect(await manager.branches.handle(deleteMessage({ branch: 't/1-other' }))).toEqual({
        outcome: 'not_found',
        what: 'branch',
      });
    },
    TIMEOUT,
  );
});
