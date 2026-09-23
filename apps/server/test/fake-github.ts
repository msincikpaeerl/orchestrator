import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { GitHubAccess, GitHubPermission } from '@orchestrator/protocol';

// A local stand-in for GitHub's REST API, answering the way ADR 0022 expects GitHub to: a
// missing permission gives 403 "Resource not accessible by personal access token" with the
// X-Accepted-GitHub-Permissions header, an invalid write request gives 422. Repositories keep
// their commits, trees and branches in memory, for the Git database requests of ADR 0023.

export interface FakeRepository {
  name: string;
  private: boolean;
  archived?: boolean;
  description?: string;
  /** An empty repository has no commits: Git requests answer 409 until a first file is put. */
  empty?: boolean;
  /** Default `main`. */
  defaultBranch?: string;
  /** Files of the first commit when not empty; default a README. */
  files?: Record<string, string>;
  /** Rulesets created on the repository, by name. */
  rulesets?: { name: string; body: unknown }[];
  /** Filled on first use; read it with `repositoryHistory` and `repositoryFiles`. */
  git?: FakeGit;
}

export interface FakeCommit {
  sha: string;
  message: string;
  tree: string;
  parents: string[];
}

export interface FakeGit {
  /** Trees as flat maps from file path to content. */
  trees: Map<string, Record<string, string>>;
  commits: Map<string, FakeCommit>;
  /** Branch name to commit. */
  refs: Map<string, string>;
}

export interface FakeAccount {
  login: string;
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

export interface FakeGitHub {
  url: string;
  /** Valid tokens and their accounts; tests change it between requests. */
  accounts: Map<string, FakeAccount>;
  requests: RecordedRequest[];
  /** Answers instead of the normal behaviour when it returns a reply. */
  override: ((request: RecordedRequest) => FakeReply | undefined) | undefined;
  close(): Promise<void>;
}

const everyPermission: Record<GitHubPermission, GitHubAccess> = {
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
    permissions: { ...everyPermission },
    repositories: [{ name: 'notes', private: true }],
    ...overrides,
  };
}

