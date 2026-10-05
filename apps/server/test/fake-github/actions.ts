import type {
  CiFailure,
  FakeAccount,
  FakeJob,
  FakePullRequest,
  FakeReply,
  FakeRun,
  FakeStatus,
  FakeWorkflow,
  Json,
  RepositoryState,
} from './common.js';
import { has, notFound, paged, refuse } from './common.js';

// GitHub Actions runs and commit statuses of the fake GitHub. Sources (REST API 2026-03-10):
//
// - Which runs exist for a commit: a workflow with `pull_request` runs when a pull request is
//   opened, reopened or its head branch updated (`synchronize`), never while the pull request has
//   a merge conflict; with `push`, when a listed branch is pushed. "Events that trigger
//   workflows", section `pull_request`
//   (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
//   A `pull_request` run's `head_sha` is the pull request's head commit, which `head_sha` filters.
// - Runs: `GET /repos/{owner}/{repo}/actions/runs` (filters `head_sha`, `branch`, `event`,
//   `status`), `GET .../actions/runs/{run_id}` ("REST API endpoints for workflow runs",
//   https://docs.github.com/en/rest/actions/workflow-runs).
// - Jobs and logs: `GET .../actions/runs/{run_id}/jobs`, `GET .../actions/jobs/{job_id}`, and
//   `GET .../actions/jobs/{job_id}/logs`, which answers 302 with a `Location` "to download a
//   plain text file of logs" that "expires after 1 minute" ("REST API endpoints for workflow
//   jobs", https://docs.github.com/en/rest/actions/workflow-jobs).
// - Statuses and conclusions of runs, jobs and steps: "About status checks"
//   (https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks).
// - Commit statuses: `GET .../commits/{ref}/status`, combined state "failure if any of the
//   contexts report as error or failure, pending if there are no statuses or a context is
//   pending, success if the latest status for all contexts is success", and
//   `GET .../commits/{ref}/statuses`, newest first ("REST API endpoints for commit statuses",
//   https://docs.github.com/en/rest/commits/statuses).
// - Permissions: Actions read for every Actions endpoint, Commit statuses read for statuses.

export interface FakeContext {
  /** The fake's address: `html_url` values point to it, never to github.com. */
  url: string;
  nextId(): number;
  now(): string;
  /** A link to the job's log on the fake's log host, valid one minute. */
  logLink(job: FakeJob): string;
}

/** The skeleton's CI (templates/project-skeleton/.github/workflows/ci.yml). */
export function skeletonWorkflow(defaultBranch = 'main'): FakeWorkflow {
  return {
    name: 'CI',
    path: '.github/workflows/ci.yml',
    on: { pullRequest: true, pushBranches: [defaultBranch] },
    jobs: [
      {
        name: 'docs-links',
        steps: [
          'Set up job',
          'Run actions/checkout@v7.0.1',
          'Run actions/setup-node@v7.0.0',
          'Check documentation links',
          'Complete job',
        ],
      },
      { name: 'ci', steps: ['Set up job', 'Check that every job passed', 'Complete job'] },
    ],
  };
}

function hasConflict(state: RepositoryState, pull: FakePullRequest): boolean {
  const base = state.store.branch(pull.base);
  return base !== undefined && state.store.mergeTree(base, pull.headSha) === null;
}

