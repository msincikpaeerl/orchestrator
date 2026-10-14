import { z } from 'zod';
import { ask, type GitHubResult } from './answers.js';
import type { GitHubClient } from './client.js';
import { repoPath, type RepositoryRef } from './repositories.js';

// The comparison of two commits (lot 3 step J3b, owner's answer 3 of step J): what a pull
// request's head holds after the commit Quality approved. Source (REST API 2026-03-10): "Compare
// two commits", `GET /repos/{owner}/{repo}/compare/{basehead}` ("REST API endpoints for commits",
// https://docs.github.com/en/rest/commits/commits): "equivalent to running the git log BASE..HEAD
// command", commits "in chronological order"; without `page` or `per_page` "the returned list is
// limited to 250 commits" and its last commit "is the most recent"; `status` is one of
// `diverged`, `ahead`, `behind`, `identical`. Contents (Read) ("Permissions required for
// fine-grained personal access tokens"). Only the fields used are read (checked against GitHub's
// OpenAPI description in test/github-documented.test.ts); A38 checks a head moved by **Update
// branch** on the real GitHub.

const Comparison = z.object({
  status: z.enum(['diverged', 'ahead', 'behind', 'identical']),
  total_commits: z.int().min(0),
  commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }) })),
});

export interface CommitComparison {
  status: 'diverged' | 'ahead' | 'behind' | 'identical';
  /** Every commit of `base..head`, even past the ones listed. */
  totalCommits: number;
  /** At most 250, oldest first: each commit's hash and its message's first line. */
  commits: { sha: string; title: string }[];
}

/** One comparison of `base...head`, never paged: one request. */
export async function compareCommits(
  client: GitHubClient,
  repo: RepositoryRef,
  base: string,
  head: string,
): Promise<GitHubResult<CommitComparison>> {
  const read = await ask(
    client,
    {
      method: 'GET',
      path: `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    },
    200,
    Comparison,
  );
  if (!read.ok) return read;
  return {
    ok: true,
    value: {
      status: read.value.status,
      totalCommits: read.value.total_commits,
      commits: read.value.commits.map((each) => ({
        sha: each.sha,
        title: each.commit.message.split('\n')[0] ?? '',
      })),
    },
  };
}
