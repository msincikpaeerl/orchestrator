import { describe, expect, it } from 'vitest';
import { settingCeiling, TEXT_CEILING } from '../text-limits.js';
import { McpError } from './errors.js';
import { MCP_TOOLS, McpToolName } from './tools.js';

const at = '2026-09-25T10:00:00.000Z';
const commentId = '5f0c7c1e-8a3b-4c1d-9e2f-0a1b2c3d4e5f';

const ticket = {
  number: 'WEB-12',
  type: 'feature',
  title: 'Contact form',
  status: 'in_progress',
  priority: 'normal',
  assignee: 'web_dev',
  blocked: false,
  description: 'A form to write to the bakery.',
  acceptance_criteria: ['The form validates the email'],
  blocked_by: [{ number: 'WEB-1', title: 'Bootstrap', status: 'done' }],
  blocks: [],
  created_by: 'owner',
  dod_report: null,
  pull_request_url: null,
};

const comment = {
  id: commentId,
  author: { agent: 'web_dev' },
  kind: 'question',
  body: 'Which colour?',
  answers: null,
  created_at: at,
};

const report = {
  criteria: [{ index: 0, status: 'met', justification: 'See ContactForm.test.ts' }],
  tests: { paths: ['src/contact/ContactForm.test.ts'], justification: null },
  docs: { paths: [], justification: 'No user-visible change.' },
  adrs: [],
  summary: 'Adds a contact form with client-side validation.',
};

type Json = Record<string, unknown>;

/** A valid input and output of every tool. */
const examples: Record<McpToolName, { input: Json; output: Json }> = {
  project_get: {
    input: {},
    output: {
      key: 'WEB',
      name: 'Bakery website',
      description: '',
      kind: 'website',
      repository: { owner: 'owner-login', name: 'bakery', default_branch: 'main' },
      conventions: {
        claude_md: 'CLAUDE.md',
        user_docs: 'docs/user/',
        dev_docs: 'docs/dev/',
        adrs: 'docs/adr/',
      },
      missing: [],
    },
  },
  ticket_get: { input: { ticket: 'WEB-1' }, output: { ticket } },
  ticket_list: {
    input: { status: ['todo', 'in_progress'], assignee: 'web_dev', text: 'form' },
    output: {
      tickets: [
        {
          number: 'WEB-12',
          type: 'feature',
          title: 'Contact form',
          status: 'todo',
          priority: 'high',
          assignee: null,
          blocked: true,
        },
      ],
      next_cursor: 'page-2',
    },
  },
  ticket_comments: { input: {}, output: { comments: [comment], next_cursor: null } },
  agent_list: {
    input: {},
    output: {
      agents: [
        { key: 'web_dev', name: 'Web Dev', role: 'builder', description: 'Builds web features.' },
      ],
    },
  },
  ticket_progress: {
    input: { text: 'Writing tests for the contact form' },
    output: { progress: 'Writing tests for the contact form', at },
  },
  ticket_comment: { input: { body: 'The API has no rate limit.' }, output: { comment } },
  ticket_ask: {
    input: { question: 'Which colour?' },
    output: { comment, ticket: { ...ticket, status: 'waiting_human' } },
  },
  ticket_give_up: {
    input: { reason: 'The payment API does not exist.', tried: 'Searched the docs and the code.' },
    output: { ticket: { ...ticket, status: 'todo' } },
  },
  ticket_create: {
    input: {
      type: 'bug',
      title: 'Menu overlaps the logo on phones',
      description: 'Seen while testing the contact form.',
      acceptance_criteria: ['The menu never covers the logo'],
      priority: 'low',
      blocked_by: ['WEB-12'],
      assignee: 'web_dev',
    },
    output: {
      ticket: {
        ...ticket,
        number: 'WEB-13',
        status: 'proposed',
        created_by: { agent: 'web_dev' },
      },
    },
  },
  ticket_submit: {
    input: report,
    output: { result: 'accepted', ticket: { ...ticket, status: 'in_review', dod_report: report } },
  },
};

/** For each tool with input fields: a required field, and a text field with its ceiling. */
const inputFields: Partial<Record<McpToolName, { required?: string; text?: [string, number] }>> = {
  ticket_list: { text: ['text', TEXT_CEILING] },
  ticket_progress: { required: 'text', text: ['text', TEXT_CEILING] },
  ticket_comment: { required: 'body', text: ['body', settingCeiling('commentMaxLength')] },
  ticket_ask: { required: 'question', text: ['question', settingCeiling('commentMaxLength')] },
  ticket_give_up: { required: 'tried', text: ['reason', settingCeiling('commentMaxLength')] },
  ticket_create: { required: 'title', text: ['title', settingCeiling('ticketTitleMaxLength')] },
  ticket_submit: { required: 'summary', text: ['summary', TEXT_CEILING] },
};

