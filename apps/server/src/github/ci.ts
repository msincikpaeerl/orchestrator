import { z } from 'zod';
import { ask, refusalOf, type GitHubResult } from './answers.js';
import type { GitHubClient } from './client.js';
import { repoPath, type RepositoryRef } from './repositories.js';

// What GitHub says about CI for a commit (04 section 3.1, 06 section 4.1; lot 3 step E1): its
// GitHub Actions runs, their jobs and steps, the end of a job's log, and the commit's statuses.
// Fine-grained tokens have no Checks permission, so the Checks API is never used (02, section 3).
// Sources (REST API 2026-03-10): "REST API endpoints for workflow runs"
// (https://docs.github.com/en/rest/actions/workflow-runs), "REST API endpoints for workflow jobs"
// (https://docs.github.com/en/rest/actions/workflow-jobs) and "REST API endpoints for commit
// statuses" (https://docs.github.com/en/rest/commits/statuses). What the documentation does not
// say is in the lot 3 plan's assumptions (A12 to A17), checked by the owner's smoke script.

// Only the fields the Orchestrator uses are read, every other one is ignored; each is read as
// GitHub documents it, nullable or optional included (checked against GitHub's OpenAPI
// description in test/github-documented.test.ts).

const PAGE_SIZE = 100;

const Run = z.object({
  id: z.int().positive(),
  // Optional and nullable: a run of a workflow file without `name:` (the file's path is shown).
  name: z.string().nullish(),
  event: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  html_url: z.string(),
  pull_requests: z.array(z.object({ number: z.int().positive() })).nullable(),
});

export interface WorkflowRun {
  id: number;
  /** The workflow's name, for example `CI`. */
  name: string;
  /** `pull_request`, `push`, … */
  event: string;
  /** `queued`, `in_progress`, `completed`, … */
  status: string;
  /** Once completed: `success`, `failure`, `cancelled`, `timed_out`, `skipped`, `neutral`, … */
  conclusion: string | null;
  headSha: string;
  headBranch: string | null;
  url: string;
  pullRequests: number[];
}

/** The Actions runs whose head commit is `headSha`, newest first; only `event` ones if given. */
export async function listCommitRuns(
  client: GitHubClient,
  repo: RepositoryRef,
  headSha: string,
  event?: string,
): Promise<GitHubResult<WorkflowRun[]>> {
  const runs: WorkflowRun[] = [];
  const filter = `head_sha=${encodeURIComponent(headSha)}${event ? `&event=${encodeURIComponent(event)}` : ''}`;
  for (let page = 1; ; page++) {
    const batch = await ask(
      client,
      {
        method: 'GET',
        path: `${repoPath(repo)}/actions/runs?${filter}&per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      },
      200,
      z.object({ workflow_runs: z.array(Run) }),
    );
    if (!batch.ok) return batch;
    runs.push(
      ...batch.value.workflow_runs.map((run) => ({
        id: run.id,
        name: run.name ?? '',
        event: run.event,
        status: run.status ?? '',
        conclusion: run.conclusion,
        headSha: run.head_sha,
        headBranch: run.head_branch,
        url: run.html_url,
        pullRequests: (run.pull_requests ?? []).map((pull) => pull.number),
      })),
    );
    if (batch.value.workflow_runs.length < PAGE_SIZE) return { ok: true, value: runs };
  }
}

const Step = z.object({
  name: z.string(),
  number: z.int(),
  status: z.string(),
  conclusion: z.string().nullable(),
});

const Job = z.object({
  id: z.int().positive(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
  steps: z.array(Step).optional(),
});

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  steps: z.infer<typeof Step>[];
}

/** The jobs of a run, with their steps and conclusions. */
export async function listRunJobs(
  client: GitHubClient,
  repo: RepositoryRef,
  runId: number,
): Promise<GitHubResult<WorkflowJob[]>> {
  const jobs: WorkflowJob[] = [];
  for (let page = 1; ; page++) {
    const batch = await ask(
      client,
      {
        method: 'GET',
        path: `${repoPath(repo)}/actions/runs/${String(runId)}/jobs?per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      },
      200,
      z.object({ jobs: z.array(Job) }),
    );
    if (!batch.ok) return batch;
    jobs.push(
      ...batch.value.jobs.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        url: job.html_url,
        steps: job.steps ?? [],
      })),
    );
    if (batch.value.jobs.length < PAGE_SIZE) return { ok: true, value: jobs };
  }
}

/**
 * The end of a job's log, at most `maxCharacters` characters. GitHub answers with a redirect to
 * a link valid one minute, downloaded without the API's Authorization header (A13); a job not
 * finished yet has no log, 404 (A14).
 */
export async function readJobLogEnd(
  client: GitHubClient,
  repo: RepositoryRef,
  jobId: number,
  maxCharacters: number,
): Promise<GitHubResult<{ text: string; truncated: boolean }>> {
  const downloaded = await client.download(
    `${repoPath(repo)}/actions/jobs/${String(jobId)}/logs`,
    maxCharacters,
  );
  if (!downloaded.ok) return { ok: false, refusal: refusalOf(downloaded.response) };
  return { ok: true, value: { text: downloaded.text, truncated: downloaded.truncated } };
}

const Status = z.object({
  context: z.string(),
  state: z.enum(['error', 'failure', 'pending', 'success']),
  description: z.string().nullable(),
  target_url: z.string().nullable(),
});

const CombinedStatus = z.object({
  state: z.enum(['failure', 'pending', 'success']),
  sha: z.string(),
  total_count: z.int(),
  statuses: z.array(Status),
});

export interface CommitStatus {
  /** GitHub's combined state: `pending` with no statuses at all (A17). */
  state: 'failure' | 'pending' | 'success';
  sha: string;
  /** The latest status of each context. */
  statuses: {
    context: string;
    state: 'error' | 'failure' | 'pending' | 'success';
    description: string | null;
    targetUrl: string | null;
  }[];
}

/** The combined status of a commit (a hash or a branch). */
export async function readCommitStatus(
  client: GitHubClient,
  repo: RepositoryRef,
  ref: string,
): Promise<GitHubResult<CommitStatus>> {
  const statuses: CommitStatus['statuses'] = [];
  for (let page = 1; ; page++) {
    const batch = await ask(
      client,
      {
        method: 'GET',
        path: `${repoPath(repo)}/commits/${encodeURIComponent(ref)}/status?per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      },
      200,
      CombinedStatus,
    );
    if (!batch.ok) return batch;
    statuses.push(
      ...batch.value.statuses.map((status) => ({
        context: status.context,
        state: status.state,
        description: status.description,
        targetUrl: status.target_url,
      })),
    );
    if (statuses.length >= batch.value.total_count || batch.value.statuses.length === 0) {
      return {
        ok: true,
        value: { state: batch.value.state, sha: batch.value.sha, statuses },
      };
    }
  }
}
