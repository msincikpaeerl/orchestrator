import { z } from 'zod';
import type { FakeGitHub } from './fake-github.js';

// The fake GitHub's controls as the end-to-end server offers them (test/e2e-server.ts, its
// control address): what happens on GitHub without the Orchestrator, in a repository of the
// account `octo-owner`. Bodies and answers are described there.

const OWNER = 'octo-owner';

const GitHubCommit = z.object({
  repository: z.string(),
  branch: z.string(),
  files: z.record(z.string(), z.string().nullable()),
  message: z.string(),
  /** A missing branch starts from this one; with no parent when not given. */
  from: z.string().optional(),
});
const GitHubCi = z.object({
  repository: z.string(),
  ref: z.string(),
  action: z.enum(['start', 'complete']),
  failures: z.array(z.object({ job: z.string(), step: z.string(), log: z.string() })).default([]),
});
const GitHubStatus = z.object({
  repository: z.string(),
  ref: z.string(),
  context: z.string(),
  state: z.enum(['error', 'failure', 'pending', 'success']),
  description: z.string().optional(),
});
const GitHubPullRequest = z.object({
  repository: z.string(),
  pullRequest: z.int().positive(),
  method: z.enum(['merge', 'squash', 'rebase']).optional(),
});

/** The GitHub controls; a refusal of the fake (what GitHub would not offer) answers 409. */
export function githubControl(
  github: FakeGitHub,
  url: string,
  body: unknown,
): number | { status: number; body: unknown } | undefined {
  const repository = (name: string) => github.repository(OWNER, name);
  try {
    switch (url) {
      case '/github/commit': {
        const commit = GitHubCommit.parse(body);
        return {
          status: 200,
          body: {
            sha: github.commit(
              repository(commit.repository),
              commit.branch,
              commit.files,
              commit.message,
              commit.from,
            ),
          },
        };
      }
      case '/github/ci': {
        const ci = GitHubCi.parse(body);
        const runs = github.runs(repository(ci.repository), ci.ref);
        for (const run of runs) {
          if (ci.action === 'start') github.startRun(run);
          else github.completeRun(run, ci.failures);
        }
        return { status: 200, body: { runs: runs.length } };
      }
      case '/github/status': {
        const { repository: name, ref, ...status } = GitHubStatus.parse(body);
        github.setStatus(repository(name), ref, status);
        return 204;
      }
      case '/github/merge': {
        const merge = GitHubPullRequest.parse(body);
        const sha = github.mergePullRequest(
          repository(merge.repository),
          merge.pullRequest,
          merge.method,
        );
        return { status: 200, body: { sha } };
      }
      case '/github/close': {
        const close = GitHubPullRequest.parse(body);
        github.closePullRequest(repository(close.repository), close.pullRequest);
        return 204;
      }
      case '/github/update-branch': {
        const update = GitHubPullRequest.parse(body);
        const sha = github.updatePullRequestBranch(
          repository(update.repository),
          update.pullRequest,
        );
        return { status: 200, body: { sha } };
      }
      default:
        return undefined;
    }
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return { status: 409, body: { message: (error as Error).message } };
  }
}

export const GITHUB_CONTROLS = [
  '/github/commit',
  '/github/ci',
  '/github/status',
  '/github/merge',
  '/github/close',
  '/github/update-branch',
];
