import {
  PUSH_PERMISSION_WORDS,
  type NeedsYouItem,
  type RunDownloadFailure,
} from '@orchestrator/protocol';
import { ticketRef } from '../tickets/text';

// A project download that failed at a run's start (04, section 5; owner's answers 1 and 2, lot 3
// step K2): which of the three causes, and what to do, for "Needs you", the run page and "Review
// did not finish".

/** The Orchestrator's own refusal of the credential, as the machine words it. */
const ORCHESTRATOR_REFUSAL = 'The Orchestrator refused the credential: ';

const NOT_COUNTED = 'It does not count as a failed attempt.';

function withoutStop(text: string): string {
  return text.trim().replace(/[.\s]+$/, '');
}

/** Why the download failed, as the end of a sentence. */
export function downloadReason(download: RunDownloadFailure | null, machine: string): string {
  if (download === null) return 'the machine gave no reason';
  switch (download.reason) {
    case 'unreachable':
      return `GitHub could not be reached from ${machine}`;
    case 'too_long':
      return 'the download took longer than Longest push and was stopped';
    case 'refused':
      if (download.permission !== null) {
        return `GitHub refused the token, which needs ${PUSH_PERMISSION_WORDS[download.permission]} on the project's repository`;
      }
      if (download.message.startsWith(ORCHESTRATOR_REFUSAL)) {
        return `the Orchestrator did not give the GitHub token: ${withoutStop(download.message.slice(ORCHESTRATOR_REFUSAL.length))}`;
      }
      return 'GitHub refused the token';
  }
}

/** What the owner does, then **Run now**. */
export function downloadToDo(download: RunDownloadFailure | null, machine: string): string {
  if (download === null) return 'Press Run now to try again.';
  switch (download.reason) {
    case 'unreachable':
      return `Check that ${machine} is connected to the internet and that GitHub works, then press Run now.`;
    case 'too_long':
      return 'The first download of a project on a new machine takes the longest. Press Run now to try again, or raise Longest push in Settings > Limits.';
    case 'refused':
      if (download.permission !== null) {
        const permission = PUSH_PERMISSION_WORDS[download.permission];
        return `On GitHub's list of your tokens, open the Orchestrator's token, make sure it includes the project's repository with ${permission}, and save it; do not regenerate it. Then press Run now.`;
      }
      if (download.message.startsWith(ORCHESTRATOR_REFUSAL)) {
        return 'Check Settings > GitHub, then press Run now.';
      }
      return "GitHub's words are below. Check the token in Settings > GitHub, then press Run now.";
  }
}

/** Whether GitHub's own words are shown: a refusal whose cause the Orchestrator cannot name. */
export function showsGitHubWords(download: RunDownloadFailure | null): boolean {
  return (
    download !== null &&
    download.reason === 'refused' &&
    download.permission === null &&
    !download.message.startsWith(ORCHESTRATOR_REFUSAL)
  );
}

/**
 * The run page's paragraph for a run ended `download_failed`, also the item's: a review run is
 * started again with **Start review**.
 */
export function downloadRunText(
  download: RunDownloadFailure | null,
  machine: string,
  review = false,
): string {
  const todo = downloadToDo(download, machine);
  return `Machine ${machine} could not download the project from GitHub when the run started, so the agent never started: ${downloadReason(download, machine)}. ${NOT_COUNTED} ${review ? todo.replace('Run now', 'Start review') : todo}`;
}

/** "<ticket> could not be downloaded from GitHub on <machine>: <title>" (owner's answer 2). */
export function downloadFailedText(item: Extract<NeedsYouItem, { type: 'download_failed' }>): {
  title: string;
  detail: string;
} {
  const ref = ticketRef(item.ticket.projectKey, item.ticket.number);
  return {
    title: `${ref} could not be downloaded from GitHub on ${item.machine.name}: ${item.ticket.title}`,
    detail: downloadRunText(item.download, item.machine.name),
  };
}
