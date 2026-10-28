import { describe, expect, it } from 'vitest';
import { loadShippedAgents, loadTemplates } from './files.js';
import { FirstMessageTooLarge, nudgeMessage, profileRunInstructions } from './messages.js';
import { planFirstMessage, type PlanRequest } from './plan-message.js';

// The first message of a `plan` run (owner's answer 5, lot 5 step E1): what it holds for an
// existing project, a new project and after a rejection, and each cut in its order.

const template = (await loadTemplates()).plan;

const at = (minute: number) => new Date(Date.UTC(2026, 9, 28, 14, minute));

const existing: PlanRequest = {
  number: 7,
  body: 'A contact page where visitors leave a message.\nNo e-mail.',
  comments: [
    {
      author: { kind: 'agent', name: 'Project Manager' },
      kind: 'question',
      at: at(1),
      body: 'Should the form ask for a phone number?',
    },
    { author: { kind: 'owner' }, kind: 'answer', at: at(2), body: 'No, a name and an e-mail.' },
  ],
  project: {
    name: 'Bakery website',
    key: 'WEB',
    kind: 'website',
    base: 'origin/main',
    tickets: [
      {
        reference: 'WEB-1',
        status: 'done',
        type: 'chore',
        assignee: 'architect',
        title: 'Bootstrap',
      },
      {
        reference: 'WEB-2',
        status: 'todo',
        type: 'feature',
        assignee: 'web_dev',
        title: 'Home page',
      },
      {
        reference: 'WEB-3',
        status: 'proposed',
        type: 'bug',
        assignee: null,
        title: 'Logo too big',
      },
    ],
  },
  agents: [
    { key: 'architect', name: 'Architect', description: 'Owns the structure.' },
    { key: 'web_dev', name: 'Web Developer', description: 'Builds web features.' },
  ],
  maxTicketsPerPlan: 15,
  attempt: 1,
  rejected: null,
};

const rejected: PlanRequest = {
  ...existing,
  attempt: 2,
  rejected: {
    summary: 'One ticket for the whole page.',
    tickets: [
      { key: 'contact', title: 'Contact page' },
      { key: 'docs', title: 'Help page' },
    ],
    feedback: 'Split the form from the page that lists the messages.',
  },
};

describe('the first message of a planning run', () => {
  it('gives the request, its conversation oldest first, the project with its open tickets first, the agents and the limit', () => {
    const message = planFirstMessage(template, existing);
    expect(message).toMatch(
      /^Plan request 7 for the project Bakery website \(WEB\), then propose your plan with `plan_propose`\. This is attempt 1 at this request\./,
    );
    expect(message).toContain(
      '# Request 7\n\nA contact page where visitors leave a message.\nNo e-mail.',
    );
    expect(message.indexOf('phone number')).toBeLessThan(message.indexOf('a name and an e-mail'));
    expect(message).toContain('### Agent Project Manager, question, 2026-10-28 14:01 UTC');
    expect(message).toContain('### The owner, answer, 2026-10-28 14:02 UTC');
    expect(message).toContain(
      'Bakery website (WEB), a project of kind `website`. Your folder holds its base branch, `origin/main`, as it is on GitHub.',
    );
    expect(message).toContain(
      '- WEB-2 (todo, feature, web_dev): Home page\n- WEB-3 (proposed, bug, no assignee): Logo too big\n- WEB-1 (done, chore, architect): Bootstrap',
    );
    expect(message).toContain(
      '- `architect`, Architect: Owns the structure.\n- `web_dev`, Web Developer: Builds web features.',
    );
    expect(message).toContain('A plan holds at most 15 tickets (Most tickets per plan).');
    expect(message).not.toMatch(/rejected|feedback|not shown here|cut here/);
    expect(message.endsWith('(Most tickets per plan).\n')).toBe(true);
  });

  it('says that a new project has nothing to read yet', () => {
    const message = planFirstMessage(template, { ...existing, comments: [], project: null });
    expect(message).toMatch(/^Plan request 7 for a new project, then propose your plan/);
    expect(message).toContain(
      'There is no project yet: the request asks for a new one, which your plan proposes with `new_project`. Your folder is empty.',
    );
    expect(message).toContain('## Conversation\n\n(No comments yet.)');
    expect(message).not.toMatch(/WEB-|Its tickets/);
  });

  it("gives the rejected plan and the owner's feedback after a rejection, the feedback winning", () => {
    const message = planFirstMessage(template, rejected);
    expect(message).toContain('This is attempt 2 at this request.');
    expect(message).toContain(
      '## The plan the owner rejected\n\nOne ticket for the whole page.\n\nIts tickets:\n\n- `contact`: Contact page\n- `docs`: Help page',
    );
    expect(message).toContain(
      "## The owner's feedback\n\nThe owner wrote this after reviewing the plan above, so it comes first: where they disagree, do what the feedback asks.\n\nSplit the form from the page that lists the messages.\n",
    );
  });

  it('starts with the scheduler line when its template part is used', () => {
    expect(template.parts.get('started-by-scheduler')).toBe(
      'Started by the scheduler: the Orchestrator started this run by itself, not the owner.',
    );
  });
});

