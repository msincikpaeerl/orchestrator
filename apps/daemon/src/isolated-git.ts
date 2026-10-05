import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  GitHash,
  HIDDEN,
  TEXT_CEILING,
  maskSecrets,
  type GitCredentialRequest,
  type PushResult,
} from '@orchestrator/protocol';
import type { Logger } from 'pino';
import { withCredentialHelper, type CredentialSource } from './credentials.js';
import { GIT_ISOLATION_ENV, GitError, type Git } from './git.js';
import { RUN_MARKER } from './processes.js';

// Every Git command that may hold the GitHub credential (fetch and push, 05 section 7) runs in an
// **isolated repository**: a new bare repository made for that command in the run folder, whose
// configuration only the daemon writes, which borrows the bare clone's objects (alternates) and
// is removed afterwards. So Git never reads a file an agent can change: not the bare clone's
// configuration or hooks, not the owner's global or system configuration, `~/.netrc` or
// `~/.git-credentials`. Git is given the run's URL, never a remote name, and an environment
// built from an allowlist. What comes back reaches the bare clone through local commands that
// never hold the credential.

/** Proxy variables of the daemon's own environment, which credentialed commands keep. */
const PROXY_VARIABLES = [
  'http_proxy',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
];

/** The refs a fetch writes in the isolated repository, as the bare clone keeps them. */
const REMOTE_REFS = 'refs/remotes/origin/';

/** Refs telling a fetch which commits are there already, through the alternates. */
const HAVE_REFS = 'refs/orchestrator/have/';

/** What one credentialed command needs. */
export interface IsolatedGitOptions {
  git: Git;
  /** The run folder (mode 700): the isolated repository and the credential socket go there. */
  folder: string;
  /** The run's URL from `run.start`. */
  cloneUrl: string;
  request: Omit<GitCredentialRequest['payload'], 'command'>;
  source: CredentialSource;
  selfCommand: readonly string[];
  log: Logger;
  /** **Longest push**: the command and every process it started are stopped after it. */
  timeoutSeconds: number;
}

/** A URL a credentialed command may use, or why not. */
export function checkCloneUrl(cloneUrl: string): { url: URL; credential: boolean } {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    throw new Error('The repository URL is not a valid URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The repository URL must hold no user name, password, query or fragment.');
  }
  if (url.protocol === 'https:') return { url, credential: true };
  // Local remotes of tests (05, section 4.1).
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return { url, credential: true };
  if (url.protocol === 'file:') return { url, credential: false };
  throw new Error(`Git over ${url.protocol} is refused: only https is used.`);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  return isIP(host) === 4 && host.startsWith('127.');
}

/** The environment of a credentialed command: an allowlist, never the daemon's whole one. */
function isolatedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH ?? '/usr/bin:/bin',
    LC_ALL: 'C',
    ...GIT_ISOLATION_ENV,
  };
  for (const name of PROXY_VARIABLES) {
    const value = base[name];
    if (value) env[name] = value;
  }
  return env;
}

/**
 * The isolated repository's configuration. `core.alternateRefsCommand` replaces the
 * `git --git-dir=<bare clone> for-each-ref` Git would otherwise start in the bare clone to learn
 * the commits it has: a shell built-in printing nothing (the `have` refs give them instead).
 */
function isolatedConfig(protocol: string): string {
  const allowed = protocol.replace(/:$/, '');
  return [
    '[core]',
    '\thooksPath = /dev/null',
    '\tfsmonitor = false',
    '\talternateRefsCommand = true',
    '\taskPass =',
    '[gc]',
    '\tauto = 0',
    '[maintenance]',
    '\tauto = false',
    '[fetch]',
    '\tunpackLimit = 1',
    '\trecurseSubmodules = false',
    '\twriteCommitGraph = false',
    '[transfer]',
    '\tunpackLimit = 1',
    '[http]',
    '\tfollowRedirects = false',
    '[protocol]',
    '\tallow = never',
    `[protocol "${allowed}"]`,
    '\tallow = always',
    '[push]',
    '\trecurseSubmodules = no',
    '\tfollowTags = false',
    '',
  ].join('\n');
}

interface Spawned {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs Git with exactly `env`, in its own process group, stopped with the whole group after
 * `timeoutSeconds`.
 */
function spawnGit(
  file: string,
  args: string[],
  env: Record<string, string>,
  timeoutSeconds: number,
  input?: string,
): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      detached: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) child.stdin?.end(input);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, timeoutSeconds * 1000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Anything the command left in its group goes with it.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // None left.
        }
      }
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes the isolated repository, runs `work` in it with the credential helper when the URL needs
 * one, and removes it.
 */