describe('MCP_TOOLS', () => {
  it('holds the lot 2 tools, named <object>_<verb>', () => {
    expect([...McpToolName.options].sort()).toEqual(Object.keys(examples).sort());
    for (const name of McpToolName.options) expect(name).toMatch(/^[a-z]+_[a-z_]+$/);
  });

  it('refuses an unknown tool name, and the dotted names of the specifications', () => {
    expect(McpToolName.safeParse('ticket_push').success).toBe(false);
    expect(McpToolName.safeParse('ticket.create').success).toBe(false);
  });

  it.each(McpToolName.options)('%s has a description written for the agent', (name) => {
    expect(MCP_TOOLS[name].description.length).toBeGreaterThan(80);
  });

  it('tells the agent what to do instead (owner review of step B)', () => {
    const guidance: [McpToolName, string][] = [
      ['ticket_progress', 'calling it more often is harmless but useless'],
      ['ticket_submit', 'every acceptance criterion'],
      ['ticket_submit', 'relative to the worktree root'],
      ['ticket_submit', 'never push and never switch branches'],
      ['ticket_submit', 'If a criterion cannot be met, do not submit'],
      ['ticket_create', 'Search with ticket_list first'],
      ['ticket_give_up', 'Never give up because a command was refused'],
    ];
    for (const [name, text] of guidance) expect(MCP_TOOLS[name].description).toContain(text);
    expect(MCP_TOOLS.ticket_progress.description).not.toContain('LIMIT_REACHED');
  });

  it.each(McpToolName.options)('%s accepts its valid input and output', (name) => {
    expect(MCP_TOOLS[name].input.safeParse(examples[name].input).success).toBe(true);
    expect(MCP_TOOLS[name].output.safeParse(examples[name].output).success).toBe(true);
  });

  it.each(McpToolName.options)('%s refuses an unknown input field and a non-object', (name) => {
    const { input } = MCP_TOOLS[name];
    expect(input.safeParse({ ...examples[name].input, ticket_id: 12 }).success).toBe(false);
    expect(input.safeParse('WEB-12').success).toBe(false);
  });

  it.each(Object.entries(inputFields))(
    '%s refuses a missing field and oversized text',
    (name, fields) => {
      const { input } = MCP_TOOLS[name as McpToolName];
      const example = examples[name as McpToolName].input;
      if (fields.required) {
        const missing = Object.fromEntries(
          Object.entries(example).filter(([key]) => key !== fields.required),
        );
        expect(input.safeParse(missing).success).toBe(false);
      }
      if (fields.text) {
        const [field, max] = fields.text;
        expect(input.safeParse({ ...example, [field]: 'x'.repeat(max) }).success).toBe(true);
        expect(input.safeParse({ ...example, [field]: 'x'.repeat(max + 1) }).success).toBe(false);
      }
    },
  );
});

describe('wrong types and inconsistent inputs', () => {
  const refused: [string, McpToolName, Json][] = [
    ['a ticket number without its project key', 'ticket_get', { ticket: '12' }],
    ['a ticket given as a number', 'ticket_get', { ticket: 12 }],
    ['an unknown status filter', 'ticket_list', { status: ['doing'] }],
    ['an empty status filter', 'ticket_list', { status: [] }],
    ['an empty progress line', 'ticket_progress', { text: '   ' }],
    ['an unknown ticket type', 'ticket_create', { ...examples.ticket_create.input, type: 'epic' }],
    [
      'a criterion list as text',
      'ticket_create',
      { ...examples.ticket_create.input, acceptance_criteria: 'works' },
    ],
    [
      'too many criteria',
      'ticket_create',
      {
        ...examples.ticket_create.input,
        acceptance_criteria: Array.from(
          { length: settingCeiling('ticketMaxAcceptanceCriteria') + 1 },
          () => 'ok',
        ),
      },
    ],
    [
      'an assignee that is not a profile key',
      'ticket_create',
      { ...examples.ticket_create.input, assignee: 'Web Dev' },
    ],
    [
      'a criterion status other than met or not_met',
      'ticket_submit',
      { ...report, criteria: [{ index: 0, status: 'done', justification: 'x' }] },
    ],
    [
      'the same criterion twice',
      'ticket_submit',
      { ...report, criteria: [report.criteria[0], report.criteria[0]] },
    ],
    [
      'no tests and no justification',
      'ticket_submit',
      { ...report, tests: { paths: [], justification: null } },
    ],
    ['a report without its docs', 'ticket_submit', { ...report, docs: undefined }],
  ];

  it.each(refused)('refuses %s', (_, tool, input) => {
    expect(MCP_TOOLS[tool].input.safeParse(input).success).toBe(false);
  });
});

describe('McpError', () => {
  it('accepts every code of 06, section 3 with details, and nothing else', () => {
    for (const code of [
      'FORBIDDEN',
      'NOT_FOUND',
      'INVALID_TRANSITION',
      'VALIDATION_FAILED',
      'DOD_FAILED',
      'LIMIT_REACHED',
      'UNAVAILABLE',
    ]) {
      expect(McpError.safeParse({ code, message: 'Explained for the agent.' }).success).toBe(true);
    }
    expect(
      McpError.safeParse({
        code: 'LIMIT_REACHED',
        message: 'Limit of 3 tickets per run reached.',
        details: [
          { message: 'Limit of 3 tickets per run reached.', setting: 'maxAgentTicketsPerRun' },
        ],
      }).success,
    ).toBe(true);
    expect(McpError.safeParse({ code: 'TIMEOUT', message: 'x' }).success).toBe(false);
    expect(McpError.safeParse({ code: 'FORBIDDEN' }).success).toBe(false);
  });
});
