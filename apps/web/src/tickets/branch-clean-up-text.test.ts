import { BranchKeptReason } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { keptReasonText } from './branch-clean-up-text';

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
