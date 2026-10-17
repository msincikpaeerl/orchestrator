import {
  DownloadFailure,
  PUSH_PERMISSION_WORDS,
  shorten,
  type PushPermission,
  type RunDownloadFailure,
} from '@orchestrator/protocol';
import type { RunRow } from './model.js';

// A project download that failed at a run's start (04, section 5; owner's answers 1 and 2, lot 3
// step K2): what the machine reported, and the words of the ticket's comment.

/** The Orchestrator's own refusal of the credential, as the daemon words it. */
const ORCHESTRATOR_REFUSAL = 'The Orchestrator refused the credential: ';

/**
 * The permission a refused download lacked, from GitHub's words: a repository GitHub says is not
 * found (HTTP 404) or forbidden (403) is one the token cannot read, which needs Contents. A token
 * GitHub does not accept at all (401, "Authentication failed") lacks no permission: null.
 */
export function downloadPermission(failure: DownloadFailure): PushPermission | null {
  if (failure.reason !== 'refused' || failure.message.startsWith(ORCHESTRATOR_REFUSAL)) return null;
  return /Repository not found|repository '[^']*' not found|returned error: 40[34]/.test(
    failure.message,
  )
    ? 'contents'
    : null;
}

/** A run's failed download; null unless it ended `download_failed` with the machine's reason. */
export function runDownload(row: Pick<RunRow, 'downloadFailure'>): RunDownloadFailure | null {
  if (row.downloadFailure === null) return null;
  const failure = DownloadFailure.parse(row.downloadFailure);
  return { ...failure, permission: downloadPermission(failure) };
}

/**
 * Why the download failed and what to do, for the ticket's comment: one sentence each, the first
 * continuing "… could not be downloaded from GitHub". Without the machine's reason (an end
 * report that carried none), only that it failed.
 */
export function downloadWords(
  download: RunDownloadFailure | null,
  repository: string,
): { why: string; todo: string } {
  if (download === null) {
    return { why: '.', todo: 'Use Run now to try again.' };
  }
  switch (download.reason) {
    case 'unreachable':
      return {
        why: ', because GitHub could not be reached from that machine.',
        todo: "Check that machine's connection to GitHub, then use Run now.",
      };
    case 'too_long':
      return {
        why: ', because the download took longer than Longest push and was stopped. The first download on a new machine takes the longest.',
        todo: 'Use Run now to try again, or raise Longest push in Settings > Limits.',
      };
    case 'refused':
      if (download.permission !== null) {
        return {
          why: `, because GitHub refused the token: it needs access to ${repository} with the permission ${PUSH_PERMISSION_WORDS[download.permission]}.`,
          todo: 'Change the token on GitHub, then use Run now.',
        };
      }
      if (download.message.startsWith(ORCHESTRATOR_REFUSAL)) {
        return {
          why: `, because the Orchestrator did not give the GitHub token: ${sentenceEnd(download.message.slice(ORCHESTRATOR_REFUSAL.length))}.`,
          todo: 'Check Settings > GitHub, then use Run now.',
        };
      }
      return {
        why: `, because GitHub refused the token: ${sentenceEnd(shorten(download.message, 300))}.`,
        todo: 'Check the token in Settings > GitHub, then use Run now.',
      };
  }
}

function sentenceEnd(text: string): string {
  return text.trim().replace(/[.\s]+$/, '');
}
