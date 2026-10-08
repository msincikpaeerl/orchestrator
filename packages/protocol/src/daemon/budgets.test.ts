import { describe, expect, it } from 'vitest';
import {
  BRANCH_REPORT_COMMITS_MAX_BYTES,
  CHANGED_FILES_MAX_BYTES,
  COMMIT_SUBJECT_MAX_CHARACTERS,
  CUT_MARKER,
  END_REPORT_TEXT_MAX_CHARACTERS,
  GIT_BRANCH_NAME_MAX_CHARACTERS,
  PUSH_MESSAGE_MAX_CHARACTERS,
  SUBMISSION_REPORT_MAX_BYTES,
  cutText,
  encodedBytes,
  fitList,
} from './budgets.js';
import { DAEMON_MESSAGE_MAX_BYTES } from './envelope.js';
import { BRANCH_REPORT_MAX_COMMITS, BranchReport, ChangedFiles, PushResult } from './git.js';
import { McpCall } from './relay.js';
import { RunState } from './runs.js';

// The budgets of a submission's facts and of an end report (04, section 8; lot 3 step F): each
// part at its budget and one above, and the largest message of each kind within the transport
// limit. A character JSON escapes as `\u0001` takes six bytes: the worst case per character.

const id = '5f0c7c1e-8a3b-4c1d-9e2f-0a1b2c3d4e5f';
const runId = '0d9a5b1c-2e3f-4a5b-8c7d-9e0f1a2b3c4d';
const at = '2026-10-08T10:00:00.000Z';
const WORST = '\u0001';

/** A SHA-256 hash (the longer kind) ending with `n`. */
function hash(n: number): string {
  return n.toString(16).padStart(64, 'a');
}

/** A string of `length` characters whose JSON encoding, quotes included, is `bytes` long. */
function encodedString(bytes: number): string {
  // Each WORST character takes 6 bytes, each 'x' one; 2 for the quotes.
  const worst = Math.floor((bytes - 2) / 6);
  return WORST.repeat(worst) + 'x'.repeat(bytes - 2 - worst * 6);
}

describe('cutText', () => {
  it('keeps a text at its limit and cuts one character above, with the marker', () => {
    expect(cutText('abcde', 5)).toBe('abcde');
    expect(cutText('abcdef', 5)).toBe(`abcd${CUT_MARKER}`);
    expect(cutText('abcdef', 5, 'end')).toBe(`${CUT_MARKER}cdef`);
  });

  it('never splits a surrogate pair', () => {
    expect(cutText('abc😀def', 5)).toBe(`abc${CUT_MARKER}`);
    expect(cutText('abc😀def', 5, 'end')).toBe(`${CUT_MARKER}def`);
    expect(cutText('ab😀cdef', 6, 'end')).toBe(`${CUT_MARKER}cdef`);
  });
});

describe('fitList', () => {
  it('keeps the first items while their JSON array fits', () => {
    // ["a","b"] is 9 bytes.
    expect(fitList(['a', 'b', 'c'], 9)).toEqual(['a', 'b']);
    expect(fitList(['a', 'b', 'c'], 8)).toEqual(['a']);
    expect(encodedBytes(fitList(['a', 'b', 'c'], 13))).toBe(13);
  });
});

describe('changed files', () => {
  it('accepts a list at its budget and refuses one byte more', () => {
    const atBudget = [encodedString(CHANGED_FILES_MAX_BYTES - 2)];
    expect(encodedBytes(atBudget)).toBe(CHANGED_FILES_MAX_BYTES);
    expect(ChangedFiles.safeParse({ listed: atBudget, count: 1 }).success).toBe(true);
    const above = [`${atBudget[0] ?? ''}x`];
    expect(ChangedFiles.safeParse({ listed: above, count: 1 }).success).toBe(false);
  });

  it('keeps a path exactly as Git gives it, spaces included, and counts every file', () => {
    expect(ChangedFiles.parse({ listed: [' a b '], count: 3 })).toEqual({
      listed: [' a b '],
      count: 3,
    });
    expect(ChangedFiles.safeParse({ listed: ['a', 'b'], count: 1 }).success).toBe(false);
    expect(ChangedFiles.safeParse({ listed: [''], count: 1 }).success).toBe(false);
  });
});

describe('branch reports', () => {
  const report = (subject: string, count = 1) => ({
    name: 't/1-notes',
    head: hash(0),
    commitsAhead: Array.from({ length: count }, (_, n) => ({ hash: hash(n), subject })),
  });

  it('cuts a subject above its limit with the marker, from any daemon', () => {
    const kept = 'x'.repeat(COMMIT_SUBJECT_MAX_CHARACTERS);
    expect(BranchReport.parse(report(kept)).commitsAhead[0]?.subject).toBe(kept);
    const cut = BranchReport.parse(report(`${kept}y`)).commitsAhead[0]?.subject ?? '';
    expect(cut).toHaveLength(COMMIT_SUBJECT_MAX_CHARACTERS);
    expect(cut.endsWith(CUT_MARKER)).toBe(true);
  });

  it('keeps the newest commits that fit the budget', () => {
    const parsed = BranchReport.parse(
      report(WORST.repeat(COMMIT_SUBJECT_MAX_CHARACTERS), BRANCH_REPORT_MAX_COMMITS),
    );
    expect(parsed.commitsAhead.length).toBeLessThan(BRANCH_REPORT_MAX_COMMITS);
    expect(parsed.commitsAhead[0]?.hash).toBe(hash(0));
    expect(encodedBytes(parsed.commitsAhead)).toBeLessThanOrEqual(BRANCH_REPORT_COMMITS_MAX_BYTES);
    const one = encodedBytes(parsed.commitsAhead[0]);
    expect(encodedBytes(parsed.commitsAhead) + one + 1).toBeGreaterThan(
      BRANCH_REPORT_COMMITS_MAX_BYTES,
    );
  });

  it('refuses a branch name above its limit', () => {
    const name = `t/${'a'.repeat(GIT_BRANCH_NAME_MAX_CHARACTERS - 2)}`;
    expect(BranchReport.safeParse({ ...report('x'), name }).success).toBe(true);
    expect(BranchReport.safeParse({ ...report('x'), name: `${name}a` }).success).toBe(false);
  });
});

