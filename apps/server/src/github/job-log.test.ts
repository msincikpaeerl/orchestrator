import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobLogReader, excerptHeading, type FailedStep, type LogEnd } from './job-log.js';

// The real log of the skeleton's docs-links job failing on a broken link (owner's run of
// 2026-10-06), rebuilt from a paste: see test/fixtures/github-job-log/README.md.
const REAL = readFileSync(
  join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'github-job-log', 'docs-links.log'),
  'utf8',
);

/** The failed step as the jobs answer gives it: whole seconds. */
const CHECK: FailedStep = {
  name: 'Check documentation links',
  startedAt: '2026-10-06T18:11:59Z',
  completedAt: '2026-10-06T18:12:12Z',
};

const LIMITS = { maxCharacters: 4000, maxReadBytes: 20 * 1_048_576 };

function read(
  log: string,
  steps: FailedStep[] = [CHECK],
  options: { limits?: typeof LIMITS; chunk?: number; end?: LogEnd } = {},
) {
  const reader = new JobLogReader(steps, options.limits ?? LIMITS);
  const size = options.chunk ?? log.length;
  for (let at = 0; at < log.length; at += size) reader.push(log.slice(at, at + size));
  return reader.finish(options.end ?? 'end');
}

/** The step's part as the real log holds it: the step's group to its ##[error] line. */
const EXPECTED = [
  '##[group]Run npm install --no-save --no-package-lock remark-cli@12.0.1 remark-validate-links@13.1.0 && npx remark . --frail --quiet --no-stdout',
  'npm install --no-save --no-package-lock remark-cli@12.0.1 remark-validate-links@13.1.0 && npx remark . --frail --quiet --no-stdout',
  'shell: /usr/bin/bash -e {0}',
  '##[endgroup]',
  'npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me',
  '',
  'added 196 packages in 12s',
  '',
  '84 packages are looking for funding',
  '  run `npm fund` for details',
  'docs/orchestrator-smoke.md',
  '5:3-5:70 warning Cannot find file `orchestrator-smoke-missing.md`; did you mean `orchestrator-smoke.md` missing-file remark-validate-links:missing-file',
  '',
  '⚠ 1 warning',
  '##[error]Process completed with exit code 1.',
].join('\n');

