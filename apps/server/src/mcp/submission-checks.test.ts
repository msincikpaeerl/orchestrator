import type { DodReport, WorkspaceFacts } from '@orchestrator/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTemplates, type Template } from '../agents/files.js';
import {
  checkSubmission,
  criteriaOutOfRange,
  normalisePath,
  refusal,
  workflowReason,
  type SubmissionFacts,
} from './submission-checks.js';

/** A string matching `pattern`, inside an expected value (`stringMatching` is untyped). */
const matching = (pattern: RegExp) => expect.stringMatching(pattern) as string;

let texts: Template;
beforeAll(async () => {
  texts = (await loadTemplates())['submit-checks'];
});

const HEAD = 'a'.repeat(40);
const REPORT: DodReport = {
  criteria: [
    { index: 0, status: 'met', justification: 'Done' },
    { index: 1, status: 'met', justification: 'Done' },
  ],
  tests: { paths: ['src/contact.test.ts'], justification: null },
  docs: { paths: ['docs/user/contact.md'], justification: null },
  adrs: [],
  summary: 'Adds the contact form.',
};

function workspace(overrides: Partial<WorkspaceFacts> = {}): WorkspaceFacts {
  const listed = ['docs/user/contact.md', 'src/contact.test.ts', 'src/contact.ts'];
  return {
    clean: true,
    branch: {
      name: 't/1-contact-form',
      head: HEAD,
      commitsAhead: [{ hash: 'b'.repeat(40), subject: 'Add the contact form' }],
      notOnGitHub: null,
    },
    push: { status: 'pushed', head: HEAD },
    changedFiles: { listed, count: listed.length },
    ...overrides,
  };
}

function facts(overrides: Partial<SubmissionFacts> = {}): SubmissionFacts {
  return {
    ticketType: 'feature',
    criteria: ['The contact page has a form', 'The e-mail address is checked'],
    report: REPORT,
    workspace: workspace(),
    baseBranch: 'main',
    ...overrides,
  };
}

const results = (input: SubmissionFacts) =>
  Object.fromEntries(checkSubmission(texts, input).checks.map((each) => [each.check, each]));

describe('normalisePath (04, section 3.1)', () => {
  it.each([
    ['./docs/user/a.md', 'docs/user/a.md'],
    ['docs//user///a.md', 'docs/user/a.md'],
    ['docs/user/', 'docs/user'],
    ['docs/./user/./a.md', 'docs/user/a.md'],
    ['README.md', 'README.md'],
    ['.', ''],
    ['docs/../README.md', 'docs/../README.md'],
  ])('%s gives %s', (path, expected) => {
    expect(normalisePath(path)).toEqual({ kind: 'path', path: expected });
  });

  it.each(['/etc/passwd', '../outside.md', './../x', 'docs\\a.md', 'a\0b'])(
    '%s is outside the repository',
    (path) => {
      expect(normalisePath(path)).toEqual({ kind: 'outside' });
    },
  );
});

