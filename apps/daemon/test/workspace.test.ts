import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitCredentialRequest } from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitCredentialHelper, withCredentialHelper } from '../src/credentials.js';
import { Git } from '../src/git.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces } from '../src/workspace.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { createRemote, gitIn } from './remote.js';
import { prepareTicketRun, runStartPayload } from './run-start.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  linkSystemTool,
  type TestHome,
} from './testing.js';

// The run's Git workspace (05, sections 4.2 and 7) with the real Git: a bare clone fetched
// through the one-shot credential helper from an authenticated HTTP remote, worktrees and the
// commit author. The token never lands in a Git configuration or a remote URL.

const TOKEN = 'ghp_TestTokenThatMustNeverBeStored0123456789';
const CREDENTIAL = { ok: true as const, username: 'x-access-token', password: TOKEN };

let home: TestHome;
let git: Git;
let remotes: string;
let server: GitHttpServer;
let asked: GitCredentialRequest['payload'][];
let logs: ReturnType<typeof captureLogger>;
let workspaces: Workspaces;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  git = new Git(join(home.bin, 'git'), home.env);
  remotes = join(home.root, 'remotes');
  await createRemote(remotes, 'owner', 'notes', home.env, ['t/2-existing']);
  server = await startGitHttpServer(remotes, CREDENTIAL);
  asked = [];
  logs = captureLogger();
  workspaces = new Workspaces({
    paths: home.paths,
    git,
    trust: new TrustRegistry(join(home.paths.claudeConfig, '.claude.json')),
    credentials: (request) => {
      asked.push(request);
      return Promise.resolve(CREDENTIAL);
    },
    selfCommand: DAEMON_COMMAND,
    log: logs.log,
  });
});
afterEach(async () => {
  await server.close();
  await home.remove();
});

