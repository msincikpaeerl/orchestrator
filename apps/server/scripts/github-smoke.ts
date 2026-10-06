import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  HIDDEN,
  REQUIRED_GITHUB_PERMISSIONS,
  maskSecrets,
  type PushResult,
  type RunStart,
} from '@orchestrator/protocol';
import {
  GIT_MINIMUM,
  Git,
  TrustRegistry,
  Workspaces,
  daemonPaths,
  findExecutable,
  type CredentialAnswer,
} from '@orchestrator/daemon/smoke';
import pino from 'pino';
import { z } from 'zod';
import type { GitHubRefusal, GitHubResult } from '../src/github/answers.js';
import { listCommitRuns, listRunJobs, readCommitStatus, readJobLogEnd } from '../src/github/ci.js';
import type { WorkflowJob, WorkflowRun } from '../src/github/ci.js';
import { createGitHubClient, type GitHubClient } from '../src/github/client.js';
import {
  closePullRequest,
  deleteBranch,
  findPullRequests,
  openPullRequest,
  readPullRequest,
  type PullRequest,
} from '../src/github/pull-requests.js';
import { branchPath, findRepository, repoPath } from '../src/github/repositories.js';
import { checkToken, inspectToken } from '../src/github/token-check.js';

// The Node.js helper of tools/smoke/github-smoke.sh (lot 3 plan, step E): the owner's check of
// the real GitHub, with no Claude quota. The script reads the token from the terminal and gives
// it here as the first line of standard input; it lives only in this process's memory. Every
// GitHub request uses the server's GitHub layer, and every fetch and push the daemon's own
// workspace code (`Workspaces`, ADR 0034), fed the token through a credential source: the
// daemon's one-shot credential socket hands it to the daemon's `git-credential` command, which
// Git runs, exactly as in a run, with this process in the server's place.
//
// Everything printed goes through `say`, which masks the token. Steps 6 to 10 come in step E3.

const options = parseArgs({
  options: {
    repository: { type: 'string' },
    'api-url': { type: 'string' },
    'git-url': { type: 'string' },
    scratch: { type: 'string' },
    'ci-wait-minutes': { type: 'string', default: '15' },
    'dry-run': { type: 'boolean', default: false },
  },
}).values;

const DRY_RUN = options['dry-run'];
const [OWNER = '', NAME = ''] = (options.repository ?? '').split('/');
const REPO = { owner: OWNER, name: NAME };
const API_URL = options['api-url'] ?? '';
const GIT_URL = (options['git-url'] ?? '').replace(/\/$/, '');
const SCRATCH = options.scratch ?? '';
const CI_WAIT_MINUTES = Number(options['ci-wait-minutes']);
/** How often GitHub is read while waiting; the dry run's fake answers at once. */
const POLL_MS = DRY_RUN ? 50 : 5_000;
/** A minute of waiting; a second in the dry run, so its test of a wait that gives up is short. */
const MINUTE_MS = DRY_RUN ? 1_000 : 60_000;
const CHECKOUT = resolve(import.meta.dirname, '..', '..', '..');
/** The file the script's commits change: a page of documentation, checked by the skeleton's CI. */
const PAGE = 'docs/orchestrator-smoke.md';
/** The size of a log end kept, as **Longest CI log excerpt** gives it by default. */
const LOG_EXCERPT = 4_000;

// ---------------------------------------------------------------------------------------------
// Output, masked

const secrets: string[] = [];

function mask(text: string): string {
  let masked = text;
  for (const secret of secrets) masked = masked.split(secret).join(HIDDEN);
  return maskSecrets(masked);
}

function say(text = ''): void {
  process.stdout.write(`${mask(text)}\n`);
}

/** Indented lines of what GitHub or Git said, masked and kept short. */
function quoted(text: string, lines = 12): string {
  const kept = mask(text).trim().split('\n').slice(-lines);
  return kept.map((line) => `      | ${line}`).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Results: each step and each assumption of the lot 3 plan, step E

type Verdict = 'PASS' | 'FAIL' | 'NOT ATTEMPTED';

const STEPS: [number, string][] = [
  [1, 'push a branch with the daemon; refusals of a wrong token and a missing repository'],
  [2, 'open a pull request; mergeable; a second pull request refused'],
  [3, 'wait for CI; runs by head commit; logs of a job not finished; combined status'],
  [4, 'a broken link; two diverged pushes refused; the failure, its jobs and its log'],
  [5, 'repair the link; CI passes'],
  [6, 'reviews on your own pull request (step E3)'],
  [7, 'mergeable state (step E3)'],
  [8, 'merge by the owner and its detection (step E3)'],
  [9, 'a conflicting pull request, closed and reopened (step E3)'],
  [10, 'the second, restricted token (step E3)'],
];
const ASSUMPTIONS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13',
  'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'A26',
]; // prettier-ignore

const stepVerdicts = new Map<number, { verdict: Verdict; failures: string[] }>();
/** What failed in the current step, each with what GitHub answered: shown in the result. */
let currentFailures: string[] = [];
/** What failed while cleaning up, shown in the result. */
const cleanUpFailures: string[] = [];
const assumptionVerdicts = new Map<string, { verdict: Verdict; answers: string[] }>();
const tokenLines: string[] = [];
let currentStep = 0;
let currentFailed = false;
let gitVersion = 'unknown';

