import { describe, expect, it } from 'vitest';
import type { CommitStatus, WorkflowRun } from '../github/ci.js';
import { ciChecks, ciChecksState } from './ci-result.js';

const COMMIT = 'c'.repeat(40);
const OLDER = 'a'.repeat(40);

function run(changes: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 7,
    name: 'CI',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    headSha: COMMIT,
    headBranch: 't/1-contact-form',
    url: 'https://github.com/octo-owner/bakery/actions/runs/7',
    pullRequests: [1],
    ...changes,
  };
}

function statuses(...states: CommitStatus['statuses'][number]['state'][]): CommitStatus {
  return {
    state: 'pending',
    sha: COMMIT,
    statuses: states.map((state, index) => ({
      context: `status-${String(index)}`,
      state,
      description: null,
      targetUrl: index === 0 ? 'not a link' : null,
    })),
  };
}

describe('the CI result of a submitted commit', () => {
  it('leaves out the runs of another commit, even a green one', () => {
    const checks = ciChecks(
      COMMIT,
      [run({ headSha: OLDER }), run({ status: 'queued' })],
      statuses(),
    );
    expect(checks).toHaveLength(1);
    expect(ciChecksState(checks)).toBe('pending');
    expect(ciChecksState(ciChecks(COMMIT, [run({ headSha: OLDER })], statuses()))).toBe('none');
  });

  it('passes on success, skipped and neutral, and with successful statuses', () => {
    const checks = ciChecks(
      COMMIT,
      [run(), run({ conclusion: 'skipped' }), run({ conclusion: 'neutral' })],
      statuses('success'),
    );
    expect(ciChecksState(checks)).toBe('passed');
    // A status's link is anyone's text: kept only when it is a link.
    expect(checks.at(-1)?.url).toBeNull();
  });

  it('waits while one is pending, even when another failed', () => {
    expect(
      ciChecksState(ciChecks(COMMIT, [run({ conclusion: 'failure' })], statuses('pending'))),
    ).toBe('pending');
  });

  it('fails on failure, cancelled, timed out, any other conclusion, and failed statuses', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'stale']) {
      expect(ciChecksState(ciChecks(COMMIT, [run({ conclusion })], statuses()))).toBe('failed');
    }
    expect(ciChecksState(ciChecks(COMMIT, [run()], statuses('error')))).toBe('failed');
    expect(ciChecksState(ciChecks(COMMIT, [], statuses('failure')))).toBe('failed');
  });

  it('names a run without a workflow name by its id', () => {
    expect(ciChecks(COMMIT, [run({ name: '' })], statuses())[0]?.name).toBe('Workflow run 7');
  });
});

describe('the names GitHub gives (lot 3 step G1b)', () => {
  it('masks secrets in workflow names and status contexts, which anyone can write', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const status = statuses('success');
    status.statuses = status.statuses.map((each) => ({ ...each, context: `deploy ${token}` }));
    const checks = ciChecks(COMMIT, [run({ name: `CI ${token}` })], status);
    expect(checks.map((check) => check.name)).toEqual(['CI [hidden]', 'deploy [hidden]']);
    const linked = ciChecks(COMMIT, [run({ url: `https://example.com/?t=${token}` })], status);
    expect(linked[0]?.url).not.toContain(token);
  });

  it('keeps the workflow run id to read its jobs, none for a status', () => {
    const checks = ciChecks(COMMIT, [run()], statuses('success'));
    expect(checks.map((check) => check.run_id)).toEqual([7, null]);
  });

  it('marks the workflow runs GitHub cancelled, never a status or another conclusion (step G2b)', () => {
    const checks = ciChecks(
      COMMIT,
      [
        run({ conclusion: 'cancelled' }),
        run({ conclusion: 'failure' }),
        run({ status: 'queued', conclusion: null }),
      ],
      statuses('error'),
    );
    expect(checks.map((check) => check.cancelled)).toEqual([true, false, false, false]);
  });
});