describe('the cuts of a planning run first message', () => {
  const size = (text: string) => Buffer.byteLength(text, 'utf8');

  it('leaves out the oldest comments first, showing those kept oldest first', () => {
    const withThree: PlanRequest = {
      ...rejected,
      comments: [
        ...rejected.comments,
        { author: { kind: 'system' }, kind: 'note', at: at(3), body: 'A note.' },
      ],
    };
    const all = planFirstMessage(template, withThree);
    const message = planFirstMessage(template, withThree, size(all) - 1);
    expect(message).toContain(
      '(1 earlier comments are not shown here: read them with `request_get`.)',
    );
    expect(message).not.toContain('phone number');
    expect(message.indexOf('a name and an e-mail')).toBeLessThan(message.indexOf('A note.'));
    // Nothing else is cut yet.
    expect(message).toContain('- WEB-1 (done, chore, architect): Bootstrap');
  });

  it("then the done tickets, the oldest other tickets, the rejected plan's tickets from the last, and the request's text at a line, never the feedback", () => {
    // Texts long enough that each cut saves more than the note saying what it left out.
    const long = (text: string) => `${text} ${'·'.repeat(150)}`;
    const request: PlanRequest = {
      ...rejected,
      body: ['First line', 'Second line', 'Third line'].map(long).join('\n'),
      comments: rejected.comments.map((comment) => ({ ...comment, body: long(comment.body) })),
      project: {
        ...(rejected.project as NonNullable<PlanRequest['project']>),
        tickets: (rejected.project?.tickets ?? []).map((ticket) => ({
          ...ticket,
          title: long(ticket.title),
        })),
      },
      rejected: {
        ...(rejected.rejected as NonNullable<PlanRequest['rejected']>),
        tickets: (rejected.rejected?.tickets ?? []).map((ticket) => ({
          ...ticket,
          title: long(ticket.title),
        })),
      },
    };
    // Each message from the full budget down, one byte at a time, while one can be built.
    const messages: string[] = [];
    for (let budget = size(planFirstMessage(template, request)); budget > 0; budget -= 1) {
      let message: string;
      try {
        message = planFirstMessage(template, request, budget);
      } catch {
        break;
      }
      expect(size(message)).toBeLessThanOrEqual(budget);
      if (messages.at(-1) !== message) messages.push(message);
    }
    /** The index of the first message without `text`. */
    const gone = (text: string) => messages.findIndex((message) => !message.includes(text));
    const order = [
      'phone number',
      'a name and an e-mail',
      'WEB-1 (done',
      'WEB-2 (todo',
      'WEB-3 (proposed',
      '`docs`: Help page',
      '`contact`: Contact page',
      'Third line',
      'Second line',
    ].map(gone);
    for (const index of order) expect(index).toBeGreaterThan(0);
    expect(new Set(order).size).toBe(order.length);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const last = messages.at(-1) ?? '';
    expect(last).toContain(
      '(2 earlier comments are not shown here: read them with `request_get`.)',
    );
    expect(last).toContain('(3 more tickets are not shown here: read them with `ticket_list`.)');
    expect(last).toContain('(2 more tickets of that plan are not shown here.)');
    expect(messages[gone('Second line')]).toMatch(
      /# Request 7\n\nFirst line ·+\n\n\[The request is cut here because it is too long for this message\. Read the rest with `request_get` before you plan\.\]/,
    );
    expect(last).toContain('# Request 7\n\n[The request is cut here');
    // The owner's feedback is never cut, and the summary of the rejected plan stays.
    for (const message of messages) {
      expect(message).toContain('Split the form from the page that lists the messages.');
      expect(message).toContain('One ticket for the whole page.');
    }
    // The comments kept are shown oldest first.
    const oneComment = messages[gone('phone number')] ?? '';
    expect(oneComment).toContain('(1 earlier comments are not shown here');
    expect(oneComment).toContain('a name and an e-mail');
  });

  it('refuses a message that does not fit even with the request cut to nothing', () => {
    expect(() => planFirstMessage(template, rejected, 200)).toThrow(FirstMessageTooLarge);
  });
});

describe('the Project Manager and its messages (snapshot)', () => {
  it('renders the appended instructions, the first messages and the nudge', async () => {
    const shipped = await loadShippedAgents();
    const pm = shipped.profiles.find((profile) => profile.key === 'pm');
    if (!pm) throw new Error('no pm profile');
    const sections = [
      '<!-- Rendered by apps/server/src/agents/plan-message.test.ts: review it with the templates. -->',
      '# Appended to the system prompt (Project Manager)',
      profileRunInstructions(shipped, pm, 'plan'),
      '# First message (plan), an existing project',
      planFirstMessage(template, existing),
      '# First message (plan), a new project',
      planFirstMessage(template, { ...existing, comments: [], project: null }),
      '# First message (plan) after a rejection: its end',
      `## Limits${planFirstMessage(template, rejected).split('## Limits')[1] ?? ''}`.trimEnd(),
      '# Nudge (plan)',
      nudgeMessage(await loadTemplates(), 'plan'),
    ];
    await expect(sections.join('\n\n')).toMatchFileSnapshot(
      './__snapshots__/plan-messages.snapshot.md',
    );
  });
});