/** One check: printed now, and kept for its assumption and the step's verdict. */
function check(assumption: string | null, ok: boolean, what: string, answer = ''): boolean {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${assumption ? `${assumption}: ` : ''}${what}`);
  if (!ok && answer) say(quoted(answer));
  if (!ok) {
    currentFailed = true;
    if (!assumption) currentFailures.push(answer ? `${what}\n${answer}` : what);
  }
  if (assumption) {
    const kept = assumptionVerdicts.get(assumption) ?? { verdict: 'PASS', answers: [] };
    if (!ok) {
      kept.verdict = 'FAIL';
      kept.answers.push(answer || what);
    }
    assumptionVerdicts.set(assumption, kept);
  }
  return ok;
}

/** What was seen without a verdict (an assumption GitHub's behaviour left untested this time). */
function notAttempted(assumption: string, why: string): void {
  say(`  NOT ATTEMPTED  ${assumption}: ${why}`);
}

function startStep(step: number): void {
  currentStep = step;
  currentFailed = false;
  currentFailures = [];
  const title = STEPS.find(([number]) => number === step)?.[1] ?? '';
  say();
  say(`Step ${String(step)}: ${title}`);
}

function endStep(): void {
  stepVerdicts.set(currentStep, {
    verdict: currentFailed ? 'FAIL' : 'PASS',
    failures: currentFailures,
  });
}

/** A step that cannot go on: the run stops here. */
class Stop extends Error {}

function stop(what: string, answer = ''): never {
  check(null, false, what, answer);
  endStep();
  throw new Stop(what);
}

function refusalText(refusal: GitHubRefusal): string {
  return `HTTP ${String(refusal.status)} ${refusal.kind}: ${refusal.message}`;
}

/** GitHub did what was asked (a 2xx), but the GitHub layer cannot read its answer. */
function unreadable(refusal: GitHubRefusal): boolean {
  return refusal.kind === 'unreadable';
}

/**
 * The value of a GitHub answer; null when GitHub answered but the layer cannot read it: the step
 * fails, naming the fields, and goes on without it. Any other refusal stops the step.
 */
function readable<T>(result: GitHubResult<T>, what: string): T | null {
  if (result.ok) return result.value;
  if (!unreadable(result.refusal)) return stop(what, refusalText(result.refusal));
  check(
    null,
    false,
    `${what}: GitHub answered HTTP ${String(result.refusal.status)}, but the answer cannot be read`,
    refusalText(result.refusal),
  );
  return null;
}

// ---------------------------------------------------------------------------------------------
// What is left on GitHub, said when the script stops early

const left = {
  branch: null as string | null,
  pullRequests: [] as number[],
  /** A pull request GitHub created whose number the script could not read nor find. */
  unknownPullRequest: false,
};

function nothingLeft(): boolean {
  return left.branch === null && left.pullRequests.length === 0 && !left.unknownPullRequest;
}
const WEB_URL = DRY_RUN ? GIT_URL : 'https://github.com';
const repoWeb = `${WEB_URL}/${OWNER}/${NAME}`;

function sayLeft(): void {
  if (nothingLeft()) {
    say('Nothing of this run is left on GitHub.');
    return;
  }
  say('Left on GitHub by this run, to remove by hand:');
  for (const number of left.pullRequests) {
    say(
      `- pull request #${String(number)}: ${repoWeb}/pull/${String(number)} ("Close pull request" at the bottom of its page; GitHub keeps closed pull requests)`,
    );
  }
  if (left.unknownPullRequest) {
    say(
      `- a pull request from branch ${BRANCH}, whose number could not be read: ${repoWeb}/pulls?q=${encodeURIComponent(`is:pr is:open head:${BRANCH}`)} (open it, then "Close pull request")`,
    );
  }
  if (left.branch !== null) {
    say(
      `- branch ${left.branch}: ${repoWeb}/branches (the bin icon on its line), or "Delete branch" on the pull request's page once closed`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The token, read once from standard input

async function readToken(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.includes('\n')) break;
  }
  process.stdin.destroy();
  return text.split('\n')[0]?.trim() ?? '';
}

// ---------------------------------------------------------------------------------------------
// The daemon's workspaces: two "machines", each with its own bare clone, as on two computers

let credential: CredentialAnswer = { ok: false, message: 'no token yet' };
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z')
  .replace('T', '-');
const BRANCH = `orchestrator-smoke-${stamp}`;
const cloneUrl = (name: string) => `${GIT_URL}/${OWNER}/${name}.git`;

/** The daemon's warnings, readable and masked (a refused credential says why). */
const daemonLog = pino(
  { level: 'warn' },
  {
    write: (line: string) => {
      const parsed = z.object({ msg: z.string() }).safeParse(JSON.parse(line));
      say(`      (daemon) ${parsed.success ? parsed.data.msg : line.trim()}`);
    },
  },
);

interface Machine {
  name: string;
  spaces: Workspaces;
  git: Git;
  start: RunStart['payload'];
  folder: string;
  bare: string;
  worktree: string;
}

function gitExecutable(): string {
  const found = findExecutable('git', process.env.PATH);
  if (!found) throw new Error('git is not in PATH.');
  return found;
}

/**
 * A `run.start` as the server sends it, for what the workspace reads (repository, branches,
 * commit author, Longest push); the session fields are never used here.
 */
