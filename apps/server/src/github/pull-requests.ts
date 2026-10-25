import { z } from 'zod';
import { ask, refused, refusalOf, type GitHubResult } from './answers.js';
import type { GitHubClient } from './client.js';
import { branchPath, repoPath, type RepositoryRef } from './repositories.js';

// Pull requests and comment reviews (04 section 3.1, 06 section 4.2; lot 3 step E1). Sources
// (REST API 2026-03-10): "REST API endpoints for pull requests"
// (https://docs.github.com/en/rest/pulls/pulls) and "REST API endpoints for pull request reviews"
// (https://docs.github.com/en/rest/pulls/reviews). What the documentation does not say is in the
// lot 3 plan's assumptions (A5 to A11, A18 to A21), checked by the owner's smoke script.
//
// Every function takes the stored-token client (`storedTokenClient`), so a missing permission
// or a rejected token reaches "Needs you", and returns GitHub's refusal for the caller to read.

const Branch = z.object({ ref: z.string(), sha: z.string() });

// Only the fields the Orchestrator uses are read, every other one is ignored; each is read as
// GitHub documents it, nullable or optional included (checked against GitHub's OpenAPI
// description in test/github-documented.test.ts). `merge_commit_sha` is not read: version
// 2026-03-10 removed it from pull requests ("Breaking changes",
// https://docs.github.com/en/rest/about-the-rest-api/breaking-changes).

