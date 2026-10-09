import {
  CheckReason,
  DodCheck,
  PullRequestFailureReason,
  PullRequestState,
  WorkflowFlag,
  type CheckReasonKind,
  type PullRequestFailure,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { findPage } from '../help/content';
import {
  SKIPPED_TEXT,
  checkTitle,
  pullRequestStateLabel,
  reasonText,
  resultLabel,
  workflowFlagText,
} from './check-text';
import { pullRequestFailureText } from './text';

// The owner's words for the checks (lot 3 step F4, owner's answer 1): every reason a check can
// fail or not be fully done has its sentence, none holds a name from the code or from the agent's
// texts, and every label the screens show is the one Help > Tickets uses.

/** One reason of each kind, as the server keeps them. Typed so a new kind fails to compile here. */
const SAMPLES: Record<CheckReasonKind, CheckReason> = {
  criterion_missing: { kind: 'criterion_missing', index: 1, text: 'The form checks e-mails' },
  criterion_not_met: { kind: 'criterion_not_met', index: 0, text: 'The page has a form' },
  uncommitted_changes: { kind: 'uncommitted_changes' },
  no_commits: { kind: 'no_commits', base: 'main' },
  push_diverged: { kind: 'push_diverged' },
  push_refused: { kind: 'push_refused' },
  push_unreachable: { kind: 'push_unreachable' },
  push_missing: { kind: 'push_missing' },
  docs_rule: { kind: 'docs_rule' },
  spike_rule: { kind: 'spike_rule' },
  path_outside: { kind: 'path_outside', list: 'tests', path: '../secrets.txt' },
  path_folder: { kind: 'path_folder', list: 'docs', path: 'docs/user' },
  path_not_changed: { kind: 'path_not_changed', list: 'adrs', path: 'docs/adr/0002-queue.md' },
  files_cut: { kind: 'files_cut', listed: 1200, count: 4000, unchecked: 3 },
  files_not_sent: { kind: 'files_not_sent' },
};

/**
 * Names from the code and from the agent-facing texts (agents/templates/submit-checks.md), which
 * the owner never reads: report fields, statuses, tool names, error codes, Git words.
 */
const INTERNAL = [
  /\w_\w/, // criteria_met, not_met, ticket_ask, DOD_FAILED, push_failed, paths_changed...
  /\b(?:tests|docs)\.paths\b/,
  /\badrs\b/,
  /\bticket_?(?:ask|submit)\b/i,
  /\borigin\//,
  /\bworktree\b/i,
  /\bDOD\b/,
  /\bincomplete\b/,
  /\bskipped\b/,
  /\bdiverged\b/,
  /\bunreachable\b/,
  /\bnot_listed|not_kept\b/,
  /\bHEAD\b/,
];

function expectOwnerWords(text: string) {
  expect(text.trim()).not.toBe('');
  for (const pattern of INTERNAL) expect(text).not.toMatch(pattern);
}

describe("the owner's sentence for each reason", () => {
  it('covers every reason the server keeps', () => {
    const kinds = CheckReason.options.map((option) => option.shape.kind.value);
    expect(Object.keys(SAMPLES).sort()).toEqual([...kinds].sort());
  });

  it.each(Object.values(SAMPLES))('$kind has a sentence in plain words', (reason) => {
    expectOwnerWords(reasonText(reason));
  });

  it('quotes the path or the criterion, numbered from 1 as the ticket page shows them', () => {
    expect(reasonText(SAMPLES.path_not_changed)).toBe(
      "Architecture decisions listed: “docs/adr/0002-queue.md” is not a file the ticket's branch changed.",
    );
    expect(reasonText(SAMPLES.criterion_missing)).toContain(
      'criterion 2: “The form checks e-mails”',
    );
    expect(reasonText(SAMPLES.files_cut)).toContain('only 1,200 of the 4,000 files');
  });

  it('gives the labels, results and other texts in plain words', () => {
    for (const check of DodCheck.options) expectOwnerWords(checkTitle(check));
    for (const label of Object.values(resultLabel)) expectOwnerWords(label);
    expectOwnerWords(SKIPPED_TEXT);
    for (const flag of WorkflowFlag.options) {
      const { title, detail } = workflowFlagText(flag);
      expectOwnerWords(title);
      expectOwnerWords(detail);
    }
    for (const label of Object.values(pullRequestStateLabel)) expectOwnerWords(label);
    for (const reason of PullRequestFailureReason.options) {
      const failure: PullRequestFailure = {
        reason,
        message: 'GitHub said no.',
        permission: reason === 'permission_missing' ? 'pull_requests' : null,
        fields: [],
        at: '2026-10-09T10:00:00.000Z',
      };
      const text = pullRequestFailureText('WEB-1', failure);
      expectOwnerWords(text.reason);
      expectOwnerWords(text.detail);
    }
  });
});

describe('Help > Tickets uses the words of the screens', () => {
  const tickets = findPage('tickets')?.markdown ?? '';

  it.each(DodCheck.options)('names the check %s as the screens do', (check) => {
    expect(tickets).toContain(`**${checkTitle(check)}**`);
  });

  it.each(Object.values(resultLabel))('names the result %s', (label) => {
    expect(tickets).toContain(`**${label}**`);
  });

  it.each(WorkflowFlag.options)('names the workflow warning %s', (flag) => {
    expect(tickets).toContain(`**${workflowFlagText(flag).title}**`);
  });

  it.each(PullRequestState.options)('names the pull request state %s', (state) => {
    expect(tickets).toContain(`**${pullRequestStateLabel[state]}**`);
  });

  it('names the lines about the pull request and the refused work', () => {
    for (const words of [
      'Pull request not opened',
      'Opening the pull request on GitHub…',
      'What the agent was told',
      'Latest refused submission',
      'Try again',
    ]) {
      expect(tickets).toContain(`**${words}**`);
    }
  });
});
