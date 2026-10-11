import type {
  CheckReason,
  DodCheck,
  DodCheckResult,
  PullRequestState,
  ReportList,
  WorkflowFlag,
} from '@orchestrator/protocol';
import { checkLabel } from './text';

// The owner's words for a submission's checks (04, section 3.1; lot 3 step F4). They are made
// here, when a screen shows a check, from the reasons the server keeps as facts: a wording fix
// changes every submission shown, old ones included. The agent's own messages, written for an
// agent, are shown apart, as "What the agent was told". Help > Tickets uses the same words
// (check-text.test.ts).

/** A check's name as a heading: "Acceptance criteria met". */
export function checkTitle(check: DodCheck): string {
  const label = checkLabel[check];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export const resultLabel: Record<DodCheckResult['result'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  incomplete: 'Could not be fully done',
  skipped: 'Not checked',
};

/** Why a check was not done: shown under "Not checked". */
export const SKIPPED_TEXT =
  'Not checked: the work was not ready to be pushed to GitHub (changes not committed, or no commits).';

const listName: Record<ReportList, string> = {
  tests: 'Tests listed',
  docs: 'Documentation listed',
  adrs: 'Architecture decisions listed',
};

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** One reason, in the owner's words. Paths and criteria are quoted as the agent or ticket gave them. */
export function reasonText(reason: CheckReason): string {
  switch (reason.kind) {
    case 'criterion_missing':
      return `The agent did not report on criterion ${String(reason.index + 1)}: “${reason.text}”.`;
    case 'criterion_not_met':
      return `The agent reported criterion ${String(reason.index + 1)} as not met: “${reason.text}”.`;
    case 'uncommitted_changes':
      return 'Some changes were not committed: the agent must commit all its work before handing it in.';
    case 'no_commits':
      return `The ticket's branch has no commits of its own compared with ${reason.base}: there is no work to hand in.`;
    case 'push_diverged':
      return "GitHub's copy of the ticket's branch has commits the machine does not have, so the work could not be pushed to GitHub.";
    case 'push_refused':
      return "GitHub refused the push of the ticket's branch.";
    case 'push_unreachable':
      return "GitHub could not be reached to push the ticket's branch.";
    case 'push_missing':
      return "The machine did not push the ticket's branch to GitHub.";
    case 'docs_rule':
      return 'A Documentation ticket must list at least one documentation file its branch changed (a README.md counts). An explanation does not replace it.';
    case 'spike_rule':
      return 'A Spike must list at least one architecture decision or document its branch changed. An explanation does not replace it.';
    case 'path_outside':
      return `${listName[reason.list]}: “${reason.path}” is outside the project's files.`;
    case 'path_folder':
      return `${listName[reason.list]}: “${reason.path}” is a folder. Only files are accepted.`;
    case 'path_not_changed':
      return `${listName[reason.list]}: “${reason.path}” is not a file the ticket's branch changed.`;
    case 'files_cut':
      return `The machine could send only ${reason.listed.toLocaleString('en-US')} of the ${plural(reason.count, 'file', 'files')} the branch changed, so ${plural(reason.unchecked, 'file the agent listed', 'files the agent listed')} could not be compared. This never refuses the work.`;
    case 'files_not_sent':
      return 'The machine did not send the list of files the branch changed (its daemon is older than 0.4.0), so the files the agent listed could not be compared. This never refuses the work.';
    case 'same_commit':
      return reason.ci === 'failed'
        ? `The agent handed in commit ${reason.commit.slice(0, 7)} again, the one CI failed for in this run: it must commit a fix first.`
        : `The agent handed in commit ${reason.commit.slice(0, 7)} again, whose pull request conflicted with ${reason.base} in this run: it must merge ${reason.base} first.`;
    case 'same_commit_request':
      // Owner's answer 1, lot 3 step I.
      return reason.by === 'quality'
        ? `Same commit as the one Quality asked changes on (${reason.commit.slice(0, 7)})`
        : `Same commit as the one you asked changes on (${reason.commit.slice(0, 7)})`;
  }
}

/** The workflow flag (04, section 3.1): what it means and what the owner should do. */
export function workflowFlagText(flag: WorkflowFlag): { title: string; detail: string } {
  const look =
    'Before merging, look at the changed files on the pull request (its “Files changed” tab), the .github/workflows/ folder first.';
  const risk =
    "A workflow runs on GitHub before anyone reads it, and a changed one could weaken the checks that judge the agent's work.";
  switch (flag) {
    case 'changed':
      return {
        title: 'Workflow files changed',
        detail: `This work changes GitHub workflow files (in .github/workflows/). ${risk} ${look}`,
      };
    case 'not_listed':
      return {
        title: 'Workflow files may have changed',
        detail: `The machine could not send the whole list of files this work changed, so a change to GitHub workflow files (in .github/workflows/) cannot be ruled out. ${risk} ${look}`,
      };
    case 'not_kept':
      return {
        title: 'Workflow files may have changed',
        detail: `This work was handed in before the Orchestrator kept why it raises this warning: it changes GitHub workflow files (in .github/workflows/), or the machine could not send the whole list of files it changed. ${risk} ${look}`,
      };
  }
}

export const pullRequestStateLabel: Record<PullRequestState, string> = {
  open: 'Open',
  closed: 'Closed without merging',
  merged: 'Merged',
};
