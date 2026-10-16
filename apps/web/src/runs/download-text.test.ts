import type { NeedsYouItem, RunDownloadFailure } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { reviewNotFinishedText } from '../tickets/review-text';
import { downloadFailedText, downloadRunText, showsGitHubWords } from './download-text';

// A project download that failed at a run's start, in the owner's words (owner's answers 1 and 2,
// lot 3 step K2): which of the three causes, and what to do.

const TICKET = { projectKey: 'BAK', number: 12, title: 'Contact form' };
const MACHINE = { id: '6f2b0c1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b', name: 'laptop' };
const SINCE = '2026-10-17T09:00:00.000Z';

function item(download: RunDownloadFailure): Extract<NeedsYouItem, { type: 'download_failed' }> {
  return {
    type: 'download_failed',
    ticket: TICKET,
    runId: '0f7a3c52-9d7e-4e8f-a4b1-111111111111',
    machine: MACHINE,
    download,
    since: SINCE,
  };
}

const LEAD =
  'Machine laptop could not download the project from GitHub when the run started, so the agent never started';

describe('downloadFailedText', () => {
  it('GitHub unreachable', () => {
    expect(
      downloadFailedText(
        item({ reason: 'unreachable', message: 'Could not resolve host', permission: null }),
      ),
    ).toEqual({
      title: 'BAK-12 could not be downloaded from GitHub on laptop: Contact form',
      detail: `${LEAD}: GitHub could not be reached from laptop. It does not count as a failed attempt. Check that laptop is connected to the internet and that GitHub works, then press Run now.`,
    });
  });

  it('Longest push reached', () => {
    expect(
      downloadFailedText(item({ reason: 'too_long', message: 'took longer', permission: null }))
        .detail,
    ).toBe(
      `${LEAD}: the download took longer than Longest push and was stopped. It does not count as a failed attempt. The first download of a project on a new machine takes the longest. Press Run now to try again, or raise Longest push in Settings > Limits.`,
    );
  });

  it("the token refused, naming the permission in the token page's words", () => {
    const download: RunDownloadFailure = {
      reason: 'refused',
      message: 'remote: Repository not found.',
      permission: 'contents',
    };
    expect(downloadFailedText(item(download)).detail).toBe(
      `${LEAD}: GitHub refused the token, which needs Contents (Read and write) on the project's repository. It does not count as a failed attempt. On GitHub's list of your tokens, open the Orchestrator's token, make sure it includes the project's repository with Contents (Read and write), and save it; do not regenerate it. Then press Run now.`,
    );
    expect(showsGitHubWords(download)).toBe(false);
  });

  it("the Orchestrator's refusal, in its words", () => {
    const download: RunDownloadFailure = {
      reason: 'refused',
      message: 'The Orchestrator refused the credential: GitHub is not connected.',
      permission: null,
    };
    expect(downloadFailedText(item(download)).detail).toBe(
      `${LEAD}: the Orchestrator did not give the GitHub token: GitHub is not connected. It does not count as a failed attempt. Check Settings > GitHub, then press Run now.`,
    );
    expect(showsGitHubWords(download)).toBe(false);
  });

  it("another refusal shows GitHub's words", () => {
    const download: RunDownloadFailure = {
      reason: 'refused',
      message: 'fatal: Authentication failed',
      permission: null,
    };
    expect(downloadFailedText(item(download)).detail).toBe(
      `${LEAD}: GitHub refused the token. It does not count as a failed attempt. GitHub's words are below. Check the token in Settings > GitHub, then press Run now.`,
    );
    expect(showsGitHubWords(download)).toBe(true);
  });
});

describe('a review run', () => {
  it('says Start review on its run page', () => {
    expect(
      downloadRunText({ reason: 'unreachable', message: 'x', permission: null }, 'laptop', true),
    ).toBe(
      `${LEAD}: GitHub could not be reached from laptop. It does not count as a failed attempt. Check that laptop is connected to the internet and that GitHub works, then press Start review.`,
    );
  });

  it('keeps "Review did not finish", with the true words', () => {
    expect(
      reviewNotFinishedText({
        type: 'review_not_finished',
        ticket: TICKET,
        runId: '0f7a3c52-9d7e-4e8f-a4b1-111111111111',
        machine: MACHINE,
        decision: null,
        end: {
          why: 'download_failed',
          download: { reason: 'too_long', message: 'took longer', permission: null },
        },
        since: SINCE,
      }),
    ).toEqual({
      title: 'Review did not finish for BAK-12: Contact form',
      detail:
        'The review run on laptop ended without a decision: the project could not be downloaded from GitHub at its start, because the download took longer than Longest push and was stopped. It does not count as a failed attempt.',
    });
  });
});
