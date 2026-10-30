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
    { request: '7', status: 'open', tool: 'request_ask' },
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
  // `ticket_update` (lot 5 step E1a).
  ['project-archived-update', {}, 'The project is archived: its tickets cannot be changed.'],
  [
    'ticket-not-editable',
    { ticket: 'WEB-3', status: 'in_progress' },
    "WEB-3 is in_progress: ticket_update changes only a ticket that is proposed or todo. Leave it as it is, and say in your plan's summary what should change.",
  ],
  [
    'dependency-itself',
    { ticket: 'WEB-3' },
    'WEB-3 cannot wait for itself: remove it from blocked_by.',
  ],
  ['dependency-itself-field', {}, 'a ticket cannot wait for itself'],
  [
    'dependency-cycle',
    { ticket: 'WEB-3', cycle: 'WEB-3 → WEB-4 → WEB-3' },
    'These dependencies would make WEB-3 wait for itself: WEB-3 → WEB-4 → WEB-3 (each waits for the next). Remove one of them from blocked_by.',
  ],
  [
    'dependency-cycle-field',
    { cycle: 'WEB-3 → WEB-4 → WEB-3' },
    'closes the cycle WEB-3 → WEB-4 → WEB-3',
  ],
  // `plan_propose` and a planning run with no project (lot 5 step E1b).
  [
    'plan-no-project',
    { request: '7', tool: 'ticket_list' },
    'Request 7 asks for a new project: there is no project yet, so ticket_list has nothing to work on. Plan it with plan_propose and new_project.',
  ],
  [
    'plan-project-archived',
    { project: 'WEB' },
    'The project WEB is archived: no plan can be proposed for it. End your run with ticket_give_up, saying so.',
  ],
  [
    'plan-refused',
    { problems: '- The plan, tickets: x' },
    'Your plan is not recorded. Fix every problem below, then call plan_propose again with the whole plan:\n- The plan, tickets: x',
  ],
  [
    'plan-problem',
    { place: 'The plan, summary', message: 'too long' },
    '- The plan, summary: too long',
  ],
  [
    'plan-place-ticket',
    { position: '2', key: 'contact', field: 'title' },
    'Ticket 2 (contact), title',
  ],
  ['plan-place-whole', {}, 'The plan'],
  [
    'plan-too-many',
    { count: '16', max: '15' },
    '16 tickets: at most 15 per plan (setting "Most tickets per plan"). Plan the first part of the work now, and say in the summary what a later request should add',
  ],
  [
    'plan-duplicate-key',
    { key: 'form', earlier: '1' },
    'the key "form" is already the key of ticket 1: give each ticket its own key',
  ],
  [
    'plan-too-long',
    { length: '201', max: '200', setting: 'Longest ticket title' },
    'too long: 201 characters, at most 200 (setting "Longest ticket title")',
  ],
  [
    'plan-too-many-criteria',
    { count: '21', max: '20' },
    '21 criteria: at most 20 (setting "Most acceptance criteria")',
  ],
  [
    'plan-criterion-too-long',
    { number: '2', length: '501', max: '500' },
    'criterion 2 is too long: 501 characters, at most 500 (setting "Longest acceptance criterion")',
  ],
  [
    'plan-assignee',
    { refusal: 'No agent profile with the key writer', assignable: 'web_dev (Web Developer)' },
    'No agent profile with the key writer. Choose one of web_dev (Web Developer), or leave the assignee out',
  ],
  [
    'plan-blocks-itself',
    { item: 'form' },
    `"form" is this ticket's own key: a ticket cannot wait for itself`,
  ],
  ['plan-unknown-key', { item: 'layout' }, 'no ticket of your plan has the key "layout"'],
  [
    'plan-other-project',
    { item: 'APP-3', project: 'WEB' },
    'APP-3 belongs to another project: name keys of your plan, or tickets of WEB',
  ],
  [
    'plan-unknown-ticket',
    { item: 'WEB-99' },
    'there is no ticket WEB-99 in the project: use ticket_list to find its tickets',
  ],
  [
    'plan-no-project-ticket',
    { item: 'WEB-3' },
    'WEB-3 is a ticket number, but the request asks for a new project, which has no tickets yet: name keys of your plan',
  ],
  [
    'plan-not-a-reference',
    { item: 'Layout', project: 'WEB' },
    '"Layout" is neither a key of your plan nor a ticket number such as WEB-3',
  ],
  [
    'plan-not-a-key',
    { item: 'Layout' },
    '"Layout" is not a key of your plan: keys are 1 to 40 lowercase letters, digits, "-" or "_"',
  ],
  [
    'plan-cycle',
    { cycle: 'a → b → a' },
    'these tickets wait for each other, so none of them could ever start: a → b → a. Remove one of these dependencies',
  ],
  [
    'plan-new-project-unwanted',
    { request: '7', project: 'WEB' },
    'request 7 is for the project WEB: leave new_project out',
  ],
  [
    'plan-new-project-missing',
    { request: '7' },
    'request 7 asks for a new project: give new_project, with its name, kind and description',
  ],
  [
    'plan-android',
    {},
    'Android projects come with version 0.8.0: choose website or web_app. If the request needs an Android app, end your run with ticket_give_up, saying so',
  ],
  [
    'plan-bootstrap-unwanted',
    { project: 'WEB' },
    'the project WEB already exists: only a plan for a new project has a bootstrap ticket. Remove bootstrap',
  ],
  [
    'plan-bootstrap-missing',
    {},
    'a plan for a new project needs exactly one ticket with bootstrap true: a chore assigned to architect and blocked by nothing, which sets the project up',
  ],
  [
    'plan-bootstrap-several',
    { count: '2', keys: 'setup, harness' },
    '2 tickets have bootstrap true (setup, harness): exactly one may have it',
  ],
  [
    'plan-bootstrap-type',
    { type: 'feature' },
    'the bootstrap ticket must be a chore, not a feature',
  ],
  ['plan-bootstrap-assignee', {}, 'the bootstrap ticket must be assigned to architect'],
  [
    'plan-bootstrap-blocked',
    {},
    'the bootstrap ticket waits for nothing: remove its blocked_by (every other ticket waits for it)',
  ],
  [
    'plan-bootstrap-criteria',
    { count: '22', added: '8', max: '20', own: '12' },
    '22 criteria once the 8 fixed ones the Orchestrator adds are counted: at most 20 (setting "Most acceptance criteria"). Keep at most 12 criteria of your own besides the fixed ones',
  ],
  [
    'plan-bootstrap-settings',
    { setting: 'Most acceptance criteria', value: '5', needed: '8 criteria' },
    'the setting "Most acceptance criteria" (5) is too low for the fixed criteria of the bootstrap ticket, which need 8 criteria. Only the owner can raise it: end your run with ticket_give_up, saying so',
  ],
  [
    'plan-accepted',
    { request: '7', count: '5' },
    "Your plan for request 7 is recorded, with 5 tickets, and waits for the owner's review. End your turn now, without another tool call.",
  ],
  [
    'plan-accepted-bootstrap',
    { key: 'setup', added: '7' },
    'The bootstrap ticket setup is first: it received 7 fixed criteria, and every other ticket waits for it.',
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

  it('have no part left out above, and none that backend.ts or plan_propose does not use', async () => {
    expect([...texts.parts.keys()].sort()).toEqual(BEFORE.map(([name]) => name).sort());
    // plan_propose words its problems in its own module (lot 5 step E1b).
    const source = [
      await readFile(new URL('./backend.ts', import.meta.url), 'utf8'),
      await readFile(new URL('../requests/plan-propose.ts', import.meta.url), 'utf8'),
    ].join('\n');
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