async function runFolder(runId: string): Promise<string> {
  const folder = join(home.paths.home, 'runs', runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return folder;
}

async function prepare(
  changes: Parameters<typeof runStartPayload>[1] = {},
  url = `${server.url}/owner/notes.git`,
) {
  const start = runStartPayload(url, changes);
  return { start, ...(await prepareTicketRun(workspaces, start, await runFolder(start.runId))) };
}

/** Every Git configuration file of the bare clone and its worktrees. */
async function gitConfigFiles(bare: string): Promise<string[]> {
  const files = [join(bare, 'config')];
  const worktrees = join(bare, 'worktrees');
  for (const name of await readdir(worktrees).catch(() => [])) {
    for (const file of await readdir(join(worktrees, name))) {
      if (file.startsWith('config')) files.push(join(worktrees, name, file));
    }
  }
  return files;
}

describe('workspace with credentials', () => {
  it('fetches through the daemon, asking the server once, and creates the ticket branch', async () => {
    const { start, bare, worktree } = await prepare();
    expect(asked).toEqual([
      { runId: start.runId, repository: { owner: 'owner', name: 'notes' }, command: 'fetch' },
    ]);
    expect(server.requests.some((request) => request.authenticated)).toBe(true);
    expect(await readFile(join(worktree, 'README.md'), 'utf8')).toBe('# notes\n');
    expect(gitIn(worktree, ['branch', '--show-current'], home.env).trim()).toBe('t/1-add-notes');
    // The author is the worktree's own, not the bare clone's.
    expect(gitIn(worktree, ['config', 'user.name'], home.env).trim()).toBe(
      'Web Developer (Orchestrator)',
    );
    expect(gitIn(worktree, ['config', 'user.email'], home.env).trim()).toBe(
      '1+owner@users.noreply.github.com',
    );
    expect(await readFile(join(bare, 'config'), 'utf8')).not.toContain('user');
  });

  it('keeps the token out of every Git configuration and remote URL', async () => {
    const { bare, worktree } = await prepare();
    const files = await gitConfigFiles(bare);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(TOKEN);
      // Only the empty helper of the bare clone, which turns the owner's helpers off (05, section 7).
      for (const line of text.split('\n').filter((each) => /helper/.test(each))) {
        expect(line.trim()).toBe('helper =');
      }
    }
    expect(gitIn(bare, ['config', '--get-all', 'credential.helper'], home.env)).toBe('\n');
    expect(gitIn(worktree, ['remote', 'get-url', 'origin'], home.env).trim()).toBe(
      `${server.url}/owner/notes.git`,
    );
    expect(gitIn(bare, ['config', '--list', '--show-origin'], home.env)).not.toContain(TOKEN);
    // Nor in the run folder or the log: the one-shot socket is gone.
    expect(
      await readdir(
        join(home.paths.home, 'runs', (await readdir(join(home.paths.home, 'runs')))[0] ?? ''),
      ),
    ).toEqual([]);
    expect(logs.lines().join('')).not.toContain(TOKEN);
  });

  it('leaves no credential to a git fetch run in the worktree outside the daemon', async () => {
    const { worktree } = await prepare();
    const fetch = await promisify(execFile)(join(home.bin, 'git'), ['fetch', 'origin'], {
      cwd: worktree,
      env: { ...home.env, GIT_TERMINAL_PROMPT: '0' },
    }).then(
      () => null,
      (error: unknown) => (error as { stderr: string }).stderr,
    );
    expect(fetch).toMatch(
      /Authentication failed|could not read Username|terminal prompts disabled/,
    );
    expect(server.requests.at(-1)?.authenticated).toBe(false);
  });

  it("gives an agent's git fetch none of the owner's own credentials, even with a global helper", async () => {
    const { worktree } = await prepare();
    // The owner's global helper, as Git Credential Manager is on WSL: here `store`, with the token
    // saved for the remote's host in the home folder.
    const host = new URL(server.url).host;
    await writeFile(
      join(home.env.HOME ?? '', '.git-credentials'),
      `http://x-access-token:${TOKEN}@${host}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(home.env.HOME ?? '', '.gitconfig'), '[credential]\n\thelper = store\n');
    const before = server.requests.length;
    const fetch = await promisify(execFile)(join(home.bin, 'git'), ['fetch', 'origin'], {
      cwd: worktree,
      // As in a run's session (05, section 4.3).
      env: { ...home.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }).then(
      () => null,
      (error: unknown) => (error as { stderr: string }).stderr,
    );
    expect(fetch).toMatch(
      /Authentication failed|could not read Username|terminal prompts disabled/,
    );
    const requests = server.requests.slice(before);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some((request) => request.authenticated)).toBe(false);
    // The daemon's own fetch still works: its helper comes on the command line.
    await prepare({ repository: { ticketBranch: 't/3-another' } });
    expect(asked).toHaveLength(2);
  });

  it('never asks for a credential for a file:// remote', async () => {
    const { worktree } = await prepare({}, `file://${join(remotes, 'owner', 'notes.git')}`);
    expect(asked).toEqual([]);
    expect(await readFile(join(worktree, 'README.md'), 'utf8')).toBe('# notes\n');
  });
});

describe('the one-shot credential socket', () => {
  async function helper(input: string, cloneUrl = 'https://github.com/owner/notes.git') {
    const folder = await runFolder('00000000-0000-4000-8000-000000000000');
    let answers: string[] = [];
    await withCredentialHelper(
      {
        folder,
        cloneUrl,
        request: {
          runId: '00000000-0000-4000-8000-000000000000',
          repository: { owner: 'owner', name: 'notes' },
          command: 'fetch',
        },
        source: (request) => {
          asked.push(request);
          return Promise.resolve(CREDENTIAL);
        },
        selfCommand: DAEMON_COMMAND,
        log: logs.log,
      },
      async ({ gitOptions, env }) => {
        expect(gitOptions.slice(0, 2)).toEqual(['-c', 'credential.helper=']);
        answers = [
          await gitCredentialHelper('get', input, env),
          await gitCredentialHelper('get', input, env),
          await gitCredentialHelper('get', input, { ...env, ORCHESTRATOR_CREDENTIAL_KEY: 'wrong' }),
          await gitCredentialHelper('store', input, env),
        ];
      },
    );
    return answers;
  }

  it("answers one credential for the clone URL's protocol, host and repository", async () => {
    const [first, second, wrongKey, store] = await helper(
      'protocol=https\nhost=github.com\npath=owner/notes.git\n',
    );
    expect(first).toBe(`username=x-access-token\npassword=${TOKEN}\n`);
    expect(second).toBe('');
    expect(wrongKey).toBe('');
    expect(store).toBe('');
    expect(asked).toHaveLength(1);
  });

  it('refuses another host, protocol or repository, logging it without the token', async () => {
    const refused = ['', '', '', ''];
    expect(await helper('protocol=https\nhost=evil.example.com\npath=owner/notes.git\n')).toEqual(
      refused,
    );
    expect(await helper('protocol=http\nhost=github.com\npath=owner/notes.git\n')).toEqual(refused);
    expect(await helper('protocol=https\nhost=github.com\npath=owner/other.git\n')).toEqual(
      refused,
    );
    expect(await helper('protocol=https\nhost=github.com\n')).toEqual(refused);
    expect(asked).toEqual([]);
    const log = logs.lines().join('');
    expect(log).toContain('evil.example.com');
    expect(log).toContain('another protocol, host or repository');
    expect(log).not.toContain(TOKEN);
  });

  it('closes for good at the first refused request: a later right one gets nothing', async () => {
    const folder = await runFolder('00000000-0000-4000-8000-000000000000');
    const answers: string[] = [];
    await withCredentialHelper(
      {
        folder,
        cloneUrl: 'https://github.com/owner/notes.git',
        request: {
          runId: '00000000-0000-4000-8000-000000000000',
          repository: { owner: 'owner', name: 'notes' },
          command: 'push',
        },
        source: (request) => {
          asked.push(request);
          return Promise.resolve(CREDENTIAL);
        },
        selfCommand: DAEMON_COMMAND,
        log: logs.log,
      },
      async ({ env }) => {
        answers.push(
          await gitCredentialHelper('get', 'protocol=https\nhost=evil.example.com\n', env),
          await gitCredentialHelper(
            'get',
            'protocol=https\nhost=github.com\npath=owner/notes.git\n',
            env,
          ),
        );
      },
    );
    expect(answers).toEqual(['', '']);
    expect(asked).toEqual([]);
  });
});

describe('ticket branches', () => {
  it('starts from the remote ticket branch when it exists', async () => {
    const { worktree } = await prepare({ repository: { ticketBranch: 't/2-existing' } });
    expect(await readFile(join(worktree, 't-2-existing.txt'), 'utf8')).toBe('t/2-existing\n');
  });

  it('keeps local commits of the ticket branch across runs, and reports them', async () => {
    const first = await prepare();
    gitIn(first.worktree, ['commit', '--quiet', '--allow-empty', '-m', 'Agent work'], home.env);
    await workspaces.remove(first.bare, first.worktree);
    await expect(readdir(first.worktree)).rejects.toThrow();

    // The next run on this machine starts from the kept branch, which no fetch overwrote.
    const second = await prepare();
    expect(gitIn(second.worktree, ['log', '-1', '--format=%s'], home.env).trim()).toBe(
      'Agent work',
    );
    const report = await workspaces.branchReport(second.bare, second.start.repository);
    expect(report).toMatchObject({
      name: 't/1-add-notes',
      commitsAhead: [{ subject: 'Agent work' }],
    });
    expect(report?.head).toBe(report?.commitsAhead[0]?.hash);
  });

  it('reports no branch when the ticket branch does not exist', async () => {
    const { bare } = await prepare();
    expect(
      await workspaces.branchReport(bare, { baseBranch: 'main', ticketBranch: 't/9-missing' }),
    ).toBeNull();
  });
});