async function inIsolatedRepository<T>(
  options: IsolatedGitOptions,
  command: GitCredentialRequest['payload']['command'],
  bare: string,
  work: (context: {
    repository: string;
    env: Record<string, string>;
    gitOptions: string[];
    run: (args: string[], input?: string) => Promise<Spawned>;
    outcome: () => { refusal: string | null; secret: string | null };
  }) => Promise<T>,
): Promise<T> {
  const { url, credential } = checkCloneUrl(options.cloneUrl);
  const env = isolatedEnv(options.git.env);
  const repository = await mkdtemp(join(options.folder, 'git-'));
  try {
    const init = await spawnGit(
      options.git.file,
      ['init', '--quiet', '--bare', '--template=', repository],
      env,
      options.timeoutSeconds,
    );
    if (init.code !== 0) throw new GitError(['init'], init.code, init.stderr);
    await appendFile(join(repository, 'config'), isolatedConfig(url.protocol));
    await mkdir(join(repository, 'objects', 'info'), { recursive: true });
    await appendFile(
      join(repository, 'objects', 'info', 'alternates'),
      `${join(bare, 'objects')}\n`,
    );
    const local = (args: string[], input?: string) =>
      spawnGit(
        options.git.file,
        ['--git-dir', repository, ...args],
        env,
        options.timeoutSeconds,
        input,
      );
    if (!credential) {
      return await work({
        repository,
        env,
        gitOptions: [],
        run: local,
        outcome: () => ({ refusal: null, secret: null }),
      });
    }
    return await withCredentialHelper(
      {
        folder: options.folder,
        cloneUrl: options.cloneUrl,
        request: { ...options.request, command },
        source: options.source,
        selfCommand: options.selfCommand,
        log: options.log,
      },
      (helper) =>
        work({
          repository,
          env: { ...env, ...helper.env },
          gitOptions: helper.gitOptions,
          run: local,
          outcome: () => helper.outcome(),
        }),
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

function seconds(count: number): string {
  return count === 1 ? '1 second' : `${String(count)} seconds`;
}

/** Masks credentials, and the one given to this command, in what Git or GitHub printed. */
function masked(text: string, secret: string | null): string {
  const hidden = secret ? text.split(secret).join(HIDDEN) : text;
  return maskSecrets(hidden).trim().slice(0, TEXT_CEILING);
}

/**
 * Fetches GitHub's branches into the bare clone's `refs/remotes/origin/*`, deleting those no
 * longer on GitHub (05, section 4.2). The fetched pack is moved into the bare clone, then its
 * refs are set in one `update-ref` transaction; neither step holds the credential.
 */
export async function isolatedFetch(options: IsolatedGitOptions, bare: string): Promise<void> {
  const { git } = options;
  const marker = { [RUN_MARKER]: options.request.runId };
  await inIsolatedRepository(options, 'fetch', bare, async (context) => {
    // What the bare clone has, so only the new commits are downloaded.
    const known = await git.run(
      ['-C', bare, 'for-each-ref', '--format=%(objectname)', 'refs/heads/', REMOTE_REFS],
      marker,
    );
    const haves = [...new Set(known.split('\n').filter((hash) => GitHash.safeParse(hash).success))];
    if (haves.length > 0) {
      const written = await context.run(
        ['update-ref', '--stdin'],
        haves.map((hash, index) => `create ${HAVE_REFS}${String(index)} ${hash}\n`).join(''),
      );
      if (written.code !== 0) {
        options.log.warn({ stderr: written.stderr }, 'known commits not given to the fetch');
      }
    }
    const fetched = await spawnGit(
      git.file,
      [
        ...context.gitOptions,
        '--git-dir',
        context.repository,
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        '--recurse-submodules=no',
        options.cloneUrl,
        `+refs/heads/*:${REMOTE_REFS}*`,
      ],
      context.env,
      options.timeoutSeconds,
    );
    const { secret } = context.outcome();
    if (fetched.timedOut) {
      throw new Error(
        `The fetch from GitHub took longer than Longest push (${seconds(options.timeoutSeconds)}) and was stopped.`,
      );
    }
    if (fetched.code !== 0) {
      throw new GitError(['fetch'], fetched.code, masked(fetched.stderr, secret));
    }
    await moveObjects(join(context.repository, 'objects'), join(bare, 'objects'));
    const refs = await context.run([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      REMOTE_REFS,
    ]);
    if (refs.code !== 0) throw new GitError(['for-each-ref'], refs.code, refs.stderr);
    const current = await git.run(
      ['-C', bare, 'for-each-ref', '--format=%(refname)', REMOTE_REFS],
      marker,
    );
    await git.run(['-C', bare, 'update-ref', '--stdin'], marker, refUpdates(refs.stdout, current));
  });
}

/** `update-ref --stdin` lines: every fetched ref set, every other remote ref deleted. */
function refUpdates(fetched: string, current: string): string {
  const lines: string[] = [];
  const names = new Set<string>();
  for (const line of fetched.split('\n').filter(Boolean)) {
    const [hash = '', name = ''] = line.split(' ');
    if (!GitHash.safeParse(hash).success || !name.startsWith(REMOTE_REFS)) continue;
    names.add(name);
    lines.push(`update ${name} ${hash}\n`);
  }
  for (const name of current.split('\n').filter(Boolean)) {
    if (!names.has(name)) lines.push(`delete ${name}\n`);
  }
  return lines.join('');
}

/**
 * Moves the objects a fetch wrote (packs, and loose objects should Git write any) into the bare
 * clone. A pack's index goes last, so Git never sees an index without its pack.
 */
async function moveObjects(from: string, to: string): Promise<void> {
  const packs = join(from, 'pack');
  const names = await readdir(packs).catch(() => [] as string[]);
  await mkdir(join(to, 'pack'), { recursive: true });
  for (const name of names.filter((each) => each.endsWith('.pack'))) {
    const base = name.slice(0, -'.pack'.length);
    for (const extension of ['.pack', '.rev', '.idx']) {
      const source = join(packs, base + extension);
      if (await exists(source)) await rename(source, join(to, 'pack', base + extension));
    }
  }
  for (const folder of await readdir(from).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(folder)) continue;
    await mkdir(join(to, folder), { recursive: true });
    for (const name of await readdir(join(from, folder))) {
      const target = join(to, folder, name);
      if (!(await exists(target))) await rename(join(from, folder, name), target);
    }
  }
}

/**
 * Pushes `head`, read once by the caller, to the ticket branch on GitHub: one explicit refspec,
 * never forced, never a tag (05, section 4.9). The isolated repository has no other branch or tag
 * to push. The result comes from `--porcelain` and the exit code, never from translated text.
 */
export async function isolatedPush(
  options: IsolatedGitOptions,
  bare: string,
  branch: string,
  head: string,
): Promise<PushResult> {
  if (!GitHash.safeParse(head).success) throw new Error(`Not a commit hash: ${head}`);
  return inIsolatedRepository(options, 'push', bare, async (context) => {
    const pushed = await spawnGit(
      options.git.file,
      [
        ...context.gitOptions,
        '--git-dir',
        context.repository,
        'push',
        '--porcelain',
        '--no-follow-tags',
        '--no-verify',
        '--recurse-submodules=no',
        options.cloneUrl,
        `${head}:refs/heads/${branch}`,
      ],
      context.env,
      options.timeoutSeconds,
    );
    return pushResult(pushed, context.outcome(), {
      ref: `refs/heads/${branch}`,
      head,
      timeoutSeconds: options.timeoutSeconds,
    });
  });
}

/** Rejections meaning GitHub's branch has commits the pushed one does not. */
const DIVERGED = /\[rejected\] \((?:non-fast-forward|fetch first|stale info)\)/;

/** Git's words for a credential refused or missing. */
const AUTHENTICATION =
  /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|The requested URL returned error: 40[13]|Permission to \S+ denied/;

/** Reads a push's outcome (exported for tests of the parsing alone). */
export function pushResult(
  pushed: Spawned,
  credential: { refusal: string | null; secret: string | null },
  expected: { ref: string; head: string; timeoutSeconds: number },
): PushResult {
  if (pushed.timedOut) {
    return {
      status: 'failed',
      reason: 'unreachable',
      message: `The push took longer than Longest push (${seconds(expected.timeoutSeconds)}) and was stopped.`,
    };
  }
  const remote = pushed.stderr
    .split('\n')
    .filter((line) => line.startsWith('remote: '))
    .map((line) => line.slice('remote: '.length).trim())
    .filter(Boolean)
    .join('\n');
  for (const line of pushed.stdout.split('\n')) {
    const [flag = '', refs = '', summary = ''] = line.split('\t');
    if (refs !== `${expected.head}:${expected.ref}`) continue;
    if (pushed.code === 0 && [' ', '*', '='].includes(flag)) {
      return { status: 'pushed', head: expected.head };
    }
    const message = masked([summary, remote].filter(Boolean).join('\n'), credential.secret);
    return {
      status: 'failed',
      reason: DIVERGED.test(summary) ? 'diverged' : 'refused',
      message: message || 'GitHub refused the push.',
    };
  }
  if (credential.refusal) {
    return {
      status: 'failed',
      reason: 'refused',
      message: masked(`The Orchestrator refused the credential: ${credential.refusal}`, null),
    };
  }
  const error = masked(
    [remote, ...pushed.stderr.split('\n').filter((line) => !line.startsWith('remote: '))]
      .filter(Boolean)
      .join('\n'),
    credential.secret,
  );
  return {
    status: 'failed',
    reason: AUTHENTICATION.test(pushed.stderr) ? 'refused' : 'unreachable',
    message: error || `Git ended with code ${String(pushed.code)} without pushing.`,
  };
}
