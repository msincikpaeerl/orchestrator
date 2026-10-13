import { BranchKeptReason } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import type { MachineBranchCleanUp, TicketBranchCleanUp } from '@orchestrator/protocol';
import { formatDateTime } from '../github/text';
import {
  gitHubCleanUpLines,
  keptReasonText,
  machineCleanUpLine,
  machineWaitText,
} from './branch-clean-up-text';

const context = {
  ticket: 'WEB-12',
  pullRequest: 4,
  mergedHead: 'def5678def5678def5678def5678def5678def56',
};

/** One reason of each kind, with the owner's words for it. */
const examples: [BranchKeptReason, string][] = [
  [{ kind: 'ticket_reopened' }, 'WEB-12 was reopened'],
  [{ kind: 'another_pull_request', number: 14 }, 'WEB-12 has another pull request now (#14)'],
  [
    { kind: 'another_pull_request', number: null },
    "WEB-12's merge is no longer recorded as it was",
  ],
  [
    { kind: 'not_merged_into_default', merged: true, base: 'release' },
    "pull request #4 was merged into release on GitHub, not into the project's default branch",
  ],
  [
    { kind: 'not_merged_into_default', merged: false, base: 'main' },
    'GitHub no longer says pull request #4 is merged',
  ],
  [
    { kind: 'head_branch_differs', headBranch: 't/13-map' },
    "pull request #4's branch on GitHub is t/13-map, not this one",
  ],
  [
    { kind: 'fork', headRepository: 'someone/bakery' },
    'pull request #4 comes from another repository (someone/bakery)',
  ],
  [
    { kind: 'fork', headRepository: null },
    'pull request #4 comes from a repository that no longer exists',
  ],
  [
    { kind: 'default_branch_changed', github: 'trunk', stored: 'main' },
    "the repository's default branch on GitHub is now trunk, not main",
  ],
  [{ kind: 'protected_name', which: 'default_branch' }, "it is the project's default branch"],
  [{ kind: 'protected_name', which: 'base' }, 'it is the base branch of pull request #4'],
  [{ kind: 'not_a_ticket_branch' }, "its name is not WEB-12's branch name"],
  [{ kind: 'used_as_head', pullRequest: 5 }, 'open pull request #5 uses it'],
  [{ kind: 'used_as_base', pullRequest: 6 }, 'open pull request #6 is based on it'],
  [
    { kind: 'moved', head: 'abc1234abc1234abc1234abc1234abc1234abc12' },
    'its head on GitHub is abc1234, not the merged head def5678: commits were pushed after the merge',
  ],
  [
    { kind: 'ref_differs', ref: 'refs/heads/t/12-contact-form-2' },
    'GitHub answered for refs/heads/t/12-contact-form-2 instead of this branch',
  ],
  [
    { kind: 'read_failed', what: 'open_pull_requests', message: 'Not Found.' },
    'reading the open pull requests on GitHub failed: Not Found',
  ],
  [
    { kind: 'refused', message: 'Cannot delete this protected branch.' },
    'GitHub refused to delete it: Cannot delete this protected branch',
  ],
  [
    { kind: 'local_head_differs', head: 'abc1234abc1234abc1234abc1234abc1234abc12' },
    'its head abc1234 is not the merged head def5678; it may hold work that was not merged',
  ],
  [{ kind: 'bare_head' }, "it is the current branch of the machine's copy of the repository"],
  [{ kind: 'machine_revoked' }, 'the machine was revoked'],
];

describe('why a branch was kept on GitHub', () => {
  it.each(examples)('%j', (reason, words) => {
    expect(keptReasonText(BranchKeptReason.parse(reason), context)).toBe(words);
  });

  it('has words for every kind', () => {
    const kinds = BranchKeptReason.options.map((option) => option.shape.kind.value);
    expect(new Set(examples.map(([reason]) => reason.kind))).toEqual(new Set(kinds));
  });
});

