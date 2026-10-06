import type { GitHubAccess, GitHubPermission } from '@orchestrator/protocol';
import type { GitStore } from './git-store.js';

// What the parts of the fake GitHub share: the account and repository descriptions tests give,
// the state the fake keeps for each repository, and GitHub's replies.
//
// Sources (GitHub REST API, version 2026-03-10, the version the server pins in
// src/github/client.ts): the permission of each endpoint comes from "Permissions required for
// fine-grained personal access tokens"
// (https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens);
// a refusal is 403 "Resource not accessible by personal access token" with the
// X-Accepted-GitHub-Permissions header, comma-separated for permissions needed together and
// semicolon-separated for alternatives ("Troubleshooting the REST API", section "Resource not
// accessible", https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api);
// invalid credentials give 401 ("Authenticating to the REST API",
// https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api).

export interface FakeRepository {
  name: string;
  private: boolean;
  archived?: boolean;
  description?: string;
  /** An empty repository has no commits: Git requests answer 409 until a first file is put. */
  empty?: boolean;
  /** Default `main`. */
  defaultBranch?: string;
  /** GitHub's `created_at`; default an old date, set to the current time by `POST /user/repos`. */
  createdAt?: string;
  /** Files of the first commit when not empty; default a README. */
  files?: Record<string, string>;
  /** Rulesets created on the repository, by name. */
  rulesets?: { name: string; body: unknown }[];
  /**
   * The GitHub Actions workflows of the repository and the events that start them; none by
   * default (no run ever exists: "No CI found"). `skeletonWorkflow()` is the skeleton's CI.
   */
  workflows?: FakeWorkflow[];
  /** What each new workflow run does by itself; default `queued` (a test moves it on). */
  ci?: CiScript;
}

export interface FakeWorkflow {
  name: string;
  /** `.github/workflows/<file>`. */
  path: string;
  on: {
    /** Runs on `opened`, `synchronize` and `reopened`, GitHub's default activity types. */
    pullRequest?: boolean;
    /** Runs on a push to one of these branches. */
    pushBranches?: string[];
  };
  /**
   * Each job's steps by name, as GitHub lists them: `Set up job` first, `Complete job` last, a
   * `Post <step>` after the steps for each action with a post step. `commands` gives the command
   * a named `run:` step shows in the log; `postIfSuccess` lists the post steps whose action runs
   * them only after success (`post-if: success()`).
   */
  jobs: {
    name: string;
    steps: string[];
    commands?: Record<string, string>;
    postIfSuccess?: string[];
  }[];
}

/** A failed step: its job, its name and the lines it printed. */
export interface CiFailure {
  job: string;
  step: string;
  log: string;
}

/**
 * `queued`: the run waits for a test control. `success`: it is completed and successful at once.
 * `{ failures }`: it is completed at once, each named step failing with its log. `none`: no run
 * is started (Actions never starts).
 */
export type CiScript = 'queued' | 'success' | 'none' | { failures: CiFailure[] };

export interface FakeAccount {
  login: string;
  /** GitHub's numeric id of the account. */
  id: number;
  permissions: Partial<Record<GitHubPermission, GitHubAccess>>;
  repositories: FakeRepository[];
  /** Value of the GitHub-Authentication-Token-Expiration header, if any. */
  expirationHeader?: string;
  /** Send X-Accepted-GitHub-Permissions on refusals (default true). */
  acceptedPermissionsHeader?: boolean;
  /** GitHub Free (the default) offers rulesets on public repositories only. */
  plan?: 'free' | 'pro';
  /** Default branch of new repositories (the owner's GitHub setting); default `main`. */
  defaultBranch?: string;
}

export interface FakeReview {
  id: number;
  user: string;
  body: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING';
  commitId: string;
  submittedAt: string | null;
}

export interface FakePullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  /** Login of the account whose token opened it. */
  user: string;
  head: string;
  base: string;
  /** The head commit; kept when the branch is gone, as GitHub does. */
  headSha: string;
  merged: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Mergeability computed for this head and base, or null until the next read computes it. */
  mergeability: { head: string; base: string; mergeable: boolean } | null;
  reviews: FakeReview[];
}

export interface FakeJob {
  id: number;
  runId: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: {
    name: string;
    number: number;
    status: string;
    conclusion: string | null;
    /** Whole seconds, as GitHub gives them. */
    startedAt: string | null;
    completedAt: string | null;
  }[];
  /** The job's log once completed. */
  log: string | null;
}

export interface FakeRun {
  id: number;
  runNumber: number;
  workflow: FakeWorkflow;
  workflowId: number;
  event: 'pull_request' | 'push';
  headSha: string;
  headBranch: string;
  /** Numbers of the pull requests the run is for (a `pull_request` run). */
  pullRequests: number[];
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  jobs: FakeJob[];
}

export interface FakeStatus {
  id: number;
  sha: string;
  context: string;
  state: 'error' | 'failure' | 'pending' | 'success';
  description: string | null;
  targetUrl: string | null;
  createdAt: string;
}

/** What the fake keeps for a repository once it is used. */
export interface RepositoryState {
  owner: string;
  repo: FakeRepository;
  store: GitStore;
  /** Branches as the fake last saw them, to find what a push changed. */
  knownBranches: Map<string, string>;
  pulls: FakePullRequest[];
  runs: FakeRun[];
  statuses: FakeStatus[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function has(
  account: FakeAccount,
  permission: GitHubPermission,
  access: GitHubAccess,
): boolean {
  const granted = account.permissions[permission];
  return granted === 'write' || granted === access;
}

/** 403 naming the permissions: `needed` sets are alternatives, each a list needed together. */
export function refuse(account: FakeAccount, ...needed: string[][]): FakeReply {
  return {
    status: 403,
    body: { message: 'Resource not accessible by personal access token' },
    headers:
      account.acceptedPermissionsHeader === false
        ? {}
        : { 'x-accepted-github-permissions': needed.map((set) => set.join(',')).join('; ') },
  };
}

export const notFound: FakeReply = { status: 404, body: { message: 'Not Found' } };

export const badCredentials: FakeReply = { status: 401, body: { message: 'Bad credentials' } };

/**
 * 422 with GitHub's error list (`errors`), for a request GitHub cannot carry out. GitHub's
 * "validation-error" body also requires `documentation_url`, a link the Orchestrator never reads.
 */
export function unprocessable(message: string, errors?: unknown[]): FakeReply {
  return {
    status: 422,
    body: {
      message,
      documentation_url: 'https://docs.github.com/rest',
      ...(errors ? { errors } : {}),
    },
  };
}

export const invalid: FakeReply = unprocessable('Validation Failed');

export function branchOf(repo: FakeRepository): string {
  return repo.defaultBranch ?? 'main';
}

/** Page `page` of `items`, `per_page` at a time (GitHub's defaults: 30, at most 100). */
export function paged<T>(items: T[], url: URL): T[] {
  const perPage = Math.min(Number(url.searchParams.get('per_page') ?? '30'), 100);
  const page = Number(url.searchParams.get('page') ?? '1');
  return items.slice((page - 1) * perPage, page * perPage);
}
