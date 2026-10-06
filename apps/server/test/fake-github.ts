import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGitHttpHandler,
  type GitHttpRequest,
} from '@orchestrator/daemon/testing/git-http-server';
import {
  actionsApi,
  addStatus,
  completeRun,
  resolveRef,
  startRun,
  syncBranches,
  type FakeContext,
} from './fake-github/actions.js';
import {
  badCredentials,
  branchOf,
  has,
  invalid,
  isObject,
  notFound,
  refuse,
  type CiFailure,
  type FakeAccount,
  type FakePullRequest,
  type FakeReply,
  type FakeRepository,
  type FakeRun,
  type FakeStatus,
  type RecordedRequest,
  type RepositoryState,
} from './fake-github/common.js';
import { GitStore, type FakeCommit } from './fake-github/git-store.js';
import { closePull, mergePull, pullsApi, updatePullBranch } from './fake-github/pulls.js';

// A local stand-in for GitHub (lot 3 plan, step C; docs/dev/testing.md, "The fake GitHub"): the
// REST API the server uses and Git over HTTP, on the same repositories. Each repository is a bare
// Git repository on disk, in a folder of the fake under /tmp/od-test-github-*, removed by
// `close()`: a push through Git is seen by the REST API, and the REST API's commits are fetched
// by Git. The tokens, their accounts and permissions are the same for both.
//
// What it answers, and where each behaviour comes from in GitHub's documentation, is said in
// fake-github/common.ts (tokens, permissions, refusals), fake-github/pulls.ts (pull requests,
// reviews, mergeability, the owner's merge, close and Update branch), fake-github/actions.ts
// (workflow runs, jobs, logs, commit statuses) and below (Git over HTTP, repositories, Git
// database). What the documentation does not say is listed in docs/dev/lot-3-plan.md, step E,
// "Assumptions to confirm on the real GitHub", which the owner's smoke script checks.

export type {
  CiFailure,
  CiScript,
  FakeAccount,
  FakeJob,
  FakePullRequest,
  FakeReply,
  FakeRepository,
  FakeReview,
  FakeRun,
  FakeStatus,
  FakeWorkflow,
  RecordedRequest,
} from './fake-github/common.js';
export type { FakeCommit } from './fake-github/git-store.js';
export { skeletonWorkflow } from './fake-github/actions.js';

/** A Git request the fake received, and what it answered (`served`, or the HTTP status). */
export interface RecordedGitRequest {
  owner: string;
  name: string;
  access: 'fetch' | 'push';
  /** Whether a credential was sent, never the credential itself. */
  credentialSent: boolean;
  outcome: 'served' | number;
}

export interface FakeGitHub {
  /** The REST API and Git over HTTP: `<url>/<owner>/<name>.git` is a repository's clone URL. */
  url: string;
  /** Valid tokens and their accounts; tests change it between requests. */
  accounts: Map<string, FakeAccount>;
  requests: RecordedRequest[];
  gitRequests: RecordedGitRequest[];
  /** Downloads from the log host, with the Authorization header they carried (none expected). */
  logRequests: { path: string; authorization: string | undefined }[];
  /** Answers instead of the normal behaviour when it returns a reply (REST only). */
  override: ((request: RecordedRequest) => FakeReply | undefined) | undefined;
  /** The folder holding the bare repositories, removed by `close()`. */
  root: string;

  // Test controls: what happens on GitHub without the Orchestrator.
  /** A repository of an account with this login. */
  repository(owner: string, name: string): FakeRepository;
  /** Branch names and their commits. */
  branches(repo: FakeRepository): Map<string, string>;
  /**
   * Someone else's commit on a branch, for example on the base branch. A missing branch is
   * created from `from` (a branch), or with no parent when `from` is not given.
   */
  commit(
    repo: FakeRepository,
    branch: string,
    files: Record<string, string | null>,
    message: string,
    from?: string,
  ): string;
  pullRequest(repo: FakeRepository, number: number): FakePullRequest;
  /** The owner merges on GitHub: a merge commit, or one squashed commit. */
  mergePullRequest(repo: FakeRepository, number: number, method?: 'merge' | 'squash'): string;
  /** The owner closes it without merging. */
  closePullRequest(repo: FakeRepository, number: number): void;
  /** The owner's **Update branch**. */
  updatePullRequestBranch(repo: FakeRepository, number: number): string;
  /** Workflow runs, oldest first; only those of `ref`'s commit (a SHA or a branch) when given. */
  runs(repo: FakeRepository, ref?: string): FakeRun[];
  startRun(run: FakeRun): void;
  /** Completes a run: successful, or with the given steps failing. */
  completeRun(run: FakeRun, failures?: CiFailure[]): void;
  /** A commit status set by an external service. */
  setStatus(
    repo: FakeRepository,
    ref: string,
    status: Pick<FakeStatus, 'context' | 'state'> & { description?: string },
  ): void;
  close(): Promise<void>;
}