function has(account: FakeAccount, permission: GitHubPermission, access: GitHubAccess): boolean {
  const granted = account.permissions[permission];
  return granted === 'write' || granted === access;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

function hash(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

function sortedFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Content-addressed like Git: the same files always give the same tree. */
function storeTree(git: FakeGit, files: Record<string, string>): string {
  const sorted = sortedFiles(files);
  const sha = hash(['tree', sorted]);
  git.trees.set(sha, sorted);
  return sha;
}

function storeCommit(git: FakeGit, message: string, tree: string, parents: string[]): FakeCommit {
  const commit = {
    sha: hash(['commit', message, tree, parents, git.commits.size]),
    message,
    tree,
    parents,
  };
  git.commits.set(commit.sha, commit);
  return commit;
}

function gitOf(repo: FakeRepository): FakeGit {
  if (repo.git) return repo.git;
  const git: FakeGit = { trees: new Map(), commits: new Map(), refs: new Map() };
  if (!repo.empty) {
    const tree = storeTree(git, repo.files ?? { 'README.md': `# ${repo.name}\n` });
    git.refs.set(branchOf(repo), storeCommit(git, 'Initial commit', tree, []).sha);
  }
  repo.git = git;
  return git;
}

function branchOf(repo: FakeRepository): string {
  return repo.defaultBranch ?? 'main';
}

/** Commits of the default branch, newest first, following first parents. */
export function repositoryHistory(repo: FakeRepository): FakeCommit[] {
  const git = gitOf(repo);
  const history: FakeCommit[] = [];
  let sha = git.refs.get(branchOf(repo));
  while (sha !== undefined) {
    const commit = git.commits.get(sha);
    if (!commit) break;
    history.push(commit);
    sha = commit.parents[0];
  }
  return history;
}

/** Files at the head of the default branch; empty for an empty repository. */
export function repositoryFiles(repo: FakeRepository): Record<string, string> {
  const git = gitOf(repo);
  const head = git.refs.get(branchOf(repo));
  const commit = head === undefined ? undefined : git.commits.get(head);
  return commit ? (git.trees.get(commit.tree) ?? {}) : {};
}

function isAncestor(git: FakeGit, ancestor: string, sha: string): boolean {
  if (ancestor === sha) return true;
  const commit = git.commits.get(sha);
  return commit ? commit.parents.some((parent) => isAncestor(git, ancestor, parent)) : false;
}

function repositoryJson(account: FakeAccount, repo: FakeRepository) {
  return {
    name: repo.name,
    full_name: `${account.login}/${repo.name}`,
    owner: { login: account.login },
    private: repo.private,
    archived: repo.archived ?? false,
    description: repo.description ?? null,
    default_branch: branchOf(repo),
  };
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const notFound: FakeReply = { status: 404, body: { message: 'Not Found' } };
const emptyRepository: FakeReply = { status: 409, body: { message: 'Git Repository is empty.' } };

function answer(account: FakeAccount, request: RecordedRequest): FakeReply {
  const refuse = (...needed: string[]): FakeReply => ({
    status: 403,
    body: { message: 'Resource not accessible by personal access token' },
    headers:
      account.acceptedPermissionsHeader === false
        ? {}
        : { 'x-accepted-github-permissions': needed.join(',') },
  });
  const invalid: FakeReply = { status: 422, body: { message: 'Validation Failed' } };
  const url = new URL(request.path, 'http://fake');
  const { method } = request;
  const path = url.pathname;
  const body = isObject(request.body) ? request.body : {};

  if (method === 'GET' && path === '/user') {
    return {
      status: 200,
      body: { login: account.login, id: 1 },
      headers: account.expirationHeader
        ? { 'github-authentication-token-expiration': account.expirationHeader }
        : {},
    };
  }
  if (method === 'GET' && path === '/user/repos') {
    const visible = account.repositories.filter(
      (repo) => !repo.private || has(account, 'metadata', 'read'),
    );
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const page = Number(url.searchParams.get('page') ?? '1');
    return {
      status: 200,
      body: visible
        .slice((page - 1) * perPage, page * perPage)
        .map((repo) => repositoryJson(account, repo)),
    };
  }
  if (method === 'POST' && path === '/user/repos') {
    if (!has(account, 'administration', 'write')) return refuse('administration=write');
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
      empty: body.auto_init !== true,
      files: { 'README.md': `# ${name}\n\n${description}\n` },
    };
    account.repositories.push(repo);
    return { status: 201, body: repositoryJson(account, repo) };
  }
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
  const repo = account.repositories.find((candidate) => candidate.name === repoMatch?.[2]);
  if (!repoMatch || repoMatch[1] !== account.login || !repo) return notFound;
  const rest = repoMatch[3] ?? '';
  const git = gitOf(repo);

  if (method === 'GET' && rest === '') {
    if (repo.private && !has(account, 'metadata', 'read')) return notFound;
    return { status: 200, body: repositoryJson(account, repo) };
  }
  if (method === 'GET' && rest === '/actions/runs') {
    return has(account, 'actions', 'read')
      ? { status: 200, body: { total_count: 0, workflow_runs: [] } }
      : refuse('actions=read');
  }
  if (method === 'GET' && /^\/commits\/[^/]+\/status$/.test(rest)) {
    if (!has(account, 'statuses', 'read')) return refuse('statuses=read');
    return git.refs.size === 0
      ? emptyRepository
      : { status: 200, body: { state: 'pending', statuses: [] } };
  }
  if (method === 'PUT' && rest.startsWith('/contents/')) {
    const filePath = decodeURIComponent(rest.slice('/contents/'.length));
    if (filePath.startsWith('.github/workflows/')) {
      if (!has(account, 'contents', 'write')) return refuse('contents=write', 'workflows=write');
      if (!has(account, 'workflows', 'write')) return refuse('workflows=write');
    } else if (!has(account, 'contents', 'write')) {
      return refuse('contents=write');
    }
    if (typeof body.message !== 'string' || typeof body.content !== 'string') return invalid;
    const branch = typeof body.branch === 'string' ? body.branch : branchOf(repo);
    const head = git.refs.get(branch);
    if (head === undefined && git.refs.size > 0) return notFound;
    const parent = head === undefined ? undefined : git.commits.get(head);
    const files = parent ? (git.trees.get(parent.tree) ?? {}) : {};
    if (filePath in files && body.sha === undefined) return invalid;
    const content = Buffer.from(body.content, 'base64').toString('utf8');
    const tree = storeTree(git, { ...files, [filePath]: content });
    const commit = storeCommit(git, body.message, tree, parent ? [parent.sha] : []);
    git.refs.set(branch, commit.sha);
    return { status: 201, body: { content: { path: filePath }, commit: { sha: commit.sha } } };
  }
  if (method === 'POST' && rest === '/pulls') {
    return has(account, 'pull_requests', 'write') ? invalid : refuse('pull_requests=write');
  }

  if (rest.startsWith('/git/')) {
    const gitPath = rest.slice('/git'.length);
    const write = method !== 'GET';
    if (!has(account, 'contents', write ? 'write' : 'read')) {
      return refuse(`contents=${write ? 'write' : 'read'}`);
    }
    if (git.refs.size === 0) return emptyRepository;

    const refMatch = /^\/refs?\/heads\/(.+)$/.exec(gitPath);
    if (method === 'GET' && refMatch && gitPath.startsWith('/ref/')) {
      const sha = git.refs.get(decodeURIComponent(refMatch[1] ?? ''));
      return sha === undefined
        ? notFound
        : {
            status: 200,
            body: { ref: `refs/heads/${refMatch[1] ?? ''}`, object: { sha, type: 'commit' } },
          };
    }
    if (method === 'PATCH' && refMatch && gitPath.startsWith('/refs/')) {
      const branch = decodeURIComponent(refMatch[1] ?? '');
      const current = git.refs.get(branch);
      const target = typeof body.sha === 'string' ? git.commits.get(body.sha) : undefined;
      if (current === undefined)
        return { status: 422, body: { message: 'Reference does not exist' } };
      if (!target) return invalid;
      if (body.force !== true && !isAncestor(git, current, target.sha)) {
        return { status: 422, body: { message: 'Update is not a fast forward' } };
      }
      const before = git.trees.get(git.commits.get(current)?.tree ?? '') ?? {};
      const after = git.trees.get(target.tree) ?? {};
      const workflowChanged = [...Object.keys(before), ...Object.keys(after)].some(
        (file) => file.startsWith('.github/workflows/') && before[file] !== after[file],
      );
      if (workflowChanged && !has(account, 'workflows', 'write')) return refuse('workflows=write');
      git.refs.set(branch, target.sha);
      return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha: target.sha } } };
    }
    const commitMatch = /^\/commits\/([0-9a-f]+)$/.exec(gitPath);
    if (method === 'GET' && commitMatch) {
      const commit = git.commits.get(commitMatch[1] ?? '');
      return commit ? { status: 200, body: commitJson(commit) } : notFound;
    }
    if (method === 'POST' && gitPath === '/commits') {
      const { message, tree, parents } = body;
      if (
        typeof message !== 'string' ||
        typeof tree !== 'string' ||
        !git.trees.has(tree) ||
        !Array.isArray(parents) ||
        !parents.every((parent) => typeof parent === 'string' && git.commits.has(parent))
      ) {
        return invalid;
      }
      return {
        status: 201,
        body: commitJson(storeCommit(git, message, tree, parents as string[])),
      };
    }
    if (method === 'POST' && gitPath === '/trees') {
      const base = typeof body.base_tree === 'string' ? git.trees.get(body.base_tree) : {};
      if (!base || !Array.isArray(body.tree)) return invalid;
      const files = { ...base };
      for (const entry of body.tree as unknown[]) {
        if (
          !isObject(entry) ||
          typeof entry.path !== 'string' ||
          typeof entry.content !== 'string'
        ) {
          return invalid;
        }
        files[entry.path] = entry.content;
      }
      const sha = storeTree(git, files);
      return { status: 201, body: treeJson(sha, files) };
    }
    const treeMatch = /^\/trees\/(.+)$/.exec(gitPath);
    if (method === 'GET' && treeMatch) {
      const name = decodeURIComponent(treeMatch[1] ?? '');
      const head = git.refs.get(name);
      const sha = head === undefined ? name : (git.commits.get(head)?.tree ?? '');
      const files = git.trees.get(sha);
      return files ? { status: 200, body: treeJson(sha, files) } : notFound;
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
    if (!has(account, 'administration', 'write')) return refuse('administration=write');
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

/** A recursive listing: every file, and every folder above them. */
function treeJson(sha: string, files: Record<string, string>) {
  const folders = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  return {
    sha,
    truncated: false,
    tree: [
      ...[...folders].map((path) => ({ path, type: 'tree', mode: '040000' })),
      ...Object.keys(files).map((path) => ({ path, type: 'blob', mode: '100644' })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

export async function startFakeGitHub(): Promise<FakeGitHub> {
  const fake: Omit<FakeGitHub, 'url' | 'close'> = {
    accounts: new Map(),
    requests: [],
    override: undefined,
  };
  const server: Server = createServer((incoming, response) => {
    void (async () => {
      const request: RecordedRequest = {
        method: incoming.method ?? 'GET',
        path: incoming.url ?? '/',
        authorization: incoming.headers.authorization,
        body: await readBody(incoming),
      };
      fake.requests.push(request);
      const token = request.authorization?.replace(/^Bearer /, '') ?? '';
      const account = fake.accounts.get(token);
      const reply =
        fake.override?.(request) ??
        (account
          ? answer(account, request)
          : { status: 401, body: { message: 'Bad credentials' } });
      response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return Object.assign(fake, {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  });
}
