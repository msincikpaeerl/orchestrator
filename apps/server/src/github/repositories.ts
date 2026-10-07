import type { HarnessElement } from '@orchestrator/protocol';
import { z } from 'zod';
import {
  acceptedPermissions,
  isNotAccessible,
  type GitHubClient,
  type GitHubResponse,
} from './client.js';
import { ErrorBody, errorText, unfitFields, unreadableText } from './answers.js';
import type { SkeletonFile } from './skeleton.js';

// Repository operations of project creation (08, sections 3.1 and 3.4; ADR 0023). Every function
// takes the stored-token client (`storedTokenClient`), so GitHub's refusals reach "Needs you".

/**
 * GitHub answered, but not as the operation needs. `message` is written for the owner and
 * becomes the reason of a failed setup; it never contains the token.
 */
export class GitHubOperationError extends Error {
  override name = 'GitHubOperationError';
}

export interface RepositoryRef {
  owner: string;
  name: string;
}

export interface GitHubRepository extends RepositoryRef {
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  /** When GitHub created the repository, ISO 8601 (GitHub's clock); null when GitHub does not say. */
  createdAt: string | null;
}

const Repository = z.object({
  name: z.string(),
  owner: z.object({ login: z.string() }),
  private: z.boolean(),
  archived: z.boolean(),
  default_branch: z.string(),
  // Nullable in lists ("repository"), never null for one repository ("full-repository").
  created_at: z.string().nullable(),
});

function toRepository(body: z.infer<typeof Repository>): GitHubRepository {
  return {
    owner: body.owner.login,
    name: body.name,
    private: body.private,
    archived: body.archived,
    defaultBranch: body.default_branch,
    createdAt: body.created_at,
  };
}

function refused(action: string, response: GitHubResponse): GitHubOperationError {
  if (response.status === 401) {
    return new GitHubOperationError(
      `Could not ${action}: GitHub rejected the token (wrong, expired or revoked)`,
    );
  }
  if (isNotAccessible(response)) {
    const permissions = acceptedPermissions(response.headers);
    return new GitHubOperationError(
      `Could not ${action}: the GitHub token is missing a permission` +
        (permissions.length > 0 ? ` (${permissions.join(', ')})` : ''),
    );
  }
  const message = ErrorBody.safeParse(response.body);
  return new GitHubOperationError(
    `Could not ${action}: GitHub answered HTTP ${String(response.status)}` +
      (message.success ? ` (${errorText(message.data)})` : ''),
  );
}

/** The body read with `schema`; else an error naming the fields that did not fit, also logged. */
function parsed<T>(
  client: GitHubClient,
  schema: z.ZodType<T>,
  action: string,
  response: GitHubResponse,
): T {
  const result = schema.safeParse(response.body);
  if (!result.success) {
    const fields = unfitFields(result.error, response.body);
    if (response.request) client.unreadable(response.request, response.status, fields);
    throw new GitHubOperationError(`Could not ${action}: ${unreadableText(fields)}`);
  }
  return result.data;
}

export function repoPath(repo: RepositoryRef): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

/** A branch name in a URL: each segment encoded, slashes kept (`git/ref/heads/feature/x`). */
export function branchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

const PAGE_SIZE = 100;

