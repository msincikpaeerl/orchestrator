import { FIRST_MESSAGE_MAX_BYTES } from '@orchestrator/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadShippedAgents, loadTemplates, type ShippedAgents, type Templates } from './files.js';
import {
  FirstMessageTooLarge,
  answerMessage,
  continueMessage,
  implementFirstMessage,
  nudgeMessage,
  runInstructions,
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

describe('run instructions and messages for a sample ticket (snapshot)', () => {
  it('renders the appended instructions, the first message and the other templates', async () => {
    const webDev = shipped.profiles.find((profile) => profile.key === 'web_dev');
    const sections = [
      '<!-- Rendered by apps/server/src/agents/messages.test.ts: review it with the templates. -->',
      '# Appended to the system prompt (Web Developer)',
      runInstructions(
        shipped.commonRules,
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
      '# Owner answer',
      answerMessage(templates, question, answer),
      '# Continue after a usage-limit pause',
      continueMessage(templates),
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
