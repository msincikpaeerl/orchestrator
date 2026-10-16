import { describe, expect, it } from 'vitest';
import type { GitHubResult } from '../src/github/answers.js';
import { listCommitRuns, listRunJobs, readCommitStatus } from '../src/github/ci.js';
import type { GitHubClient } from '../src/github/client.js';
import { compareCommits } from '../src/github/compare.js';
import {
  closePullRequest,
  findPullRequests,
  listOpenPullRequestsUsing,
  openPullRequest,
  postReview,
  readBranchRef,
  readPullRequest,
  reopenPullRequest,
  updatePullRequest,
} from '../src/github/pull-requests.js';
import {
  applyBranchProtection,
  applySkeleton,
  createRepository,
  findMissingHarness,
  findRepository,
  holdsOnlyInitialCommit,
  listOwnerRepositories,
} from '../src/github/repositories.js';
import { inspectToken } from '../src/github/token-check.js';
import {
  branchHead,
  mergeMethod,
  readCommit,
  readMergeSettings,
  updatePullRequestBranch,
} from '../scripts/github-smoke-reads.js';
import { documentedOperation, plainestBody } from './fake-github/documented.js';

// Every reading of the GitHub layer against GitHub's documented answers (lot 3, after the owner's
// first smoke run): the bodies come from GitHub's OpenAPI description (ADR 0035), with every
// absence it allows, not from the fake. `nulls`: only the required fields, each nullable one null,
// one item in each list. `inner`: nullable objects and lists filled, optional fields present,
// nullable plain values null. The layer reads only the fields it uses: each must accept both.

const REPO = { owner: 'octo-owner', name: 'shop' };

/**
 * Where the layer checks more than GitHub's description says, on purpose. The plainest body has
 * a placeholder string there; these give a value GitHub's documentation names.
 */
const DELIBERATE: Record<string, (body: Record<string, unknown>) => void> = {
  // Typed `string` in lists ("pull-request-simple"), while the same pull request read alone
  // documents the values `open` and `closed`: the Orchestrator reads both forms the same way.
  'GET /repos/{owner}/{repo}/pulls': (body) => {
    for (const pull of body as unknown as Record<string, unknown>[]) pull.state = 'open';
  },
  // Typed `string` in the description, whose text lists the values: "Can be one of error,
  // failure, pending, or success" (and failure, pending or success combined). The Orchestrator
  // decides CI from them (step G1): a new value must be reported unreadable, never guessed.
  'GET /repos/{owner}/{repo}/commits/{ref}/status': (body) => {
    body.state = 'pending';
    for (const status of body.statuses as Record<string, unknown>[]) status.state = 'pending';
  },
};

type Filling = 'nulls' | 'inner';

/** A client answering each request with the documented plainest body; records unreadable ones. */
function documentedClient(
  filling: Filling,
): GitHubClient & { unreadable: GitHubClient['unreadable'] } {
  const unreadable: string[] = [];
  return {
    request(request) {
      const path = new URL(request.path, 'http://github.test').pathname;
      for (const status of [200, 201, 202]) {
        const operation = documentedOperation(request.method, path, status);
        if (operation === undefined) continue;
        const body = plainestBody(operation, status, filling);
        DELIBERATE[operation]?.(body as Record<string, unknown>);
        return Promise.resolve({ status, headers: new Headers(), body, request });
      }
      throw new Error(`no documented answer for ${request.method} ${path}`);
    },
    download() {
      throw new Error('not used');
    },
    unreadable(request, status, fields) {
      unreadable.push(`${request.method} ${request.path}: ${fields.join('; ')}`);
      throw new Error(unreadable.join('\n'));
    },
  };
}

function read<T>(result: GitHubResult<T>): T {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result.value;
}

