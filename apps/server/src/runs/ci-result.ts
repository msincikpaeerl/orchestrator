import { maskSecrets, type CiCheck } from '@orchestrator/protocol';
import { z } from 'zod';
import type { CommitStatus, WorkflowRun } from '../github/ci.js';

// The CI result of a submission (04, section 3.1; lot 3 step G1a): every GitHub Actions workflow
// run of the commit pushed at the submission, plus that commit's statuses. A run of another
// commit is never part of it, whatever GitHub answered (owner's answer 1, step G1). Names are
// anyone's text: secrets masked before they reach an agent or a screen (lot 3 step G1b).

/** GitHub's conclusions that pass: success, and skipped or neutral (04, section 3.1). */
const PASSING = ['success', 'skipped', 'neutral'];

/** A link GitHub gave, kept only when it is one: a status's `target_url` is anyone's text. */
function link(url: string | null): string | null {
  if (url === null) return null;
  const masked = maskSecrets(url);
  return z.url().safeParse(masked).success ? masked : null;
}

/**
 * Each workflow run of `commit` and each status, as one check: a run not completed is pending;
 * completed, it passed with a passing conclusion and failed with any other (failure, cancelled,
 * timed out, and the rest: the safe side). A status passes on `success`, fails on `error` or
 * `failure`. Runs of another commit are left out.
 */
export function ciChecks(commit: string, runs: WorkflowRun[], status: CommitStatus): CiCheck[] {
  const fromRuns = runs
    .filter((run) => run.headSha === commit)
    .map((run): CiCheck => ({
      kind: 'workflow_run',
      name: run.name === '' ? `Workflow run ${String(run.id)}` : maskSecrets(run.name),
      state:
        run.status !== 'completed'
          ? 'pending'
          : PASSING.includes(run.conclusion ?? '')
            ? 'passed'
            : 'failed',
      url: link(run.url),
      run_id: run.id,
    }));
  const fromStatuses = status.statuses.map((each): CiCheck => ({
    kind: 'status',
    name: maskSecrets(each.context),
    state: each.state === 'success' ? 'passed' : each.state === 'pending' ? 'pending' : 'failed',
    url: link(each.targetUrl),
    run_id: null,
  }));
  return [...fromRuns, ...fromStatuses];
}

/**
 * The state of the checks: `none` when there is none (the caller decides between waiting, "No
 * CI found" and a conflict); `pending` while one is not completed; then `failed` when one failed,
 * else `passed`.
 */
export function ciChecksState(checks: CiCheck[]): 'none' | 'pending' | 'passed' | 'failed' {
  if (checks.length === 0) return 'none';
  if (checks.some((check) => check.state === 'pending')) return 'pending';
  return checks.some((check) => check.state === 'failed') ? 'failed' : 'passed';
}
