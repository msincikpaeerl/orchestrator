import { describe, expect, it } from 'vitest';
import { formatDate, problemText } from './text';

describe('formatDate', () => {
  it('writes the date out, whatever the time zone', () => {
    expect(formatDate('2027-09-23')).toBe('September 23, 2027');
  });
});

describe('problemText', () => {
  it('names the missing permission as GitHub shows it', () => {
    expect(
      problemText({ type: 'permission_missing', permission: 'pull_requests', access: 'write' }),
    ).toEqual({
      title: 'The GitHub token is missing the Pull requests permission',
      detail:
        'Give it "Read and write" access: create a new token with the "Create the token on GitHub" button and enter it.',
    });
  });

  it("reads the permissions of GitHub's refusal header", () => {
    expect(
      problemText({
        type: 'permission_refused',
        permissions: ['workflows=write', 'something_new'],
        request: 'PUT /repos/o/r/contents/x',
        at: '2026-09-23T10:00:00.000Z',
      }).detail,
    ).toContain('The token needs: Workflows (Read and write), something_new.');
  });

  it('uses the wording of the secret key page for an unreadable token', () => {
    expect(problemText({ type: 'token_unreadable', since: '2026-09-23T10:00:00.000Z' }).title).toBe(
      'Enter your GitHub token again',
    );
  });
});
