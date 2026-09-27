import { describe, expect, it } from 'vitest';
import { CreateTicketRequest, MarkDoneRequest, UpdateTicketRequest } from './tickets.js';

describe('CreateTicketRequest', () => {
  it('fills in the defaults and trims the text', () => {
    expect(CreateTicketRequest.parse({ type: 'bug', title: '  Fix the menu ' })).toEqual({
      type: 'bug',
      title: 'Fix the menu',
      description: '',
      acceptanceCriteria: [],
      priority: 'normal',
      blockedBy: [],
      assignee: null,
    });
  });

  it('refuses an empty title or criterion, a bad number and an unknown field', () => {
    for (const body of [
      { type: 'bug', title: '   ' },
      { type: 'bug', title: 'T', acceptanceCriteria: ['ok', ' '] },
      { type: 'bug', title: 'T', blockedBy: [0] },
      { type: 'bug', title: 'T', blockedBy: ['2'] },
      { type: 'bug', title: 'T', status: 'done' },
      { type: 'epic', title: 'T' },
      { type: 'bug', title: 'T', assignee: 'Web Dev' },
    ]) {
      expect(CreateTicketRequest.safeParse(body).success).toBe(false);
    }
  });
});

describe('UpdateTicketRequest', () => {
  it('needs at least one field and never changes the status', () => {
    expect(UpdateTicketRequest.safeParse({}).success).toBe(false);
    expect(UpdateTicketRequest.safeParse({ status: 'done' }).success).toBe(false);
    expect(UpdateTicketRequest.safeParse({ priority: 'high' }).success).toBe(true);
    expect(UpdateTicketRequest.safeParse({ assignee: null }).success).toBe(true);
    expect(UpdateTicketRequest.safeParse({ assignee: 'web_dev' }).success).toBe(true);
  });
});

describe('MarkDoneRequest', () => {
  it('needs a comment', () => {
    expect(MarkDoneRequest.safeParse({}).success).toBe(false);
    expect(MarkDoneRequest.safeParse({ comment: '  ' }).success).toBe(false);
    expect(MarkDoneRequest.safeParse({ comment: 'Done by hand' }).success).toBe(true);
  });
});
