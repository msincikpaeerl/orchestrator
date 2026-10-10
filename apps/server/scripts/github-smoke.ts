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
import {
  listCommitRuns,
  listRunJobs,
  readCommitStatus,
  readFailedStepLogs,
} from '../src/github/ci.js';
import type { WorkflowJob, WorkflowRun } from '../src/github/ci.js';
import { createGitHubClient, type GitHubClient } from '../src/github/client.js';
import {
  closePullRequest,
  deleteBranch,
  findPullRequests,
  isPullRequestMerged,
  openPullRequest,
  postReview,
  readPullRequest,
  reopenPullRequest,
  type PullRequest,
} from '../src/github/pull-requests.js';
import { findRepository } from '../src/github/repositories.js';
import { excerptHeading } from '../src/github/job-log.js';
import { checkToken, inspectToken } from '../src/github/token-check.js';
import {
  branchHead,
  mergeMethod,
  readCommit,
  updatePullRequestBranch,
} from './github-smoke-reads.js';

// The Node.js helper of tools/smoke/github-smoke.sh (lot 3 plan, step E): the owner's check of
// the real GitHub, with no Claude quota. The script reads the token from the terminal and gives
// it here as the first line of standard input (the second, restricted token of step 10 as the
// second line); they live only in this process's memory. Every
// GitHub request uses the server's GitHub layer, and every fetch and push the daemon's own
// workspace code (`Workspaces`, ADR 0034), fed the token through a credential source: the
// daemon's one-shot credential socket hands it to the daemon's `git-credential` command, which
// Git runs, exactly as in a run, with this process in the server's place.
//
// Everything printed goes through `say`, which masks the tokens.

const options = parseArgs({
  options: {
    repository: { type: 'string' },
    'api-url': { type: 'string' },
    'git-url': { type: 'string' },
    scratch: { type: 'string' },
    'ci-wait-minutes': { type: 'string', default: '15' },
    'owner-wait-minutes': { type: 'string', default: '30' },
    'restricted-token': { type: 'boolean', default: false },
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
const OWNER_WAIT_MINUTES = Number(options['owner-wait-minutes']);
/** Whether the owner gives the second, restricted token (step 10). */
const RESTRICTED = options['restricted-token'];
/** How often GitHub is read while waiting; the dry run's fake answers at once. */
const POLL_MS = DRY_RUN ? 50 : 5_000;
/** How often GitHub is read while the owner acts on GitHub's site (15 seconds). */
const OWNER_POLL_MS = DRY_RUN ? 50 : 15_000;
/** A minute of waiting; a second in the dry run, so its test of a wait that gives up is short. */
const MINUTE_MS = DRY_RUN ? 1_000 : 60_000;
const CHECKOUT = resolve(import.meta.dirname, '..', '..', '..');
/** The file the script's commits change: a page of documentation, checked by the skeleton's CI. */
const PAGE = 'docs/orchestrator-smoke.md';
/** The size of a log end kept, as **Longest CI log excerpt** gives it by default. */
const LOG_EXCERPT = 4_000;
/** How much of a job's log is read, as **Longest CI log read** gives it by default (20 MB). */
const LOG_READ = 20 * 1_048_576;
const LOG_LIMITS = { maxCharacters: LOG_EXCERPT, maxReadBytes: LOG_READ };

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
  [6, 'reviews on your own pull request'],
  [7, 'mergeable state'],
  [8, 'merge by you on GitHub, and its detection'],
  [9, 'a conflicting pull request, closed by you, found and reopened'],
  [10, 'the second, restricted token'],
];
const ASSUMPTIONS = [
  'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13',
  'A14', 'A15', 'A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24', 'A25', 'A26',
  'A30', 'A31',
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
  /** The run's branches on GitHub, the first one first. */
  branches: [] as string[],
  pullRequests: [] as number[],
  /** A pull request GitHub created whose number the script could not read nor find. */
  unknownPullRequest: false,
};

function nothingLeft(): boolean {
  return left.branches.length === 0 && left.pullRequests.length === 0 && !left.unknownPullRequest;
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
  for (const branch of left.branches) {
    say(
      `- branch ${branch}: ${repoWeb}/branches (the bin icon on its line), or "Delete branch" on the pull request's page once closed`,
    );
  }
}

/** What stays on GitHub by design (the plan's step E3), and what the run saw happen. */
const stays: string[] = [];
const notes: string[] = [];

function sayStays(): void {
  say('Stays on GitHub by design:');
  for (const line of stays) say(`- ${line}`);
  say(
    `- the workflow runs of this run, in the Actions tab: ${repoWeb}/actions (each can be deleted)`,
  );
}

// ---------------------------------------------------------------------------------------------
// The token, read once from standard input

/** The first `count` lines of standard input: the token, then the second token when given. */
async function readTokens(count: number): Promise<string[]> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.split('\n').length > count) break;
  }
  process.stdin.destroy();
  const lines = text.split('\n');
  return Array.from({ length: count }, (_, index) => lines[index]?.trim() ?? '');
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
/** Step 9's branch, made from the default branch as it was before the merge of step 8. */
const CONFLICT_BRANCH = `${BRANCH}-conflict`;
/** Step 10's branch, pushed with the second token: it adds a workflow file. */
const WORKFLOW_BRANCH = `${BRANCH}-workflow`;
const WORKFLOW_FILE = '.github/workflows/orchestrator-smoke.yml';
/**
 * Harmless if GitHub accepts it by mistake (the owner's addition, step E3): it runs only when
 * started by hand, and its one job only prints.
 */
