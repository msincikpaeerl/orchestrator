import { z } from 'zod';
import { ask, type GitHubResult } from '../src/github/answers.js';
import type { GitHubClient } from '../src/github/client.js';
import { readBranchRef } from '../src/github/pull-requests.js';
import { repoPath, type RepositoryRef } from '../src/github/repositories.js';

// GitHub reads only the owner's smoke script makes (tools/smoke/github-smoke.sh, lot 3 step E3),
// kept out of the GitHub layer because no product code uses them (working rule 5). Each is read
// as GitHub documents it and checked against the documented bodies in
// test/github-documented.test.ts (ADR 0035), like the layer's.

/**
 * The branch's head on GitHub; null when the branch does not exist (404). The layer's read
 * (`readBranchRef`), which the clean-up after a merge uses since lot 3 step J2a.
 */
export async function branchHead(
  client: GitHubClient,
  repo: RepositoryRef,
  branch: string,
): Promise<GitHubResult<string | null>> {
  const read = await readBranchRef(client, repo, branch);
  return read.ok ? { ok: true, value: read.value?.sha ?? null } : read;
}

/** "git-commit": its message and its parents. */
const Commit = z.object({
  message: z.string(),
  parents: z.array(z.object({ sha: z.string() })),
});

export interface CommitShape {
  message: string;
  parents: string[];
}

/** A commit's message and parents ("Get a commit object", https://docs.github.com/en/rest/git/commits). */
export async function readCommit(
  client: GitHubClient,
  repo: RepositoryRef,
  sha: string,
): Promise<GitHubResult<CommitShape>> {
  const read = await ask(
    client,
    { method: 'GET', path: `${repoPath(repo)}/git/commits/${sha}` },
    200,
    Commit,
  );
  return read.ok
    ? {
        ok: true,
        value: {
          message: read.value.message,
          parents: read.value.parents.map((parent) => parent.sha),
        },
      }
    : read;
}

/**
 * The merge method the default branch's new head shows: two parents is a merge commit; one parent
 * that is the default branch's head before the merge is a squash (one new commit); anything else
 * a rebase (the pull request's commits replayed, the script's being several). Printed only: no
 * product code reads it (the owner's decision, step E3; step J detects a merge by `merged`,
 * whatever the method).
 */
export function mergeMethod(
  commit: CommitShape,
  baseBefore: string,
): 'merge' | 'squash' | 'rebase' {
  if (commit.parents.length >= 2) return 'merge';
  return commit.parents[0] === baseBefore ? 'squash' : 'rebase';
}

/** "Update a pull request branch": 202 with a message (all its fields optional). */
const UpdateAccepted = z.object({ message: z.string().optional() });

/**
 * **Update branch** through the API ("Update a pull request branch", `PUT .../update-branch`,
 * https://docs.github.com/en/rest/pulls/pulls): 202 when GitHub accepts it, else its refusal
 * (A18: a pull request with a conflict).
 */
export async function updatePullRequestBranch(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
  expectedHead: string,
): Promise<GitHubResult<string>> {
  const updated = await ask(
    client,
    {
      method: 'PUT',
      path: `${repoPath(repo)}/pulls/${String(number)}/update-branch`,
      body: { expected_head_sha: expectedHead },
    },
    202,
    UpdateAccepted,
  );
  return updated.ok ? { ok: true, value: updated.value.message ?? '' } : updated;
}

/**
 * "full-repository": whether squash and rebase merging are allowed (Settings > General > Pull
 * Requests). Both optional in GitHub's description; absent (GitHub did not show them to this
 * token) reads as null.
 */
const MergeSettings = z.object({
  allow_squash_merge: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
});

export interface MergeSettings {
  squash: boolean | null;
  rebase: boolean | null;
}

/**
 * The repository's merge settings ("Get a repository", https://docs.github.com/en/rest/repos/repos),
 * read before step 11 (lot 3 step J4c), whose merges by squash and by rebase need them on.
 */
export async function readMergeSettings(
  client: GitHubClient,
  repo: RepositoryRef,
): Promise<GitHubResult<MergeSettings>> {
  const read = await ask(client, { method: 'GET', path: repoPath(repo) }, 200, MergeSettings);
  return read.ok
    ? {
        ok: true,
        value: {
          squash: read.value.allow_squash_merge ?? null,
          rebase: read.value.allow_rebase_merge ?? null,
        },
      }
    : read;
}