function runStart(account: { login: string; id: number }, baseBranch: string, name = NAME) {
  const start: RunStart['payload'] = {
    runId: randomUUID(),
    purpose: 'implement',
    subject: { kind: 'ticket', id: randomUUID(), number: 'SMOKE-1' },
    repository: {
      owner: OWNER,
      name,
      cloneUrl: cloneUrl(name),
      baseBranch,
      ticketBranch: BRANCH,
    },
    commitAuthor: {
      name: 'Orchestrator smoke test',
      email: `${String(account.id)}+${account.login}@users.noreply.github.com`,
    },
    profile: {
      key: 'web_dev',
      version: 1,
      instructions: 'Not used: no session.',
      model: 'none',
      allowedTools: [],
    },
    runToken: 'not-used',
    initialPrompt: 'Not used: no session.',
    nudgeMessage: 'Not used: no session.',
    limits: {
      maxRunDurationMinutes: 90,
      idleTimeoutMinutes: 10,
      maxNudgesPerRun: 2,
      waitingRunLifetimeMinutes: 30,
      sessionStartTimeoutSeconds: 30,
      mcpCallTimeoutSeconds: 30,
      claudeCodeMcpToolTimeoutSeconds: 120,
      // **Longest push**'s default.
      pushTimeoutSeconds: 120,
    },
    resumeSessionId: null,
  };
  return start;
}

async function prepareMachine(
  name: string,
  account: { login: string; id: number },
  baseBranch: string,
): Promise<Machine> {
  const home = join(SCRATCH, name);
  const paths = daemonPaths({ ...process.env, ORCHESTRATOR_HOME: home });
  const git = new Git(gitExecutable(), process.env);
  const spaces = new Workspaces({
    paths,
    git,
    trust: new TrustRegistry(join(paths.claudeConfig, '.claude.json')),
    credentials: () => Promise.resolve(credential),
    selfCommand: [
      process.execPath,
      ...process.execArgv,
      join(CHECKOUT, 'apps', 'daemon', 'src', 'cli.ts'),
    ],
    log: daemonLog,
  });
  const start = runStart(account, baseBranch);
  // Short: the credential socket goes there, and a Unix socket's path is at most 107 bytes.
  const folder = join(home, 'run');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const prepared = await spaces.prepare(start, folder);
  return { name, spaces, git, start, folder, ...prepared };
}