/** Repositories of the owner's personal account, archived ones included (02, section 6.2). */
export async function listOwnerRepositories(client: GitHubClient): Promise<GitHubRepository[]> {
  const action = 'list your repositories';
  const repositories: GitHubRepository[] = [];
  for (let page = 1; ; page++) {
    const response = await client.request({
      method: 'GET',
      path: `/user/repos?affiliation=owner&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
    });
    if (response.status !== 200) throw refused(action, response);
    const batch = parsed(client, z.array(Repository), action, response);
    repositories.push(...batch.map(toRepository));
    if (batch.length < PAGE_SIZE) return repositories;
  }
}

/** The repository, or null when the owner has none with this name: the name is free. */
export async function findRepository(
  client: GitHubClient,
  repo: RepositoryRef,
): Promise<GitHubRepository | null> {
  const action = `read the repository ${repo.owner}/${repo.name}`;
  const response = await client.request({ method: 'GET', path: repoPath(repo) });
  if (response.status === 404) return null;
  if (response.status !== 200) throw refused(action, response);
  return toRepository(parsed(client, Repository, action, response));
}

/**
 * Creates the repository on the owner's personal account with GitHub's first commit (a README):
 * the Git database API cannot build commits in an empty repository.
 */
export async function createRepository(
  client: GitHubClient,
  input: { name: string; description: string; private: boolean },
): Promise<GitHubRepository> {
  const action = `create the repository ${input.name}`;
  const response = await client.request({
    method: 'POST',
    path: '/user/repos',
    body: {
      name: input.name,
      description: input.description,
      private: input.private,
      auto_init: true,
    },
  });
  if (response.status !== 201) throw refused(action, response);
  return toRepository(parsed(client, Repository, action, response));
}

const Ref = z.object({ object: z.object({ sha: z.string() }) });
const Commit = z.object({
  sha: z.string(),
  tree: z.object({ sha: z.string() }),
  parents: z.array(z.object({ sha: z.string() })),
});
const Tree = z.object({
  sha: z.string(),
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

const SKELETON_MESSAGE = 'chore: add the project skeleton';

/** Head commit of the branch, or null when the repository has no commit yet (HTTP 409). */
async function readHead(
  client: GitHubClient,
  repo: RepositoryRef,
  branch: string,
): Promise<{ commit: string; tree: string; parents: number } | null> {
  const refResponse = await client.request({
    method: 'GET',
    path: `${repoPath(repo)}/git/ref/heads/${branchPath(branch)}`,
  });
  if (refResponse.status === 409) return null;
  if (refResponse.status !== 200) throw refused(`read the branch ${branch}`, refResponse);
  const { sha } = parsed(client, Ref, `read the branch ${branch}`, refResponse).object;
  const commitResponse = await client.request({
    method: 'GET',
    path: `${repoPath(repo)}/git/commits/${sha}`,
  });
  if (commitResponse.status !== 200) throw refused(`read the commit ${sha}`, commitResponse);
  const commit = parsed(client, Commit, `read the commit ${sha}`, commitResponse);
  return { commit: sha, tree: commit.tree.sha, parents: commit.parents.length };
}

/**
 * Commits the skeleton in one commit after the branch's head (08, section 3.1), and moves the
 * branch forward to it without force: GitHub accepts only a fast-forward. An empty repository
 * first gets the skeleton's README through the contents API. Can be run again after a failure:
 * when the head already has the skeleton's content, nothing is committed.
 */
export async function applySkeleton(
  client: GitHubClient,
  repo: RepositoryRef & { defaultBranch: string },
  files: SkeletonFile[],
): Promise<{ commit: string; alreadyApplied: boolean }> {
  const branch = repo.defaultBranch;
  let head = await readHead(client, repo, branch);
  if (head === null) {
    const readme = files.find((file) => file.path === 'README.md');
    const response = await client.request({
      method: 'PUT',
      path: `${repoPath(repo)}/contents/README.md`,
      body: {
        message: 'Initial commit',
        // No branch: in an empty repository, the first commit creates the default branch.
        content: Buffer.from(readme?.content ?? `# ${repo.name}\n`).toString('base64'),
      },
    });
    if (response.status !== 201) throw refused('create the first commit', response);
    head = await readHead(client, repo, branch);
    if (head === null) {
      throw new GitHubOperationError('Could not create the first commit: the repository is empty');
    }
  }

  const treeResponse = await client.request({
    method: 'POST',
    path: `${repoPath(repo)}/git/trees`,
    body: {
      base_tree: head.tree,
      tree: files.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        content: file.content,
      })),
    },
  });
  if (treeResponse.status !== 201) throw refused('write the skeleton files', treeResponse);
  const tree = parsed(client, Tree, 'write the skeleton files', treeResponse).sha;
  if (tree === head.tree) return { commit: head.commit, alreadyApplied: true };

  const commitResponse = await client.request({
    method: 'POST',
    path: `${repoPath(repo)}/git/commits`,
    body: { message: SKELETON_MESSAGE, tree, parents: [head.commit] },
  });
  if (commitResponse.status !== 201) throw refused('commit the skeleton', commitResponse);
  const commit = parsed(client, Commit, 'commit the skeleton', commitResponse).sha;

  const refResponse = await client.request({
    method: 'PATCH',
    path: `${repoPath(repo)}/git/refs/heads/${branchPath(branch)}`,
    body: { sha: commit, force: false },
  });
  if (refResponse.status !== 200) {
    throw refused(`move the branch ${branch} to the skeleton commit`, refResponse);
  }
  return { commit, alreadyApplied: false };
}

/**
 * True when the default branch is empty or holds only GitHub's first commit: one commit with no
 * parent whose files are just the README (`auto_init`). Reads only.
 */
