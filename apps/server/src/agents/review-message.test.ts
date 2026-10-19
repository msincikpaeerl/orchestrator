import { FIRST_MESSAGE_MAX_BYTES } from '@orchestrator/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadShippedAgents, loadTemplates, type Templates } from './files.js';
import { FirstMessageTooLarge, nudgeMessage, runInstructions, runRules } from './messages.js';
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
  previous: null,
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

const reviewed = '1111111aaaaaaa1111111aaaaaaa1111111aaaaa';

/** The request the work answers: Quality's first round (owner's answer 4, lot 3 step I). */
const qualityRequest: ReviewTicket['previous'] = {
  by: 'quality',
  at: new Date('2026-09-27T14:52:00Z'),
  commit: reviewed,
  round: 1,
  limit: 2,
  points: [
    { body: 'Show the error message next to the field.', file: 'src/ContactForm.tsx', line: 42 },
    { body: 'Describe the form in the user documentation.', file: null, line: null },
  ],
  notes: [
    {
      author: { kind: 'agent', name: 'Web Developer' },
      at: new Date('2026-09-27T15:40:00Z'),
      body: 'Point 2: docs/user/contact.md already describes the form.',
    },
  ],
};

/** After an owner's request (owner's answer 14, lot 4 step C). */
const ownerFirst =
  "The owner's request for changes, given under \"The previous review\" below, was written after these criteria, so it wins where they disagree. The agent was told to do what the request asks and to say so in that criterion's justification: a criterion the agent reported as superseded by the owner's request is not a reason to request changes. Check instead that the work does what the request asks.";

describe('the previous review (owner, lot 3 step I)', () => {
  it("gives Quality's request, the diff since, the rest of the change and the agent's notes, before the earlier reviews", () => {
    const text = message({ previous: qualityRequest });
    const section = text.split('## The previous review\n\n')[1]?.split('## Earlier reviews')[0];
    expect(section).toBe(
      [
        `Quality requested changes on commit ${reviewed} at 2026-09-27 14:52 UTC (round 1 of at most 2). The work you review now is the agent's answer: check that each point was addressed, or that the agent's reason for leaving it holds. \`git diff ${reviewed} HEAD\` shows what changed since that review. Then review the rest of the change as usual, since the answer to a point can break something else: your review is of the whole work at commit ${commit}, not only of what changed since.`,
        '',
        '1. `src/ContactForm.tsx:42`: Show the error message next to the field.\n2. Describe the form in the user documentation.',
        '',
        'What the agent said about these points:',
        '',
        '### Agent Web Developer, 2026-09-27 15:40 UTC',
        '',
        'Point 2: docs/user/contact.md already describes the form.',
        '',
        '',
      ].join('\n'),
    );
  });

  it("gives the owner's request with what it came after, and says when the agent left no note", () => {
    const text = message({
      previous: {
        by: 'owner',
        at: new Date('2026-09-27T15:10:00Z'),
        commit: reviewed,
        after: 'approved',
        comment: 'Also add a link to the map.',
        notes: [],
      },
    });
    expect(text).toContain(
      `The owner requested changes at 2026-09-27 15:10 UTC, on commit ${reviewed} (Quality had approved it): Also add a link to the map.\n\nThe work you review now is the agent's answer:`,
    );
    expect(text).toContain('(The agent left no comment about these points.)');
    // It was written after the criteria and wins where they disagree (owner's answer 14, step C).
    expect(text).toContain(
      `- Criterion 2 (index 1): An invalid e-mail address is refused with a message next to the field\n\n${ownerFirst}\n\n## Dependencies`,
    );
    const legacy = message({
      previous: {
        by: 'owner',
        at: new Date('2026-09-27T15:10:00Z'),
        commit: null,
        after: null,
        comment: 'Also add a link to the map.',
        notes: [],
      },
    });
    expect(legacy).toContain('The owner requested changes at 2026-09-27 15:10 UTC: Also add');
    expect(legacy).not.toContain('shows what changed since that review');
    expect(legacy).toContain(ownerFirst);
  });

  it("says the owner's request wins over the criteria only after an owner's request", () => {
    expect(message({ previous: qualityRequest })).not.toContain('wins where they disagree');
    expect(message()).not.toContain('wins where they disagree');
    expect(message()).toContain(
      '- Criterion 2 (index 1): An invalid e-mail address is refused with a message next to the field\n\n## Dependencies',
    );
  });

  it('is left out, with no heading, when the work answers no request', () => {
    expect(message()).not.toContain('The previous review');
    expect(message()).toContain('\n\n## Earlier reviews\n\n');
  });
});