describe("what a machine's clean-up waits for", () => {
  it.each([
    ['runs_ending', null, 'a run stopped by the merge has not reported its end yet'],
    ['offline', '16:02', 'the machine is offline since 16:02; it is asked when it reconnects'],
    ['offline', null, 'the machine is offline; it is asked when it reconnects'],
    [
      'daemon_outdated',
      null,
      "the machine's daemon is too old to be asked; it is asked once the daemon is updated",
    ],
    ['next_check', null, 'it is asked at the next check'],
    [
      'busy',
      null,
      'a run of the same repository was working on the machine; it is asked again at the next check',
    ],
    ['answer', null, 'the machine was asked and has not answered yet'],
  ] as const)('%s', (wait, since, words) => {
    expect(machineWaitText(wait, since)).toBe(words);
  });
});

it('says which run keeps a busy machine from deleting the branch', () => {
  expect(machineWaitText('busy', null, 'worktree')).toBe(
    'a run waiting for an answer or paused has it checked out; it is asked again at the next check',
  );
  expect(machineWaitText('busy', null, 'run')).toBe(
    'a run of the same repository was working on the machine; it is asked again at the next check',
  );
});

const at = '2026-10-13T16:03:00.000Z';
const since = '2026-10-13T16:02:00.000Z';
const laptop = { id: '7f1b5d6e-8c2a-4f3b-9d1e-0a1b2c3d4e5f', name: 'laptop' };
const desk = { id: '8f1b5d6e-8c2a-4f3b-9d1e-0a1b2c3d4e5f', name: 'desk' };
const runId = '9f1b5d6e-8c2a-4f3b-9d1e-0a1b2c3d4e5f';

function cleanUp(changes: Partial<TicketBranchCleanUp> = {}): TicketBranchCleanUp {
  return {
    branch: 't/12-add-faq',
    pullRequest: 4,
    mergedHead: context.mergedHead,
    state: 'deleted',
    decidedAt: at,
    reason: null,
    waitingFor: [],
    failure: null,
    pushedAgain: null,
    machines: [],
    ...changes,
  };
}

function machineRow(changes: Partial<MachineBranchCleanUp> = {}): MachineBranchCleanUp {
  return {
    machine: laptop,
    state: 'deleted',
    decidedAt: at,
    reason: null,
    waiting: null,
    offlineSince: null,
    sentAt: null,
    busy: null,
    ...changes,
  };
}

const texts = (value: TicketBranchCleanUp) =>
  gitHubCleanUpLines(value, 'WEB-12').map((line) => line.text);