describe('push results', () => {
  it('accepts a message at its limit and refuses one character more', () => {
    const failed = (message: string) => ({ status: 'failed', reason: 'refused', message });
    expect(PushResult.safeParse(failed('x'.repeat(PUSH_MESSAGE_MAX_CHARACTERS))).success).toBe(
      true,
    );
    expect(PushResult.safeParse(failed('x'.repeat(PUSH_MESSAGE_MAX_CHARACTERS + 1))).success).toBe(
      false,
    );
  });
});

/** The largest valid commits, changed files and push failure, each at its budget. */
function largestFacts() {
  const commits = fitList(
    Array.from({ length: BRANCH_REPORT_MAX_COMMITS }, (_, n) => ({
      hash: hash(n),
      subject: WORST.repeat(COMMIT_SUBJECT_MAX_CHARACTERS),
    })),
    BRANCH_REPORT_COMMITS_MAX_BYTES,
  );
  const branch = {
    name: `t/${'a'.repeat(GIT_BRANCH_NAME_MAX_CHARACTERS - 2)}`,
    head: hash(0),
    commitsAhead: commits,
    notOnGitHub: {
      listed: Array.from({ length: BRANCH_REPORT_MAX_COMMITS }, (_, n) => hash(n)),
      count: Number.MAX_SAFE_INTEGER,
    },
  };
  const push = {
    status: 'failed' as const,
    reason: 'refused' as const,
    message: WORST.repeat(PUSH_MESSAGE_MAX_CHARACTERS),
  };
  const changedFiles = {
    listed: fitList(
      Array.from({ length: 100_000 }, (_, n) => `${WORST.repeat(100)}${String(n)}`),
      CHANGED_FILES_MAX_BYTES,
    ),
    count: Number.MAX_SAFE_INTEGER,
  };
  return { branch, push, changedFiles };
}

describe('the largest messages', () => {
  it('a ticket_submit with every part at its budget fits in one message', () => {
    const { branch, push, changedFiles } = largestFacts();
    const input = { summary: encodedString(SUBMISSION_REPORT_MAX_BYTES - '{"summary":}'.length) };
    expect(encodedBytes(input)).toBe(SUBMISSION_REPORT_MAX_BYTES);
    const call = McpCall.parse({
      type: 'mcp.call',
      id,
      payload: {
        tool: 'ticket_submit',
        runToken: `ort_${'a'.repeat(196)}`,
        input,
        workspace: { clean: true, branch, push, changedFiles },
      },
    });
    expect(encodedBytes(changedFiles.listed)).toBeGreaterThan(CHANGED_FILES_MAX_BYTES - 1_000);
    expect(encodedBytes(call)).toBeLessThanOrEqual(DAEMON_MESSAGE_MAX_BYTES);
  });

  it('refuses a DoD report one byte above its budget', () => {
    const input = {
      summary: encodedString(SUBMISSION_REPORT_MAX_BYTES - '{"summary":}'.length + 1),
    };
    const call = {
      type: 'mcp.call',
      id,
      payload: {
        tool: 'ticket_submit',
        runToken: 'ort_token',
        input,
        workspace: { clean: true, branch: largestFacts().branch, push: null, changedFiles: null },
      },
    };
    expect(McpCall.safeParse(call).success).toBe(false);
  });

  it('an end report with every part at its budget fits in one message', () => {
    const { branch, push } = largestFacts();
    const state = RunState.parse({
      type: 'run.state',
      id,
      payload: {
        runId,
        at,
        claudeSessionId: runId,
        sessionAlive: false,
        state: 'ended',
        reason: 'push_failed',
        detail: WORST.repeat(END_REPORT_TEXT_MAX_CHARACTERS),
        branch,
        push,
        headMoved: true,
        gitConfigRestored: WORST.repeat(END_REPORT_TEXT_MAX_CHARACTERS),
      },
    });
    expect(encodedBytes(state)).toBeLessThanOrEqual(DAEMON_MESSAGE_MAX_BYTES);
  });

  it('cuts an end detail above its limit, from any daemon, and refuses a longer restored configuration', () => {
    const ended = (detail: string, gitConfigRestored: string | null) => ({
      type: 'run.state',
      id,
      payload: {
        runId,
        at,
        claudeSessionId: null,
        sessionAlive: false,
        state: 'ended',
        reason: 'crashed',
        detail,
        branch: null,
        gitConfigRestored,
      },
    });
    const parsed = RunState.parse(ended('x'.repeat(END_REPORT_TEXT_MAX_CHARACTERS + 1), null));
    if (parsed.payload.state !== 'ended') throw new Error('not ended');
    expect(parsed.payload.detail).toHaveLength(END_REPORT_TEXT_MAX_CHARACTERS);
    const text = 'x'.repeat(END_REPORT_TEXT_MAX_CHARACTERS);
    expect(RunState.safeParse(ended('x', text)).success).toBe(true);
    expect(RunState.safeParse(ended('x', `${text}x`)).success).toBe(false);
  });
});
