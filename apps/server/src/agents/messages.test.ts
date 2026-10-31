import { FIRST_MESSAGE_MAX_BYTES } from '@orchestrator/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadShippedAgents, loadTemplates, type ShippedAgents, type Templates } from './files.js';
import {
  FirstMessageTooLarge,
  answerMessage,
  answerResumeMessage,
  continueMessage,
  fixReviewFirstMessage,
  implementFirstMessage,
  nudgeMessage,
  runInstructions,
  runRules,
  type FixReviewTicket,
  type ImplementTicket,
} from './messages.js';

let templates: Templates;
let shipped: ShippedAgents;

beforeAll(async () => {
  templates = await loadTemplates();
  shipped = await loadShippedAgents();
});

const sample: ImplementTicket = {
  projectName: 'Bakery website',
  reference: 'WEB-12',
  title: 'Contact form',
  type: 'feature',
  priority: 'high',
  description:
    'Visitors need a way to write to the bakery.\n\nThe form sends an e-mail to the owner.',
  acceptanceCriteria: [
    'The contact page has a form with name, e-mail address and message',
    'An invalid e-mail address is refused with a message next to the field',
  ],
  dependencies: [{ reference: 'WEB-3', title: 'Bootstrap project harness', status: 'done' }],
  comments: [
    {
      author: { kind: 'owner' },
      kind: 'note',
      at: new Date('2026-09-26T09:30:00Z'),
      body: 'Keep the form short: no phone number.',
    },
    {
      author: { kind: 'agent', name: 'Web Developer' },
      kind: 'question',
      at: new Date('2026-09-26T10:02:00Z'),
      body: 'Should the form also send a copy to the visitor?',
    },
    {
      author: { kind: 'owner' },
      kind: 'answer',
      at: new Date('2026-09-26T11:15:00Z'),
      body: 'No copy.',
    },
    {
      author: { kind: 'system' },
      kind: 'status_change',
      at: new Date('2026-09-26T11:20:00Z'),
      body: 'The run failed: timeout.',
    },
  ],
  attempt: 1,
  earlierWorkBase: null,
  notPushed: null,
};

const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';

/** A `fix_review` run after Quality's request (owner's answers 3 to 5, lot 3 step I). */
const fixSample: FixReviewTicket = {
  ...sample,
  attempt: 2,
  earlierWorkBase: 'origin/main',
  branch: 't/12-contact-form',
  base: 'origin/main',
  pullRequest: 7,
  lost: false,
  request: {
    by: 'quality',
    at: new Date('2026-09-27T14:52:00Z'),
    commit: COMMIT,
    points: [
      { body: 'Show the error message next to the field.', file: 'src/ContactForm.tsx', line: 42 },
      { body: 'Test an empty e-mail address too.', file: 'src/contact.test.ts', line: null },
      { body: 'Describe the form in the user documentation.', file: null, line: null },
    ],
  },
};

const fixMessage = (ticket: Partial<FixReviewTicket> = {}, maxBytes?: number) =>
  fixReviewFirstMessage(
    templates['fix-review'],
    templates.implement,
    { ...fixSample, ...ticket },
    maxBytes,
  );

