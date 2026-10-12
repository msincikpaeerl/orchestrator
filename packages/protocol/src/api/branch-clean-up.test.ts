import { describe, expect, it } from 'vitest';
import { isTicketBranchName } from './branch-clean-up.js';

describe('a ticket branch name (04, section 4)', () => {
  it.each(['t/1', 't/1-contact-form', 't/12-a1-b2', 't/305'])('accepts %s', (name) => {
    expect(isTicketBranchName(name)).toBe(true);
  });

  it.each([
    'main',
    't/',
    't/0',
    't/01-x',
    't/1-',
    't/1--x',
    't/1-Contact',
    't/1/x',
    'T/1',
    'feature/t/1',
    ' t/1',
    't/1 ',
    'refs/heads/t/1',
  ])('refuses %j', (name) => {
    expect(isTicketBranchName(name)).toBe(false);
  });

  it("with a ticket number, accepts only that ticket's: t/1 is never t/12's", () => {
    expect(isTicketBranchName('t/1-contact-form', 1)).toBe(true);
    expect(isTicketBranchName('t/1', 1)).toBe(true);
    expect(isTicketBranchName('t/12-contact-form', 1)).toBe(false);
    expect(isTicketBranchName('t/12', 1)).toBe(false);
    expect(isTicketBranchName('t/1', 12)).toBe(false);
    expect(isTicketBranchName('t/12-x', 12)).toBe(true);
  });
});