/** Starts the runs of every workflow `event` triggers, then applies the repository's script. */
function startRuns(
  ctx: FakeContext,
  state: RepositoryState,
  event: FakeRun['event'],
  branch: string,
  sha: string,
  pull?: FakePullRequest,
): void {
  const script = state.repo.ci ?? 'queued';
  if (script === 'none') return;
  for (const [index, workflow] of (state.repo.workflows ?? []).entries()) {
    const wanted =
      event === 'push'
        ? (workflow.on.pushBranches ?? []).includes(branch)
        : workflow.on.pullRequest === true;
    if (!wanted) continue;
    const runId = ctx.nextId();
    const now = ctx.now();
    const run: FakeRun = {
      id: runId,
      runNumber: state.runs.filter((other) => other.workflow === workflow).length + 1,
      workflow,
      workflowId: index + 1,
      event,
      headSha: sha,
      headBranch: branch,
      pullRequests: pull ? [pull.number] : [],
      status: 'queued',
      conclusion: null,
      createdAt: now,
      updatedAt: now,
      jobs: workflow.jobs.map((job) => ({
        id: ctx.nextId(),
        runId,
        name: job.name,
        status: 'queued',
        conclusion: null,
        startedAt: null,
        completedAt: null,
        steps: [],
        log: null,
      })),
    };
    state.runs.push(run);
    if (script === 'success') completeRun(ctx, run, []);
    else if (script !== 'queued') completeRun(ctx, run, script.failures);
  }
}

/** A pull request opened or reopened: its `pull_request` runs, unless it has a conflict. */
export function pullRequestEvent(
  ctx: FakeContext,
  state: RepositoryState,
  pull: FakePullRequest,
): void {
  if (!hasConflict(state, pull))
    startRuns(ctx, state, 'pull_request', pull.head, pull.headSha, pull);
}

/**
 * Compares the branches with those last seen and plays the events of each change: a `push`, and
 * `synchronize` for the open pull requests of a moved head. Called after every change (a Git
 * push, a REST write, a test control).
 */
export function syncBranches(ctx: FakeContext, state: RepositoryState): void {
  const branches = state.store.branches();
  for (const [branch, sha] of branches) {
    if (state.knownBranches.get(branch) === sha) continue;
    startRuns(ctx, state, 'push', branch, sha);
    for (const pull of state.pulls) {
      if (pull.state !== 'open' || pull.head !== branch) continue;
      pull.headSha = sha;
      pull.updatedAt = ctx.now();
      pullRequestEvent(ctx, state, pull);
    }
  }
  state.knownBranches = branches;
}

/** Moves a run to `in_progress`: its jobs start, each at its first step. */
export function startRun(ctx: FakeContext, run: FakeRun): void {
  const now = ctx.now();
  run.status = 'in_progress';
  run.updatedAt = now;
  for (const job of run.jobs) {
    job.status = 'in_progress';
    job.startedAt = now;
    const steps = run.workflow.jobs.find((plan) => plan.name === job.name)?.steps ?? [];
    job.steps = steps.map((name, index) => ({
      name,
      number: index + 1,
      status: index === 0 ? 'in_progress' : 'queued',
      conclusion: null,
    }));
  }
}

/** A line of a job log: a timestamp with seven decimals, a space, the text (step E confirms). */
function logLine(time: string, text: string): string {
  return `${time.slice(0, 19)}.0000000Z ${text}`;
}

/**
 * Completes a run: every job succeeds except those with a failure, whose failing step fails
 * after printing its log and whose later steps are skipped. The run's conclusion is `failure`
 * when a job failed, else `success`.
 */
export function completeRun(ctx: FakeContext, run: FakeRun, failures: CiFailure[]): void {
  for (const failure of failures) {
    const plan = run.workflow.jobs.find((job) => job.name === failure.job);
    if (!plan?.steps.includes(failure.step)) {
      throw new Error(`${run.workflow.name} has no step "${failure.step}" in a job ${failure.job}`);
    }
  }
  if (run.status === 'queued') startRun(ctx, run);
  const now = ctx.now();
  for (const job of run.jobs) {
    const failure = failures.find((candidate) => candidate.job === job.name);
    const lines: string[] = [];
    let failed = false;
    for (const step of job.steps) {
      step.status = 'completed';
      if (failed) {
        step.conclusion = 'skipped';
        continue;
      }
      lines.push(logLine(now, `##[group]${step.name}`), logLine(now, '##[endgroup]'));
      if (failure && failure.step === step.name) {
        for (const text of failure.log.split('\n')) lines.push(logLine(now, text));
        lines.push(logLine(now, '##[error]Process completed with exit code 1.'));
        step.conclusion = 'failure';
        failed = true;
      } else {
        step.conclusion = 'success';
      }
    }
    job.status = 'completed';
    job.conclusion = failed ? 'failure' : 'success';
    job.completedAt = now;
    job.log = `${lines.join('\n')}\n`;
  }
  run.status = 'completed';
  run.conclusion = run.jobs.some((job) => job.conclusion === 'failure') ? 'failure' : 'success';
  run.updatedAt = now;
}