describe('the first message of a fix_review run (lot 3 step I)', () => {
  it("opens with the approved words, the branch and pull request, then Quality's points", () => {
    const text = fixMessage();
    expect(text).toMatch(
      /^Address the review of ticket WEB-12, then submit it again with `ticket_submit`\. This is attempt 2\.\n/,
    );
    expect(text).toContain(
      'The branch t/12-contact-form already holds the submitted work (pull request #7): continue on it.',
    );
    expect(text).toContain(
      `## Points to address (Quality, 2026-09-27 14:52 UTC, commit ${COMMIT})`,
    );
    expect(text).toContain(
      [
        '1. `src/ContactForm.tsx:42`: Show the error message next to the field.',
        '2. `src/contact.test.ts`: Test an empty e-mail address too.',
        '3. Describe the form in the user documentation.',
      ].join('\n'),
    );
    expect(text).toContain(
      '3. Describe the form in the user documentation.\n\nAddress every point. If one cannot or should not be done, say why with `ticket_comment` or ask with `ticket_ask`.',
    );
    // Quality's points never come before the criteria (owner's answer 14, lot 4 step A).
    expect(text).not.toContain('comes first');
    // Then the ticket as in implement.md.
    expect(text).toContain('# WEB-12: Contact form');
    expect(text).toContain('- Criterion 2: An invalid e-mail address is refused');
    expect(text).toContain('Keep the form short: no phone number.');
  });

  it("gives the owner's comment whole, under its own heading", () => {
    const text = fixMessage({
      request: {
        by: 'owner',
        at: new Date('2026-09-27T15:10:00Z'),
        comment: 'Also add a link to the map.\n\nKeep the rest.',
      },
    });
    expect(text).toContain(
      "## Points to address (the owner's request, 2026-09-27 15:10 UTC)\n\nAlso add a link to the map.\n\nKeep the rest.\n",
    );
    // The owner's request comes after the criteria (owner's answer 14, lot 4 step A).
    expect(text).toContain(
      "Keep the rest.\n\nThe owner wrote this request after the acceptance criteria below, so it comes first: where it contradicts a criterion, do what the request asks, and say so in that criterion's justification. The owner may edit the criterion meanwhile.\n\nAddress every point.",
    );
  });

  it('says where the work is: not on GitHub yet (0.3.0), not pushed, diverged, lost', () => {
    expect(fixMessage({ pullRequest: null })).toContain(
      'committed on this machine and not on GitHub yet: continue on it; `ticket_submit` pushes it and the Orchestrator opens its pull request.',
    );
    expect(fixMessage({ notPushed: { branch: 't/12-contact-form', diverged: false } })).toContain(
      'committed on this machine but not pushed to GitHub',
    );
    expect(fixMessage({ notPushed: { branch: 't/12-contact-form', diverged: true } })).toContain(
      'run `git merge origin/t/12-contact-form`',
    );
    const lost = fixMessage({ lost: true, pullRequest: null, earlierWorkBase: null });
    expect(lost).toContain('The earlier work on this ticket is no longer available');
    expect(lost).toContain(
      'The branch t/12-contact-form starts again from origin/main: implement the ticket again, with the points below in mind.',
    );
  });

  it('adds the sentence after CI failed or a conflict, as implement does', () => {
    expect(fixMessage({ previousCi: { kind: 'failed' } })).toContain(
      'The previous attempt ended after CI failed on GitHub',
    );
    expect(fixMessage({ previousCi: { kind: 'conflict', base: 'main' } })).toContain(
      'The pull request conflicts with main',
    );
  });

  it('when too long, drops the comments, then the last points with their number, never the first', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      body: `Point ${String(index)}: ${'x'.repeat(3000)}`,
      file: null,
      line: null,
    }));
    const text = fixMessage({ request: { ...fixSample.request, points: many } as never }, 60_000);
    expect(bytes(text)).toBeLessThanOrEqual(60_000);
    expect(text).not.toContain('Keep the form short');
    expect(text).toContain('1. Point 0:');
    expect(text).toMatch(
      /\(\d+ more points are not shown here because this message would be too long: read them with `ticket_comments`, where each point is a review comment\.\)/,
    );
  });
});

/** The sample's question and its answer, as the answer message quotes them. */
const question = sample.comments[1]?.body ?? '';
const answer = sample.comments[2]?.body ?? '';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