const everyPermission: FakeAccount['permissions'] = {
  administration: 'write',
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
  statuses: 'read',
  actions: 'read',
  metadata: 'read',
};

/** An account whose token has every required permission, with one private repository. */
export function fullAccount(overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    login: 'octo-owner',
    id: 5_550_123,
    permissions: { ...everyPermission },
    repositories: [{ name: 'notes', private: true }],
    ...overrides,
  };
}

/** The state of every repository a fake has used, whichever fake. */
const states = new WeakMap<FakeRepository, RepositoryState>();

function used(repo: FakeRepository): RepositoryState {
  const state = states.get(repo);
  if (!state) throw new Error(`the fake GitHub has not used the repository ${repo.name} yet`);
  return state;
}

/** Commits of the default branch, newest first, following first parents. */
export function repositoryHistory(repo: FakeRepository): FakeCommit[] {
  const { store } = used(repo);
  const head = store.branch(branchOf(repo));
  return head === undefined ? [] : store.history(head);
}

/** Files at the head of the default branch; empty for an empty repository. */
export function repositoryFiles(repo: FakeRepository): Record<string, string> {
  const { store } = used(repo);
  const head = store.branch(branchOf(repo));
  return head === undefined ? {} : store.files(head);
}

function repositoryJson(owner: string, repo: FakeRepository) {
  return {
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.private,
    archived: repo.archived ?? false,
    description: repo.description ?? null,
    default_branch: branchOf(repo),
    created_at: repo.createdAt ?? '2020-01-01T00:00:00Z',
  };
}

const emptyRepository: FakeReply = { status: 409, body: { message: 'Git Repository is empty.' } };

/** GitHub Free, private repository: rulesets need a paid plan (lot 1 plan, step A notes). */
const upgradeRequired: FakeReply = {
  status: 403,
  body: {
    message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
  },
};

