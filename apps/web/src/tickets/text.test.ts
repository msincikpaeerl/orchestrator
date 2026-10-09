import type { NeedsYouItem } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { pullRequestFailureText, pullRequestNotOpenedText, pushFailedText } from './text';

type PushFailed = Extract<NeedsYouItem, { type: 'push_failed' }>;

const item = (fields: Partial<PushFailed>): PushFailed => ({
  type: 'push_failed',
  ticket: { projectKey: 'WEB', number: 4, title: 'Contact form' },
  machine: { id: '00000000-0000-4000-8000-000000000001', name: 'Laptop' },
  reason: 'refused',
  permission: null,
  message: 'remote: Repository rule violations found',
  since: '2026-10-08T10:00:00.000Z',
  ...fields,
});

describe('pushFailedText (04, section 5)', () => {
  it("names the permission as GitHub's token page does", () => {
    expect(pushFailedText(item({ permission: 'contents' }))).toEqual({
      title: 'GitHub refused the push of WEB-4: the token needs Contents (Read and write)',
      detail:
        "The work is committed on machine Laptop but is not on GitHub. On GitHub's list of your tokens, open the Orchestrator's token, set Contents (Read and write), and save it; do not regenerate it. Then press Run now on the ticket: the next run, on Laptop, pushes the work.",
    });
    const workflows = pushFailedText(item({ permission: 'workflows' }));
    expect(workflows.title).toBe(
      'GitHub refused the push of WEB-4: the token needs Workflows (Read and write)',
    );
    expect(workflows.detail).toContain('The work changes a GitHub workflow');
  });

  it("points to GitHub's own words for any other refusal", () => {
    expect(pushFailedText(item({})).title).toBe('GitHub refused the push of WEB-4');
    expect(pushFailedText(item({})).detail).toContain(
      "GitHub's words are below. When their cause is fixed, press Run now",
    );
  });

  it('says what happens for a diverged branch and for GitHub unreachable', () => {
    expect(pushFailedText(item({ reason: 'diverged' }))).toMatchObject({
      title: 'The branch of WEB-4 changed on GitHub',
      detail: expect.stringContaining("brings GitHub's commits in with a merge") as string,
    });
    expect(pushFailedText(item({ reason: 'unreachable' })).title).toBe(
      'GitHub could not be reached to push WEB-4',
    );
  });
});

type NotOpened = Extract<NeedsYouItem, { type: 'pull_request_not_opened' }>;

const notOpened = (
  failure: Partial<NotOpened['failure']>,
  openPullRequest: number | null = null,
): NotOpened => ({
  type: 'pull_request_not_opened',
  ticket: { projectKey: 'WEB', number: 4, title: 'Contact form' },
  failure: {
    reason: 'refused',
    message: 'Validation Failed: base: invalid',
    permission: null,
    fields: [],
    at: '2026-10-08T10:00:00.000Z',
    ...failure,
  },
  openPullRequest,
  since: '2026-10-08T10:00:00.000Z',
});

describe('pullRequestNotOpenedText (04, section 3.1)', () => {
  it("names the permission as GitHub's token page does", () => {
    expect(
      pullRequestNotOpenedText(
        notOpened({ reason: 'permission_missing', permission: 'pull_requests' }),
      ),
    ).toEqual({
      title: 'Pull request not opened for WEB-4: the token needs Pull requests (Read and write)',
      detail:
        "The work of WEB-4 is on GitHub, but the Orchestrator could not open its pull request. On GitHub's list of your tokens, open the Orchestrator's token, set Pull requests (Read and write), and save it; do not regenerate it. Then press Try again.",
      where: 'tokens',
      showMessage: false,
    });
  });

  it("shows GitHub's words for a refusal, and a permission it did not name", () => {
    expect(pullRequestNotOpenedText(notOpened({}))).toMatchObject({
      title: 'GitHub refused to open the pull request of WEB-4',
      showMessage: true,
    });
    expect(
      pullRequestNotOpenedText(notOpened({ reason: 'permission_missing', permission: null }))
        .showMessage,
    ).toBe(true);
  });

  it('says what to do for each other reason', () => {
    expect(pullRequestNotOpenedText(notOpened({ reason: 'unreachable' })).title).toBe(
      'Pull request not opened for WEB-4: GitHub could not be reached',
    );
    expect(
      pullRequestNotOpenedText(
        notOpened({ reason: 'no_token', message: 'No GitHub token is saved' }),
      ),
    ).toMatchObject({
      where: 'settings',
      detail: expect.stringContaining('No GitHub token is saved. Save') as string,
    });
    expect(pullRequestNotOpenedText(notOpened({ reason: 'rate_limited' })).detail).toContain(
      'Wait a few minutes',
    );
    expect(pullRequestNotOpenedText(notOpened({ reason: 'unreadable' })).detail).toContain(
      'never opens a second one',
    );
  });
});

describe("a pull request not updated (owner's correction, step F4)", () => {
  it('says the open pull request was not updated, and what is out of date', () => {
    const text = pullRequestNotOpenedText(notOpened({ reason: 'unreachable' }, 12));
    expect(text.title).toBe('Pull request not updated for WEB-4: GitHub could not be reached');
    expect(text.detail).toMatch(
      /^The work of WEB-4 is on GitHub, but the Orchestrator could not update its pull request #12: its description still shows the report of the earlier submission\. The new commits are on GitHub, in the pull request\./,
    );
    expect(pullRequestNotOpenedText(notOpened({}, 12)).title).toBe(
      'GitHub refused to update the pull request of WEB-4',
    );
  });

  it('gives the heading of the ticket page', () => {
    const failure = notOpened({ reason: 'unreachable' }).failure;
    expect(pullRequestFailureText('WEB-4', failure, 12).heading).toBe('Pull request not updated');
    expect(pullRequestFailureText('WEB-4', failure, null).heading).toBe('Pull request not opened');
  });
});
