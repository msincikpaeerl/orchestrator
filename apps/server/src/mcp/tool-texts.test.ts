import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadTemplates } from '../agents/files.js';
import { part } from '../agents/messages.js';

// The MCP tools' texts other than `ticket_submit`'s (lot 3 step L): moved from `backend.ts` into
// `agents/templates/mcp-tools.md` with their words unchanged. Each part, filled in, is compared
// with the text `backend.ts` wrote before the move, written out here.

const texts = (await loadTemplates())['mcp-tools'];

/** Each part, its values, and the words `backend.ts` gave before step L. */
const BEFORE: [string, Record<string, string>, string][] = [
  [
    'input-invalid',
    { tool: 'ticket_comment', issues: 'body: Too small; kind: Invalid option' },
    'The input of ticket_comment is not valid: body: Too small; kind: Invalid option',
  ],
  ['input-issue', { field: 'body', message: 'Too small' }, 'body: Too small'],
  [
    'role',
    { role: 'reviewer', tool: 'ticket_submit' },
    'Your role (reviewer) does not allow ticket_submit.',
  ],
  [
    'ticket-unknown',
    { reference: 'WEB-9', project: 'WEB' },
    'No ticket WEB-9 in the project WEB: use ticket_list to find tickets.',
  ],
  ['profile-unknown', { key: 'nobody' }, 'No agent profile nobody: use agent_list.'],
  ['profile-unknown-field', {}, 'unknown agent profile'],
  ['cursor-unknown', {}, 'cursor: pass back a next_cursor returned by this tool.'],
  ['cursor-unknown-field', {}, 'unknown cursor'],
  [
    'description-cut',
    {},
    'The rest of the description cannot be read through the tools; ask the owner with ticket_ask if you need it.',
  ],
  [
    'comment-cut',
    {},
    'The rest of this comment cannot be read through the tools; ask the owner with ticket_ask if you need it.',
  ],
  ['too-long', { details: 'a; b' }, 'Too long: a; b.'],
  [
    'too-long-characters',
    { field: 'body', max: '20000', setting: 'Longest comment' },
    'body: at most 20000 characters (setting "Longest comment": 20000)',
  ],
  [
    'too-long-criteria',
    { field: 'acceptance_criteria', max: '20', setting: 'Most acceptance criteria' },
    'acceptance_criteria: at most 20 criteria (setting "Most acceptance criteria": 20)',
  ],
  ['already-submitted', {}, 'You already submitted this ticket: end your turn now.'],
  ['already-gave-up', {}, 'You already gave up this ticket: end your turn now.'],
  [
    'waiting-answer',
    { tool: 'ticket_submit' },
    'You asked the owner a question and the ticket waits for the answer: ticket_submit is not possible now. End your turn; the answer arrives as your next message.',
  ],
  [
    'needs-in-progress',
    { status: 'todo', tool: 'ticket_submit' },
    'The ticket is todo: ticket_submit needs it in_progress.',
  ],
  [
    'review-only',
    { tool: 'review_approve', purpose: 'implement' },
    'review_approve is only for a review run of a ticket in in_review; the purpose of this run is implement.',
  ],
  ['already-approved', {}, 'You already approved this ticket in this run: end your turn.'],
  [
    'already-requested-changes',
    {},
    'You already asked for changes on this ticket in this run: end your turn.',
  ],
  ['already-gave-up-review', {}, 'You already gave up this review: end your turn now.'],
  [
    'needs-in-review',
    { status: 'awaiting_merge', tool: 'review_approve' },
    'The ticket is awaiting_merge: review_approve needs it in_review.',
  ],
  [
    'reviewer-implemented',
    { name: 'Web Developer' },
    'Web Developer implemented this ticket in an earlier run, so it cannot review it: end your turn without a decision.',
  ],
  [
    'review-head-moved',
    { head: 'bbbbbbb', commit: 'aaaaaaa' },
    'The pull request changed on GitHub during your review, now bbbbbbb: your review of aaaaaaa no longer applies. End your turn.',
  ],
  ['decision-approved', { commit: 'aaaaaaa' }, 'Your approval of commit aaaaaaa is recorded.'],
  [
    'decision-changes-one',
    { commit: 'aaaaaaa' },
    'Your request for changes on commit aaaaaaa (1 point) is recorded.',
  ],
  [
    'decision-changes',
    { commit: 'aaaaaaa', count: '3' },
    'Your request for changes on commit aaaaaaa (3 points) is recorded.',
  ],
  [
    'decision-applied',
    {},
    'It is applied when your turn ends: end your turn now, without another tool call.',
  ],
  [
    'decision-head-unchecked',
    { why: 'GitHub could not be reached' },
    "GitHub could not be read to check the pull request's head (GitHub could not be reached): the owner is told to check it before merging.",
  ],
  ['project-archived', {}, 'The project is archived: no ticket can be created in it.'],
  [
    'project-not-ready',
    {},
    'The repository setup of the project is not finished: no ticket can be created yet.',
  ],
  [
    'ticket-limit',
    { limit: '5', setting: 'Most tickets an agent creates per run' },
    'Limit of 5 tickets per run reached (setting "Most tickets an agent creates per run": 5). Record what you found with ticket_comment instead.',
  ],
  ['ticket-limit-field', { limit: '5' }, 'at most 5 tickets per run'],
  [
    'assignee-reviewer',
    { name: 'Quality' },
    'Quality reviews the work of other agents and cannot be assigned a ticket: choose a builder or a writer from agent_list, or leave the assignee out.',
  ],
  ['assignee-reviewer-field', {}, 'this profile cannot be assigned a ticket'],
  [
    'blocked-by-unknown',
    { references: 'WEB-8, WEB-9', project: 'WEB' },
    'No ticket WEB-8, WEB-9 in the project WEB: blocked_by names tickets of the same project.',
  ],
  ['blocked-by-unknown-field', { reference: 'WEB-9' }, 'unknown ticket WEB-9'],
  // Planning runs (lot 5 step D2a): new words, not moved from backend.ts.
  [
    'plan-ticket-needed',
    { request: '7' },
    'Your run plans request 7 and has no ticket of its own: name a ticket with `ticket`, or read the request with request_get.',
  ],
  ['plan-ticket-needed-field', {}, 'a planning run has no ticket: name one'],
  [
    'plan-no-ticket',
    { request: '7', tool: 'ticket_comment' },
    'Your run plans request 7 and has no ticket: ticket_comment is not possible in it. Read the request with request_get, and ask the owner with request_ask.',
  ],
  [
    'plan-no-pull-request',
    { request: '7' },
    'Your run plans request 7: it has no ticket and no pull request, so ci_status has nothing to report.',
  ],
  [
    'plan-decided',
    {},
    'You already ended the work of this planning run with a decision: end your turn now.',
  ],
  [
    'request-only',
    { tool: 'request_get', purpose: 'implement' },
    'request_get is only for a planning run, which plans a request; the purpose of this run is implement.',
  ],
  [
    'request-waiting-answer',
    { request: '7', tool: 'request_ask' },
    'You asked the owner a question and request 7 waits for the answer: request_ask is not possible now. End your turn; the answer arrives as your next message.',
  ],
  [
    'request-not-planning',
    { request: '7', status: 'open' },
    'Request 7 is open: request_ask needs it planning. End your turn.',
  ],
  [
    'request-text-cut',
    {},
    'The rest of the request cannot be read through the tools; ask the owner with request_ask if you need it.',
  ],
  [
    'request-comment-cut',
    {},
    'The rest of this comment cannot be read through the tools; ask the owner with request_ask if you need it.',
  ],
];

describe("the MCP tools' texts in agents/templates/mcp-tools.md", () => {
  it('keep the words of the run ended refusal', () => {
    expect(texts.main).toBe(
      'This run has ended (it was stopped, or its time is over): its token is no longer valid. Stop working: nothing you do now will be recorded.',
    );
  });

  for (const [name, values, before] of BEFORE) {
    it(`keep the words of ${name}`, () => {
      expect(part(texts, name, values)).toBe(before);
    });
  }

  it('have no part left out above, and none that backend.ts does not use', async () => {
    expect([...texts.parts.keys()].sort()).toEqual(BEFORE.map(([name]) => name).sort());
    const source = await readFile(new URL('./backend.ts', import.meta.url), 'utf8');
    for (const name of texts.parts.keys()) {
      // `too-long-${unit}` names the two units' parts.
      const used = name.startsWith('too-long-')
        ? source.includes('`too-long-${unit}`')
        : source.includes(`'${name}'`);
      expect(used, name).toBe(true);
    }
    // No refusal text is written in backend.ts any more: each comes from the template.
    expect(source).not.toMatch(/refuse\(\s*'[A-Z_]+',\s*['`]/);
  });
});
