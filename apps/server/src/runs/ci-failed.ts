import { FIRST_MESSAGE_MAX_BYTES, type CiResult } from '@orchestrator/protocol';
import type { Templates } from '../agents/files.js';
import { fill, part } from '../agents/messages.js';
import { ciOutput, keepEnd } from './ci-status.js';

// The message of a CI round (04, section 3.1; owner's answers 1, 5 and 8, lot 3 step G2b): a
// failed CI result or a conflict sent back to the agent, from the template `ci-failed.md`, whose
// excerpts are introduced by the sentences of `ci-status.md`. Every excerpt is quoted output in a
// fenced block it cannot close; the whole text stays within FIRST_MESSAGE_MAX_BYTES, since a
// closed session gets it as `run.resume`'s command-line argument, the excerpts cut the longest
// first with a marker, the list of failed jobs and steps always complete.

export interface CiRoundText {
  kind: 'failed' | 'conflict';
  /** This round's number, from 1, and **Most CI failures per run** as the run keeps it. */
  round: number;
  max: number;
  commit: string;
  base: string;
  /** The result the round sends: for a failure, with its failed jobs and their excerpts. */
  result: CiResult;
  settings: { githubPollSeconds: number; ciLogReadMaxMegabytes: number };
}

/**
 * A fence longer than any run of backticks in `text` (at least three): a fenced block closes only
 * on a fence at least as long, so the excerpt cannot close its own block.
 */
export function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

export function ciFailedMessage(
  templates: Pick<Templates, 'ci-failed' | 'ci-status'>,
  round: CiRoundText,
  maxBytes = FIRST_MESSAGE_MAX_BYTES,
): string {
  const t = templates['ci-failed'];
  const values = {
    commit: round.commit,
    base: round.base,
    round: String(round.round),
    max: String(round.max),
  };
  const intro =
    round.kind === 'conflict'
      ? part(t, 'intro-conflict', values)
      : part(t, round.round === 1 ? 'intro-failed-first' : 'intro-failed-again', values);
  const left = round.max - round.round;
  const closing = [
    round.kind === 'conflict'
      ? part(t, 'closing-conflict', values)
      : part(t, 'closing-failed', values),
    left <= 0
      ? part(t, 'last-round')
      : left === 1
        ? part(t, 'rounds-left-one')
        : part(t, 'rounds-left-many', { left: String(left) }),
  ].join(' ');

  const link = (url: string | null) => (url === null ? '' : part(t, 'link', { url }));
  const output = ciOutput(templates['ci-status'], round.result, round.settings);
  const steps = output.failed_jobs.flatMap((job) => job.failed_steps);

  const render = (): string => {
    const sections: string[] = [];
    if (round.kind === 'failed') {
      const checks = round.result.checks
        .filter((check) => check.state === 'failed')
        .map((check) =>
          part(t, check.kind === 'status' ? 'check-status' : 'check-workflow-run', {
            name: check.name,
            state: part(t, check.cancelled ? 'check-cancelled' : 'check-failed'),
            link: link(check.url),
          }),
        );
      if (checks.length > 0) sections.push(part(t, 'checks', { checks: checks.join('\n') }));
      for (const job of output.failed_jobs) {
        sections.push(
          part(t, 'job', { job: job.job, workflow: job.workflow, link: link(job.url) }),
        );
        for (const step of job.failed_steps) {
          sections.push(step.about);
          if (step.log !== null) {
            const marker = fence(step.log);
            sections.push(`${marker}\n${step.log}\n${marker}`);
          }
        }
      }
      for (const job of output.logs_not_read.jobs) {
        const named = { job: job.job, workflow: job.workflow, link: link(job.url) };
        sections.push(
          job.failed_steps.length === 0
            ? part(t, 'job-not-read-no-step', named)
            : part(t, 'job-not-read', {
                ...named,
                steps: job.failed_steps.map((step) => part(t, 'step-name', { step })).join(', '),
              }),
        );
      }
      const problem = round.result.jobs_problem;
      if (!round.result.jobs_read && problem !== null) {
        sections.push(
          part(t, 'jobs-problem', {
            problem: problem.message === '' ? problem.reason : problem.message,
          }),
        );
      }
    }
    const failures = sections.length === 0 ? '' : `\n\n${sections.join('\n\n')}`;
    return `${fill(t, t.main, { intro, failures, closing })}\n`;
  };

  // The longest excerpt first, down to the next longest at most, until the whole fits.
  let text = render();
  for (let turn = 0; turn < 10_000 && bytes(text) > maxBytes; turn++) {
    const logs = steps.filter((step) => step.log !== null);
    const longest = logs.reduce<(typeof logs)[number] | null>(
      (most, step) => ((step.log?.length ?? 0) > (most?.log?.length ?? 0) ? step : most),
      null,
    );
    const length = longest?.log?.length ?? 0;
    const markerOnly = keepEnd(templates['ci-status'], longest?.log ?? '', 0).length;
    if (longest === null || length <= markerOnly) break;
    const second = Math.max(
      0,
      ...logs.map((step) => step.log?.length ?? 0).filter((size) => size < length),
    );
    // A character is at least one byte: cutting as many characters as bytes are over is enough.
    const over = bytes(text) - maxBytes + 50;
    const target = Math.max(second, length - over);
    longest.log = keepEnd(
      templates['ci-status'],
      longest.log ?? '',
      Math.max(0, Math.min(target, length - 100)),
    );
    text = render();
  }
  return text;
}
