import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { GitHubAccess, GitHubPermission } from '@orchestrator/protocol';

// A local stand-in for GitHub's REST API, answering the way ADR 0022 expects GitHub to: a
// missing permission gives 403 "Resource not accessible by personal access token" with the
// X-Accepted-GitHub-Permissions header, an invalid write request gives 422. Nothing is stored.

export interface FakeRepository {
  name: string;
  private: boolean;
  archived?: boolean;
  /** An empty repository has no commits: the status endpoint answers 409. */
  empty?: boolean;
}

export interface FakeAccount {
  login: string;
  permissions: Partial<Record<GitHubPermission, GitHubAccess>>;
  repositories: FakeRepository[];
  /** Value of the GitHub-Authentication-Token-Expiration header, if any. */
  expirationHeader?: string;
  /** Send X-Accepted-GitHub-Permissions on refusals (default true). */
  acceptedPermissionsHeader?: boolean;
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
    return {
      status: 200,
      body: visible.map((repo) => ({
        name: repo.name,
        owner: { login: account.login },
        private: repo.private,
        archived: repo.archived ?? false,
        default_branch: 'main',
      })),
    };
  }
  if (method === 'POST' && path === '/user/repos') {
    return has(account, 'administration', 'write') ? invalid : refuse('administration=write');
  }
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
  const repo = account.repositories.find((candidate) => candidate.name === repoMatch?.[2]);
  if (!repoMatch || !repo) return { status: 404, body: { message: 'Not Found' } };
  const rest = repoMatch[3] ?? '';
  if (method === 'GET' && rest === '/actions/runs') {
    return has(account, 'actions', 'read')
      ? { status: 200, body: { total_count: 0, workflow_runs: [] } }
      : refuse('actions=read');
  }
  if (method === 'GET' && /^\/commits\/[^/]+\/status$/.test(rest)) {
    if (!has(account, 'statuses', 'read')) return refuse('statuses=read');
    return repo.empty
      ? { status: 409, body: { message: 'Git Repository is empty.' } }
      : { status: 200, body: { state: 'pending', statuses: [] } };
  }
  if (method === 'PUT' && rest.startsWith('/contents/.github/workflows/')) {
    if (!has(account, 'contents', 'write')) return refuse('contents=write', 'workflows=write');
    return has(account, 'workflows', 'write') ? invalid : refuse('workflows=write');
  }
  if (method === 'PUT' && rest.startsWith('/contents/')) {
    return has(account, 'contents', 'write') ? invalid : refuse('contents=write');
  }
  if (method === 'POST' && rest === '/pulls') {
    return has(account, 'pull_requests', 'write') ? invalid : refuse('pull_requests=write');
  }
  return { status: 404, body: { message: 'Not Found' } };
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
