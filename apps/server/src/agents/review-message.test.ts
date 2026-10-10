import { FIRST_MESSAGE_MAX_BYTES } from '@orchestrator/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadShippedAgents, loadTemplates, type Templates } from './files.js';
import { FirstMessageTooLarge, nudgeMessage, runInstructions } from './messages.js';
import { reviewFirstMessage, type ReviewTicket } from './review-message.js';

// The first message of a review run (03, section 3.1; owner's answers 4 and 5, lot 3 step H).

let templates: Templates;

beforeAll(async () => {
  templates = await loadTemplates();
});

const commit = 'abc1234def5678abc1234def5678abc1234def56';

const sample: ReviewTicket = {
  projectName: 'Bakery website',
  reference: 'WEB-12',
  title: 'Contact form',
  type: 'feature',
  priority: 'high',
  description: 'Visitors need a way to write to the bakery.',
  acceptanceCriteria: [
    'The contact page has a form with name, e-mail address and message',
    'An invalid e-mail address is refused with a message next to the field',
  ],
  dependencies: [],
  comments: [
    {
      author: { kind: 'owner' },
      kind: 'note',
      at: new Date('2026-09-26T09:30:00Z'),
      body: 'Keep the form short: no phone number.',
    },
  ],
  earlierReviews: [],
  commit,
  pullRequest: { number: 12, url: 'https://github.com/owner/bakery/pull/12' },
  base: 'main',
  ci: 'passed',
  workflows: null,
  report: {
    criteria: [
      { index: 0, status: 'met', justification: 'ContactForm.tsx renders the three fields.' },
      { index: 1, status: 'met', justification: 'ContactForm.test.ts checks the message.' },
    ],
    tests: { paths: ['src/ContactForm.test.ts'], justification: null },
    docs: { paths: [], justification: 'The form explains itself.' },
    adrs: [],
    summary: 'Adds a contact form with client-side validation.',
  },
};

const message = (ticket: Partial<ReviewTicket> = {}) =>
  reviewFirstMessage(templates.review, { ...sample, ...ticket });

describe('the first message of a review run', () => {
  it('names the commit, the pull request and how to see the diff', () => {
    const text = message();
    expect(text).toContain('Review ticket WEB-12 of the project Bakery website');
    expect(text).toContain(`Your worktree holds commit ${commit}, the head of pull request #12`);
    expect(text).toContain('https://github.com/owner/bakery/pull/12');
    expect(text).toContain('`git diff origin/main...HEAD`');
    expect(text).toContain('`git log origin/main..HEAD`');
    expect(text).toContain('never change a file, commit or merge');
  });

  it('holds the ticket, the report as the agent account and the comments', () => {
    const text = message();
    expect(text).toContain('- [1] An invalid e-mail address is refused');
    expect(text).toContain(
      "This report is the implementing agent's own account of its work: check it against the diff, and never take it as proof by itself.",
    );
    expect(text).toContain('Adds a contact form with client-side validation.');
    expect(text).toContain('- [0] met: ContactForm.tsx renders the three fields.');
    expect(text).toContain('Tests: `src/ContactForm.test.ts`');
    expect(text).toContain(
      "Documentation: none listed; the agent's reason: The form explains itself.",
    );
    expect(text).toContain('ADRs: none');
    expect(text).toContain('Keep the form short: no phone number.');
    expect(text).toContain('(None: this is the first review of this ticket.)');
    expect(text.indexOf('own account')).toBeLessThan(text.indexOf('Adds a contact form'));
  });

  it('lists the earlier reviews apart from the comments', () => {
    const text = message({
      earlierReviews: [
        {
          author: { kind: 'agent', name: 'Quality' },
          at: new Date('2026-09-27T14:52:00Z'),
          body: '`src/ContactForm.tsx:42`: the error message is not shown.',
        },
      ],
    });
    const reviews = text.split('## Earlier reviews')[1]?.split('## Comments')[0] ?? '';
    expect(reviews).toContain('### Agent Quality, 2026-09-27 14:52 UTC');
    expect(reviews).toContain('the error message is not shown');
  });

  describe('CI (owner answer 4)', () => {
    it('with CI passed, says so and not to run the test suite again', () => {
      const text = message();
      expect(text).toContain(`CI passed on GitHub for commit ${commit}.`);
      expect(text).toContain(
        'CI already ran on GitHub: do not run the test suite again unless the diff or the CI result gives you a reason.',
      );
      expect(text).not.toContain('Nothing on GitHub tested this work');
    });

    it('with the work accepted by Check CI again, says CI passed and never that it failed', () => {
      const text = message({ ci: 'passed_later' });
      expect(text).toContain(
        `CI passed on GitHub for commit ${commit}; the owner had it read again after the agent's run ended, and the work was accepted then.`,
      );
      expect(text).toContain('CI already ran on GitHub: do not run the test suite again');
      expect(text).not.toMatch(/fail|did not finish/i);
    });

    it('with No CI found, says nothing tested it and to run the tests and build', () => {
      const text = message({ ci: 'no_ci' });
      expect(text).toContain(
        `No CI ran on GitHub for commit ${commit}: nothing appeared within Wait for CI to start after the pull request opened. Nothing on GitHub tested this work.`,
      );
      expect(text).toContain(
        "Nothing on GitHub tested this work: run the project's tests and build yourself, with the commands `CLAUDE.md` gives, when the project has any, and say in your decision what you ran.",
      );
      expect(text).not.toContain('CI already ran on GitHub');
      expect(text).not.toContain('do not run the test suite again');
    });

    it('with No CI found and workflow files changed, says both in one sentence', () => {
      const text = message({ ci: 'no_ci', workflows: 'changed' });
      expect(text).toContain(
        `No CI found for commit ${commit}, and this work changed files under .github/workflows/: it may have removed or weakened CI. Read those changes first.`,
      );
      expect(text).not.toContain('Workflow files changed:');
      expect(text).not.toContain('do not run the test suite again');
      expect(text).toContain("run the project's tests and build yourself");
    });

    it('with CI passed and workflow files changed or maybe changed, adds a line of its own', () => {
      expect(message({ workflows: 'changed' })).toContain(
        'Workflow files changed: this work changes',
      );
      expect(message({ workflows: 'not_listed' })).toContain('Workflow files may have changed:');
      expect(message({ workflows: 'not_listed' })).toContain(
        `CI passed on GitHub for commit ${commit}.`,
      );
    });
  });

  it('keeps a text containing a placeholder as written', () => {
    expect(message({ description: 'Use {{commit}} here.' })).toContain('Use {{commit}} here.');
  });
});

