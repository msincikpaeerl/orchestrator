import type { PlanTicketView } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import {
  approveNewProjectText,
  approveText,
  blockerText,
  closeTexts,
  earlierPlanHeading,
  listText,
  notApprovableText,
  planProblemPlace,
  planToReviewHeading,
  removeTexts,
} from './plan-text';

const ticket = (key: string, waitsFor: string[] = []): PlanTicketView => ({
  key,
  type: 'feature',
  title: `Title of ${key}`,
  description: '',
  acceptance_criteria: [],
  priority: 'normal',
  assignee: null,
  blocked_by: waitsFor,
  bootstrap: false,
  assigneeName: null,
  waitsFor: waitsFor.map((each) => ({ kind: 'plan', key: each, title: `Title of ${each}` })),
  created: null,
});

describe('Needs you and Approve (owner answers 12 and 13, lot 5 step F)', () => {
  it('names the request, its project or a new project, and its first line', () => {
    const request = { number: 7, line: 'A contact form', project: { key: 'TESTB', name: 'B' } };
    expect(planToReviewHeading(request)).toBe(
      'Plan to review for request 7 (TESTB): A contact form',
    );
    expect(planToReviewHeading({ ...request, project: null })).toBe(
      'Plan to review for request 7 (new project): A contact form',
    );
  });

  it('counts the tickets Approve creates', () => {
    expect(approveText(4, 'TESTB')).toBe(
      'It creates 4 tickets in TESTB, in To do. The scheduler starts them by themselves as machines are free: each one uses Claude Code sessions.',
    );
    expect(approveText(1, 'TESTB')).toMatch(/^It creates 1 ticket in TESTB/);
  });

  it('says what Approve creates for a new project (owner answer 6, step G)', () => {
    expect(
      approveNewProjectText({
        ticketCount: 4,
        name: 'Contact site',
        key: 'SITE',
        repository: 'octo-owner/contact-site',
        private: true,
      }),
    ).toBe(
      "It creates the project Contact site (SITE) and its private repository octo-owner/contact-site on GitHub with the starting files, then 4 tickets in SITE, in To do. They wait for the project's setup; then the scheduler starts them by themselves as machines are free: each one uses Claude Code sessions.",
    );
    expect(
      approveNewProjectText({
        ticketCount: 1,
        name: 'Blog',
        key: 'BLOG',
        repository: 'blog',
        private: false,
      }),
    ).toMatch(
      /^It creates the project Blog \(BLOG\) and its public repository blog on GitHub with the starting files, then 1 ticket in BLOG/,
    );
  });

  it('says why Approve is not offered (owner answer 5, step F2)', () => {
    expect(notApprovableText({ key: 'TESTB', archived: false })).toBeNull();
    expect(notApprovableText(null)).toBeNull();
    expect(notApprovableText({ key: 'TESTB', archived: true })).toBe(
      'TESTB is archived: its plan cannot be approved. Reject it with feedback, or close the request.',
    );
  });
});

describe('Remove and Close request (owner answers 3 and 4, step F2)', () => {
  it('names the tickets that wait for the removed one', () => {
    const plan = {
      tickets: [ticket('HOME'), ticket('CONTACT', ['HOME']), ticket('DOCS', ['HOME', 'CONTACT'])],
    };
    expect(removeTexts(plan, { key: 'HOME', title: 'Home page' })).toEqual({
      title: 'Remove HOME (Home page) from the plan?',
      lines: [
        'CONTACT and DOCS wait for it: they will no longer.',
        'A removed ticket cannot be added back: to get it again, reject the plan with feedback.',
      ],
    });
    expect(removeTexts(plan, { key: 'CONTACT', title: 'Form' }).lines[0]).toBe(
      'DOCS waits for it: it will no longer.',
    );
    expect(removeTexts(plan, { key: 'DOCS', title: 'Docs' }).lines).toHaveLength(1);
  });

  it('names the run it stops and the plan it rejects, only when there are', () => {
    expect(closeTexts({ runActive: true, planProposed: true })).toEqual([
      'It is final: the request cannot be reopened. Submit a new request to ask again.',
      'Its planning run stops now; this does not count as a failed attempt.',
      'Its proposed plan is rejected: no ticket is created.',
      'You can still add comments.',
    ]);
    expect(closeTexts({ runActive: false, planProposed: false })).toHaveLength(2);
  });

  it('joins names in plain English', () => {
    expect(listText(['A'])).toBe('A');
    expect(listText(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('the plan list', () => {
  it('names what a ticket waits for, in the plan or in the project', () => {
    expect(blockerText({ kind: 'plan', key: 'HOME', title: 'Home page' })).toBe('HOME (Home page)');
    expect(
      blockerText({ kind: 'ticket', reference: 'WEB-3', title: 'Logo', status: 'in_progress' }),
    ).toBe('WEB-3 (Logo, in progress)');
    expect(blockerText({ kind: 'ticket', reference: 'WEB-9', title: null, status: null })).toBe(
      'WEB-9 (no such ticket in the project)',
    );
  });

  it('says how an earlier plan ended (owner answer 7, step F2)', () => {
    const at = '2026-11-01T10:00:00.000Z';
    expect(earlierPlanHeading({ status: 'superseded', proposedAt: at, decidedAt: at })).toMatch(
      /^Proposed at .+, rejected with your feedback at .+$/,
    );
    expect(earlierPlanHeading({ status: 'rejected', proposedAt: at, decidedAt: at })).toMatch(
      /^Proposed at .+, rejected at .+$/,
    );
  });

  it('locates a problem by the ticket key and field', () => {
    expect(planProblemPlace({ position: 2, key: 'contact', field: 'title', message: 'x' })).toBe(
      'Ticket “contact”, field title',
    );
    expect(planProblemPlace({ position: null, key: null, field: null, message: 'x' })).toBe(
      'The plan',
    );
  });
});