describe('the first message of a review run', () => {
  it('names the commit, the pull request and how to see the diff', () => {
    const text = message();
    expect(text).toContain('Review ticket WEB-12 of the project Bakery website');
    expect(text).toContain(`Your worktree holds commit ${commit}, the head of pull request #12`);
    expect(text).toContain('https://github.com/owner/bakery/pull/12');
    expect(text).toContain('`git diff origin/main...HEAD`');
    expect(text).toContain('`git log origin/main..HEAD`');
    // What a review must not change is said once, in the reviewer rules (lot 3 step H5).
    expect(text).not.toMatch(/never change a file|commit or merge/);
  });

  it('holds the ticket, the report as the agent account and the comments', () => {
    const text = message();
    expect(text).toContain('- Criterion 2 (index 1): An invalid e-mail address is refused');
    expect(text).toContain(
      "This report is the implementing agent's own account of its work: check it against the diff, and never take it as proof by itself.",
    );
    expect(text).toContain('Adds a contact form with client-side validation.');
    expect(text).toContain(
      '- Criterion 1 (index 0), met: ContactForm.tsx renders the three fields.',
    );
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
      // Whether to run the tests comes right after the CI result (lot 3 step H5).
      expect(text.split('## CI')[1]?.split('\n# WEB-12')[0]).toContain(
        'CI already ran on GitHub: do not run the test suite again',
      );
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
        `No CI ran on GitHub for commit ${commit}: nothing appeared within Wait for CI to start after the pull request opened.`,
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

    it('with No CI found, says once that nothing on GitHub tested the work (owner, step I)', () => {
      for (const workflows of [null, 'changed', 'not_listed'] as const) {
        const text = message({ ci: 'no_ci', workflows });
        expect(text.split('Nothing on GitHub tested this work').length - 1).toBe(1);
      }
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

  // Owner's answer 1, lot 3 step I2: never refused for the previous review's length or the
  // earlier reviews'; each step is taken only while the message is still too long.
  describe('the previous review and the earlier reviews, cut and never refused (owner, step I2)', () => {
    const big = (label: string, index: number, size = 2_000) =>
      `${label} ${String(index)} ${'y'.repeat(size)}`;
    const notes = (count: number, size = 2_000) =>
      Array.from({ length: count }, (_, index) => ({
        author: { kind: 'agent' as const, name: 'Web Developer' },
        at: new Date(`2026-09-27T15:${String(index).padStart(2, '0')}:00Z`),
        body: big('Note', index, size),
      }));
    const points = (count: number, size = 2_000) =>
      Array.from({ length: count }, (_, index) => ({
        body: big('Point', index, size),
        file: 'src/ContactForm.tsx',
        line: index + 1,
      }));
    const earlier = (count: number, size = 2_000) =>
      Array.from({ length: count }, (_, index) => ({
        author: { kind: 'agent' as const, name: 'Quality' },
        at: new Date(`2026-09-20T10:${String(index).padStart(2, '0')}:00Z`),
        body: big('Earlier', index, size),
      }));
    const quality = (fields: Partial<Extract<ReviewTicket['previous'], { by: 'quality' }>>) => ({
      ...qualityRequest,
      ...fields,
    });
    const comments = Array.from({ length: 10 }, (_, index) => ({
      author: { kind: 'owner' as const },
      kind: 'note' as const,
      at: new Date(`2026-09-26T09:${String(index).padStart(2, '0')}:00Z`),
      body: big('Comment', index),
    }));
    const summary = Array.from({ length: 200 }, (_, i) => `Line ${String(i)} of the summary.`);
    const report = { ...sample.report, summary: summary.join('\n') };
    const description = Array.from({ length: 200 }, (_, i) => `Description line ${String(i)}.`);
    const within = (ticket: Partial<ReviewTicket>, budget: number) => {
      const text = reviewFirstMessage(templates.review, { ...sample, ...ticket }, budget);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
      return text;
    };
    const fullSize = (ticket: Partial<ReviewTicket>) => Buffer.byteLength(message(ticket));
    const POINTS_LEFT_OUT =
      /\((\d+) more points are not shown here because this message would be too long: read them with `ticket_comments`, where each point is a review comment\.\)/;
    const NOTES_LEFT_OUT =
      /\((\d+) more comments of the agent about these points are not shown here because this message would be too long: read them with `ticket_comments`\.\)/;
    const EARLIER_LEFT_OUT =
      /\((\d+) earlier review comments are not shown here because this message would be too long: read them with `ticket_comments`\.\)/;
    const REPORT_CUT = '[The report is cut here because it is too long for this message.';
    const DESCRIPTION_CUT = '[The description is cut here because it is too long for this message.';

    it('drops the comments first, then the earlier reviews oldest first, with their marker', () => {
      const ticket = { comments, earlierReviews: earlier(10), previous: quality({}) };
      const text = within(ticket, fullSize(ticket) - 25_000);
      expect(text).not.toContain('Comment 9 ');
      expect(text).toMatch(EARLIER_LEFT_OUT);
      expect(text).not.toContain('Earlier 0 ');
      expect(text).toContain('Earlier 9 ');
      expect(text).toContain('Show the error message next to the field.');
      expect(text).not.toContain(REPORT_CUT);
    });

    it("then the agent's notes oldest first, keeping the latest, with their marker", () => {
      const ticket = {
        comments,
        earlierReviews: earlier(5),
        previous: quality({ notes: notes(10) }),
      };
      const text = within(ticket, fullSize(ticket) - 40_000);
      expect(text).not.toContain('Earlier 4 ');
      expect(text).toMatch(EARLIER_LEFT_OUT);
      const kept = text.split('What the agent said about these points:')[1] ?? '';
      expect(kept).toMatch(NOTES_LEFT_OUT);
      expect(kept.indexOf('more comments of the agent')).toBeLessThan(kept.indexOf('Note 9 '));
      expect(kept).not.toContain('Note 0 ');
      expect(kept).toContain('Note 9 ');
      expect(text).not.toContain(REPORT_CUT);
      expect(text).toContain('Show the error message next to the field.');
    });

    it('then cuts the report, then drops the points from the last down to the second', () => {
      const ticket = { report, previous: quality({ points: points(30), notes: notes(2) }) };
      const reportOnly = within(ticket, fullSize(ticket) - 6_000);
      expect(reportOnly).toContain(REPORT_CUT);
      expect(reportOnly).toContain('Line 0 of the summary.');
      expect(reportOnly).toContain('Point 29 ');
      expect(reportOnly).not.toMatch(POINTS_LEFT_OUT);
      expect(reportOnly.match(NOTES_LEFT_OUT)?.[1]).toBe('2');

      const fewer = within(ticket, fullSize(ticket) - 20_000);
      expect(fewer).toContain(REPORT_CUT);
      expect(fewer).toContain('Point 0 ');
      expect(fewer).not.toContain('Point 29 ');
      expect(fewer.match(POINTS_LEFT_OUT)?.[1]).toBe(
        String(30 - (fewer.match(/Point \d+ /g) ?? []).length),
      );
      expect(fewer).toContain('Visitors need a way to write to the bakery.');
    });

    it('then cuts the description, and only then drops the first point', () => {
      const one = { description: description.join('\n'), previous: quality({ points: points(3) }) };
      const descriptionCut = within(one, fullSize(one) - 6_000);
      expect(descriptionCut).toContain('Point 0 ');
      expect(descriptionCut).not.toContain('Point 1 ');
      expect(descriptionCut).toMatch(POINTS_LEFT_OUT);
      expect(descriptionCut).toContain(DESCRIPTION_CUT);

      // A first point larger than the whole budget: left out, the message still built.
      const huge = { previous: quality({ points: points(2, 100_000) }) };
      const text = within(huge, FIRST_MESSAGE_MAX_BYTES);
      expect(text).not.toContain('Point 0 ');
      expect(text.match(POINTS_LEFT_OUT)?.[1]).toBe('2');
      expect(text).toContain('# WEB-12: Contact form');
    });

    it("cuts the owner's request at a line boundary, with its marker, at the points' place", () => {
      const lines = Array.from({ length: 300 }, (_, i) => `Request line ${String(i)}.`);
      const owner: ReviewTicket['previous'] = {
        by: 'owner',
        at: new Date('2026-09-27T15:10:00Z'),
        commit: reviewed,
        after: 'approved',
        comment: lines.join('\n'),
        notes: [],
      };
      const ticket = { report, previous: owner };
      const text = within(ticket, fullSize(ticket) - 8_000);
      expect(text).toContain(REPORT_CUT);
      expect(text).toContain('Request line 0.');
      expect(text).not.toContain('Request line 299.');
      expect(text).toContain(
        "(The rest of the owner's request is not shown here because this message would be too long: read it with `ticket_comments`.)",
      );
      expect(text).toContain('Visitors need a way to write to the bakery.');

      const oneLine = { previous: { ...owner, comment: 'z'.repeat(150_000) } };
      const cut = within(oneLine, FIRST_MESSAGE_MAX_BYTES);
      expect(cut).toContain("(The rest of the owner's request is not shown here");
    });

    it('is never refused at the protocol budget, whatever the lengths', () => {
      const all = {
        comments,
        earlierReviews: earlier(60),
        report,
        description: description.join('\n'),
        previous: quality({ points: points(60), notes: notes(60) }),
      };
      expect(() => within(all, FIRST_MESSAGE_MAX_BYTES)).not.toThrow();
    });
  });

  it('leaves the round out for a request made before Try again (owner, step I2)', () => {
    const text = message({
      previous: { ...qualityRequest, round: null },
    });
    expect(text).toContain(
      `Quality requested changes on commit ${reviewed} at 2026-09-27 14:52 UTC. The work you review now`,
    );
    expect(text).not.toContain('round');
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
        runRules(shipped.rules, 'review'),
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
      '# First message (review) after a request for changes: the previous review',
      `## The previous review${
        message({ previous: qualityRequest })
          .split('## The previous review')[1]
          ?.split('## Earlier reviews')[0] ?? ''
      }`.trimEnd(),
      "# First message (review) after the owner's request: its acceptance criteria",
      `## Acceptance criteria${
        message({
          previous: {
            by: 'owner',
            at: new Date('2026-09-27T15:10:00Z'),
            commit: reviewed,
            after: 'approved',
            comment: 'Also add a link to the map.',
            notes: [],
          },
        })
          .split('## Acceptance criteria')[1]
          ?.split('## Dependencies')[0] ?? ''
      }`.trimEnd(),
      '# First message (review), No CI found and workflow files changed: its CI',
      `## CI${noCi.split('## CI')[1]?.split('\n# WEB-12')[0] ?? ''}`.trimEnd(),
      '# Nudge (review)',
      nudgeMessage(templates, 'review'),
    ];
    await expect(sections.join('\n\n')).toMatchFileSnapshot(
      './__snapshots__/review-messages.snapshot.md',
    );
  });
});