describe('the byte budget of the review message', () => {
  it('drops the oldest comments first, then cuts the report, then the description', () => {
    const comments = Array.from({ length: 40 }, (_, index) => ({
      author: { kind: 'owner' as const },
      kind: 'note' as const,
      at: new Date(`2026-09-26T09:${String(index).padStart(2, '0')}:00Z`),
      body: `Comment ${String(index)} ${'x'.repeat(200)}`,
    }));
    const full = message({ comments });
    const budget = Buffer.byteLength(full) - 2_000;
    const fewer = reviewFirstMessage(templates.review, { ...sample, comments }, budget);
    expect(Buffer.byteLength(fewer)).toBeLessThanOrEqual(budget);
    expect(fewer).toContain('Comment 39');
    expect(fewer).not.toContain('Comment 0 ');
    expect(fewer).toMatch(/\(\d+ earlier comments are not shown here/);

    const summary = Array.from({ length: 400 }, (_, i) => `Line ${String(i)} of the summary.`);
    const report = { ...sample.report, summary: summary.join('\n') };
    const long = message({ report });
    const cut = reviewFirstMessage(
      templates.review,
      { ...sample, report },
      Buffer.byteLength(long) - 4_000,
    );
    expect(cut).toContain('Line 0 of the summary.');
    expect(cut).not.toContain('Line 399 of the summary.');
    expect(cut).toContain('[The report is cut here because it is too long for this message.');
    expect(cut).toContain('Visitors need a way to write to the bakery.');
  });

  it('uses the protocol constant by default and throws when even the cut ticket cannot fit', () => {
    expect(Buffer.byteLength(message())).toBeLessThan(FIRST_MESSAGE_MAX_BYTES);
    expect(() => reviewFirstMessage(templates.review, sample, 500)).toThrow(FirstMessageTooLarge);
  });
});

describe('Quality and its messages (snapshot)', () => {
  it('renders the appended instructions, the first message, its No CI variant and the nudge', async () => {
    const shipped = await loadShippedAgents();
    const quality = shipped.profiles.find((profile) => profile.key === 'quality');
    const noCi = message({ ci: 'no_ci', workflows: 'changed' });
    const sections = [
      '<!-- Rendered by apps/server/src/agents/review-message.test.ts: review it with the templates. -->',
      '# Appended to the system prompt (Quality)',
      runInstructions(
        shipped.commonRules,
        quality?.instructions ?? '',
        shipped.allowlist,
        quality?.allowedTools ?? [],
      ),
      '# First message (review), CI passed',
      message({
        earlierReviews: [
          {
            author: { kind: 'agent', name: 'Quality' },
            at: new Date('2026-09-27T14:52:00Z'),
            body: '`src/ContactForm.tsx:42`: the error message is not shown.',
          },
        ],
      }),
      '# First message (review), No CI found and workflow files changed: its CI and How to decide',
      `## CI${noCi.split('## CI')[1]?.split('\n# WEB-12')[0] ?? ''}`.trimEnd(),
      `## How to decide${noCi.split('## How to decide')[1] ?? ''}`.trimEnd(),
      '# Nudge (review)',
      nudgeMessage(templates, 'review'),
    ];
    await expect(sections.join('\n\n')).toMatchFileSnapshot(
      './__snapshots__/review-messages.snapshot.md',
    );
  });
});