describe('checkSubmission', () => {
  it('passes an honest submission, every check named', () => {
    const checked = checkSubmission(texts, facts());
    expect(checked.checks.map((each) => [each.check, each.result])).toEqual([
      ['criteria_met', 'passed'],
      ['worktree_clean', 'passed'],
      ['commits_ahead', 'passed'],
      ['pushed', 'passed'],
      ['type_rules', 'passed'],
      ['paths_changed', 'passed'],
    ]);
    expect(checked.workflowChanges).toBe(false);
    expect(refusal(texts, checked)).toBeNull();
  });

  it('refuses a criterion not met or not reported', () => {
    const checked = checkSubmission(
      texts,
      facts({
        report: { ...REPORT, criteria: [{ index: 0, status: 'not_met', justification: 'No' }] },
      }),
    );
    const refused = refusal(texts, checked);
    expect(refused?.code).toBe('DOD_FAILED');
    expect(refused?.message).toMatch(/^The submission is refused: 2 checks failed/);
    expect(refused?.details).toEqual([
      { check: 'criteria_met', message: matching(/^Criterion 0 is reported not_met/) },
      { check: 'criteria_met', message: matching(/^Criterion 1 is not reported/) },
    ]);
  });

  it('refuses criteria the ticket does not have, as wrong input', () => {
    const error = criteriaOutOfRange(texts, ['One'], {
      ...REPORT,
      criteria: [{ index: 3, status: 'met', justification: 'Done' }],
    });
    expect(error).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The ticket has 1 acceptance criteria (indexes 0 to 0): 3 do not exist.',
      details: [{ field: 'criteria.0.index', message: 'no criterion 3' }],
    });
  });

  it('skips the push check when the worktree is not ready to push', () => {
    const checked = results(
      facts({
        workspace: workspace({
          clean: false,
          push: null,
          branch: { ...workspace().branch, commitsAhead: [] },
        }),
      }),
    );
    expect(checked.worktree_clean?.result).toBe('failed');
    expect(checked.commits_ahead?.result).toBe('failed');
    expect(checked.pushed).toEqual({
      check: 'pushed',
      result: 'skipped',
      messages: [],
      reasons: [],
    });
  });

  it.each([
    ['diverged', /has commits this machine does not have/],
    ['refused', /GitHub refused the push/],
    ['unreachable', /GitHub could not be reached/],
  ] as const)('answers a push failed as %s with the push check only', (reason, text) => {
    const checked = checkSubmission(
      texts,
      facts({
        // Another check fails too: the agent is not told, since it can fix nothing in this run.
        report: { ...REPORT, docs: { paths: ['docs/missing.md'], justification: null } },
        workspace: workspace({ push: { status: 'failed', reason, message: 'GitHub said no' } }),
      }),
    );
    expect(checked.pushFailed).toBe(true);
    const refused = refusal(texts, checked);
    expect(refused?.message).toMatch(/not yours to fix.*end your turn now/);
    expect(refused?.details).toEqual([{ check: 'pushed', message: matching(text) }]);
    // Kept for the owner all the same.
    expect(checked.checks.find((each) => each.check === 'paths_changed')?.result).toBe('failed');
  });

  it('refuses a clean branch the daemon did not push', () => {
    const refused = refusal(
      texts,
      checkSubmission(texts, facts({ workspace: workspace({ push: null }) })),
    );
    expect(refused?.details).toEqual([
      {
        check: 'pushed',
        message: 'The branch t/1-contact-form was not pushed to GitHub by this machine.',
      },
    ]);
    expect(refused?.message).toMatch(/^The submission is refused: 1 check failed/);
  });
});

describe('listed paths (04, section 3.1)', () => {
  const withPaths = (paths: Partial<Pick<DodReport, 'tests' | 'docs' | 'adrs'>>) =>
    facts({ report: { ...REPORT, ...paths } });

  it('matches normalised paths exactly with the changed files', () => {
    const checked = results(
      withPaths({
        tests: { paths: ['./src//contact.test.ts'], justification: null },
        docs: { paths: ['docs/user/contact.md/'], justification: null },
      }),
    );
    expect(checked.paths_changed?.result).toBe('passed');
  });

  it('refuses a path outside the repository, a folder, an unchanged file and another case', () => {
    const refused = refusal(
      texts,
      checkSubmission(
        texts,
        withPaths({
          tests: { paths: ['../secrets.txt', 'src'], justification: null },
          docs: { paths: ['docs/user/other.md', 'Docs/User/Contact.md'], justification: null },
          adrs: ['/docs/adr/0001.md'],
        }),
      ),
    );
    expect(refused?.details?.map((detail) => detail.message)).toEqual([
      'tests.paths: "../secrets.txt" is outside the repository. List file paths relative to the root of your worktree, such as docs/user/contact.md.',
      'tests.paths: "src" is a folder. List the files themselves: a folder is not accepted.',
      'docs.paths: "docs/user/other.md" is not a file this branch changed (compared with origin/main). List only files you changed and committed, each by its path: a folder is not accepted.',
      'docs.paths: "Docs/User/Contact.md" is not a file this branch changed (compared with origin/main). List only files you changed and committed, each by its path: a folder is not accepted.',
      'adrs: "/docs/adr/0001.md" is outside the repository. List file paths relative to the root of your worktree, such as docs/user/contact.md.',
    ]);
    expect(new Set(refused?.details?.map((detail) => detail.check))).toEqual(
      new Set(['paths_changed']),
    );
  });

  it('never refuses a path missing from a cut list: the check says it could not be fully done', () => {
    const changed = { listed: ['src/contact.ts'], count: 40 };
    const checked = checkSubmission(
      texts,
      facts({ workspace: workspace({ changedFiles: changed }) }),
    );
    expect(refusal(texts, checked)).toBeNull();
    expect(checked.checks.find((each) => each.check === 'paths_changed')).toEqual({
      check: 'paths_changed',
      result: 'incomplete',
      messages: [
        'Could not be fully done: this machine listed 1 of the 40 files the branch changed, so 2 listed paths could not be compared.',
      ],
      reasons: [{ kind: 'files_cut', listed: 1, count: 40, unchecked: 2 }],
    });
    // A cut list still finds a folder and a path outside the repository.
    const refused = refusal(
      texts,
      checkSubmission(
        texts,
        facts({
          report: { ...REPORT, tests: { paths: ['src', '../x'], justification: null } },
          workspace: workspace({ changedFiles: changed }),
        }),
      ),
    );
    expect(refused?.details).toHaveLength(2);
  });

  it('says the check could not be done when no list was sent (protocol 1)', () => {
    const checked = checkSubmission(texts, facts({ workspace: workspace({ changedFiles: null }) }));
    expect(refusal(texts, checked)).toBeNull();
    expect(checked.checks.find((each) => each.check === 'paths_changed')).toMatchObject({
      result: 'incomplete',
      messages: ['Could not be done: this machine did not send the files the branch changed.'],
    });
    expect(checked.workflowChanges).toBe(true);
    expect(checked.workflowReason).toBe('not_listed');
  });
});