/** Writes the page and commits it in the machine's worktree, as an agent would. */
async function commitPage(machine: Machine, content: string, message: string): Promise<string> {
  const file = join(machine.worktree, PAGE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  await machine.git.run(['-C', machine.worktree, 'add', PAGE]);
  await machine.git.run(['-C', machine.worktree, 'commit', '--quiet', '-m', message]);
  return (await machine.git.run(['-C', machine.worktree, 'rev-parse', 'HEAD'])).trim();
}

/** A commit on `parent` with its tree, leaving every branch where it is. */
async function commitOn(machine: Machine, parent: string, message: string): Promise<string> {
  const hash = await machine.git.run([
    '-C',
    machine.worktree,
    'commit-tree',
    `${parent}^{tree}`,
    '-p',
    parent,
    '-m',
    message,
  ]);
  return hash.trim();
}

function pushText(result: PushResult): string {
  return result.status === 'pushed'
    ? `pushed ${result.head}`
    : `${result.reason}: ${result.message}`;
}

// ---------------------------------------------------------------------------------------------
// GitHub reads

const Reference = z.object({ object: z.object({ sha: z.string() }) });

/** The branch's head on GitHub ("Get a reference"); null when it does not exist. */
async function githubHead(client: GitHubClient, branch: string): Promise<string | null> {
  const response = await client.request({
    method: 'GET',
    path: `${repoPath(REPO)}/git/ref/heads/${branchPath(branch)}`,
  });
  const parsed = Reference.safeParse(response.body);
  return response.status === 200 && parsed.success ? parsed.data.object.sha : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Waits for every Actions run of `head` to complete, at most **--ci-wait-minutes**. While a job
 * is not finished, reads its log once when `tryUnfinishedLog` (A14). Null when the runs' answer
 * cannot be read (the step has failed, naming the fields).
 */
async function waitForCi(
  client: GitHubClient,
  head: string,
  pull: number,
  tryUnfinishedLog: boolean,
): Promise<{ runs: WorkflowRun[]; unfinishedLog: GitHubResult<unknown> | null } | null> {
  const until = Date.now() + CI_WAIT_MINUTES * MINUTE_MS;
  say(
    `  Waiting for CI on ${head.slice(0, 7)} (at most ${String(CI_WAIT_MINUTES)} minutes, --ci-wait-minutes): ${repoWeb}/pull/${String(pull)}/checks`,
  );
  let unfinishedLog: GitHubResult<unknown> | null = null;
  let tryLog = tryUnfinishedLog;
  for (;;) {
    const runs = readable(await listCommitRuns(client, REPO, head), 'read the runs of the commit');
    if (runs === null) return null;
    if (runs.length > 0 && runs.every((run) => run.status === 'completed')) {
      return { runs, unfinishedLog };
    }
    if (tryLog && unfinishedLog === null) {
      for (const run of runs.filter((each) => each.status !== 'completed')) {
        const jobs = readable(await listRunJobs(client, REPO, run.id), 'read the jobs of a run');
        if (jobs === null) {
          tryLog = false;
          break;
        }
        const job = jobs.find((each) => each.status !== 'completed');
        if (job) {
          unfinishedLog = await readJobLogEnd(client, REPO, job.id, LOG_EXCERPT);
          break;
        }
      }
    }
    if (Date.now() > until) {
      stop(
        `CI did not finish within ${String(CI_WAIT_MINUTES)} minutes (${runs.length === 0 ? 'no run started: does the repository have the skeleton CI, .github/workflows/ci.yml?' : runs.map((run) => `${run.name} ${run.status}`).join(', ')})`,
      );
    }
    await sleep(POLL_MS);
  }
}

function conclusions(runs: WorkflowRun[]): string {
  return runs
    .map((run) => `${run.name} (${run.event}): ${run.conclusion ?? run.status}`)
    .join(', ');
}

// ---------------------------------------------------------------------------------------------
// The steps

interface Context {
  client: GitHubClient;
  account: { login: string; id: number };
  baseBranch: string;
  token: string;
  first?: Machine;
  second?: Machine;
  stepOneHead?: string;
  pull?: number;
  brokenHead?: string;
}

async function stepZero(context: Context): Promise<void> {
  say();
  say("Step 0: the token check (the Orchestrator's own check, as in Settings > GitHub)");
  say(
    '  Administration and Workflows read Missing with the dedicated token: it does not have them, and this script does not use them.',
  );
  const result = await checkToken(context.client);
  if (!result.valid) throw new Stop('GitHub rejected the token in the middle of the check.');
  const labels = { ok: 'OK', missing: 'Missing', could_not_verify: 'Could not verify' };
  for (const { permission, label } of REQUIRED_GITHUB_PERMISSIONS) {
    const found = result.permissions.find((each) => each.permission === permission);
    const line = found
      ? `${label}: ${labels[found.result]}${found.reason ? ` (${found.reason})` : ''}`
      : `${label}: not checked`;
    tokenLines.push(line);
    say(`  ${line}`);
  }
}

async function stepOne(context: Context): Promise<void> {
  startStep(1);
  credential = { ok: true, username: 'x-access-token', password: context.token };
  const first = await prepareMachine('machine-1', context.account, context.baseBranch);
  context.first = first;
  const head = await commitPage(
    first,
    `# Orchestrator smoke test\n\nWritten by tools/smoke/github-smoke.sh on ${stamp}.\n`,
    'Orchestrator smoke test: step 1',
  );
  const pushed = await first.spaces.push(first.start, first.bare, first.folder, head);
  if (pushed.status === 'pushed') left.branch = BRANCH;
  check(
    'A1',
    pushed.status === 'pushed' && (await githubHead(context.client, BRANCH)) === head,
    `the daemon's push with the token as password and x-access-token as user name: branch ${BRANCH} at ${head.slice(0, 7)}`,
    pushText(pushed),
  );
  if (pushed.status !== 'pushed') stop('the first push failed: nothing more can be checked');
  context.stepOneHead = head;

  // No credential anywhere in the clone: not in its configuration, not in any file.
  const holding = await filesHolding([first.bare, first.worktree], context.token);
  const helpers = await first.git.exec([
    '-C',
    first.bare,
    'config',
    '--get-all',
    'credential.helper',
  ]);
  check(
    null,
    holding.length === 0 && helpers.stdout.trim() === '',
    "no credential left in the clone's configuration or files (credential.helper empty)",
    [...holding, `credential.helper: ${helpers.stdout.trim() || '(empty)'}`].join('\n'),
  );

  // A wrong token, on Git and on the REST API.
  const wrong = `github_pat_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  secrets.push(wrong);
  credential = { ok: true, username: 'x-access-token', password: wrong };
  const sibling = await commitOn(first, head, 'Orchestrator smoke test: wrong token');
  const refused = await first.spaces.push(first.start, first.bare, first.folder, sibling);
  credential = { ok: true, username: 'x-access-token', password: context.token };
  say(`  The daemon reads the push with a wrong token as: ${pushText(refused)}`);
  check(
    'A4',
    refused.status === 'failed' &&
      refused.reason === 'refused' &&
      /Authentication failed/.test(refused.message),
    'a push with a wrong token: refused, Git says "Authentication failed"',
    pushText(refused),
  );
  const wrongClient = createGitHubClient({ apiUrl: API_URL, token: wrong, timeoutSeconds: 30 });
  const user = await wrongClient.request({ method: 'GET', path: '/user' });
  const message = z.object({ message: z.string() }).safeParse(user.body);
  check(
    'A22',
    user.status === 401 && message.success && message.data.message === 'Bad credentials',
    'a REST request with a wrong token: 401 "Bad credentials"',
    `HTTP ${String(user.status)} ${JSON.stringify(user.body)}`,
  );

  // A repository name of the account that does not exist (A24).
  const missing = `${NAME}-missing-${stamp}`.slice(0, 100);
  const missingStart = runStart(context.account, context.baseBranch, missing);
  const notFound = await first.spaces.push(missingStart, first.bare, first.folder, head);
  say(`  The daemon reads the push to ${OWNER}/${missing} as: ${pushText(notFound)}`);
  check(
    'A24',
    notFound.status === 'failed' &&
      notFound.reason === 'refused' &&
      /Repository not found/.test(notFound.message) &&
      /repository '[^']*' not found/.test(notFound.message),
    `a push to ${OWNER}/${missing}, which does not exist: "Repository not found", read as refused`,
    pushText(notFound),
  );

  // The second machine's clone, made now: it has step 1's head, never the commits after it.
  context.second = await prepareMachine('machine-2', context.account, context.baseBranch);
  endStep();
}

async function filesHolding(folders: string[], text: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      const content = await readFile(path).catch(() => null);
      if (content?.includes(text)) found.push(path);
      return;
    }
    for (const entry of entries) await visit(join(path, entry.name));
  };
  for (const folder of folders) await visit(folder);
  return found;
}

/**
 * The open pull request of the run's branch that is not among `known`, found by its branch:
 * the way to a pull request GitHub created with an answer the layer cannot read. Null when
 * there is none, or when the list cannot be read either (the step fails, naming the fields).
 */
async function pullOfBranch(context: Context, known: number[]): Promise<number | null> {
  const found = readable(
    await findPullRequests(context.client, REPO, BRANCH, 'open'),
    `find the pull request of branch ${BRANCH}`,
  );
  return found?.find((pull) => !known.includes(pull.number))?.number ?? null;
}

async function stepTwo(context: Context): Promise<void> {
  startStep(2);
  const opening = await openPullRequest(context.client, REPO, {
    head: BRANCH,
    base: context.baseBranch,
    title: `Orchestrator smoke test ${stamp}`,
    body: "Opened by the Orchestrator's smoke script (tools/smoke/github-smoke.sh). The script closes it and deletes its branch when it finishes; if it stopped early, close this pull request and delete the branch.",
  });
  let opened: PullRequest | null = null;
  if (opening.ok) {
    opened = opening.value;
  } else if (unreadable(opening.refusal)) {
    // GitHub created it: the step fails, naming the fields; found by its branch, the pull
    // request is used and cleaned up like the rest.
    left.unknownPullRequest = true;
    readable(opening, 'open the pull request');
  } else {
    stop('open the pull request', refusalText(opening.refusal));
  }
  const number = opened?.number ?? (await pullOfBranch(context, []));
  if (number === null) {
    return stop(`find the pull request GitHub created for ${BRANCH}: steps 3 to 5 need it`);
  }
  left.unknownPullRequest = false;
  left.pullRequests.push(number);
  context.pull = number;
  say(`  Pull request #${String(number)}: ${opened?.url ?? `${repoWeb}/pull/${String(number)}`}`);
  const reads = opened
    ? [`at creation: mergeable ${String(opened.mergeable)} (${opened.mergeableState})`]
    : [];
  let mergeable = opened ? opened.mergeable : null;
  for (let read = 0; read < 20 && mergeable === null; read++) {
    await sleep(DRY_RUN ? POLL_MS : 2_000);
    const again = readable(
      await readPullRequest(context.client, REPO, number),
      'read the pull request',
    );
    if (again === null) break;
    mergeable = again.mergeable;
    reads.push(
      `read ${String(read + 1)}: mergeable ${String(again.mergeable)} (${again.mergeableState})`,
    );
  }
  for (const line of reads) say(`  ${line}`);
  if (opened === null) {
    notAttempted('A5', 'the creation answer could not be read, so its mergeable is unknown');
  } else {
    check(
      'A5',
      opened.mergeable === null && mergeable !== null,
      'mergeable is null in the creation answer, then true or false at a later read',
      reads.join('\n'),
    );
  }
  const second = await openPullRequest(context.client, REPO, {
    head: BRANCH,
    base: context.baseBranch,
    title: 'Orchestrator smoke test: a second pull request (must be refused)',
    body: 'GitHub must refuse this one.',
  });
  if (second.ok) left.pullRequests.push(second.value.number);
  else if (unreadable(second.refusal)) {
    // Created after all: found by its branch, or listed as unknown.
    const other = await pullOfBranch(context, left.pullRequests);
    if (other === null) left.unknownPullRequest = true;
    else left.pullRequests.push(other);
  }
  const expected = `A pull request already exists for ${OWNER}:${BRANCH}.`;
  check(
    'A6',
    !second.ok &&
      second.refusal.kind === 'invalid' &&
      second.refusal.details.some((detail) => detail === expected),
    `a second pull request for the same branch: 422 "${expected}"`,
    second.ok ? `opened #${String(second.value.number)}` : refusalText(second.refusal),
  );
  endStep();
}

async function stepThree(context: Context): Promise<void> {
  startStep(3);
  const head = context.stepOneHead ?? '';
  const ci = await waitForCi(context.client, head, context.pull ?? 0, true);
  const runs = ci?.runs ?? null;
  const unfinishedLog = ci?.unfinishedLog ?? null;
  if (runs === null) {
    notAttempted('A12', 'the runs could not be read');
  } else {
    say(`  Runs of ${head.slice(0, 7)}: ${conclusions(runs)}`);
    check(
      'A12',
      runs.every((run) => run.event === 'pull_request' && run.headSha === head),
      "the runs found by the head commit are the pull request's runs only (no push run for this branch)",
      conclusions(runs),
    );
  }
  if (unfinishedLog === null) {
    notAttempted(
      'A14',
      runs === null
        ? 'the runs or jobs could not be read'
        : 'every job had finished before the script could read its log',
    );
  } else {
    check(
      'A14',
      !unfinishedLog.ok && unfinishedLog.refusal.status === 404,
      'the log of a job not finished yet: 404',
      unfinishedLog.ok ? 'a log came' : refusalText(unfinishedLog.refusal),
    );
  }
  const status = readable(
    await readCommitStatus(context.client, REPO, head),
    'read the combined commit status',
  );
  if (status === null) {
    notAttempted('A17', 'the combined commit status could not be read');
  } else {
    check(
      'A17',
      status.state === 'pending' && status.statuses.length === 0,
      'with Actions only, the combined commit status is pending with no statuses',
      `${status.state}, ${String(status.statuses.length)} statuses`,
    );
  }
  // CI that fails on the first commit makes the later steps meaningless; runs that cannot be
  // read do not: the later steps still check the pushes and what can be read.
  const passed = runs?.every((run) => run.conclusion === 'success') ?? true;
  if (runs !== null) check(null, passed, 'CI passed on the first commit', conclusions(runs));
  endStep();
  if (!passed) throw new Stop('CI did not pass on the first commit');
}

/** A diverged push from `machine`: refused by GitHub with `summary`, read as `diverged`. */
async function divergedPush(
  context: Context,
  machine: Machine,
  head: string,
  summary: string,
): Promise<boolean> {
  const result = await machine.spaces.push(machine.start, machine.bare, machine.folder, head);
  say(`  Push from ${machine.name} of ${head.slice(0, 7)}, made on step 1's head:`);
  say(`    the daemon's reading: ${result.status === 'pushed' ? 'pushed' : result.reason}`);
  if (result.status === 'failed') say(`    Git and GitHub said:\n${quoted(result.message)}`);
  const runs = readable(
    await listCommitRuns(context.client, REPO, head),
    `read the runs of ${head.slice(0, 7)}`,
  );
  return (
    result.status === 'failed' &&
    result.reason === 'diverged' &&
    result.message.includes(summary) &&
    runs !== null &&
    runs.length === 0
  );
}

async function stepFour(context: Context): Promise<void> {
  startStep(4);
  const first = context.first;
  const second = context.second;
  const stepOne = context.stepOneHead;
  if (!first || !second || !stepOne) return stop('steps 1 to 3 did not finish');
  const broken = await commitPage(
    first,
    `# Orchestrator smoke test\n\nWritten by tools/smoke/github-smoke.sh on ${stamp}.\n\nA [link to a page that does not exist](orchestrator-smoke-missing.md).\n`,
    'Orchestrator smoke test: a broken link',
  );
  const pushed = await first.spaces.push(first.start, first.bare, first.folder, broken);
  if (pushed.status !== 'pushed') stop('the push of the broken link failed', pushText(pushed));
  context.brokenHead = broken;

  // Two commits made on step 1's head, which GitHub must refuse without starting CI (A25).
  const fromSecond = await commitPage(
    second,
    `# Orchestrator smoke test\n\nChanged by the second clone, which never fetched the broken link.\n`,
    'Orchestrator smoke test: from the second clone',
  );
  const fetchFirst = await divergedPush(context, second, fromSecond, 'fetch first');
  const fromFirst = await commitOn(first, stepOne, 'Orchestrator smoke test: made on step 1');
  const nonFastForward = await divergedPush(context, first, fromFirst, 'non-fast-forward');
  const githubNow = await githubHead(context.client, BRANCH);
  check(
    'A25',
    fetchFirst && nonFastForward && githubNow === broken,
    'both pushes rejected without CI ("fetch first" from the second clone, "non-fast-forward" from the first), read as diverged; the branch stays at the broken link',
    `fetch first ${fetchFirst ? 'as expected' : 'not as expected'}, non-fast-forward ${nonFastForward ? 'as expected' : 'not as expected'}, branch on GitHub at ${githubNow ?? 'none'}`,
  );

  const runs = (await waitForCi(context.client, broken, context.pull ?? 0, false))?.runs ?? null;
  if (runs === null) {
    for (const assumption of ['A12', 'A13', 'A15']) {
      notAttempted(assumption, 'the runs could not be read');
    }
    endStep();
    return;
  }
  say(`  Runs of ${broken.slice(0, 7)}: ${conclusions(runs)}`);
  check(
    'A12',
    runs.every((run) => run.event === 'pull_request' && run.headSha === broken),
    "the runs found by the new head commit are the pull request's runs only",
    conclusions(runs),
  );
  check(
    null,
    runs.some((run) => run.conclusion === 'failure'),
    'CI failed on the broken link',
    conclusions(runs),
  );
  const jobs: WorkflowJob[] = [];
  for (const run of runs) {
    const read = readable(await listRunJobs(context.client, REPO, run.id), 'read the jobs');
    if (read === null) {
      notAttempted('A15', 'the jobs could not be read');
      notAttempted('A13', 'the jobs could not be read');
      endStep();
      return;
    }
    jobs.push(...read);
  }
  for (const job of jobs) {
    say(`  Job ${job.name}: ${job.conclusion ?? job.status}`);
    for (const step of job.steps) say(`    ${step.name}: ${step.conclusion ?? step.status}`);
  }
  const links = jobs.find((job) => job.name === 'docs-links');
  const ci = jobs.find((job) => job.name === 'ci');
  const failedStep = links?.steps.findIndex((step) => step.conclusion === 'failure') ?? -1;
  check(
    'A15',
    links?.conclusion === 'failure' &&
      links.steps[failedStep]?.name === 'Check documentation links' &&
      ci?.conclusion === 'failure',
    'job docs-links fails at step "Check documentation links", and job ci fails too',
    jobs.map((job) => `${job.name}: ${String(job.conclusion)}`).join(', '),
  );
  if (!links) return stop('no docs-links job to read the log of');
  const later = links.steps.slice(failedStep + 1);
  const log = await readJobLogEnd(context.client, REPO, links.id, LOG_EXCERPT);
  if (!log.ok) {
    check('A13', false, "the failed job's log through the redirect", refusalText(log.refusal));
  } else {
    const lines = log.value.text.split('\n').filter((line) => line.trim() !== '');
    say(`  The end of the docs-links log (${String(lines.length)} lines kept):`);
    say(quoted(log.value.text, 15));
    const stamped = lines.every((line) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z /.test(line));
    check(
      'A13',
      stamped &&
        log.value.text.includes('##[group]') &&
        log.value.text.includes('##[error]Process completed with exit code 1.') &&
        failedStep >= 0 &&
        later.every((step) => step.conclusion === 'skipped'),
      'the log comes through the redirect; each line starts with a timestamp with seven decimals; steps open with ##[group]; the failure ends with "##[error]Process completed with exit code 1."; the later steps are skipped',
      [
        `timestamps on every line: ${String(stamped)}`,
        `##[group]: ${String(log.value.text.includes('##[group]'))}`,
        `##[error]Process completed with exit code 1.: ${String(log.value.text.includes('##[error]Process completed with exit code 1.'))}`,
        `later steps: ${later.map((step) => `${step.name} ${String(step.conclusion)}`).join(', ') || 'none'}`,
      ].join('\n'),
    );
  }
  endStep();
}

async function stepFive(context: Context): Promise<void> {
  startStep(5);
  const first = context.first;
  if (!first) return stop('step 1 did not finish');
  const repaired = await commitPage(
    first,
    `# Orchestrator smoke test\n\nWritten by tools/smoke/github-smoke.sh on ${stamp}.\n\nA [link that works](../README.md).\n`,
    'Orchestrator smoke test: the link repaired',
  );
  const pushed = await first.spaces.push(first.start, first.bare, first.folder, repaired);
  if (pushed.status !== 'pushed') stop('the push of the repair failed', pushText(pushed));
  const runs = (await waitForCi(context.client, repaired, context.pull ?? 0, false))?.runs;
  if (runs) {
    check(
      null,
      runs.every((run) => run.conclusion === 'success'),
      'CI passed on the repaired link (the ci check your projects require to merge)',
      conclusions(runs),
    );
  }
  endStep();
}

function cleanUpFailed(what: string, answer: string): void {
  say(`  FAIL  ${what}`);
  say(quoted(answer));
  cleanUpFailures.push(`${what}\n${answer}`);
}

/**
 * Closes the pull requests (also one GitHub created with an answer the script could not read,
 * found by its branch) and deletes the branch, the second time already gone (A26).
 */
async function cleanUp(context: Context): Promise<void> {
  say();
  say('Clean-up');
  if (left.unknownPullRequest) {
    const found = await findPullRequests(context.client, REPO, BRANCH, 'open');
    if (found.ok) {
      for (const pull of found.value) {
        if (!left.pullRequests.includes(pull.number)) left.pullRequests.push(pull.number);
      }
      left.unknownPullRequest = false;
    } else {
      cleanUpFailed(`find the pull requests of ${BRANCH}`, refusalText(found.refusal));
    }
  }
  for (const number of [...left.pullRequests]) {
    const closed = await closePullRequest(context.client, REPO, number);
    // An answer that cannot be read still means GitHub closed it.
    if (closed.ok || unreadable(closed.refusal)) {
      say(`  Pull request #${String(number)} closed (GitHub keeps closed pull requests).`);
      left.pullRequests = left.pullRequests.filter((each) => each !== number);
    }
    if (!closed.ok) {
      cleanUpFailed(`close pull request #${String(number)}`, refusalText(closed.refusal));
    }
  }
  if (left.branch !== null) {
    const deleted = await deleteBranch(context.client, REPO, left.branch);
    const again = await deleteBranch(context.client, REPO, left.branch);
    if (deleted.ok && deleted.value === 'deleted') left.branch = null;
    say(
      `  Branch deleted: ${deleted.ok ? deleted.value : refusalText(deleted.refusal)}; deleted again: ${again.ok ? again.value : refusalText(again.refusal)}`,
    );
    currentStep = 0;
    check(
      'A26',
      deleted.ok && deleted.value === 'deleted' && again.ok && again.value === 'already_gone',
      'deleting a branch already deleted answers 422 "Reference does not exist", read as already gone',
      `${deleted.ok ? deleted.value : refusalText(deleted.refusal)}; ${again.ok ? again.value : refusalText(again.refusal)}`,
    );
  }
  for (const machine of [context.first, context.second]) {
    if (machine) await machine.spaces.remove(machine.bare, machine.worktree);
  }
}

// ---------------------------------------------------------------------------------------------
// The result block

function run(file: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    execFile(file, args, (error, stdout) => {
      done(error ? '' : stdout);
    });
  });
}