describe("a failed step's part of a real job log", () => {
  it("runs from the step's group to its ##[error] line, without the post steps' clean-up", () => {
    const { excerpts, facts } = read(REAL);
    expect(excerpts).toEqual([
      { step: 'Check documentation links', cut: 'step', text: EXPECTED, truncated: false },
    ]);
    expect(facts).toEqual({
      lines: 191,
      timestamped: 191,
      groups: 16,
      errors: 1,
      byteOrderMark: false,
      escapes: 16,
    });
    // What the end of the whole log is instead: the checkout's clean-up, the owner's finding.
    expect(REAL.trimEnd().endsWith('Cleaning up orphan processes')).toBe(true);
    expect(EXPECTED).not.toContain('Post job cleanup.');
  });

  it('is the same with a byte order mark, without colour codes, and read in small chunks', () => {
    const withMark = read(`\ufeff${REAL}`);
    expect(withMark.excerpts[0]?.text).toBe(EXPECTED);
    expect(withMark.facts).toMatchObject({ byteOrderMark: true, lines: 191, timestamped: 191 });
    // As the paste gave it: the colour codes without their escape character are kept as text.
    // eslint-disable-next-line no-control-regex -- the escape character of the colour codes
    const plain = read(REAL.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(plain.excerpts[0]?.text).toBe(EXPECTED);
    expect(plain.facts.escapes).toBe(0);
    for (const chunk of [1, 7, 4096])
      expect(read(REAL, [CHECK], { chunk }).excerpts[0]?.text).toBe(EXPECTED);
    expect(read(REAL.replace(/\n/g, '\r\n')).excerpts[0]?.text).toBe(EXPECTED);
  });

  it('keeps the end on whole lines when longer than Longest CI log excerpt', () => {
    const [excerpt] = read(REAL, [CHECK], { limits: { ...LIMITS, maxCharacters: 200 } }).excerpts;
    expect(excerpt).toMatchObject({ cut: 'step', truncated: true });
    expect(excerpt?.text).toBe(EXPECTED.split('\n').slice(-3).join('\n'));
    expect(excerptHeading(excerpt ?? EXPECTED_STEP)).toBe(
      'Step "Check documentation links": its part of the job\'s log (its end only).',
    );
  });

  it('stops reading once every failed step is cut and its time is over', () => {
    const reader = new JobLogReader(
      [
        {
          name: 'Run actions/checkout@v7.0.1',
          startedAt: '2026-10-06T18:11:57Z',
          completedAt: '2026-10-06T18:11:57Z',
        },
      ],
      LIMITS,
    );
    const withError = REAL.replace(
      '2026-10-06T18:11:57.9929693Z ##[endgroup]',
      '2026-10-06T18:11:57.9929693Z ##[error]Checkout failed',
    );
    const lines = withError.split('\n');
    // Wanted until the first line after 18:11:58, the end of its time.
    const until = lines.findIndex((line) => line.startsWith('2026-10-06T18:11:58'));
    for (const [index, line] of lines.entries()) {
      const wanted = reader.push(`${line}\n`);
      expect(wanted, `line ${String(index + 1)}`).toBe(index < until);
      if (!wanted) break;
    }
    expect(reader.finish('enough').excerpts[0]).toMatchObject({ cut: 'step' });
  });

  it('masks secrets in every excerpt', () => {
    const token = `github_pat_${'A1b2'.repeat(10)}`;
    const leaky = REAL.replace('added 196 packages in 12s', `added 196 packages with ${token}`);
    const [step] = read(leaky).excerpts;
    expect(step?.text).toContain('added 196 packages with [hidden]');
    const [job] = read(
      REAL.replace('##[error]', 'error').replace(
        'Cleaning up orphan processes',
        `Cleaning up ${token}`,
      ),
    ).excerpts;
    expect(job?.cut).toBe('job');
    expect(job?.text.endsWith('Cleaning up [hidden]')).toBe(true);
  });
});

const EXPECTED_STEP = { step: '', cut: 'step' as const, text: '', truncated: false };

describe('when the step cannot be cut, the end of the job, and why', () => {
  const end = (log: string) => log.trimEnd().split('\n').slice(-1)[0];

  it.each<[string, FailedStep[], string, string?]>([
    [
      'no times for the step',
      [{ ...CHECK, startedAt: null }],
      'GitHub gave no start or end time for the step',
    ],
    [
      'no line within its times',
      [{ ...CHECK, startedAt: '2026-10-06T19:00:00Z', completedAt: '2026-10-06T19:00:05Z' }],
      "no line of the log falls within the step's times",
    ],
    [
      'no ##[error] line within its times',
      [
        {
          ...CHECK,
          name: 'Run actions/checkout@v7.0.1',
          startedAt: '2026-10-06T18:11:57Z',
          completedAt: '2026-10-06T18:11:58Z',
        },
      ],
      "no ##[error] line falls within the step's times",
    ],
    ['no timestamps', [CHECK], "the log's lines carry no timestamp", 'strip'],
  ])('%s', (_what, steps, reason, change) => {
    const log = change === 'strip' ? REAL.replace(/^\S+Z ?/gm, '') : REAL;
    const [excerpt] = read(log, steps).excerpts;
    expect(excerpt).toMatchObject({ cut: 'job', reason, readToEnd: true, truncated: true });
    expect(excerpt?.text.endsWith('Cleaning up orphan processes')).toBe(true);
    expect(end(REAL)).toMatch(/Cleaning up orphan processes$/);
    expect(excerptHeading(excerpt ?? EXPECTED_STEP)).toBe(
      `Step "${steps[0]?.name ?? ''}": its part of the log could not be cut out (${reason}). Below is the end of the whole job's log (its end only), not the step's part.`,
    );
  });

  it('beyond Longest CI log read, says only the first part was read', () => {
    const limits = { maxCharacters: 4000, maxReadBytes: 2 * 1_048_576 };
    const half = REAL.slice(0, REAL.indexOf('##[error]') - 29);
    const [excerpt] = read(half, [CHECK], { limits, end: 'ceiling' }).excerpts;
    expect(excerpt).toMatchObject({
      cut: 'job',
      readToEnd: false,
      reason:
        "the job's log is larger than Longest CI log read (2 MB), and the step's part does not end within its first 2 MB",
    });
    // The line the ceiling cut is not used.
    expect(excerpt?.text.endsWith('⚠ 1 warning')).toBe(true);
    expect(excerptHeading(excerpt ?? EXPECTED_STEP)).toContain(
      "Below is the end of the part of the job's log that was read",
    );
  });

  it('a job without a failed step gives the end of its log', () => {
    const [excerpt] = read(REAL, []).excerpts;
    expect(excerpt).toMatchObject({
      step: '',
      cut: 'job',
      reason: 'GitHub names no failed step in the job',
    });
    expect(excerptHeading(excerpt ?? EXPECTED_STEP)).toMatch(/^The job's failed step is not known/);
  });
});