describe('run instructions', () => {
  // Owner's decision, lot 2 step N: the agent is told its Bash allowlist, so it does not try
  // commands that are refused (each refusal costs a turn).
  it("end with the profile's Bash rules and say that any other command is refused", () => {
    const text = runInstructions('Common.', 'Role.', shipped.allowlist, [
      'Read',
      'Bash(npm *)',
      'Bash(git status)',
      'WebFetch',
    ]);
    expect(text).toMatch(/^Common\.\n\nRole\.\n\n## Commands you may run\n/);
    expect(text).toContain('\n- `npm *`\n- `git status`\n');
    expect(text).toContain('Any other command is refused');
    expect(text).not.toContain('`Read`');
    expect(runInstructions('Common.', 'Role.', shipped.allowlist, ['Read'])).toContain(
      shipped.allowlist.parts.get('no-commands'),
    );
  });
});

describe('the rules each run purpose receives (03, section 3; lot 3 step H5)', () => {
  it('gives shared and builder rules to implement, fix_review and document runs, shared and reviewer rules to review runs, shared and planner rules to plan runs', () => {
    const { shared, builder, reviewer, planner } = shipped.rules;
    const builderRules = runRules(shipped.rules, 'implement');
    const reviewerRules = runRules(shipped.rules, 'review');
    expect(runRules(shipped.rules, 'fix_review')).toBe(builderRules);
    expect(runRules(shipped.rules, 'document')).toBe(builderRules);
    const plannerRules = runRules(shipped.rules, 'plan');
    expect(reviewerRules).not.toBe(builderRules);
    // Each one holds the shared rules' own text and its kind's, never the other kind's.
    for (const rules of [builderRules, reviewerRules, plannerRules]) {
      expect(rules).toContain('# How you work in the Orchestrator');
      expect(rules).toContain('## Staying on task');
    }
    expect(builderRules).toContain(builder.main);
    expect(builderRules).not.toContain(reviewer.main);
    expect(reviewerRules).toContain(reviewer.main);
    expect(reviewerRules).not.toContain(builder.main);
    expect(plannerRules).toContain(planner.main);
    expect(plannerRules).not.toContain(builder.main);
    expect(plannerRules).not.toContain(reviewer.main);
    for (const name of ['assignment', 'start', 'tools', 'files', 'needs', 'task']) {
      expect(builderRules).toContain(builder.parts.get(name));
      expect(reviewerRules).toContain(reviewer.parts.get(name));
      expect(plannerRules).toContain(planner.parts.get(name));
      expect(shared.main).toContain(`{{${name}}}`);
    }
    expect(shared.main).toMatch(/\{\{work\}\}/);
  });
});

describe('run instructions and messages for a sample ticket (snapshot)', () => {
  it('renders the appended instructions, the first message and the other templates', async () => {
    const webDev = shipped.profiles.find((profile) => profile.key === 'web_dev');
    const sections = [
      '<!-- Rendered by apps/server/src/agents/messages.test.ts: review it with the templates. -->',
      '# Appended to the system prompt (Web Developer)',
      runInstructions(
        runRules(shipped.rules, 'implement'),
        webDev?.instructions ?? '',
        shipped.allowlist,
        webDev?.allowedTools ?? [],
      ),
      '# First message (implement)',
      implementFirstMessage(templates.implement, sample),
      '# First message (implement), attempt 2 with commits from an earlier attempt',
      implementFirstMessage(templates.implement, {
        ...sample,
        attempt: 2,
        earlierWorkBase: 'origin/main',
      })
        .split('\n# WEB-12')[0]
        ?.trimEnd() ?? '',
      '# First message (implement), the earlier commits not pushed (GitHub refused or unreachable)',
      implementFirstMessage(templates.implement, {
        ...sample,
        attempt: 2,
        earlierWorkBase: 'origin/main',
        notPushed: { branch: 't/12-contact-form', diverged: false },
      })
        .split('\n# WEB-12')[0]
        ?.trimEnd() ?? '',
      '# First message (implement), the earlier commits not pushed, the branch diverged on GitHub',
      implementFirstMessage(templates.implement, {
        ...sample,
        attempt: 2,
        earlierWorkBase: 'origin/main',
        notPushed: { branch: 't/12-contact-form', diverged: true },
      })
        .split('\n# WEB-12')[0]
        ?.trimEnd() ?? '',
      "# First message (fix_review), after Quality's request",
      fixMessage().split('\n# WEB-12')[0]?.trimEnd() ?? '',
      "# First message (fix_review), after the owner's request on a ticket left by 0.3.0",
      fixMessage({
        pullRequest: null,
        request: {
          by: 'owner',
          at: new Date('2026-09-27T15:10:00Z'),
          comment: 'Also add a link to the map.',
        },
      })
        .split('\n# WEB-12')[0]
        ?.trimEnd() ?? '',
      '# First message (fix_review), the earlier work lost with its machine',
      fixMessage({ lost: true, pullRequest: null, earlierWorkBase: null })
        .split('\n## Points')[0]
        ?.trimEnd() ?? '',
      '# Owner answer',
      answerMessage(templates, question, answer),
      "# Owner answer to a planning run's question",
      answerMessage(
        templates,
        'Which pages should the site have?',
        'Home and contact.',
        'request-answer',
      ),
      '# Continue after a usage-limit pause',
      continueMessage(templates),
      '# Continue a planning run after a usage-limit pause (lot 5 step E2b)',
      continueMessage(templates, 'plan'),
      '# Nudge',
      nudgeMessage(templates),
    ];
    await expect(sections.join('\n\n')).toMatchFileSnapshot(
      './__snapshots__/run-messages.snapshot.md',
    );
  });

  it('shows the empty cases in the words of the template', () => {
    const message = implementFirstMessage(templates.implement, {
      ...sample,
      description: ' ',
      acceptanceCriteria: [],
      dependencies: [],
      comments: [],
    });
    for (const name of ['empty-description', 'no-criteria', 'no-dependencies', 'no-comments']) {
      expect(message).toContain(templates.implement.parts.get(name));
    }
  });

  it('states the attempt, and points to the earlier commits only when there are some', () => {
    const first = implementFirstMessage(templates.implement, sample);
    expect(first).toContain('This is attempt 1 at this ticket.');
    expect(first).toContain(templates.implement.parts.get('start'));
    expect(first).not.toContain('earlier attempt');
    const again = implementFirstMessage(templates.implement, {
      ...sample,
      attempt: 3,
      earlierWorkBase: 'origin/trunk',
    });
    expect(again).toContain('This is attempt 3 at this ticket.');
    expect(again).toContain('already has commits from an earlier attempt');
    expect(again).toContain('`git log origin/trunk..HEAD`');
    expect(again).toContain('`git diff origin/trunk...HEAD`');
    expect(again).not.toContain(templates.implement.parts.get('start'));
  });

  it('says when the earlier commits were not pushed, and to merge a diverged branch first', () => {
    const notPushed = implementFirstMessage(templates.implement, {
      ...sample,
      attempt: 2,
      earlierWorkBase: 'origin/main',
      notPushed: { branch: 't/12-contact-form', diverged: false },
    });
    expect(notPushed).toContain('committed on this machine but not pushed to GitHub');
    expect(notPushed).not.toContain('git merge');
    const diverged = implementFirstMessage(templates.implement, {
      ...sample,
      attempt: 2,
      earlierWorkBase: 'origin/main',
      notPushed: { branch: 't/12-contact-form', diverged: true },
    });
    expect(diverged).toContain('run `git merge origin/t/12-contact-form`');
    expect(diverged).toContain('`git log origin/main..HEAD`');
  });

  it('quotes the question of the sample ticket in full in the answer', () => {
    expect(question).toBe('Should the form also send a copy to the visitor?');
    const message = answerMessage(templates, question, answer);
    expect(message).toContain(`Your question:\n\n${question}\n`);
    expect(message).toContain(`Their answer:\n\n${answer}\n`);
  });

  it('points a planning run to request_get when its answer is cut (lot 5 step D2a)', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${String(i)} of a long text.`).join(
      '\n',
    );
    const message = answerResumeMessage(templates, long, long, 'request-answer', 4_000);
    expect(bytes(message)).toBeLessThanOrEqual(4_000);
    expect(message).toContain(templates['request-answer'].parts.get('question-cut'));
    expect(message).toContain('Read it in full with `request_get`');
    expect(message).not.toContain('ticket_comments');
    expect(message).toContain('Continue planning the request with this answer.');
  });

  it('keeps a text containing a placeholder as written', () => {
    const message = implementFirstMessage(templates.implement, {
      ...sample,
      description: 'Show {{title}} and {{unknown}} literally.',
    });
    expect(message).toContain('Show {{title}} and {{unknown}} literally.');
  });
});

describe('the byte budget of the first message (03, section 3.2)', () => {
  const full = () => implementFirstMessage(templates.implement, sample);

  it('uses the protocol constant by default', () => {
    expect(bytes(full())).toBeLessThan(FIRST_MESSAGE_MAX_BYTES);
    const big = implementFirstMessage(templates.implement, {
      ...sample,
      comments: Array.from({ length: 40 }, (_, index) => ({
        ...sample.comments[0],
        author: { kind: 'owner' as const },
        kind: 'note' as const,
        at: new Date(Date.UTC(2026, 8, 1, 0, index)),
        body: `Comment ${String(index)}: ${'€'.repeat(3_000)}`,
      })),
    });
    expect(bytes(big)).toBeLessThanOrEqual(FIRST_MESSAGE_MAX_BYTES);
    expect(big).toContain('Comment 39:');
    expect(big).not.toContain('Comment 0:');
  });

  it('keeps the newest comments that fit and says how many were left out', () => {
    const withoutOldest = implementFirstMessage(templates.implement, {
      ...sample,
      comments: sample.comments.slice(2),
    });
    const budget = bytes(withoutOldest) + 100;
    const message = implementFirstMessage(templates.implement, sample, budget);
    expect(bytes(message)).toBeLessThanOrEqual(budget);
    expect(message).toContain('No copy.');
    expect(message).toContain('The run failed: timeout.');
    expect(message).not.toContain('no phone number');
    expect(message).not.toContain('send a copy to the visitor');
    expect(message).toContain(
      '(2 earlier comments are not shown here: read them with `ticket_comments`.)',
    );
    // Always the whole ticket.
    for (const criterion of sample.acceptanceCriteria) expect(message).toContain(criterion);
    expect(message).toContain(sample.description);
  });

  it('cuts a description too long at a line boundary, with the marker pointing to ticket_get', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `Line ${String(index)} of the spec.`);
    const ticket = { ...sample, description: lines.join('\n') };
    const budget = bytes(implementFirstMessage(templates.implement, { ...sample, comments: [] }));
    const message = implementFirstMessage(templates.implement, ticket, budget + 500);
    expect(bytes(message)).toBeLessThanOrEqual(budget + 500);
    expect(message).toContain('Line 0 of the spec.');
    expect(message).not.toContain('Line 199 of the spec.');
    expect(message).toMatch(
      /Line \d+ of the spec\.\n\n\[The description is cut here because it is too long for this message\. Read the rest with `ticket_get` before you start\.\]/,
    );
    // Whole lines only, and the comments are left out and counted.
    const kept = [...message.matchAll(/^Line (\d+) of the spec\.$/gm)].map((match) =>
      Number(match[1]),
    );
    expect(kept).toEqual(kept.map((_, index) => index));
    expect(message).toContain('(4 earlier comments are not shown here');
    for (const criterion of sample.acceptanceCriteria) expect(message).toContain(criterion);
  });

  it('throws when the ticket does not fit even without its description', () => {
    expect(() => implementFirstMessage(templates.implement, sample, 200)).toThrow(
      FirstMessageTooLarge,
    );
  });
});