describe.each<Filling>(['nulls', 'inner'])(
  "the GitHub layer reads GitHub's documented answers (%s)",
  (filling) => {
    it('pull requests and reviews', async () => {
      const client = documentedClient(filling);
      const opened = read(
        await openPullRequest(client, REPO, { head: 'h', base: 'main', title: 't', body: 'b' }),
      );
      expect(opened.mergeable).toBeNull();
      expect(opened.mergedAt).toBeNull();
      const pull = read(await readPullRequest(client, REPO, 1));
      // The head and base repositories the clean-up after a merge checks (lot 3 step J2a).
      expect(pull.headRepository).toBe('documented');
      expect(pull.defaultBranch).toBe('documented');
      read(await updatePullRequest(client, REPO, 1, { title: 'u' }));
      read(await closePullRequest(client, REPO, 1));
      read(await reopenPullRequest(client, REPO, 1));
      expect(read(await findPullRequests(client, REPO, 'h'))).toHaveLength(1);
      expect(read(await listOpenPullRequestsUsing(client, REPO, 'head', 'h'))).toHaveLength(1);
      expect(read(await listOpenPullRequestsUsing(client, REPO, 'base', 'h'))).toHaveLength(1);
      expect(read(await readBranchRef(client, REPO, 'h'))).toEqual({
        ref: 'documented',
        sha: 'documented',
      });
      read(await postReview(client, REPO, 1, { event: 'COMMENT', body: 'c' }));
      // The moved head's comparison (lot 3 step J3b).
      const comparison = read(await compareCommits(client, REPO, 'abc', 'def'));
      expect(comparison.status).toBe('diverged');
      expect(comparison.commits).toEqual([{ sha: 'documented', title: 'documented' }]);
    });

    it('Actions runs, jobs and commit statuses', async () => {
      const client = documentedClient(filling);
      const [run] = read(await listCommitRuns(client, REPO, 'abc'));
      expect(run?.name).toBe('');
      expect(run?.status).toBe('');
      expect(run?.conclusion).toBeNull();
      expect(run?.pullRequests).toEqual(filling === 'nulls' ? [] : [1]);
      const [job] = read(await listRunJobs(client, REPO, 1));
      expect(job?.url).toBeNull();
      expect(job?.steps).toEqual(
        filling === 'nulls' ? [] : [expect.objectContaining({ conclusion: null })],
      );
      expect(read(await readCommitStatus(client, REPO, 'abc')).statuses).toEqual([
        { context: 'documented', state: 'pending', description: null, targetUrl: null },
      ]);
    });

    it("the smoke script's own reads: a branch's head, a commit, Update branch, merge settings", async () => {
      const client = documentedClient(filling);
      expect(read(await branchHead(client, REPO, 'main'))).toBe('documented');
      const commit = read(await readCommit(client, REPO, 'abc'));
      expect(commit.parents).toHaveLength(1);
      read(await updatePullRequestBranch(client, REPO, 1, 'abc'));
      // The merge settings read before step 11 (lot 3 step J4c): optional, absent read as null.
      const settings = read(await readMergeSettings(client, REPO));
      if (filling === 'nulls') expect(settings).toEqual({ squash: null, rebase: null });
      else expect([typeof settings.squash, typeof settings.rebase]).toEqual(['boolean', 'boolean']);
    });

    it('the token, repositories, branches, commits, trees and rulesets', async () => {
      const client = documentedClient(filling);
      expect(await inspectToken(client)).toMatchObject({ valid: true, account: 'documented' });
      const [listed] = await listOwnerRepositories(client);
      expect(listed?.createdAt).toBeNull();
      await findRepository(client, REPO);
      await createRepository(client, { name: 'n', description: 'd', private: true });
      const branch = { ...REPO, defaultBranch: 'main' };
      await holdsOnlyInitialCommit(client, branch);
      await findMissingHarness(client, branch);
      await applySkeleton(client, branch, [{ path: 'README.md', content: '# n\n' }]);
      expect(await applyBranchProtection(client, REPO)).toEqual({ status: 'applied' });
    });
  },
);

describe('the merge method the smoke script prints (step 8, A21)', () => {
  it('reads two parents as a merge commit, one new commit on the old head as a squash, else a rebase', () => {
    const message = 'Orchestrator smoke test';
    expect(mergeMethod({ message, parents: ['base', 'head'] }, 'base')).toBe('merge');
    expect(mergeMethod({ message, parents: ['base'] }, 'base')).toBe('squash');
    expect(mergeMethod({ message, parents: ['replayed'] }, 'base')).toBe('rebase');
  });
});