const WORKFLOW = `# Pushed by the Orchestrator's smoke script (tools/smoke/github-smoke.sh) with a token that
# must be refused. It runs only when started by hand, and does nothing.
name: Orchestrator smoke test
on: workflow_dispatch
permissions: {}
jobs:
  nothing:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "Nothing to do."
`;
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
function runStart(
  account: { login: string; id: number },
  baseBranch: string,
  name = NAME,
  ticketBranch = BRANCH,
) {
  const start: RunStart['payload'] = {
    runId: randomUUID(),
    purpose: 'implement',
    subject: { kind: 'ticket', id: randomUUID(), number: 'SMOKE-1' },
    repository: {
      owner: OWNER,
      name,
      cloneUrl: cloneUrl(name),
      baseBranch,
      ticketBranch,
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
    mcpTools: [],
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

/**
 * The branch's head on GitHub; null when it does not exist, or when the answer cannot be read
 * (the step then fails, naming the fields).
 */
async function githubHead(client: GitHubClient, branch: string): Promise<string | null> {
  return readable(await branchHead(client, REPO, branch), `read the head of ${branch}`);
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
          unfinishedLog = await readFailedStepLogs(client, REPO, job, LOG_LIMITS);
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
  /** The first pull request's title, for the squash commit's message (A21). */
  pullTitle?: string;
  brokenHead?: string;
  /** Whether the repository is private (A23's reads need a permission only there). */
  privateRepository: boolean;
  /** A comment review was posted on the first pull request (step 6). */
  reviewed?: boolean;
  /** The owner merged the first pull request (step 8). */
  merged?: boolean;
  /** The default branch's head right after the merge: for this script only (step E3). */
  mergedHead?: string;
  /** The second, restricted token and its client (step 10). */
  restricted?: { token: string; client: GitHubClient };
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
  if (pushed.status === 'pushed') left.branches.push(BRANCH);
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
  context.pullTitle = `Orchestrator smoke test ${stamp}`;
  const opening = await openPullRequest(context.client, REPO, {
    head: BRANCH,
    base: context.baseBranch,
    title: context.pullTitle,
    body: "Opened by the Orchestrator's smoke script (tools/smoke/github-smoke.sh). Merge it only when the script asks you to; if the script stopped early, close this pull request and delete its branch.",
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
  // After the failure GitHub still runs the post steps (or skips those its action runs only
  // after success) and Complete job; the end of the log is their clean-up, so the excerpt an agent
  // gets is the failed step's own part (owner's third run, 2026-10-06).
  const post = links.steps.filter((step) => step.name.startsWith('Post '));
  const complete = links.steps.find((step) => step.name === 'Complete job');
  const reading = await readFailedStepLogs(context.client, REPO, links, LOG_LIMITS);
  if (!reading.ok) {
    check('A13', false, "the failed job's log through the redirect", refusalText(reading.refusal));
  } else {
    const { facts, excerpts } = reading.value;
    const excerpt = excerpts.find((each) => each.step === 'Check documentation links');
    const counts = [
      `lines: ${String(facts.lines)}, with a timestamp: ${String(facts.timestamped)}, ##[group]: ${String(facts.groups)}, ##[error]: ${String(facts.errors)}`,
      `byte order mark at the start: ${facts.byteOrderMark ? 'yes' : 'no'}; escape characters (colour codes): ${String(facts.escapes)}`,
      `post steps: ${post.map((step) => `${step.name} ${String(step.conclusion)}`).join(', ') || 'none'}; Complete job: ${String(complete?.conclusion)}`,
      `excerpt of "Check documentation links": ${
        excerpt === undefined
          ? 'none'
          : excerpt.cut === 'step'
            ? `cut by the step, ${String(excerpt.text.split('\n').length)} lines`
            : `the end of the job instead (${excerpt.reason})`
      }; holds orchestrator-smoke-missing.md: ${excerpt?.text.includes('orchestrator-smoke-missing.md') ? 'yes' : 'no'}`,
    ];
    say('  The docs-links log, as the Orchestrator reads it:');
    for (const line of counts) say(`    ${line}`);
    if (excerpt) {
      say(`  ${excerptHeading(excerpt)}`);
      say(quoted(excerpt.text, 15));
    }
    check(
      'A13',
      facts.lines > 0 &&
        facts.timestamped === facts.lines &&
        facts.errors >= 1 &&
        post.length > 0 &&
        post.every((step) => step.conclusion === 'success' || step.conclusion === 'skipped') &&
        complete?.conclusion === 'success' &&
        excerpt?.cut === 'step' &&
        excerpt.text.includes('orchestrator-smoke-missing.md'),
      "the log comes through the redirect; every line starts with a timestamp with seven decimals; after the failure the post steps run (success or skipped) and Complete job succeeds; the failed step's excerpt, cut from the log by its times and its ##[error] line, holds the broken link's file name",
      counts.join('\n'),
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

// ---------------------------------------------------------------------------------------------
// Waiting for the owner

/**
 * Says what the owner must do on GitHub, then calls `poll` every 15 seconds until it gives a
 * value, at most **--owner-wait-minutes**. Null when the wait runs out. GitHub out of reach for a
 * moment does not end the wait.
 */
async function waitForOwner<T>(lines: string[], poll: () => Promise<T | null>): Promise<T | null> {
  say();
  for (const line of lines) say(`  ${line}`);
  say(
    `  The script checks every 15 seconds, for at most ${String(OWNER_WAIT_MINUTES)} minutes (--owner-wait-minutes).`,
  );
  const until = Date.now() + OWNER_WAIT_MINUTES * MINUTE_MS;
  let unreachableSaid = false;
  for (;;) {
    try {
      const found = await poll();
      if (found !== null) return found;
    } catch (error) {
      if (error instanceof Stop) throw error;
      if (!unreachableSaid) {
        say(
          `  (GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}; trying again)`,
        );
        unreachableSaid = true;
      }
    }
    if (Date.now() > until) {
      say(`  The wait ran out after ${String(OWNER_WAIT_MINUTES)} minutes.`);
      return null;
    }
    await sleep(OWNER_POLL_MS);
  }
}

/** Removes `number` from what is left on GitHub (it is closed). */
function closedNow(number: number): void {
  left.pullRequests = left.pullRequests.filter((each) => each !== number);
}

/**
 * Reads the pull request until `done` says so: null while waiting. When its answer cannot be
 * read, the step fails once, naming the fields, and "Check if merged" and the list of the
 * branch's open pull requests answer instead (`pull` is then null).
 */
function pullWatcher(
  context: Context,
  number: number,
  branch: string,
): () => Promise<{ merged: boolean; pull: PullRequest | null } | null> {
  let unreadableSeen = false;
  return async () => {
    if (!unreadableSeen) {
      const read = await readPullRequest(context.client, REPO, number);
      if (read.ok) {
        return read.value.state === 'closed'
          ? { merged: read.value.merged, pull: read.value }
          : null;
      }
      if (!unreadable(read.refusal)) return null;
      unreadableSeen = true;
      readable(read, `read pull request #${String(number)}`);
    }
    const merged = await isPullRequestMerged(context.client, REPO, number);
    if (merged.ok && merged.value) return { merged: true, pull: null };
    const open = await findPullRequests(context.client, REPO, branch, 'open');
    if (open.ok && !open.value.some((pull) => pull.number === number)) {
      return { merged: false, pull: null };
    }
    return null;
  };
}

/** A20: what a closed pull request reads: `state`, `merged` and "Check if merged". */
async function checkClosed(
  context: Context,
  number: number,
  pull: PullRequest | null,
  merged: boolean,
): Promise<void> {
  const answer = await isPullRequestMerged(context.client, REPO, number);
  const read = pull
    ? `state ${pull.state}, merged ${String(pull.merged)}, merged_at ${pull.mergedAt ?? 'null'}`
    : 'the pull request could not be read';
  const mergeAnswer = answer.ok
    ? `GET .../merge ${answer.value ? '204' : '404'}`
    : refusalText(answer.refusal);
  check(
    'A20',
    (pull === null ||
      (pull.state === 'closed' && pull.merged === merged && (pull.mergedAt !== null) === merged)) &&
      answer.ok &&
      answer.value === merged,
    merged
      ? 'a merged pull request reads state closed, merged true, and GET .../merge answers 204'
      : 'a pull request closed without merging reads state closed, merged false, and GET .../merge answers 404',
    `${read}; ${mergeAnswer}`,
  );
}

/** Reads the pull request until `mergeable` is known (at most 20 reads), each read printed. */
async function readUntilMergeable(
  context: Context,
  number: number,
  reads: string[],
): Promise<PullRequest | null> {
  let last: PullRequest | null = null;
  for (let read = 0; read < 20; read++) {
    await sleep(DRY_RUN ? POLL_MS : 2_000);
    const again = readable(
      await readPullRequest(context.client, REPO, number),
      `read pull request #${String(number)}`,
    );
    if (again === null) break;
    last = again;
    reads.push(
      `read ${String(read + 1)}: mergeable ${String(again.mergeable)} (${again.mergeableState})`,
    );
    if (again.mergeable !== null) break;
  }
  return last;
}

/** A commit on `parent` that writes `content` to `path`, leaving every branch where it is. */
async function commitFile(
  machine: Machine,
  parent: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  const env = { GIT_INDEX_FILE: join(machine.folder, 'smoke-index') };
  const at = ['-C', machine.worktree];
  await machine.git.run([...at, 'read-tree', parent], env);
  const blob = (
    await machine.git.run([...at, 'hash-object', '-w', '--stdin'], env, content)
  ).trim();
  await machine.git.run(
    [...at, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`],
    env,
  );
  const tree = (await machine.git.run([...at, 'write-tree'], env)).trim();
  return (await machine.git.run([...at, 'commit-tree', tree, '-p', parent, '-m', message])).trim();
}

/** The default branch as the first machine fetched it at step 1, before the merge of step 8. */
async function baseAtStepOne(context: Context, machine: Machine): Promise<string> {
  const ref = `refs/remotes/origin/${context.baseBranch}`;
  return (await machine.git.run(['-C', machine.bare, 'rev-parse', ref])).trim();
}

// ---------------------------------------------------------------------------------------------
// Steps 6 to 10

async function stepSix(context: Context): Promise<void> {
  startStep(6);
  const number = context.pull;
  if (number === undefined) return stop('step 2 did not finish');
  const comment = await postReview(context.client, REPO, number, {
    event: 'COMMENT',
    body: "A comment review by the Orchestrator's smoke script: the Orchestrator posts its reviews as comments (A11).",
  });
  if (comment.ok || unreadable(comment.refusal)) context.reviewed = true;
  if (comment.ok) {
    check(
      'A11',
      comment.value.state === 'COMMENTED',
      'a comment review on your own pull request is accepted, with state COMMENTED',
      `state ${comment.value.state}`,
    );
  } else if (unreadable(comment.refusal)) {
    readable(comment, 'post a comment review');
  } else {
    check(
      'A11',
      false,
      'a comment review on your own pull request is accepted',
      refusalText(comment.refusal),
    );
  }
  const refusals: ['APPROVE' | 'REQUEST_CHANGES', string][] = [
    ['APPROVE', 'Review Can not approve your own pull request'],
    ['REQUEST_CHANGES', 'Review Can not request changes on your own pull request'],
  ];
  for (const [event, text] of refusals) {
    const posted = await postReview(context.client, REPO, number, {
      event,
      body: `An ${event} review by the Orchestrator's smoke script: GitHub must refuse it.`,
    });
    check(
      'A11',
      !posted.ok && posted.refusal.kind === 'invalid' && posted.refusal.details.includes(text),
      `${event} on your own pull request: 422 "${text}"`,
      posted.ok ? `accepted, state ${posted.value.state}` : refusalText(posted.refusal),
    );
  }
  await reviewsOnCommits(context, number);
  endStep();
}

/**
 * Comment reviews with `commit_id`, as the Orchestrator posts them (lot 3 step H3): on the pull
 * request's head (A11), on an older commit of it, and on a commit that is not in it (A30). GitHub
 * documents only that `commit_id` defaults to the most recent commit; its answers are printed.
 */
async function reviewsOnCommits(context: Context, number: number): Promise<void> {
  const pull = readable(
    await readPullRequest(context.client, REPO, number),
    'read the pull request for its head',
  );
  if (pull === null) {
    notAttempted('A11', "the pull request's head could not be read");
    notAttempted('A30', "the pull request's head could not be read");
    return;
  }
  const onHead = await postReview(context.client, REPO, number, {
    event: 'COMMENT',
    body: "A comment review on the pull request's head commit, by the Orchestrator's smoke script (A11).",
    commitId: pull.headSha,
  });
  if (!onHead.ok && unreadable(onHead.refusal)) {
    readable(onHead, 'post a comment review on the head commit');
  } else {
    check(
      'A11',
      onHead.ok && onHead.value.state === 'COMMENTED' && onHead.value.commitId === pull.headSha,
      `a comment review with commit_id the head ${pull.headSha.slice(0, 7)}: accepted, its commit_id read back`,
      onHead.ok
        ? `state ${onHead.value.state}, commit_id ${String(onHead.value.commitId)}`
        : refusalText(onHead.refusal),
    );
  }
  const older = context.stepOneHead;
  if (older === undefined || older === pull.headSha) {
    notAttempted('A30', 'no older commit of the pull request is known');
  } else {
    const onOlder = await postReview(context.client, REPO, number, {
      event: 'COMMENT',
      body: "A comment review on an older commit of the pull request, by the Orchestrator's smoke script (A30).",
      commitId: older,
    });
    if (!onOlder.ok && unreadable(onOlder.refusal)) {
      readable(onOlder, 'post a comment review on an older commit');
    } else
      check(
        'A30',
        onOlder.ok && onOlder.value.commitId === older,
        `a comment review with commit_id an older commit of the pull request (${older.slice(0, 7)}): accepted, its commit_id read back`,
        onOlder.ok
          ? `state ${onOlder.value.state}, commit_id ${String(onOlder.value.commitId)}`
          : refusalText(onOlder.refusal),
      );
  }
  const first = context.first;
  if (first === undefined) {
    notAttempted('A30', 'no commit outside the pull request is known');
    return;
  }
  const outside = await baseAtStepOne(context, first);
  const onOutside = await postReview(context.client, REPO, number, {
    event: 'COMMENT',
    body: "A comment review on a commit that is not in the pull request, by the Orchestrator's smoke script (A30).",
    commitId: outside,
  });
  if (!onOutside.ok && unreadable(onOutside.refusal)) {
    readable(onOutside, 'post a comment review on a commit not in the pull request');
    return;
  }
  const answer = onOutside.ok
    ? `accepted: state ${onOutside.value.state}, commit_id ${String(onOutside.value.commitId)}`
    : refusalText(onOutside.refusal);
  say(`  GitHub's answer for a commit not in the pull request (${outside.slice(0, 7)}): ${answer}`);
  // Either is read by the Orchestrator: accepted is posted, a 422 refused (owner's answer 2).
  check(
    'A30',
    onOutside.ok || onOutside.refusal.kind === 'invalid',
    'a comment review with commit_id a commit not in the pull request: accepted, or refused with 422 (the answer above)',
    answer,
  );
  notes.push(`Step 6: a comment review on a commit not in the pull request: ${answer}.`);
}

async function stepSeven(context: Context): Promise<void> {
  startStep(7);
  const number = context.pull;
  if (number === undefined) return stop('step 2 did not finish');
  const reads: string[] = [];
  const pull = await readUntilMergeable(context, number, reads);
  for (const line of reads) say(`  ${line}`);
  if (pull === null) {
    notAttempted('A10', 'the pull request could not be read');
  } else {
    check(
      'A10',
      pull.mergeable === true && pull.mergeableState === 'clean',
      'CI passed and no conflict: mergeable true, mergeable_state clean',
      reads.join('\n'),
    );
  }
  endStep();
}

async function stepEight(context: Context): Promise<void> {
  startStep(8);
  const number = context.pull;
  if (number === undefined) return stop('step 2 did not finish');
  const before = await githubHead(context.client, context.baseBranch);
  const link = `${repoWeb}/pull/${String(number)}`;
  const seen = await waitForOwner(
    [
      `>>> Your turn on GitHub: merge pull request #${String(number)}.`,
      `  1. Open ${link}`,
      '  2. At the bottom of the page, click the arrow beside the green merge button and choose "Create a merge commit".',
      '  3. Click "Merge pull request", then "Confirm merge". Leave the branch: do not click "Delete branch" (the script deletes it).',
      'If you choose "Squash and merge" or "Rebase and merge" instead, the merge is detected the same way and the result says which method it found.',
      'If you close it without merging, or the wait runs out (the script then closes it): step 8 fails, step 9 is not attempted (it needs the merge), and the script goes on with step 10 and the clean-up.',
    ],
    pullWatcher(context, number, BRANCH),
  );
  if (seen === null) {
    check(
      null,
      false,
      `pull request #${String(number)} was not merged within ${String(OWNER_WAIT_MINUTES)} minutes`,
    );
    const closed = await closePullRequest(context.client, REPO, number);
    if (closed.ok || unreadable(closed.refusal)) {
      closedNow(number);
      say(`  The script closed pull request #${String(number)}.`);
    } else {
      say(`  The script could not close it: ${refusalText(closed.refusal)}`);
    }
    notes.push(
      `Step 8: pull request #${String(number)} was not merged within the wait; the script closed it.`,
    );
    endStep();
    return;
  }
  closedNow(number);
  stays.push(
    `pull request #${String(number)}, ${seen.merged ? 'merged' : 'closed'}${context.reviewed ? ', with the comment reviews of step 6' : ''}: ${link}`,
  );
  await checkClosed(context, number, seen.pull, seen.merged);
  if (!seen.merged) {
    check(
      null,
      false,
      `pull request #${String(number)} was closed without merging: step 9 needs a merge`,
    );
    notes.push(`Step 8: you closed pull request #${String(number)} without merging it.`);
    endStep();
    return;
  }
  context.merged = true;

  // The merge commit: the default branch's head right after the merge. For this script only,
  // where it is printed (the owner's decision, step E3): no product code reads it.
  const head = await githubHead(context.client, context.baseBranch);
  const commit =
    head === null
      ? null
      : readable(
          await readCommit(context.client, REPO, head),
          'read the new head of the default branch',
        );
  if (head === null || commit === null || before === null) {
    notAttempted('A21', "the default branch's new head could not be read");
  } else {
    const method = mergeMethod(commit, before);
    const firstLine = commit.message.split('\n')[0] ?? '';
    const words = { merge: 'a merge commit', squash: 'a squash commit', rebase: 'a rebase' };
    say(
      `  ${context.baseBranch} is now at ${head.slice(0, 7)}: ${words[method]} (${String(commit.parents.length)} parent${commit.parents.length === 1 ? '' : 's'}), message "${firstLine}"`,
    );
    notes.push(
      `Step 8: merged by ${words[method]}; the default branch's new head ${head} has ${String(commit.parents.length)} parent(s) and the message "${firstLine}".`,
    );
    stays.push(
      `the merge of pull request #${String(number)} into ${context.baseBranch} (${words[method]}), with ${PAGE}: ${repoWeb}/commit/${head}`,
    );
    if (method === 'rebase') {
      notAttempted('A21', "a rebase keeps each commit's own message");
    } else {
      const expected =
        method === 'merge'
          ? `Merge pull request #${String(number)} from ${OWNER}/${BRANCH}`
          : `${context.pullTitle ?? ''} (#${String(number)})`;
      check(
        'A21',
        firstLine === expected,
        `the ${method === 'merge' ? 'merge' : 'squash'} commit's message: "${expected}"`,
        firstLine,
      );
    }
    context.mergedHead = head;
  }

  // A merged pull request cannot be reopened (A9).
  const reopened = await reopenPullRequest(context.client, REPO, number);
  check(
    'A9',
    !reopened.ok && reopened.refusal.kind === 'invalid',
    'reopening a merged pull request: 422',
    reopened.ok ? `reopened, state ${reopened.value.state}` : refusalText(reopened.refusal),
  );
  if (!reopened.ok) say(`  GitHub's answer: ${refusalText(reopened.refusal)}`);

  // The push runs of the merge, listed as soon as they start, never waited for (A16).
  if (context.mergedHead === undefined) {
    notAttempted('A16', "the default branch's new head could not be read");
  } else {
    const mergedHead = context.mergedHead;
    const until = Date.now() + 3 * MINUTE_MS;
    let runs: WorkflowRun[] | null = [];
    while (runs !== null && runs.length === 0 && Date.now() < until) {
      await sleep(POLL_MS);
      runs = readable(
        await listCommitRuns(context.client, REPO, mergedHead),
        'read the runs of the merge',
      );
    }
    if (runs === null) {
      notAttempted('A16', 'the runs could not be read');
    } else {
      say(`  Runs of ${mergedHead.slice(0, 7)}: ${conclusions(runs) || 'none within 3 minutes'}`);
      check(
        'A16',
        runs.length > 0 && runs.every((run) => run.event === 'push' && run.headSha === mergedHead),
        "the merge starts the default branch's push runs on its new head (not waited for)",
        conclusions(runs) || 'no run within 3 minutes',
      );
    }
  }
  endStep();
}

/** The open pull request GitHub created for `branch` with an answer the layer cannot read. */
async function pullOfConflictBranch(context: Context): Promise<number | null> {
  const found = readable(
    await findPullRequests(context.client, REPO, CONFLICT_BRANCH, 'open'),
    `find the pull request of branch ${CONFLICT_BRANCH}`,
  );
  return found?.[0]?.number ?? null;
}

async function stepNine(context: Context): Promise<void> {
  const first = context.first;
  if (!context.merged || !first) {
    say();
    say(
      'Step 9: NOT ATTEMPTED (it needs the merge of step 8: without it the second pull request would not conflict, and would start a CI run)',
    );
    return;
  }
  startStep(9);
  const base = await baseAtStepOne(context, first);
  const head = await commitFile(
    first,
    base,
    PAGE,
    `# Orchestrator smoke test\n\nWritten by the second pull request of the smoke test on ${stamp}: it conflicts with the first.\n`,
    'Orchestrator smoke test: a conflicting change',
  );
  const start = runStart(context.account, context.baseBranch, NAME, CONFLICT_BRANCH);
  const pushed = await first.spaces.push(start, first.bare, first.folder, head);
  if (pushed.status !== 'pushed') {
    check(
      null,
      false,
      `the push of ${CONFLICT_BRANCH}, made from ${context.baseBranch} before the merge`,
      pushText(pushed),
    );
    endStep();
    return;
  }
  left.branches.push(CONFLICT_BRANCH);
  say(
    `  Branch ${CONFLICT_BRANCH} at ${head.slice(0, 7)}, made from ${context.baseBranch} as it was before the merge, changes the same line.`,
  );

  const opening = await openPullRequest(context.client, REPO, {
    head: CONFLICT_BRANCH,
    base: context.baseBranch,
    title: `Orchestrator smoke test ${stamp}: a conflict`,
    body: "Opened by the Orchestrator's smoke script: it conflicts on purpose. The script closes it (with your help) and deletes its branch.",
  });
  let opened: PullRequest | null = null;
  if (opening.ok) {
    opened = opening.value;
  } else if (unreadable(opening.refusal)) {
    left.unknownPullRequest = true;
    readable(opening, 'open the second pull request');
  } else {
    check(null, false, 'open the second pull request', refusalText(opening.refusal));
    endStep();
    return;
  }
  const number = opened?.number ?? (await pullOfConflictBranch(context));
  if (number === null) return stop(`find the pull request GitHub created for ${CONFLICT_BRANCH}`);
  left.unknownPullRequest = false;
  left.pullRequests.push(number);
  const link = `${repoWeb}/pull/${String(number)}`;
  say(`  Pull request #${String(number)}: ${link}`);
  const reads = opened
    ? [`at creation: mergeable ${String(opened.mergeable)} (${opened.mergeableState})`]
    : [];
  const read = await readUntilMergeable(context, number, reads);
  for (const line of reads) say(`  ${line}`);
  if (read === null) {
    notAttempted('A19', 'the pull request could not be read');
    notAttempted('A10', 'the pull request could not be read');
  } else {
    check(
      'A19',
      (opened === null || opened.mergeable === null) && read.mergeable === false,
      'a pull request conflicting with the base branch: mergeable null at creation, then false',
      reads.join('\n'),
    );
    check(
      'A10',
      read.mergeableState === 'dirty',
      'with a conflict, mergeable_state is dirty',
      reads.join('\n'),
    );
  }

  // Update branch through the API: refused while the pull request has a conflict (A18).
  const update = await updatePullRequestBranch(context.client, REPO, number, head);
  check(
    'A18',
    !update.ok && update.refusal.kind === 'invalid',
    'Update branch through the API, with a conflict: 422',
    update.ok ? `accepted: ${update.value}` : refusalText(update.refusal),
  );
  if (!update.ok) say(`  GitHub's answer: ${refusalText(update.refusal)}`);

  // No pull_request run for a pull request with a conflict (GitHub's documentation).
  await sleep(DRY_RUN ? 500 : 30_000);
  const runs = readable(
    await listCommitRuns(context.client, REPO, head),
    'read the runs of the second pull request',
  );
  if (runs !== null) {
    check(
      null,
      runs.length === 0,
      'no CI run starts for a pull request with a conflict (30 seconds after it was opened)',
      conclusions(runs),
    );
  }

  const seen = await waitForOwner(
    [
      `>>> Your turn on GitHub: close pull request #${String(number)} without merging it.`,
      `  1. Open ${link}`,
      '  2. At the bottom of the page, click "Close pull request" (it cannot be merged: it conflicts with the first one).',
      '  Do not click "Resolve conflicts", and do not click "Delete branch" afterwards: the script reopens it, closes it again and deletes the branch.',
      'If the wait runs out: step 9 fails, and the script closes it itself and checks the rest.',
      'If you delete the branch: the reopen cannot be checked (NOT ATTEMPTED). If you resolve the conflicts on GitHub: any CI run that starts is listed in the result.',
    ],
    pullWatcher(context, number, CONFLICT_BRANCH),
  );
  if (seen === null) {
    check(
      null,
      false,
      `pull request #${String(number)} was not closed within ${String(OWNER_WAIT_MINUTES)} minutes`,
    );
    const closed = await closePullRequest(context.client, REPO, number);
    if (closed.ok || unreadable(closed.refusal)) {
      closedNow(number);
      say(`  The script closed pull request #${String(number)}.`);
    } else {
      say(`  The script could not close it: ${refusalText(closed.refusal)}`);
    }
  } else {
    closedNow(number);
    await checkClosed(context, number, seen.pull, seen.merged);
    if (seen.merged) {
      check(null, false, `pull request #${String(number)} was merged, not closed`);
      notes.push(`Step 9: pull request #${String(number)} was merged instead of closed.`);
    }
  }
  // A comment review on the closed pull request (A31, lot 3 step H3): GitHub documents nothing.
  const onClosed = await postReview(context.client, REPO, number, {
    event: 'COMMENT',
    body: "A comment review on a closed pull request, by the Orchestrator's smoke script (A31).",
    commitId: head,
  });
  if (!onClosed.ok && unreadable(onClosed.refusal)) {
    readable(onClosed, 'post a comment review on the closed pull request');
  }
  const closedAnswer = onClosed.ok
    ? `accepted: state ${onClosed.value.state}`
    : refusalText(onClosed.refusal);
  say(`  GitHub's answer for a comment review on the closed pull request: ${closedAnswer}`);
  if (onClosed.ok || !unreadable(onClosed.refusal))
    check(
      'A31',
      onClosed.ok || onClosed.refusal.kind === 'invalid',
      'a comment review on a closed pull request: accepted, or refused with 422 (the answer above)',
      closedAnswer,
    );
  notes.push(`Step 9: a comment review on the closed pull request: ${closedAnswer}.`);
  stays.push(
    `pull request #${String(number)}, closed${onClosed.ok ? ', with the comment review of step 9' : ''}: ${link}`,
  );

  // Found with state=all (A8).
  const all = readable(
    await findPullRequests(context.client, REPO, CONFLICT_BRANCH, 'all'),
    `list the pull requests of ${CONFLICT_BRANCH} with state=all`,
  );
  if (all === null) {
    notAttempted('A8', 'the list could not be read');
  } else {
    const found = all.find((pull) => pull.number === number);
    check(
      'A8',
      found?.state === 'closed',
      'a closed pull request is found with state=all',
      found ? `found, state ${found.state}` : `not found among ${String(all.length)}`,
    );
  }

  // Reopened through the API while its branch exists, then closed again (A9).
  const branchNow = await githubHead(context.client, CONFLICT_BRANCH);
  if (branchNow === null) {
    notAttempted('A9', `branch ${CONFLICT_BRANCH} was deleted, so a reopen cannot be checked`);
    left.branches = left.branches.filter((branch) => branch !== CONFLICT_BRANCH);
    notes.push(`Step 9: branch ${CONFLICT_BRANCH} was deleted on GitHub before the reopen.`);
  } else if (!seen?.merged) {
    const reopened = await reopenPullRequest(context.client, REPO, number);
    if (reopened.ok || unreadable(reopened.refusal)) left.pullRequests.push(number);
    check(
      'A9',
      reopened.ok && reopened.value.state === 'open',
      'a pull request closed without merging is reopened through the API while its branch exists',
      reopened.ok ? `state ${reopened.value.state}` : refusalText(reopened.refusal),
    );
    if (reopened.ok || unreadable(reopened.refusal)) {
      const closed = await closePullRequest(context.client, REPO, number);
      if (closed.ok || unreadable(closed.refusal)) closedNow(number);
      check(
        null,
        closed.ok,
        `pull request #${String(number)} closed again`,
        closed.ok ? '' : refusalText(closed.refusal),
      );
    }
  }

  // CI runs started on the second pull request (for example after conflicts resolved on GitHub).
  const heads = [...new Set([head, ...(branchNow === null ? [] : [branchNow])])];
  const started: WorkflowRun[] = [];
  for (const each of heads) {
    const found = await listCommitRuns(context.client, REPO, each);
    if (found.ok) started.push(...found.value);
  }
  notes.push(
    `Step 9: CI runs started on the second pull request: ${started.length === 0 ? 'none' : conclusions(started)}.`,
  );
  endStep();
}

/** How a push with the second token went: the class of GitHub's answer. */
function restrictedPushKind(
  result: PushResult,
): 'pushed' | 'denied' | 'workflow' | 'rejected' | 'other' {
  if (result.status === 'pushed') return 'pushed';
  if (/refusing to allow .* workflow/.test(result.message)) return 'workflow';
  if (/Authentication failed|Invalid username or token/.test(result.message)) return 'rejected';
  if (/Write access to repository not granted|error: 403/.test(result.message)) return 'denied';
  return 'other';
}

async function stepTen(context: Context): Promise<void> {
  const restricted = context.restricted;
  const first = context.first;
  if (!restricted || !first) {
    say();
    say(
      `Step 10: NOT ATTEMPTED (${restricted ? 'step 1 did not finish' : 'no second token: add --restricted-token, see --help'})`,
    );
    return;
  }
  startStep(10);
  const denials = (result: GitHubResult<unknown>): string =>
    result.ok
      ? 'accepted'
      : `${refusalText(result.refusal)}; X-Accepted-GitHub-Permissions: ${result.refusal.kind === 'permission_missing' ? result.refusal.permissions.join(', ') || 'none' : 'none'}`;
  const names = (result: GitHubResult<unknown>, permission: string): boolean =>
    !result.ok &&
    result.refusal.kind === 'permission_missing' &&
    result.refusal.status === 403 &&
    result.refusal.permissions.includes(permission);

  // Opening a pull request: from the first branch, which GitHub would refuse anyway (merged, or
  // already open), so the second token never creates one unless step 8 was closed unmerged.
  const opening = await openPullRequest(restricted.client, REPO, {
    head: BRANCH,
    base: context.baseBranch,
    title: 'Orchestrator smoke test: opened with the second token (must be refused)',
    body: 'The second token must not be able to open this.',
  });
  if (opening.ok) left.pullRequests.push(opening.value.number);
  else if (unreadable(opening.refusal)) left.unknownPullRequest = true;
  check(
    'A23',
    names(opening, 'pull_requests=write'),
    'opening a pull request with the second token: 403 naming pull_requests=write',
    denials(opening),
  );
  say(`  Opening a pull request: ${denials(opening)}`);
  const head = context.mergedHead ?? context.stepOneHead ?? '';
  if (!context.privateRepository) {
    notAttempted(
      'A23',
      'the repository is public: reading its runs and statuses needs no permission',
    );
  } else {
    const runs = await listCommitRuns(restricted.client, REPO, head);
    say(`  Reading Actions runs: ${denials(runs)}`);
    check(
      'A23',
      names(runs, 'actions=read'),
      'reading Actions runs with the second token: 403 naming actions=read',
      denials(runs),
    );
    const status = await readCommitStatus(restricted.client, REPO, head);
    say(`  Reading the commit status: ${denials(status)}`);
    check(
      'A23',
      names(status, 'statuses=read'),
      'reading the combined commit status with the second token: 403 naming statuses=read',
      denials(status),
    );
  }

  // A push adding a workflow file: refused without Contents write (A3), then, once the owner has
  // given Contents write, refused without Workflows (A2).
  const commit = await commitFile(
    first,
    await baseAtStepOne(context, first),
    WORKFLOW_FILE,
    WORKFLOW,
    'Orchestrator smoke test: a workflow file, pushed with a token that must be refused',
  );
  const start = runStart(context.account, context.baseBranch, NAME, WORKFLOW_BRANCH);
  const push = async (): Promise<PushResult> => {
    credential = { ok: true, username: 'x-access-token', password: restricted.token };
    try {
      return await first.spaces.push(start, first.bare, first.folder, commit);
    } finally {
      credential = { ok: true, username: 'x-access-token', password: context.token };
    }
  };
  const sayPush = (result: PushResult) => {
    say(
      `  The daemon reads the push with the second token as: ${result.status === 'pushed' ? 'pushed' : result.reason}`,
    );
    if (result.status === 'failed') say(`    Git and GitHub said:\n${quoted(result.message)}`);
  };
  // GitHub's words for a fine-grained token (the owner's run, step E3).
  const denied = 'Write access to repository not granted.';
  let result: PushResult | null = await push();
  sayPush(result);
  const kind = restrictedPushKind(result);
  if (kind === 'denied') {
    check(
      'A3',
      result.status === 'failed' && result.reason === 'refused' && result.message.includes(denied),
      `a push without Contents write: refused, "${denied}"`,
      pushText(result),
    );
    result = await waitForOwner(
      [
        '>>> Your turn on GitHub: give the second token Contents write (only you can change a token).',
        "  1. Open https://github.com/settings/personal-access-tokens and click the second token's name (orchestrator-smoke-restricted, if you named it as --help says).",
        '  2. Click "Edit". Under "Repository permissions", set "Contents" to "Read and write". Change nothing else: not "Workflows".',
        '  3. Click "Update" at the bottom. Do not click "Regenerate token": the script keeps the value you pasted and does not ask for it again.',
        'The script tries its refused push again until GitHub answers differently; you need not come back to this terminal.',
        'If you also give Workflows: GitHub accepts the push (A2 FAIL); its workflow runs only when started by hand and does nothing, and the script deletes its branch with your first token.',
        'If you regenerate or delete the token, or the wait runs out: A2 is NOT ATTEMPTED.',
      ],
      async () => {
        const again = await push();
        return restrictedPushKind(again) === 'denied' ? null : again;
      },
    );
    if (result !== null) sayPush(result);
  } else {
    notAttempted(
      'A3',
      'the second token already had Contents write when given (or GitHub refused it otherwise): no pause',
    );
    if (kind === 'other' || kind === 'rejected')
      check('A3', false, `a push without Contents write: refused, "${denied}"`, pushText(result));
  }
  const workflowText = `refusing to allow a Personal Access Token to create or update workflow \`${WORKFLOW_FILE}\` without \`workflow\` scope`;
  const after = result === null ? null : restrictedPushKind(result);
  if (result === null) {
    notAttempted('A2', `Contents write was not given within ${String(OWNER_WAIT_MINUTES)} minutes`);
    notes.push('Step 10: the second token was not given Contents write within the wait.');
  } else if (after === 'rejected') {
    notAttempted('A2', 'GitHub no longer accepts the second token (regenerated or deleted?)');
    notes.push('Step 10: GitHub stopped accepting the second token during the wait.');
  } else if (after === 'pushed') {
    left.branches.push(WORKFLOW_BRANCH);
    check(
      'A2',
      false,
      'a push adding a workflow file without Workflows write is refused',
      'GitHub accepted it: the second token has Workflows write',
    );
    await sleep(DRY_RUN ? 500 : 30_000);
    const runs = await listCommitRuns(context.client, REPO, commit);
    notes.push(
      `Step 10: the workflow file was pushed by mistake (branch ${WORKFLOW_BRANCH}, deleted at the clean-up); CI runs started by it within 30 seconds: ${runs.ok ? (runs.value.length === 0 ? 'none' : conclusions(runs.value)) : refusalText(runs.refusal)}.`,
    );
  } else {
    check(
      'A2',
      result.status === 'failed' &&
        result.reason === 'refused' &&
        result.message.includes(workflowText),
      `a push adding ${WORKFLOW_FILE} without Workflows: refused, "${workflowText}"`,
      pushText(result),
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
 * Closes the pull requests still open (also one GitHub created with an answer the script could
 * not read, found by its branch), then deletes the branches, the first one twice (A26).
 */
async function cleanUp(context: Context): Promise<void> {
  say();
  say('Clean-up');
  if (left.unknownPullRequest) {
    left.unknownPullRequest = false;
    for (const branch of [BRANCH, CONFLICT_BRANCH]) {
      const found = await findPullRequests(context.client, REPO, branch, 'open');
      if (found.ok) {
        for (const pull of found.value) {
          if (!left.pullRequests.includes(pull.number)) left.pullRequests.push(pull.number);
        }
      } else {
        left.unknownPullRequest = true;
        cleanUpFailed(`find the pull requests of ${branch}`, refusalText(found.refusal));
      }
    }
  }
  for (const number of [...left.pullRequests]) {
    const closed = await closePullRequest(context.client, REPO, number);
    // An answer that cannot be read still means GitHub closed it.
    if (closed.ok || unreadable(closed.refusal)) {
      say(`  Pull request #${String(number)} closed (GitHub keeps closed pull requests).`);
      closedNow(number);
      if (!stays.some((line) => line.startsWith(`pull request #${String(number)},`))) {
        stays.push(`pull request #${String(number)}, closed: ${repoWeb}/pull/${String(number)}`);
      }
    }
    if (!closed.ok) {
      cleanUpFailed(`close pull request #${String(number)}`, refusalText(closed.refusal));
    }
  }
  for (const branch of [...left.branches]) {
    const deleted = await deleteBranch(context.client, REPO, branch);
    const answer = (result: typeof deleted) =>
      result.ok ? result.value : refusalText(result.refusal);
    if (deleted.ok) left.branches = left.branches.filter((each) => each !== branch);
    else cleanUpFailed(`delete branch ${branch}`, answer(deleted));
    if (branch !== BRANCH) {
      say(`  Branch ${branch}: ${answer(deleted)}`);
      continue;
    }
    // GitHub may have deleted it already after the merge ("Automatically delete head branches").
    const again = await deleteBranch(context.client, REPO, branch);
    say(`  Branch ${branch}: ${answer(deleted)}; deleted again: ${answer(again)}`);
    currentStep = 0;
    check(
      'A26',
      deleted.ok && again.ok && again.value === 'already_gone',
      'deleting a branch already deleted answers 422 "Reference does not exist", read as already gone',
      `${answer(deleted)}; ${answer(again)}`,
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
  for (const note of notes) say(note);
  sayLeft();
  sayStays();
  say('===== End of the result =====');
  say(
    `Delete the token${RESTRICTED ? 's' : ''} you made for this check now: https://github.com/settings/personal-access-tokens (each token's name, then "Delete").`,
  );
  const failed =
    cleanUpFailures.length > 0 ||
    [...stepVerdicts.values()].some((kept) => kept.verdict === 'FAIL') ||
    [...assumptionVerdicts.values()].some((kept) => kept.verdict === 'FAIL');
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Main

/**
 * The second token of step 10, checked before anything is created: GitHub accepts it, it is of
 * the same account, and it sees the repository. Null, with what is wrong said, when it is not.
 */
async function restrictedToken(
  restricted: string,
  token: string,
  account: string,
): Promise<{ token: string; client: GitHubClient } | null> {
  const refuse = (why: string) => {
    say(`STOPPED: the second token (--restricted-token) ${why}. Nothing was done on GitHub.`);
    return null;
  };
  if (restricted === '') return refuse('was not given');
  if (restricted === token)
    return refuse('is the same as the first: make a second one (see --help)');
  const client = createGitHubClient({ apiUrl: API_URL, token: restricted, timeoutSeconds: 30 });
  const identity = await inspectToken(client);
  if (!identity.valid) return refuse('was refused by GitHub (401 Bad credentials)');
  if (identity.account !== account) {
    return refuse(`is of ${identity.account}, not of ${account}: make it on the same account`);
  }
  if ((await findRepository(client, REPO)) === null) {
    return refuse(`cannot see ${OWNER}/${NAME}: give it access to that repository only`);
  }
  return { token: restricted, client };
}

async function main(): Promise<number> {
  const [token = '', restricted = ''] = await readTokens(RESTRICTED ? 2 : 1);
  if (token === '') {
    say('STOPPED: no token was given. Nothing was done on GitHub.');
    return 3;
  }
  secrets.push(token);
  if (restricted !== '') secrets.push(restricted);
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
  const second = RESTRICTED ? await restrictedToken(restricted, token, identity.account) : null;
  if (RESTRICTED && second === null) return 3;
  gitVersion = await readGitVersion();
  say(
    `Token of ${identity.account}; repository ${OWNER}/${NAME} (default branch ${repository.defaultBranch}, ${repository.private ? 'private' : 'public'}).`,
  );
  if (second) say(`Second token: of ${identity.account} too, and it sees ${OWNER}/${NAME}.`);
  say(`Git: ${gitVersion}`);

  const context: Context = {
    client,
    account: { login: identity.account, id: identity.accountId },
    baseBranch: repository.defaultBranch,
    token,
    privateRepository: repository.private,
    ...(second ? { restricted: second } : {}),
  };
  const interrupted = () => {
    say();
    say('Stopped (Ctrl+C).');
    void printResult().then(() => process.exit(3));
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
    await stepSix(context);
    await stepSeven(context);
    await stepEight(context);
    await stepNine(context);
    await stepTen(context);
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
  if (stopped) {
    say();
    say(`STOPPED at step ${String(currentStep)}.`);
    const code = await printResult();
    return Math.max(code, 1);
  }
  await cleanUp(context);
  return printResult();
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
