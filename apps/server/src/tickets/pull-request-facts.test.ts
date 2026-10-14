import { MOVED_HEAD_TITLE_MAX_CHARS } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import type { PullRequest } from '../github/pull-requests.js';
import {
  comparisonResult,
  conflictAfter,
  conflictRequestText,
  currentConflict,
  plainTitle,
} from './pull-request-facts.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const NOW = new Date('2026-10-14T10:00:00.000Z');
const LATER = new Date('2026-10-14T10:05:00.000Z');

function read(headSha: string, mergeable: boolean | null): PullRequest {
  return {
    number: 12,
    url: 'https://github.com/o/r/pull/12',
    state: 'open',
    title: 't',
    body: null,
    headBranch: 't/12-x',
    headSha,
    baseBranch: 'main',
    mergedAt: null,
    closedAt: null,
    merged: false,
    mergeable,
    mergeableState: 'unknown',
    headRepository: 'o/r',
    defaultBranch: 'main',
  };
}

describe("GitHub's conflict fact", () => {
  it('is set by mergeable false, kept with its first time, and cleared by true', () => {
    const set = conflictAfter({ pullRequestConflict: null }, read(A, false), NOW);
    expect(set).toEqual({ head: A, base: 'main', since: NOW.toISOString() });
    expect(conflictAfter({ pullRequestConflict: set }, read(A, false), LATER)).toEqual(set);
    expect(conflictAfter({ pullRequestConflict: set }, read(A, true), LATER)).toBeNull();
  });

  it('is kept while GitHub computes it, and by a list read, for the same head only', () => {
    const set = { head: A, base: 'main', since: NOW.toISOString() };
    expect(conflictAfter({ pullRequestConflict: set }, read(A, null), LATER)).toEqual(set);
    const full = read(A, null);
    const listed = {
      number: full.number,
      url: full.url,
      state: full.state,
      title: full.title,
      body: full.body,
      headBranch: full.headBranch,
      headSha: full.headSha,
      baseBranch: full.baseBranch,
      mergedAt: full.mergedAt,
      closedAt: full.closedAt,
    };
    expect(conflictAfter({ pullRequestConflict: set }, listed, LATER)).toEqual(set);
    // Another head: the fact was about another commit.
    expect(conflictAfter({ pullRequestConflict: set }, read(B, null), LATER)).toBeNull();
    expect(conflictAfter({ pullRequestConflict: set }, read(B, false), LATER)).toEqual({
      head: B,
      base: 'main',
      since: LATER.toISOString(),
    });
  });

  it("counts only for the stored head, and fills in Request changes' text", () => {
    const fact = { head: A, base: 'main', since: NOW.toISOString() };
    expect(currentConflict({ pullRequestConflict: fact, pullRequestHead: A })).toEqual(fact);
    expect(currentConflict({ pullRequestConflict: fact, pullRequestHead: B })).toBeNull();
    expect(conflictRequestText(12, 'main')).toBe(
      'Pull request #12 conflicts with main. Merge main into the branch with `git merge origin/main`, resolve the conflicts keeping the approved work, then hand it in again.',
    );
  });
});

describe('the moved head comparison', () => {
  const commits = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ sha: A, title: `Commit ${String(index + 1)}` }));

  it('lists the newest 5 titles, newest first, then how many more of every commit', () => {
    expect(
      comparisonResult({
        ok: true,
        value: { status: 'ahead', totalCommits: 300, commits: commits(250) },
      }),
    ).toEqual({
      kind: 'ahead',
      titles: ['Commit 250', 'Commit 249', 'Commit 248', 'Commit 247', 'Commit 246'],
      more: 295,
    });
    expect(
      comparisonResult({
        ok: true,
        value: { status: 'ahead', totalCommits: 2, commits: commits(2) },
      }),
    ).toEqual({ kind: 'ahead', titles: ['Commit 2', 'Commit 1'], more: 0 });
  });

  it('says not part for any other status, and failed for a refusal', () => {
    for (const status of ['diverged', 'behind', 'identical'] as const) {
      expect(
        comparisonResult({ ok: true, value: { status, totalCommits: 1, commits: commits(1) } }),
      ).toEqual({ kind: 'not_part', status });
    }
    expect(
      comparisonResult({
        ok: false,
        refusal: { kind: 'not_found', status: 404, message: 'Not Found' },
      }),
    ).toEqual({ kind: 'failed', reason: 'refused', message: 'Not Found' });
  });

  it('keeps a title as plain text: one line, no control character, masked, cut', () => {
    expect(plainTitle('Fix\tthe\u001b[31m form ')).toBe('Fix the [31m form');
    expect(plainTitle(`Token ghp_${'a'.repeat(36)}`)).not.toContain('ghp_aaaa');
    // An accented letter written as two code points is one character, never split.
    const cut = plainTitle('e\u0301'.repeat(100));
    expect(cut.length).toBe(2 * (MOVED_HEAD_TITLE_MAX_CHARS - 1) + 1);
    expect(cut.endsWith('…')).toBe(true);
    expect(plainTitle('x'.repeat(MOVED_HEAD_TITLE_MAX_CHARS))).toHaveLength(
      MOVED_HEAD_TITLE_MAX_CHARS,
    );
  });
});
