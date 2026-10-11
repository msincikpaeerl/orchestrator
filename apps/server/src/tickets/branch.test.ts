import { describe, expect, it } from 'vitest';
import { commitsNotOnGitHub, type ReportedBranch } from './branch.js';

// Where a ticket branch's commits are (07, section 3; lot 3 step D3), and the one exception the
// pull request's head read on GitHub makes (owner's answer 3, lot 3 step J1).

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** A machine's report: B on A, neither on a branch it fetched from GitHub. */
const report: ReportedBranch = {
  head: B,
  commits: [
    { hash: B, subject: 'Second' },
    { hash: A, subject: 'First' },
  ],
  notOnGitHub: { listed: [B, A], count: 2 },
};

describe('the commits not on GitHub', () => {
  it('are those no push the server saw held', () => {
    expect(
      commitsNotOnGitHub({ githubBranchCommits: [A], pullRequestHead: null }, report).count,
    ).toBe(1);
  });

  it("are none when the pull request's head on GitHub is exactly the report's head", () => {
    // The push the daemon made but could not report (D3's "not seen by the server").
    expect(commitsNotOnGitHub({ githubBranchCommits: null, pullRequestHead: B }, report)).toEqual({
      commits: [],
      count: 0,
    });
  });

  it("are counted as before when the pull request's head is another commit", () => {
    // An older head (A), or a head GitHub moved (C): the server has no ancestry to tell.
    for (const head of [A, C]) {
      expect(
        commitsNotOnGitHub({ githubBranchCommits: null, pullRequestHead: head }, report).count,
      ).toBe(2);
    }
  });

  it('never use the exception for a report without a head', () => {
    expect(
      commitsNotOnGitHub(
        { githubBranchCommits: null, pullRequestHead: B },
        { ...report, head: null },
      ).count,
    ).toBe(2);
  });
});