export async function holdsOnlyInitialCommit(
  client: GitHubClient,
  repo: RepositoryRef & { defaultBranch: string },
): Promise<boolean> {
  const head = await readHead(client, repo, repo.defaultBranch);
  if (head === null) return true;
  if (head.parents > 0) return false;
  const action = `read the files of ${repo.owner}/${repo.name}`;
  const response = await client.request({
    method: 'GET',
    path: `${repoPath(repo)}/git/trees/${head.tree}`,
  });
  if (response.status !== 200) throw refused(action, response);
  const { tree } = parsed(client, Tree, action, response);
  return tree.length === 1 && tree[0]?.path === 'README.md' && tree[0].type === 'blob';
}

/** Name of the ruleset the Orchestrator creates; also how a retry finds it. */
export const RULESET_NAME = 'Orchestrator: protect the default branch';
/**
 * The only check the ruleset requires: the final job of the skeleton's CI, which depends on every
 * other job, so the project's jobs can change without making pull requests unmergeable.
 */
export const REQUIRED_CHECK = 'ci';

export type BranchProtectionResult =
  { status: 'applied' } | { status: 'not_available' } | { status: 'failed'; reason: string };

const Ruleset = z.object({ name: z.string() });

/** GitHub Free offers rulesets on public repositories only (lot 1 plan, step A notes). */
function isPlanRefusal(response: GitHubResponse): boolean {
  const message = ErrorBody.safeParse(response.body);
  return (
    response.status === 403 &&
    message.success &&
    /upgrade to github pro|make this repository public/i.test(message.data.message)
  );
}

/**
 * Protects the default branch with a repository ruleset: pull request required, skeleton CI
 * required (08, section 3.1). A ruleset left by an earlier attempt counts as applied.
 */
export async function applyBranchProtection(
  client: GitHubClient,
  repo: RepositoryRef,
): Promise<BranchProtectionResult> {
  const action = 'protect the default branch';
  const existing = await client.request({ method: 'GET', path: `${repoPath(repo)}/rulesets` });
  if (existing.status === 200) {
    const rulesets = parsed(client, z.array(Ruleset), action, existing);
    if (rulesets.some((ruleset) => ruleset.name === RULESET_NAME)) return { status: 'applied' };
  } else if (!isPlanRefusal(existing)) {
    return { status: 'failed', reason: refused(action, existing).message };
  }

  const response = await client.request({
    method: 'POST',
    path: `${repoPath(repo)}/rulesets`,
    body: {
      name: RULESET_NAME,
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        {
          type: 'pull_request',
          parameters: {
            // The owner merges their own pull requests: GitHub never lets them approve those.
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: REQUIRED_CHECK }],
          },
        },
      ],
    },
  });
  if (response.status === 201) return { status: 'applied' };
  if (isPlanRefusal(response)) return { status: 'not_available' };
  return { status: 'failed', reason: refused(action, response).message };
}

/** When each harness element counts as found (08, section 3.4), from a file's path. */
const HARNESS_RULES: readonly [HarnessElement, (path: string) => boolean][] = [
  ['claude_md', (path) => path === 'CLAUDE.md'],
  ['user_docs', (path) => path.startsWith('docs/user/')],
  ['dev_docs', (path) => path.startsWith('docs/dev/')],
  ['adrs', (path) => path.startsWith('docs/adr/')],
  // GitHub runs only the workflows directly in this folder.
  ['ci_workflow', (path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)],
];

/**
 * Harness elements missing on the repository's default branch (08, section 3.4), in the order
 * of that table. An empty repository has all of them missing. Reads only.
 */
export async function findMissingHarness(
  client: GitHubClient,
  repo: RepositoryRef & { defaultBranch: string },
): Promise<HarnessElement[]> {
  const action = `read the files of ${repo.owner}/${repo.name}`;
  const response = await client.request({
    method: 'GET',
    path: `${repoPath(repo)}/git/trees/${branchPath(repo.defaultBranch)}?recursive=1`,
  });
  if (response.status === 409) return HARNESS_RULES.map(([element]) => element);
  if (response.status !== 200) throw refused(action, response);
  // A truncated listing (over 100,000 entries) may miss files: such repositories are not
  // expected here, so elements not listed are reported missing.
  const files = parsed(client, Tree, action, response)
    .tree.filter((entry) => entry.type === 'blob')
    .map((entry) => entry.path);
  return HARNESS_RULES.filter(([, found]) => !files.some(found)).map(([element]) => element);
}
