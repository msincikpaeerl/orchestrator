import {
  MCP_OUTPUT_MAX_CHARACTERS,
  McpCiStatus,
  type CiExcerpt,
  type CiJobLog,
  type CiReadProblem,
  type CiResult,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../agents/files.js';
import { jsonLength } from '../mcp/output.js';
import { CI_EXCERPTS_MAX, ciOutput, fitAnswer, jobsWithLogs } from './ci-status.js';

// `ci_status`'s answer (06, section 4.1; lot 3 step G1b): the logs read job by job while each
// excerpt keeps room, the agent's sentences, and the whole within MCP_OUTPUT_MAX_CHARACTERS.

const t = (await loadTemplates())['ci-status'];
const SETTINGS = { githubPollSeconds: 60, ciLogReadMaxMegabytes: 20 };
const AT = '2026-10-09T10:00:00.000Z';
const JOB_URL = 'https://github.com/octo-owner/bakery/actions/runs/7/job/9';

function failed(jobs: CiResult['failed_jobs']): CiResult {
  return {
    state: 'failed',
    checks: [
      { kind: 'workflow_run', name: 'CI', state: 'failed', url: null, run_id: 7 },
      { kind: 'status', name: 'deploy', state: 'passed', url: null, run_id: null },
    ],
    failed_jobs: jobs,
    jobs_read: true,
    jobs_problem: null,
  };
}

const excerpt = (step: string, text: string, changes: Partial<CiExcerpt> = {}): CiExcerpt => ({
  step,
  fallback: null,
  read_to_end: true,
  text,
  cut: false,
  ...changes,
});

describe('which failed jobs get their log read (owner answer 3)', () => {
  it('reads job by job while each failed step still gets the minimum excerpt', () => {
    expect(CI_EXCERPTS_MAX).toBe(60);
    expect(jobsWithLogs([1, 1, 1], 2)).toBe(2);
    expect(jobsWithLogs([2, 1, 5, 1], 4)).toBe(2);
    expect(jobsWithLogs([1, 1], 2)).toBe(2);
  });

  it('always reads the first job, and counts a job naming no failed step as one', () => {
    expect(jobsWithLogs([5], 2)).toBe(1);
    expect(jobsWithLogs([0, 0, 0], 2)).toBe(2);
    expect(jobsWithLogs([], 2)).toBe(0);
  });
});

describe('the result as the agent reads it', () => {
  it('gives each failed step its excerpt, introduced by what it is', () => {
    const ci = ciOutput(
      t,
      failed([
        {
          workflow: 'CI',
          job: 'docs-links',
          url: JOB_URL,
          failed_steps: ['Check documentation links', 'Lint'],
          log: {
            state: 'read',
            excerpts: [
              excerpt('Check documentation links', 'Broken link', { cut: true }),
              excerpt('Lint', 'end of job', { fallback: 'no_times' }),
            ],
          },
        },
        {
          workflow: 'CI',
          job: 'ci',
          url: null,
          failed_steps: [],
          log: {
            state: 'read',
            excerpts: [excerpt('', 'job end', { fallback: 'no_failed_step' })],
          },
        },
        {
          workflow: 'CI',
          job: 'big',
          url: null,
          failed_steps: ['Build'],
          log: {
            state: 'read',
            excerpts: [excerpt('Build', 'part', { fallback: 'ceiling', read_to_end: false })],
          },
        },
      ]),
      SETTINGS,
    );
    expect(ci.checks).toEqual([
      { kind: 'workflow_run', name: 'CI', state: 'failed', url: null },
      { kind: 'status', name: 'deploy', state: 'passed', url: null },
    ]);
    expect(ci.failed_jobs.flatMap((job) => job.failed_steps)).toEqual([
      {
        step: 'Check documentation links',
        about:
          'Step "Check documentation links": its own part of the job\'s log. Only the end of it is shown.',
        log: 'Broken link',
      },
      {
        step: 'Lint',
        about:
          'Step "Lint": its part of the log could not be cut out (GitHub gave no start or end time for the step). The log below is the end of the whole job\'s log, not the step\'s part.',
        log: 'end of job',
      },
      {
        step: '',
        about:
          "GitHub names no failed step in this job. The log below is the end of the whole job's log.",
        log: 'job end',
      },
      {
        step: 'Build',
        about:
          "Step \"Build\": its part of the log could not be cut out (the job's log is larger than Longest CI log read (20 MB), and the step's part does not end within what was read). The log below is the end of the part of the job's log that was read, not the step's part.",
        log: 'part',
      },
    ]);
    expect(ci.logs_not_read).toEqual({ count: 0, jobs: [] });
  });

  it('says why a log could not be read, and when to call again', () => {
    const problem = (
      reason: CiReadProblem['reason'],
      changes: Partial<CiReadProblem> = {},
    ): CiJobLog => ({
      state: 'unavailable',
      problem: { reason, message: '', retry_at: null, at: AT, ...changes },
    });
    const job = (name: string, log: CiJobLog) => ({
      workflow: 'CI',
      job: name,
      url: null,
      failed_steps: ['Test'],
      log,
    });
    const ci = ciOutput(
      t,
      CiResultOf([
        job('expired', problem('expired')),
        job('unreachable', problem('unreachable')),
        job('limited', problem('rate_limited', { retry_at: '2026-10-09T10:30:00.000Z' })),
        job('refused', problem('permission_missing', { message: 'Resource not accessible' })),
      ]),
      SETTINGS,
    );
    expect(ci.failed_jobs.map((each) => each.failed_steps[0])).toEqual([
      {
        step: 'Test',
        about: "GitHub no longer has this job's log (it expired or was deleted).",
        log: null,
      },
      {
        step: 'Test',
        about:
          "GitHub could not be reached for this job's log: call ci_status again after 2026-10-09T10:01:00.000Z.",
        log: null,
      },
      {
        step: 'Test',
        about:
          "GitHub's request limit stopped the reading of this job's log: call ci_status again after 2026-10-09T10:30:00.000Z.",
        log: null,
      },
      {
        step: 'Test',
        about: "GitHub did not give this job's log: Resource not accessible",
        log: null,
      },
    ]);
  });

  it('lists the jobs whose log was not read, with their failed steps and their count', () => {
    const ci = ciOutput(
      t,
      failed([
        {
          workflow: 'CI',
          job: 'one',
          url: null,
          failed_steps: ['A'],
          log: { state: 'read', excerpts: [excerpt('A', 'a')] },
        },
        {
          workflow: 'CI',
          job: 'two',
          url: JOB_URL,
          failed_steps: ['B', 'C'],
          log: { state: 'not_read' },
        },
      ]),
      SETTINGS,
    );
    expect(ci.failed_jobs.map((job) => job.job)).toEqual(['one']);
    expect(ci.logs_not_read).toEqual({
      count: 1,
      jobs: [{ workflow: 'CI', job: 'two', url: JOB_URL, failed_steps: ['B', 'C'] }],
    });
  });
});

function CiResultOf(jobs: CiResult['failed_jobs']): CiResult {
  return failed(jobs);
}

function answerWith(logs: string[], notRead = 0, checks = 2): McpCiStatus {
  return {
    commit: { hash: 'c'.repeat(40), by: 'this_run', attempt: 1, submitted_at: AT },
    pull_request: null,
    read_at: AT,
    note: 'Note.',
    ci: {
      state: 'failed',
      checks: Array.from({ length: checks }, (_, index) => ({
        kind: 'status' as const,
        name: `status ${String(index)}`,
        state: 'failed' as const,
        url: null,
      })),
      failed_jobs: [
        {
          workflow: 'CI',
          job: 'job',
          url: null,
          failed_steps: logs.map((log, index) => ({
            step: `Step ${String(index)}`,
            about: 'About.',
            log,
          })),
        },
      ],
      logs_not_read: {
        count: notRead,
        jobs: Array.from({ length: notRead }, (_, index) => ({
          workflow: 'CI',
          job: `not read ${String(index)}`,
          url: null,
          failed_steps: ['Step'],
        })),
      },
    },
  };
}

const lines = (count: number, tag: string) =>
  Array.from({ length: count }, (_, index) => `${tag} line ${String(index)} "quoted"\t`).join('\n');

describe('the answer within MCP_OUTPUT_MAX_CHARACTERS', () => {
  it('leaves an answer that fits as it is', () => {
    const answer = answerWith(['short', lines(50, 'b')]);
    expect(fitAnswer(t, structuredClone(answer))).toEqual(answer);
  });

  it('cuts the longest excerpts first, each keeping its end, with a marker', () => {
    // Three excerpts at the setting's maximum (20,000 characters), escapes making them longer.
    const long = [lines(1200, 'a').slice(-20_000), lines(1200, 'b').slice(-20_000), 'short'];
    const fitted = fitAnswer(t, answerWith(long));
    expect(jsonLength(fitted)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
    expect(McpCiStatus.parse(fitted)).toEqual(fitted);
    const steps = fitted.ci?.failed_jobs[0]?.failed_steps ?? [];
    expect(steps[2]?.log).toBe('short');
    for (const [index, step] of steps.slice(0, 2).entries()) {
      expect(step.log).toMatch(
        /^\[Cut here: \d+ earlier characters of this log are not shown, because the answer would be too long for you\.\]\n/,
      );
      expect(step.log?.endsWith(long[index]?.slice(-200) ?? '')).toBe(true);
    }
    // Shared out: neither keeps nearly all the room.
    const sizes = steps.slice(0, 2).map((step) => step.log?.length ?? 0);
    expect(Math.abs((sizes[0] ?? 0) - (sizes[1] ?? 0))).toBeLessThan(2_000);
  });

  it('keeps the count of the jobs not read when their list does not fit, and says when checks are cut', () => {
    const fitted = fitAnswer(t, answerWith([lines(10, 'a')], 2_000, 2_000));
    expect(jsonLength(fitted)).toBeLessThanOrEqual(MCP_OUTPUT_MAX_CHARACTERS);
    expect(fitted.ci?.logs_not_read.count).toBe(2_000);
    expect(fitted.ci?.logs_not_read.jobs.length).toBe(0);
    const shown = fitted.ci?.checks.length ?? 0;
    expect(shown).toBeLessThan(2_000);
    expect(fitted.note).toContain(
      `${String(shown)} of the 2000 workflow runs and statuses are listed: the others did not fit in this answer.`,
    );
  });
});
