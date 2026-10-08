import type { NeedsYouItem } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { pushFailedText } from './text';

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