/** "pull-request-simple", as lists return it: no `merged` or `mergeable`. */
const PullRequestSimple = z.object({
  number: z.int().positive(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  title: z.string(),
  body: z.string().nullable(),
  head: Branch,
  base: Branch,
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
});

/**
 * A pull request's head or base repository: its full name and default branch. A head repository
 * reads as null (a fork deleted since, which GitHub's description does not show): never the
 * project's.
 */
const Repository = z.object({ full_name: z.string(), default_branch: z.string() });

/** "pull-request", as get, create and update return it. */
const PullRequestFull = PullRequestSimple.extend({
  head: Branch.extend({ repo: Repository.nullable() }),
  base: Branch.extend({ repo: Repository }),
  merged: z.boolean(),
  // Null while GitHub computes it: read again later (A5).
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
});

export interface PullRequestSummary {
  number: number;
  /** The pull request's page on GitHub. */
  url: string;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  headBranch: string;
  headSha: string;
  baseBranch: string;
  /** When it was merged; null when it was not (open, or closed without merging). */
  mergedAt: string | null;
  /** When it was closed or merged; null while it is open (lot 3 step J3a). */
  closedAt: string | null;
}

export interface PullRequest extends PullRequestSummary {
  merged: boolean;
  /** Null while GitHub computes it after a change of the head or the base. */
  mergeable: boolean | null;
  /** For example `clean`, `dirty` or `unknown`: printed only, `mergeable` is what is used (A10). */
  mergeableState: string;
  /** The head repository, `owner/name`; null when GitHub gives none (a fork deleted since). */
  headRepository: string | null;
  /** The base repository's default branch, as GitHub has it now. */
  defaultBranch: string;
}

function summary(body: z.infer<typeof PullRequestSimple>): PullRequestSummary {
  return {
    number: body.number,
    url: body.html_url,
    state: body.state,
    title: body.title,
    body: body.body,
    headBranch: body.head.ref,
    headSha: body.head.sha,
    baseBranch: body.base.ref,
    mergedAt: body.merged_at,
    closedAt: body.closed_at,
  };
}

function full(body: z.infer<typeof PullRequestFull>): PullRequest {
  return {
    ...summary(body),
    merged: body.merged,
    mergeable: body.mergeable,
    mergeableState: body.mergeable_state,
    headRepository: body.head.repo?.full_name ?? null,
    defaultBranch: body.base.repo.default_branch,
  };
}

function mapped<T, U>(result: GitHubResult<T>, map: (value: T) => U): GitHubResult<U> {
  return result.ok ? { ok: true, value: map(result.value) } : result;
}

function pullPath(repo: RepositoryRef, number: number): string {
  return `${repoPath(repo)}/pulls/${String(number)}`;
}

/**
 * Opens a normal pull request (not a draft) from `head` into `base`. GitHub refuses a second
 * open one for the same branches with 422 "A pull request already exists for <owner>:<head>."
 * (A6).
 */
export async function openPullRequest(
  client: GitHubClient,
  repo: RepositoryRef,
  pull: { head: string; base: string; title: string; body: string },
): Promise<GitHubResult<PullRequest>> {
  const opened = await ask(
    client,
    { method: 'POST', path: `${repoPath(repo)}/pulls`, body: { ...pull, draft: false } },
    201,
    PullRequestFull,
  );
  return mapped(opened, full);
}

/** Reads one pull request, with `merged` and `mergeable`. */
export async function readPullRequest(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
): Promise<GitHubResult<PullRequest>> {
  const read = await ask(
    client,
    { method: 'GET', path: pullPath(repo, number) },
    200,
    PullRequestFull,
  );
  return mapped(read, full);
}

async function editPullRequest(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
  body: Record<string, string>,
): Promise<GitHubResult<PullRequest>> {
  const edited = await ask(
    client,
    { method: 'PATCH', path: pullPath(repo, number), body },
    200,
    PullRequestFull,
  );
  return mapped(edited, full);
}

/** Changes the title and the description. */
export function updatePullRequest(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
  change: { title?: string; body?: string },
): Promise<GitHubResult<PullRequest>> {
  return editPullRequest(client, repo, number, { ...change });
}

/** Closes without merging. */
export function closePullRequest(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
): Promise<GitHubResult<PullRequest>> {
  return editPullRequest(client, repo, number, { state: 'closed' });
}

/**
 * Reopens a pull request closed without merging while its branch exists; GitHub refuses a merged
 * one with 422 (A9).
 */
export function reopenPullRequest(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
): Promise<GitHubResult<PullRequest>> {
  return editPullRequest(client, repo, number, { state: 'open' });
}

const PAGE_SIZE = 100;

/**
 * The pull requests from `branch` of the repository's owner, newest first: open, closed or both
 * (`all` finds one closed without merging, A8).
 */
export async function findPullRequests(
  client: GitHubClient,
  repo: RepositoryRef,
  branch: string,
  state: 'open' | 'closed' | 'all' = 'all',
): Promise<GitHubResult<PullRequestSummary[]>> {
  const found: PullRequestSummary[] = [];
  const head = encodeURIComponent(`${repo.owner}:${branch}`);
  for (let page = 1; ; page++) {
    const batch = await ask(
      client,
      {
        method: 'GET',
        path: `${repoPath(repo)}/pulls?head=${head}&state=${state}&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      },
      200,
      z.array(PullRequestSimple),
    );
    if (!batch.ok) return batch;
    found.push(...batch.value.map(summary));
    if (batch.value.length < PAGE_SIZE) return { ok: true, value: found };
  }
}

/**
 * Every open pull request of the repository, every page read (lot 3 step J1, owner's answer 1):
 * merged and closed ones are left out (A32). A page that fails fails the whole list: a pull
 * request missing from a partial list must never read as gone.
 */
export async function listOpenPullRequests(
  client: GitHubClient,
  repo: RepositoryRef,
): Promise<GitHubResult<PullRequestSummary[]>> {
  const found: PullRequestSummary[] = [];
  for (let page = 1; ; page++) {
    const batch = await ask(
      client,
      {
        method: 'GET',
        path: `${repoPath(repo)}/pulls?state=open&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      },
      200,
      z.array(PullRequestSimple),
    );
    if (!batch.ok) return batch;
    found.push(...batch.value.map(summary));
    if (batch.value.length < PAGE_SIZE) return { ok: true, value: found };
  }
}

/**
 * The open pull requests whose head (`head`, as `owner:branch`) or base (`base`) is `branch`,
 * every page read (lot 3 step J2a). GitHub ignores a malformed `head` filter and returns every
 * open pull request: the caller checks each one's head and base itself.
 */
export async function listOpenPullRequestsUsing(
  client: GitHubClient,
  repo: RepositoryRef,
  side: 'head' | 'base',
  branch: string,
): Promise<GitHubResult<PullRequestSummary[]>> {
  const found: PullRequestSummary[] = [];
  const filter = encodeURIComponent(side === 'head' ? `${repo.owner}:${branch}` : branch);
  for (let page = 1; ; page++) {
    const batch = await ask(
      client,
      {
        method: 'GET',
        path: `${repoPath(repo)}/pulls?state=open&${side}=${filter}&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      },
      200,
      z.array(PullRequestSimple),
    );
    if (!batch.ok) return batch;
    found.push(...batch.value.map(summary));
    if (batch.value.length < PAGE_SIZE) return { ok: true, value: found };
  }
}

/** "git-ref": the reference GitHub answered for, and its head. */
const Reference = z.object({ ref: z.string(), object: z.object({ sha: z.string() }) });

/**
 * A branch's reference on GitHub ("Get a reference", singular `git/ref`, "REST API endpoints for
 * Git references", https://docs.github.com/en/rest/git/refs): the reference GitHub answered for
 * and its head; null when there is none (404). The caller checks `ref` is exactly the one asked
 * for (A37).
 */
export async function readBranchRef(
  client: GitHubClient,
  repo: RepositoryRef,
  branch: string,
): Promise<GitHubResult<{ ref: string; sha: string } | null>> {
  const read = await ask(
    client,
    { method: 'GET', path: `${repoPath(repo)}/git/ref/heads/${branchPath(branch)}` },
    200,
    Reference,
  );
  if (read.ok) return { ok: true, value: { ref: read.value.ref, sha: read.value.object.sha } };
  if (read.refusal.kind === 'not_found') return { ok: true, value: null };
  return read;
}

/** "Check if a pull request has been merged": 204 merged, 404 not merged (A20). */
export async function isPullRequestMerged(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
): Promise<GitHubResult<boolean>> {
  const response = await client.request({
    method: 'GET',
    path: `${pullPath(repo, number)}/merge`,
  });
  if (response.status === 204) return { ok: true, value: true };
  if (response.status === 404) return { ok: true, value: false };
  return refused(refusalOf(response));
}

const Review = z.object({
  id: z.int().positive(),
  state: z.string(),
  html_url: z.string(),
  body: z.string(),
  // Nullable in GitHub's description ("pull-request-review").
  commit_id: z.string().nullable(),
});

export interface PullRequestReview {
  id: number;
  /** `COMMENTED` for a comment review. */
  state: string;
  url: string;
  body: string;
  /** The commit the review is about; null when GitHub gives none. */
  commitId: string | null;
}

function review(body: z.infer<typeof Review>): PullRequestReview {
  return {
    id: body.id,
    state: body.state,
    url: body.html_url,
    body: body.body,
    commitId: body.commit_id,
  };
}

/**
 * Posts a review. The Orchestrator posts comment reviews: GitHub refuses approval and request
 * changes on your own pull request, and every pull request is the owner's (A11). The other
 * events exist for the owner's smoke script, which checks those refusals. `commit_id` is the
 * commit reviewed; GitHub "Defaults to the most recent commit in the pull request" without it.
 */
export async function postReview(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
  posted: { event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; body: string; commitId?: string },
): Promise<GitHubResult<PullRequestReview>> {
  const result = await ask(
    client,
    {
      method: 'POST',
      path: `${pullPath(repo, number)}/reviews`,
      body: {
        event: posted.event,
        body: posted.body,
        ...(posted.commitId === undefined ? {} : { commit_id: posted.commitId }),
      },
    },
    200,
    Review,
  );
  return mapped(result, review);
}

/**
 * The first review `wanted` accepts, reading the pull request's reviews page after page ("in
 * chronological order", at most 100 a page) until one does or the list ends (owner's answer 1,
 * lot 3 step H3: more than 100 reviews never hide ours); null when none does.
 */
export async function findReview(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
  wanted: (review: PullRequestReview) => boolean,
): Promise<GitHubResult<PullRequestReview | null>> {
  for (let page = 1; ; page++) {
    const batch = await ask(
      client,
      {
        method: 'GET',
        path: `${pullPath(repo, number)}/reviews?per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      },
      200,
      z.array(Review),
    );
    if (!batch.ok) return batch;
    const found = batch.value.map(review).find(wanted);
    if (found) return { ok: true, value: found };
    if (batch.value.length < PAGE_SIZE) return { ok: true, value: null };
  }
}

/**
 * Deletes a branch on GitHub. A branch already gone (deleted on GitHub, or by the repository's
 * "Automatically delete head branches") is accepted: "Delete a reference" answers 422 for a
 * reference that does not exist ("REST API endpoints for Git references",
 * https://docs.github.com/en/rest/git/refs).
 */
export async function deleteBranch(
  client: GitHubClient,
  repo: RepositoryRef,
  branch: string,
): Promise<GitHubResult<'deleted' | 'already_gone'>> {
  const response = await client.request({
    method: 'DELETE',
    path: `${repoPath(repo)}/git/refs/heads/${branchPath(branch)}`,
  });
  if (response.status === 204) return { ok: true, value: 'deleted' };
  const refusal = refusalOf(response);
  if (refusal.kind === 'invalid' && /Reference does not exist/i.test(refusal.message)) {
    return { ok: true, value: 'already_gone' };
  }
  return refused(refusal);
}

/** "pull-request-merge-result", as a merge returns it. */
const MergeResult = z.object({ sha: z.string(), merged: z.boolean(), message: z.string() });

/**
 * "Merge a pull request" (`PUT .../pulls/{pull_number}/merge`; 04, section 4; lot 5 step 5bis
 * B): merges only while the head is `sha` (409 otherwise); 405 when GitHub cannot merge it. Needs
 * Contents write ("Permissions required for fine-grained personal access tokens"). The answer's
 * `sha` is the merge commit.
 */
export async function mergePullRequest(
  client: GitHubClient,
  repo: RepositoryRef,
  number: number,
  merge: { sha: string; method: 'merge' | 'squash' | 'rebase' },
): Promise<GitHubResult<{ mergeCommit: string; merged: boolean }>> {
  const merged = await ask(
    client,
    {
      method: 'PUT',
      path: `${pullPath(repo, number)}/merge`,
      body: { sha: merge.sha, merge_method: merge.method },
    },
    200,
    MergeResult,
  );
  return mapped(merged, (body) => ({ mergeCommit: body.sha, merged: body.merged }));
}