describe('the clean-up on GitHub on the ticket page', () => {
  it('says the branch was deleted, or already gone, with the real name and time', () => {
    expect(texts(cleanUp())).toEqual([
      `Branch t/12-add-faq deleted on GitHub at ${formatDateTime(at)}.`,
    ]);
    expect(texts(cleanUp({ state: 'already_gone' }))).toEqual([
      `Branch t/12-add-faq was already gone from GitHub when the Orchestrator checked at ${formatDateTime(at)}: nothing to delete.`,
    ]);
  });

  it('says why it was kept', () => {
    expect(
      gitHubCleanUpLines(
        cleanUp({ state: 'kept', reason: { kind: 'used_as_base', pullRequest: 6 } }),
        'WEB-12',
      ),
    ).toEqual([
      {
        text: 'Branch t/12-add-faq kept on GitHub: open pull request #6 is based on it.',
        tone: 'kept',
      },
    ]);
  });

  it("waits for the stopped run's end, naming the machine and since when it is offline", () => {
    expect(
      texts(
        cleanUp({
          state: 'wanted',
          decidedAt: null,
          waitingFor: [{ runId, machine: laptop, offlineSince: since }],
        }),
      ),
    ).toEqual([
      `Branch t/12-add-faq kept on GitHub for now: the run on laptop was stopped by the merge and laptop has not reported its end yet (offline since ${formatDateTime(since)}). The branch is deleted once laptop reports its end, or if you revoke laptop.`,
    ]);
  });

  it('waits for several machines', () => {
    expect(
      texts(
        cleanUp({
          state: 'wanted',
          decidedAt: null,
          waitingFor: [
            { runId, machine: laptop, offlineSince: null },
            { runId: laptop.id, machine: laptop, offlineSince: null },
            { runId: desk.id, machine: desk, offlineSince: null },
          ],
        }),
      ),
    ).toEqual([
      'Branch t/12-add-faq kept on GitHub for now: the runs on laptop were stopped by the merge and laptop has not reported their end yet; the run on desk was stopped by the merge and desk has not reported its end yet. The branch is deleted once laptop and desk report their end, or if you revoke the machine.',
    ]);
  });

  it('says the next check deletes it, or why the latest try could not end', () => {
    expect(texts(cleanUp({ state: 'wanted', decidedAt: null }))).toEqual([
      'Branch t/12-add-faq is deleted on GitHub at the next check.',
    ]);
    expect(
      texts(
        cleanUp({
          state: 'wanted',
          decidedAt: null,
          failure: {
            reason: 'permission_missing',
            message: 'Contents (Read and write).',
            at: since,
          },
        }),
      ),
    ).toEqual([
      `Branch t/12-add-faq not deleted on GitHub yet: at ${formatDateTime(since)}, the token is missing a permission: Contents (Read and write). The Orchestrator tries again at the next check.`,
    ]);
  });

  it('adds a push recorded after the deletion', () => {
    expect(
      texts(
        cleanUp({
          pushedAgain: {
            machine: 'laptop',
            head: 'abc1234abc1234abc1234abc1234abc1234abc12',
            at: since,
          },
        }),
      ),
    ).toEqual([
      `Branch t/12-add-faq deleted on GitHub at ${formatDateTime(at)}.`,
      `Branch t/12-add-faq is on GitHub again since ${formatDateTime(since)}: laptop pushed abc1234 after the deletion, a commit that was not merged. It is kept; delete it on GitHub if you do not need it.`,
    ]);
  });
});

describe('the clean-up on a machine on the ticket page', () => {
  const line = (row: MachineBranchCleanUp) => machineCleanUpLine(row, cleanUp(), 'WEB-12');

  it('says deleted, already gone and kept', () => {
    expect(line(machineRow())).toEqual({
      text: `Branch t/12-add-faq deleted on machine laptop at ${formatDateTime(at)}.`,
      tone: 'done',
    });
    expect(line(machineRow({ state: 'already_gone' })).text).toBe(
      `Branch t/12-add-faq was already gone from machine laptop at ${formatDateTime(at)}: nothing to delete.`,
    );
    expect(
      line(
        machineRow({
          state: 'kept',
          reason: { kind: 'local_head_differs', head: 'abc1234abc1234abc1234abc1234abc1234abc12' },
        }),
      ),
    ).toEqual({
      text: 'Branch t/12-add-faq kept on machine laptop: its head abc1234 is not the merged head def5678; it may hold work that was not merged.',
      tone: 'kept',
    });
  });

  it('says what it waits for', () => {
    expect(
      line(
        machineRow({ state: 'wanted', decidedAt: null, waiting: 'offline', offlineSince: since }),
      ),
    ).toEqual({
      text: `Branch t/12-add-faq not deleted on machine laptop yet: the machine is offline since ${formatDateTime(since)}; it is asked when it reconnects.`,
      tone: 'waiting',
    });
    expect(
      line(machineRow({ state: 'wanted', decidedAt: null, waiting: 'busy', busy: 'worktree' }))
        .text,
    ).toBe(
      'Branch t/12-add-faq not deleted on machine laptop yet: a run waiting for an answer or paused has it checked out; it is asked again at the next check.',
    );
  });
});