/** Records a commit status, as an external service would with `POST .../statuses/{sha}`. */
export function addStatus(
  ctx: FakeContext,
  state: RepositoryState,
  sha: string,
  status: Pick<FakeStatus, 'context' | 'state'> &
    Partial<Pick<FakeStatus, 'description' | 'targetUrl'>>,
): FakeStatus {
  const recorded: FakeStatus = {
    id: ctx.nextId(),
    sha,
    context: status.context,
    state: status.state,
    description: status.description ?? null,
    targetUrl: status.targetUrl ?? null,
    createdAt: ctx.now(),
  };
  state.statuses.push(recorded);
  return recorded;
}

function runJson(ctx: FakeContext, state: RepositoryState, run: FakeRun): Json {
  const repoPath = `${state.owner}/${state.repo.name}`;
  const api = `${ctx.url}/repos/${repoPath}/actions/runs/${String(run.id)}`;
  return {
    id: run.id,
    name: run.workflow.name,
    display_title: run.workflow.name,
    head_branch: run.headBranch,
    head_sha: run.headSha,
    path: run.workflow.path,
    run_number: run.runNumber,
    run_attempt: 1,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    workflow_id: run.workflowId,
    html_url: `${ctx.url}/${repoPath}/actions/runs/${String(run.id)}`,
    pull_requests: run.pullRequests.map((number) => {
      const pull = state.pulls.find((candidate) => candidate.number === number);
      return {
        id: number,
        number,
        url: `${ctx.url}/repos/${repoPath}/pulls/${String(number)}`,
        head: { ref: pull?.head ?? '', sha: run.headSha },
        base: { ref: pull?.base ?? '', sha: state.store.branch(pull?.base ?? '') ?? '' },
      };
    }),
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    jobs_url: `${api}/jobs`,
    logs_url: `${api}/logs`,
  };
}

function jobJson(ctx: FakeContext, state: RepositoryState, job: FakeJob, run: FakeRun): Json {
  const repoPath = `${state.owner}/${state.repo.name}`;
  return {
    id: job.id,
    run_id: run.id,
    run_url: `${ctx.url}/repos/${repoPath}/actions/runs/${String(run.id)}`,
    run_attempt: 1,
    head_sha: run.headSha,
    head_branch: run.headBranch,
    workflow_name: run.workflow.name,
    url: `${ctx.url}/repos/${repoPath}/actions/jobs/${String(job.id)}`,
    html_url: `${ctx.url}/${repoPath}/actions/runs/${String(run.id)}/job/${String(job.id)}`,
    status: job.status,
    conclusion: job.conclusion,
    created_at: run.createdAt,
    started_at: job.startedAt ?? run.createdAt,
    completed_at: job.completedAt,
    name: job.name,
    steps: job.steps.map((step) => ({ ...step, started_at: null, completed_at: null })),
    labels: ['ubuntu-24.04'],
  };
}

function statusJson(status: FakeStatus): Json {
  return {
    id: status.id,
    state: status.state,
    context: status.context,
    description: status.description,
    target_url: status.targetUrl,
    created_at: status.createdAt,
    updated_at: status.createdAt,
  };
}