function commitJson(commit: FakeCommit) {
  return {
    sha: commit.sha,
    message: commit.message,
    tree: { sha: commit.tree },
    parents: commit.parents.map((sha) => ({ sha })),
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no TCP address');
      resolve(`http://127.0.0.1:${String(address.port)}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Git over HTTP (`<url>/<owner>/<name>.git/...`), as opposed to a REST path. */
function isGitPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\.git\//.test(path);
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  // Named like every test folder (lot 3 plan, "Lessons of lot 2"), never like the owner's.
  const root = mkdtempSync(join(tmpdir(), 'od-test-github-'));
  const home = join(root, 'home');
  mkdirSync(home);
  let counter = 0;
  let url = '';
  let logUrl = '';
  const logs = new Map<string, { text: string; expires: number }>();

  const ctx: FakeContext = {
    get url() {
      return url;
    },
    nextId: () => ++counter,
    now: () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    logLink(job) {
      const key = randomBytes(16).toString('hex');
      logs.set(key, { text: job.log ?? '', expires: Date.now() + 60_000 });
      return `${logUrl}/job-logs/${key}`;
    },
  };

  const accounts = new Map<string, FakeAccount>();

  /** The repository's state, creating its bare repository on first use. */
  function stateOf(owner: string, repo: FakeRepository): RepositoryState {
    const existing = states.get(repo);
    if (existing) return existing;
    const store = new GitStore(join(root, 'repositories', `${String(++counter)}.git`), home);
    store.init(branchOf(repo));
    if (!repo.empty) {
      store.commitFiles(
        branchOf(repo),
        repo.files ?? { 'README.md': `# ${repo.name}\n` },
        'Initial commit',
      );
    }
    const state: RepositoryState = {
      owner,
      repo,
      store,
      knownBranches: store.branches(),
      pulls: [],
      runs: [],
      statuses: [],
    };
    states.set(repo, state);
    return state;
  }

  function ownerOf(repo: FakeRepository): string {
    for (const account of accounts.values()) {
      if (account.repositories.includes(repo)) return account.login;
    }
    throw new Error(`the repository ${repo.name} belongs to no account of the fake GitHub`);
  }

  const control = (repo: FakeRepository) => stateOf(ownerOf(repo), repo);

  function answer(account: FakeAccount, request: RecordedRequest): FakeReply {
    const requestUrl = new URL(request.path, 'http://fake');
    const { method } = request;
    const path = requestUrl.pathname;
    const body = isObject(request.body) ? request.body : {};

    if (method === 'GET' && path === '/user') {
      return {
        status: 200,
        body: { login: account.login, id: account.id },
        headers: account.expirationHeader
          ? { 'github-authentication-token-expiration': account.expirationHeader }
          : {},
      };
    }
    if (method === 'GET' && path === '/user/repos') {
      const visible = account.repositories.filter(
        (repo) => !repo.private || has(account, 'metadata', 'read'),
      );
      const perPage = Number(requestUrl.searchParams.get('per_page') ?? '30');
      const page = Number(requestUrl.searchParams.get('page') ?? '1');
      return {
        status: 200,
        body: visible
          .slice((page - 1) * perPage, page * perPage)
          .map((repo) => repositoryJson(account.login, repo)),
      };
    }
    if (method === 'POST' && path === '/user/repos') {
      if (!has(account, 'administration', 'write')) {
        return refuse(account, ['administration=write']);
      }
      const { name } = body;
      if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) return invalid;
      if (account.repositories.some((repo) => repo.name.toLowerCase() === name.toLowerCase())) {
        return {
          status: 422,
          body: {
            message: 'Repository creation failed.',
            errors: [
              {
                resource: 'Repository',
                code: 'custom',
                field: 'name',
                message: 'name already exists on this account',
              },
            ],
          },
        };
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const repo: FakeRepository = {
        name,
        private: body.private === true,
        description,
        defaultBranch: account.defaultBranch ?? 'main',
        createdAt: new Date().toISOString(),
        empty: body.auto_init !== true,
        files: { 'README.md': `# ${name}\n\n${description}\n` },
      };
      account.repositories.push(repo);
      stateOf(account.login, repo);
      return { status: 201, body: repositoryJson(account.login, repo) };
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    const repo = account.repositories.find((candidate) => candidate.name === repoMatch?.[2]);
    if (!repoMatch || repoMatch[1] !== account.login || !repo) return notFound;
    const rest = repoMatch[3] ?? '';
    const state = stateOf(account.login, repo);
    const { store } = state;

    if (method === 'GET' && rest === '') {
      if (repo.private && !has(account, 'metadata', 'read')) return notFound;
      return { status: 200, body: repositoryJson(account.login, repo) };
    }
    const reply =
      actionsApi(ctx, account, state, method, rest, requestUrl) ??
      pullsApi(ctx, account, state, method, rest, requestUrl, body);
    if (reply) return reply;

    if (method === 'PUT' && rest.startsWith('/contents/')) {
      const filePath = decodeURIComponent(rest.slice('/contents/'.length));
      if (filePath.startsWith('.github/workflows/')) {
        if (!has(account, 'contents', 'write')) {
          return refuse(account, ['contents=write', 'workflows=write']);
        }
        if (!has(account, 'workflows', 'write')) return refuse(account, ['workflows=write']);
      } else if (!has(account, 'contents', 'write')) {
        return refuse(account, ['contents=write']);
      }
      if (typeof body.message !== 'string' || typeof body.content !== 'string') return invalid;
      const branch = typeof body.branch === 'string' ? body.branch : branchOf(repo);
      const head = store.branch(branch);
      if (head === undefined && store.branches().size > 0) return notFound;
      const files = head === undefined ? {} : store.files(head);
      if (filePath in files && body.sha === undefined) return invalid;
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      const sha = store.commitFiles(branch, { [filePath]: content }, body.message);
      syncBranches(ctx, state);
      return { status: 201, body: { content: { path: filePath }, commit: { sha } } };
    }

    if (rest.startsWith('/git/')) {
      const gitPath = rest.slice('/git'.length);
      const write = method !== 'GET';
      if (!has(account, 'contents', write ? 'write' : 'read')) {
        return refuse(account, [`contents=${write ? 'write' : 'read'}`]);
      }
      if (store.branches().size === 0) return emptyRepository;

      const refMatch = /^\/refs?\/heads\/(.+)$/.exec(gitPath);
      if (method === 'GET' && refMatch && gitPath.startsWith('/ref/')) {
        const name = decodeURIComponent(refMatch[1] ?? '');
        const sha = store.branch(name);
        return sha === undefined
          ? notFound
          : { status: 200, body: { ref: `refs/heads/${name}`, object: { sha, type: 'commit' } } };
      }
      if (method === 'PATCH' && refMatch && gitPath.startsWith('/refs/')) {
        const branch = decodeURIComponent(refMatch[1] ?? '');
        const current = store.branch(branch);
        const target = typeof body.sha === 'string' ? store.commit(body.sha) : undefined;
        if (current === undefined) {
          return { status: 422, body: { message: 'Reference does not exist' } };
        }
        if (!target) return invalid;
        if (body.force !== true && !store.isAncestor(current, target.sha)) {
          return { status: 422, body: { message: 'Update is not a fast forward' } };
        }
        const workflowChanged = store
          .changedFiles(current, target.sha)
          .some((file) => file.startsWith('.github/workflows/'));
        if (workflowChanged && !has(account, 'workflows', 'write')) {
          return refuse(account, ['workflows=write']);
        }
        store.setBranch(branch, target.sha, current);
        syncBranches(ctx, state);
        return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: target.sha } } };
      }
      // "Delete a reference": 204, or 422 "Reference does not exist" ("REST API endpoints for Git
      // references", https://docs.github.com/en/rest/git/refs; the text is A26).
      if (method === 'DELETE' && refMatch && gitPath.startsWith('/refs/')) {
        const branch = decodeURIComponent(refMatch[1] ?? '');
        if (store.branch(branch) === undefined) {
          return { status: 422, body: { message: 'Reference does not exist' } };
        }
        store.deleteBranch(branch);
        syncBranches(ctx, state);
        return { status: 204 };
      }
      const commitMatch = /^\/commits\/([0-9a-f]+)$/.exec(gitPath);
      if (method === 'GET' && commitMatch) {
        const commit = store.commit(commitMatch[1] ?? '');
        return commit ? { status: 200, body: commitJson(commit) } : notFound;
      }
      if (method === 'POST' && gitPath === '/commits') {
        const { message, tree, parents } = body;
        if (
          typeof message !== 'string' ||
          typeof tree !== 'string' ||
          !store.isTree(tree) ||
          !Array.isArray(parents) ||
          !parents.every((parent) => typeof parent === 'string' && store.commit(parent))
        ) {
          return invalid;
        }
        const sha = store.commitTree(tree, parents as string[], message);
        const commit = store.commit(sha);
        return commit ? { status: 201, body: commitJson(commit) } : invalid;
      }
      if (method === 'POST' && gitPath === '/trees') {
        const base = typeof body.base_tree === 'string' ? body.base_tree : undefined;
        if ((base !== undefined && !store.isTree(base)) || !Array.isArray(body.tree)) {
          return invalid;
        }
        const changes: Record<string, string> = {};
        for (const entry of body.tree as unknown[]) {
          if (
            !isObject(entry) ||
            typeof entry.path !== 'string' ||
            typeof entry.content !== 'string'
          ) {
            return invalid;
          }
          changes[entry.path] = entry.content;
        }
        const sha = store.writeTree(base, changes);
        return { status: 201, body: treeJson(store, sha, true) };
      }
      const treeMatch = /^\/trees\/(.+)$/.exec(gitPath);
      if (method === 'GET' && treeMatch) {
        const name = decodeURIComponent(treeMatch[1] ?? '');
        const sha = store.treeOf(store.branch(name) ?? name);
        // "Setting this parameter to any value returns the objects or subtrees referenced by the
        // tree" ("REST API endpoints for Git trees", https://docs.github.com/en/rest/git/trees).
        const recursive = requestUrl.searchParams.has('recursive');
        return sha === undefined
          ? notFound
          : { status: 200, body: treeJson(store, sha, recursive) };
      }
    }

    if (method === 'GET' && rest === '/rulesets') {
      if (repo.private && account.plan !== 'pro') return upgradeRequired;
      return {
        status: 200,
        body: (repo.rulesets ?? []).map((ruleset, id) => ({ id, name: ruleset.name })),
      };
    }
    if (method === 'POST' && rest === '/rulesets') {
      if (!has(account, 'administration', 'write')) {
        return refuse(account, ['administration=write']);
      }
      if (repo.private && account.plan !== 'pro') return upgradeRequired;
      if (
        typeof body.name !== 'string' ||
        typeof body.target !== 'string' ||
        !Array.isArray(body.rules)
      ) {
        return invalid;
      }
      const name = body.name;
      if (repo.rulesets?.some((ruleset) => ruleset.name === name)) {
        return {
          status: 422,
          body: { message: 'Validation Failed', errors: ['Name must be unique'] },
        };
      }
      repo.rulesets = [...(repo.rulesets ?? []), { name, body }];
      return { status: 201, body: { id: repo.rulesets.length - 1, name } };
    }
    return notFound;
  }

  /**
   * Git over HTTP with the REST API's tokens. A token is the password of HTTP Basic
   * authentication, with any non-empty user name ("Managing your personal access tokens",
   * section "Using a personal access token on the command line",
   * https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
   * Git over HTTP needs the Contents permission, and editing `.github/workflows` the Workflows
   * permission ("Choosing permissions for a GitHub App",
   * https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
   * checked by the repository's pre-receive hook (fake-github/git-store.ts). A public repository
   * is fetched without a credential; everything else asks for one with 401. The 403 and 404 texts
   * are the fake's (lot 3 plan, step E).
   */
  function authorizeGit(request: GitHttpRequest) {
    const record = (outcome: RecordedGitRequest['outcome']) => {
      gitRequests.push({
        owner: request.owner,
        name: request.name,
        access: request.access,
        credentialSent: request.credential !== null,
        outcome,
      });
    };
    const askForCredential = () => {
      record(401);
      return {
        status: 401,
        message: 'Invalid username or token.',
        headers: { 'WWW-Authenticate': 'Basic realm="GitHub"' },
      };
    };
    const account =
      request.credential && request.credential.username !== ''
        ? accounts.get(request.credential.password)
        : undefined;
    if (request.credential && !account) return askForCredential();
    const owners = account ? [account] : [...accounts.values()];
    const found = owners
      .filter((candidate) => candidate.login === request.owner)
      .flatMap((candidate) => candidate.repositories)
      .find((candidate) => candidate.name === request.name);
    if (!account) {
      if (found && !found.private && request.access === 'fetch') {
        record('served');
        return { repository: stateOf(request.owner, found).store.path, user: 'anonymous' };
      }
      return askForCredential();
    }
    if (!found) {
      record(404);
      return { status: 404, message: 'Repository not found.' };
    }
    const needed = request.access === 'push' ? 'write' : 'read';
    if (!has(account, 'contents', needed) && (needed === 'write' || found.private)) {
      record(403);
      return {
        status: 403,
        message: `Permission to ${request.owner}/${request.name}.git denied to ${account.login}.`,
      };
    }
    record('served');
    return {
      repository: stateOf(account.login, found).store.path,
      user: account.login,
      env: { FAKE_GITHUB_WORKFLOWS: has(account, 'workflows', 'write') ? 'write' : 'none' },
    };
  }

  const gitRequests: RecordedGitRequest[] = [];
  const git = createGitHttpHandler({
    authorize: authorizeGit,
    onPushed: (repository) => {
      for (const account of accounts.values()) {
        for (const repo of account.repositories) {
          const state = states.get(repo);
          if (state?.store.path === repository) syncBranches(ctx, state);
        }
      }
    },
  });

  const fake = {
    accounts,
    requests: [] as RecordedRequest[],
    gitRequests,
    logRequests: [] as FakeGitHub['logRequests'],
    override: undefined as FakeGitHub['override'],
    root,
  };

  const server: Server = createServer((incoming, response) => {
    if (isGitPath(new URL(incoming.url ?? '/', 'http://fake').pathname)) {
      git.handle(incoming, response);
      return;
    }
    void (async () => {
      const request: RecordedRequest = {
        method: incoming.method ?? 'GET',
        path: incoming.url ?? '/',
        authorization: incoming.headers.authorization,
        body: await readBody(incoming),
      };
      fake.requests.push(request);
      const token = request.authorization?.replace(/^Bearer /, '') ?? '';
      const account = accounts.get(token);
      let reply: FakeReply;
      try {
        reply = fake.override?.(request) ?? (account ? answer(account, request) : badCredentials);
      } catch (error) {
        // A fault of the fake, not an answer of GitHub: shown in the test's output.
        console.error(error);
        reply = { status: 500, body: { message: String(error) } };
      }
      const json = reply.status !== 204 && reply.status !== 302;
      response.writeHead(reply.status, {
        ...(json ? { 'content-type': 'application/json' } : {}),
        ...reply.headers,
      });
      response.end(json && reply.body !== undefined ? JSON.stringify(reply.body) : '');
    })();
  });

  // The host the job logs redirect to: another origin, as GitHub's log storage is, so a client
  // must follow the redirect without the API's Authorization header.
  const logServer: Server = createServer((request, response) => {
    fake.logRequests.push({
      path: request.url ?? '/',
      authorization: request.headers.authorization,
    });
    const key = /^\/job-logs\/([0-9a-f]+)$/.exec(request.url ?? '')?.[1] ?? '';
    const log = logs.get(key);
    if (!log) {
      response.writeHead(404).end();
    } else if (Date.now() > log.expires) {
      response.writeHead(403, { 'content-type': 'text/plain' }).end('The link has expired.');
    } else {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(log.text);
    }
  });

  url = await listen(server);
  logUrl = await listen(logServer);

  const controls: Omit<FakeGitHub, keyof typeof fake | 'url' | 'close'> = {
    repository(owner, name) {
      for (const account of accounts.values()) {
        const repo = account.repositories.find((candidate) => candidate.name === name);
        if (account.login === owner && repo) return repo;
      }
      throw new Error(`no repository ${owner}/${name} in the fake GitHub`);
    },
    branches: (repo) => control(repo).store.branches(),
    commit(repo, branch, files, message, from) {
      const state = control(repo);
      const start = from === undefined ? undefined : state.store.branch(from);
      if (from !== undefined && start === undefined) throw new Error(`no branch ${from}`);
      if (start !== undefined && state.store.branch(branch) === undefined) {
        state.store.setBranch(branch, start, null);
      }
      const sha = state.store.commitFiles(branch, files, message);
      syncBranches(ctx, state);
      return sha;
    },
    pullRequest(repo, number) {
      const pull = control(repo).pulls.find((candidate) => candidate.number === number);
      if (!pull) throw new Error(`no pull request #${String(number)} in ${repo.name}`);
      return pull;
    },
    mergePullRequest: (repo, number, method) => mergePull(ctx, control(repo), number, method),
    closePullRequest: (repo, number) => {
      closePull(ctx, control(repo), number);
    },
    updatePullRequestBranch: (repo, number) => updatePullBranch(ctx, control(repo), number),
    runs(repo, ref) {
      const state = control(repo);
      if (ref === undefined) return [...state.runs];
      const sha = resolveRef(state, ref);
      return state.runs.filter((run) => run.headSha === sha);
    },
    startRun: (run) => {
      startRun(ctx, run);
    },
    completeRun: (run, failures = []) => {
      completeRun(ctx, run, failures);
    },
    setStatus(repo, ref, status) {
      const state = control(repo);
      const sha = resolveRef(state, ref);
      if (sha === undefined) throw new Error(`no commit ${ref} in ${repo.name}`);
      addStatus(ctx, state, sha, status);
    },
  };

  return Object.assign(fake, controls, {
    url,
    close: async () => {
      await closeServer(server);
      await git.close();
      await closeServer(logServer);
      rmSync(root, { recursive: true, force: true });
    },
  });
}

/** Entries of a tree, with GitHub's `truncated` flag. */
function treeJson(store: GitStore, sha: string, recursive: boolean) {
  return { sha, truncated: false, tree: store.treeEntries(sha, recursive) };
}