describe('rules per ticket type (04, section 3.3)', () => {
  const noDocs = { paths: [], justification: 'Nothing for the owner to read.' };

  it('a docs ticket needs a documentation path the branch changed, wherever it is', () => {
    const readme = { listed: ['README.md'], count: 1 };
    const passed = results(
      facts({
        ticketType: 'docs',
        report: {
          ...REPORT,
          tests: { paths: [], justification: 'Documentation only.' },
          docs: { paths: ['README.md'], justification: null },
        },
        workspace: workspace({ changedFiles: readme }),
      }),
    );
    expect(passed.type_rules?.result).toBe('passed');

    const refused = refusal(
      texts,
      checkSubmission(
        texts,
        facts({
          ticketType: 'docs',
          report: { ...REPORT, docs: noDocs },
        }),
      ),
    );
    expect(refused?.details).toEqual([
      { check: 'type_rules', message: matching(/^A docs ticket's deliverable/) },
    ]);
  });

  it('a spike needs an ADR or a documentation path, a justification never replacing it', () => {
    const adr = facts({
      ticketType: 'spike',
      report: { ...REPORT, docs: noDocs, adrs: ['docs/adr/0002-queue.md'] },
      workspace: workspace({ changedFiles: { listed: ['docs/adr/0002-queue.md'], count: 1 } }),
    });
    expect(results(adr).type_rules?.result).toBe('passed');
    const none = refusal(
      texts,
      checkSubmission(texts, facts({ ticketType: 'spike', report: { ...REPORT, docs: noDocs } })),
    );
    expect(none?.details?.map((detail) => detail.check)).toEqual(['type_rules']);
  });

  it('a type rule met only by a path a cut list leaves out could not be fully done', () => {
    const checked = results(
      facts({
        ticketType: 'docs',
        workspace: workspace({ changedFiles: { listed: ['src/contact.ts'], count: 9 } }),
      }),
    );
    expect(checked.type_rules?.result).toBe('incomplete');
  });

  it('a type rule not fully done says why, even when another listed path failed', () => {
    const checked = results(
      facts({
        ticketType: 'docs',
        report: { ...REPORT, tests: { paths: ['src'], justification: null } },
        workspace: workspace({ changedFiles: { listed: ['src/contact.ts'], count: 9 } }),
      }),
    );
    expect(checked.paths_changed?.result).toBe('failed');
    expect(checked.type_rules).toMatchObject({
      result: 'incomplete',
      messages: [matching(/^Could not be fully done: this machine listed 1 of the 9 files/)],
    });
  });

  it.each(['feature', 'bug', 'chore'] as const)(
    'a %s ticket has no rule beyond the form',
    (type) => {
      expect(
        results(facts({ ticketType: type, report: { ...REPORT, docs: noDocs } })).type_rules,
      ).toEqual({ check: 'type_rules', result: 'passed', messages: [], reasons: [] });
    },
  );
});

describe('the workflow flag (04, section 3.1)', () => {
  it.each([
    [['src/a.ts'], 1, null],
    [['.github/workflows/ci.yml'], 1, 'changed'],
    [['.github/workflows-notes.md'], 1, null],
    [['.GitHub/Workflows/ci.yml'], 1, null],
    [['.github/dependabot.yml'], 1, null],
    [['src/a.ts'], 2, 'not_listed'],
    // A workflow file in the part of a cut list received: the owner's answer 2, step F4.
    [['.github/workflows/ci.yml'], 2, 'changed'],
  ])('%j of %i changed files: %s', (listed, count, reason) => {
    expect(workflowReason({ listed, count })).toBe(reason);
  });

  it('is raised with its reason on the checked submission', () => {
    const changed = { listed: ['.github/workflows/ci.yml', 'src/contact.ts'], count: 2 };
    const checked = checkSubmission(texts, facts({ workspace: workspace({ changedFiles: changed }) }));
    expect(checked).toMatchObject({ workflowChanges: true, workflowReason: 'changed' });
    expect(workflowReason(null)).toBe('not_listed');
  });
});

describe('reasons for the owner (lot 3 step F4)', () => {
  it('pairs every message of a failed or incomplete check with its reason, in order', () => {
    const checked = checkSubmission(
      texts,
      facts({
        ticketType: 'docs',
        report: {
          ...REPORT,
          criteria: [{ index: 0, status: 'not_met', justification: 'No' }],
          tests: { paths: ['../secrets.txt', 'src'], justification: null },
          docs: { paths: [], justification: 'None' },
          adrs: ['docs/adr/0002-other.md'],
        },
        workspace: workspace({
          clean: false,
          push: null,
          branch: { ...workspace().branch, commitsAhead: [] },
        }),
      }),
    );
    const reasons = Object.fromEntries(checked.checks.map((each) => [each.check, each.reasons]));
    expect(reasons).toEqual({
      criteria_met: [
        { kind: 'criterion_not_met', index: 0, text: 'The contact page has a form' },
        { kind: 'criterion_missing', index: 1, text: 'The e-mail address is checked' },
      ],
      worktree_clean: [{ kind: 'uncommitted_changes' }],
      commits_ahead: [{ kind: 'no_commits', base: 'main' }],
      pushed: [],
      type_rules: [{ kind: 'docs_rule' }],
      paths_changed: [
        { kind: 'path_outside', list: 'tests', path: '../secrets.txt' },
        { kind: 'path_folder', list: 'tests', path: 'src' },
        { kind: 'path_not_changed', list: 'adrs', path: 'docs/adr/0002-other.md' },
      ],
    });
    for (const each of checked.checks) expect(each.reasons).toHaveLength(each.messages.length);
  });

  it.each([
    ['diverged', 'push_diverged'],
    ['refused', 'push_refused'],
    ['unreachable', 'push_unreachable'],
  ] as const)('gives a push failed as %s its reason', (reason, kind) => {
    const checked = results(
      facts({ workspace: workspace({ push: { status: 'failed', reason, message: 'No' } }) }),
    );
    expect(checked.pushed?.reasons).toEqual([{ kind }]);
  });

  it('gives the push not made, the spike rule and a list not sent their reasons', () => {
    expect(results(facts({ workspace: workspace({ push: null }) })).pushed?.reasons).toEqual([
      { kind: 'push_missing' },
    ]);
    const spike = results(
      facts({
        ticketType: 'spike',
        report: { ...REPORT, docs: { paths: [], justification: 'None' } },
      }),
    );
    expect(spike.type_rules?.reasons).toEqual([{ kind: 'spike_rule' }]);
    const unsent = results(
      facts({ ticketType: 'docs', workspace: workspace({ changedFiles: null }) }),
    );
    expect(unsent.paths_changed?.reasons).toEqual([{ kind: 'files_not_sent' }]);
    expect(unsent.type_rules).toMatchObject({
      result: 'incomplete',
      reasons: [{ kind: 'files_not_sent' }],
    });
  });
});