async function scriptVersion(): Promise<string> {
  const commit = (await run('git', ['-C', CHECKOUT, 'rev-parse', 'HEAD'])).trim() || 'unknown';
  const changes = (await run('git', ['-C', CHECKOUT, 'status', '--porcelain'])).trim();
  return changes ? `${commit} with local changes` : commit;
}

async function readGitVersion(): Promise<string> {
  const text = await run(gitExecutable(), ['--version']);
  const found = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!found) return `unknown (${text.trim()})`;
  const [major, minor] = [Number(found[1]), Number(found[2])];
  const [needMajor, needMinor] = GIT_MINIMUM;
  const enough = major > needMajor || (major === needMajor && minor >= needMinor);
  return `${found[0]} (the daemon needs ${String(needMajor)}.${String(needMinor)} or later${enough ? '' : ': TOO OLD'})`;
}

async function printResult(): Promise<number> {
  for (const [step] of STEPS) {
    if (!stepVerdicts.has(step)) stepVerdicts.set(step, { verdict: 'NOT ATTEMPTED', failures: [] });
  }
  say();
  say('===== Result: paste this block back =====');
  say(`Script: ${await scriptVersion()}`);
  say(`Git: ${gitVersion}`);
  say(`Step 0 (the token check): ${tokenLines.join('; ') || 'not reached'}`);
  for (const [step, title] of STEPS) {
    const kept = stepVerdicts.get(step);
    say(`Step ${String(step)}: ${kept?.verdict ?? 'NOT ATTEMPTED'} (${title})`);
    for (const failure of kept?.failures ?? []) say(quoted(failure, 8));
  }
  for (const assumption of ASSUMPTIONS) {
    const kept = assumptionVerdicts.get(assumption);
    const verdict = kept?.verdict ?? 'NOT ATTEMPTED';
    say(`${assumption}: ${verdict}`);
    if (verdict === 'FAIL') for (const answer of kept?.answers ?? []) say(quoted(answer, 6));
  }
  if (cleanUpFailures.length > 0) {
    say('Clean-up: FAIL');
    for (const failure of cleanUpFailures) say(quoted(failure, 8));
  }
  say('===== End of the result =====');
  const failed =
    cleanUpFailures.length > 0 ||
    [...stepVerdicts.values()].some((kept) => kept.verdict === 'FAIL') ||
    [...assumptionVerdicts.values()].some((kept) => kept.verdict === 'FAIL');
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Main

async function main(): Promise<number> {
  const token = await readToken();
  if (token === '') {
    say('STOPPED: no token was given. Nothing was done on GitHub.');
    return 3;
  }
  secrets.push(token);
  const client = createGitHubClient({ apiUrl: API_URL, token, timeoutSeconds: 30 });

  const identity = await inspectToken(client);
  if (!identity.valid) {
    say('STOPPED: GitHub refused the token (401 Bad credentials). Nothing was done on GitHub.');
    return 3;
  }
  const repository = await findRepository(client, REPO);
  if (repository === null) {
    say(
      `REFUSED: ${OWNER}/${NAME} does not exist, or the token cannot see it (give the token access to it).`,
    );
    say('Nothing was done on GitHub.');
    return 3;
  }
  gitVersion = await readGitVersion();
  say(
    `Token of ${identity.account}; repository ${OWNER}/${NAME} (default branch ${repository.defaultBranch}).`,
  );
  say(`Git: ${gitVersion}`);

  const context: Context = {
    client,
    account: { login: identity.account, id: identity.accountId },
    baseBranch: repository.defaultBranch,
    token,
  };
  const interrupted = () => {
    say();
    say('Stopped (Ctrl+C).');
    void printResult().then(() => {
      sayLeft();
      process.exit(3);
    });
  };
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);

  await stepZero(context);
  let stopped = false;
  try {
    await stepOne(context);
    await stepTwo(context);
    await stepThree(context);
    await stepFour(context);
    await stepFive(context);
  } catch (error) {
    if (!(error instanceof Stop)) {
      check(
        null,
        false,
        'the script failed',
        error instanceof Error ? error.message : String(error),
      );
      endStep();
    }
    stopped = true;
  }
  say();
  say('Steps 6 to 10 come with step E3 of the lot 3 plan: NOT ATTEMPTED.');
  if (stopped) {
    say();
    say(`STOPPED at step ${String(currentStep)}.`);
    const code = await printResult();
    sayLeft();
    return Math.max(code, 1);
  }
  await cleanUp(context);
  const code = await printResult();
  sayLeft();
  if (nothingLeft()) {
    say(
      `Also on GitHub: the closed pull request and its workflow runs, in the Actions tab (${repoWeb}/actions), where each run can be deleted.`,
    );
  }
  return code;
}

if (!OWNER || !NAME || !API_URL || !GIT_URL || !SCRATCH) {
  process.stderr.write(
    'Run tools/smoke/github-smoke.sh: this helper is not meant to be run alone.\n',
  );
  process.exit(3);
}
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    say(`STOPPED: ${error instanceof Error ? error.message : String(error)}`);
    sayLeft();
    process.exit(3);
  },
);