/** A commit SHA, a branch name, `heads/<branch>` or a tag, as statuses accept. */
export function resolveRef(state: RepositoryState, ref: string): string | undefined {
  const refs = state.store.refs();
  const named =
    refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/${ref}`) ?? refs.get(`refs/tags/${ref}`);
  return named ?? state.store.commit(ref)?.sha;
}

/** The Actions and commit status endpoints; undefined when the request is none of them. */
export function actionsApi(
  ctx: FakeContext,
  account: FakeAccount,
  state: RepositoryState,
  method: string,
  rest: string,
  url: URL,
): FakeReply | undefined {
  if (method === 'GET' && rest.startsWith('/actions/')) {
    if (!has(account, 'actions', 'read')) return refuse(account, ['actions=read']);
    const findRun = (id: string) => state.runs.find((run) => String(run.id) === id);
    const findJob = (id: string) =>
      state.runs
        .flatMap((run) => run.jobs.map((job) => ({ job, run })))
        .find((found) => String(found.job.id) === id);
    if (rest === '/actions/runs') {
      const filters = url.searchParams;
      const runs = state.runs
        .filter(
          (run) =>
            (!filters.has('head_sha') || run.headSha === filters.get('head_sha')) &&
            (!filters.has('branch') || run.headBranch === filters.get('branch')) &&
            (!filters.has('event') || run.event === filters.get('event')) &&
            (!filters.has('status') ||
              run.status === filters.get('status') ||
              run.conclusion === filters.get('status')),
        )
        .reverse();
      return {
        status: 200,
        body: {
          total_count: runs.length,
          workflow_runs: paged(runs, url).map((run) => runJson(ctx, state, run)),
        },
      };
    }
    const runMatch = /^\/actions\/runs\/(\d+)(\/jobs)?$/.exec(rest);
    if (runMatch) {
      const run = findRun(runMatch[1] ?? '');
      if (!run) return notFound;
      if (!runMatch[2]) return { status: 200, body: runJson(ctx, state, run) };
      return {
        status: 200,
        body: {
          total_count: run.jobs.length,
          jobs: paged(run.jobs, url).map((job) => jobJson(ctx, state, job, run)),
        },
      };
    }
    const jobMatch = /^\/actions\/jobs\/(\d+)(\/logs)?$/.exec(rest);
    if (jobMatch) {
      const found = findJob(jobMatch[1] ?? '');
      if (!found) return notFound;
      if (!jobMatch[2]) return { status: 200, body: jobJson(ctx, state, found.job, found.run) };
      // A log exists once the job has finished (lot 3 plan, step E: to confirm).
      if (found.job.log === null) return notFound;
      return { status: 302, headers: { location: ctx.logLink(found.job) } };
    }
    return notFound;
  }

  const statusMatch = /^\/commits\/(.+)\/(status|statuses)$/.exec(rest);
  if (method === 'GET' && statusMatch) {
    if (!has(account, 'statuses', 'read')) return refuse(account, ['statuses=read']);
    if (state.store.branches().size === 0) {
      return { status: 409, body: { message: 'Git Repository is empty.' } };
    }
    const sha = resolveRef(state, decodeURIComponent(statusMatch[1] ?? ''));
    if (sha === undefined) return notFound;
    const oldestFirst = state.statuses.filter((status) => status.sha === sha);
    if (statusMatch[2] === 'statuses') {
      return { status: 200, body: paged([...oldestFirst].reverse(), url).map(statusJson) };
    }
    // The latest status of each context.
    const latest = [...new Map(oldestFirst.map((status) => [status.context, status])).values()];
    const combined = latest.some((status) => ['error', 'failure'].includes(status.state))
      ? 'failure'
      : latest.length === 0 || latest.some((status) => status.state === 'pending')
        ? 'pending'
        : 'success';
    return {
      status: 200,
      body: {
        state: combined,
        sha,
        total_count: latest.length,
        statuses: paged(latest, url).map(statusJson),
        repository: { name: state.repo.name, full_name: `${state.owner}/${state.repo.name}` },
      },
    };
  }
  return undefined;
}
