import { describe, expect, it } from 'vitest';
import { CUT_MARKER, PUSH_MESSAGE_MAX_CHARACTERS } from '@orchestrator/protocol';
import { checkCloneUrl, pushResult } from './isolated-git.js';

// Reading a push's outcome from `git push --porcelain` (05, section 4.9). The texts are Git
// 2.53's, captured with LC_ALL=C.

const HEAD = 'a3114fec6d99f710a220759df951e2cc80d6a1d1';
const REF = 'refs/heads/t/1-add-notes';
const TOKEN = 'ghp_PushResultTokenNeverShown0123456789';
const expected = { ref: REF, head: HEAD, timeoutSeconds: 60 };
const none = { refusal: null, secret: null };

function porcelain(line: string): string {
  return `To https://github.com/owner/notes.git\n${line}\nDone\n`;
}

describe('pushResult', () => {
  it('reads a new branch, a fast-forward and an unchanged branch as pushed', () => {
    for (const [flag, summary] of [
      ['*', '[new branch]'],
      [' ', '1111111..a3114fe'],
      ['=', '[up to date]'],
    ] as const) {
      const stdout = porcelain(`${flag}\t${HEAD}:${REF}\t${summary}`);
      expect(pushResult({ code: 0, stdout, stderr: '', timedOut: false }, none, expected)).toEqual({
        status: 'pushed',
        head: HEAD,
      });
    }
  });

  it('reads "fetch first" and "non-fast-forward" as diverged, never forced', () => {
    for (const reason of ['fetch first', 'non-fast-forward']) {
      const stdout = porcelain(`!\t${HEAD}:${REF}\t[rejected] (${reason})`);
      expect(
        pushResult(
          { code: 1, stdout, stderr: 'hint: Updates were rejected', timedOut: false },
          none,
          expected,
        ),
      ).toEqual({ status: 'failed', reason: 'diverged', message: `[rejected] (${reason})` });
    }
  });

  it("keeps GitHub's own message for a refusal, masked", () => {
    const stdout = porcelain(
      `!\t${HEAD}:${REF}\t[remote rejected] (refusing to allow a Personal Access Token to create or update workflow \`.github/workflows/ci.yml\` without \`workflow\` scope)`,
    );
    const stderr = `remote: error: GH006: Protected branch update failed for ${TOKEN}.        \nerror: failed to push some refs\n`;
    const result = pushResult(
      { code: 1, stdout, stderr, timedOut: false },
      { refusal: null, secret: TOKEN },
      expected,
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'refused' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.status === 'failed' && result.message).toBe(
      '[remote rejected] (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\nerror: GH006: Protected branch update failed for [hidden].',
    );
  });

  it("reads GitHub's refusal of a token without Contents write as refused", () => {
    // The owner's run (lot 3 step E3), a fine-grained token with Contents read-only.
    const access =
      "fatal: unable to access 'https://github.com/owner/notes.git/': The requested URL returned error: 403";
    expect(
      pushResult(
        {
          code: 128,
          stdout: '',
          stderr: `remote: Write access to repository not granted.\n${access}\n`,
          timedOut: false,
        },
        none,
        expected,
      ),
    ).toEqual({
      status: 'failed',
      reason: 'refused',
      message: `Write access to repository not granted.\n${access}`,
    });
  });

  it('reads a failed authentication as refused, and no answer as unreachable', () => {
    expect(
      pushResult(
        {
          code: 128,
          stdout: '',
          stderr: "fatal: Authentication failed for 'https://github.com/owner/notes.git/'\n",
          timedOut: false,
        },
        none,
        expected,
      ),
    ).toMatchObject({ status: 'failed', reason: 'refused' });
    expect(
      pushResult(
        {
          code: 128,
          stdout: '',
          stderr:
            "fatal: unable to access 'https://github.com/owner/notes.git/': Could not resolve host: github.com\n",
          timedOut: false,
        },
        none,
        expected,
      ),
    ).toEqual({
      status: 'failed',
      reason: 'unreachable',
      message:
        "fatal: unable to access 'https://github.com/owner/notes.git/': Could not resolve host: github.com",
    });
  });

  it("names the Orchestrator's refusal of the credential, and the time limit", () => {
    expect(
      pushResult(
        { code: 128, stdout: '', stderr: 'fatal: could not read Username', timedOut: false },
        { refusal: 'a review run never pushes', secret: null },
        expected,
      ),
    ).toEqual({
      status: 'failed',
      reason: 'refused',
      message: 'The Orchestrator refused the credential: a review run never pushes',
    });
    expect(
      pushResult({ code: 1, stdout: '', stderr: '', timedOut: true }, none, {
        ...expected,
        timeoutSeconds: 1,
      }),
    ).toEqual({
      status: 'failed',
      reason: 'unreachable',
      message: 'The push took longer than Longest push (1 second) and was stopped.',
    });
  });

  it('cuts a long message at its budget, keeping its end, which says why (lot 3 step F)', () => {
    const noise = Array.from({ length: 400 }, (_, n) => `remote: line ${String(n)} of noise`);
    const why =
      "fatal: unable to access 'https://github.com/owner/notes.git/': Could not resolve host";
    const result = pushResult(
      { code: 128, stdout: '', stderr: [...noise, why].join('\n'), timedOut: false },
      none,
      expected,
    );
    if (result.status !== 'failed') throw new Error('not failed');
    expect(result.message).toHaveLength(PUSH_MESSAGE_MAX_CHARACTERS);
    expect(result.message.startsWith(CUT_MARKER)).toBe(true);
    expect(result.message.endsWith(why)).toBe(true);
    // Short ones are kept whole.
    const refused = pushResult(
      { code: 128, stdout: '', stderr: 'fatal: could not read Username', timedOut: false },
      { refusal: 'x'.repeat(PUSH_MESSAGE_MAX_CHARACTERS), secret: null },
      expected,
    );
    if (refused.status !== 'failed') throw new Error('not failed');
    expect(refused.message).toHaveLength(PUSH_MESSAGE_MAX_CHARACTERS);
  });

  it('never reads another ref as the pushed one', () => {
    const stdout = porcelain(`*\t${HEAD}:refs/heads/other\t[new branch]`);
    expect(
      pushResult({ code: 0, stdout, stderr: '', timedOut: false }, none, expected),
    ).toMatchObject({ status: 'failed', reason: 'unreachable' });
  });
});

describe('checkCloneUrl', () => {
  it('allows https, http only to a loopback address, and file without a credential', () => {
    expect(checkCloneUrl('https://github.com/owner/notes.git').credential).toBe(true);
    expect(checkCloneUrl('http://127.0.0.1:8080/owner/notes.git').credential).toBe(true);
    expect(checkCloneUrl('http://localhost:8080/owner/notes.git').credential).toBe(true);
    expect(checkCloneUrl('file:///tmp/remotes/owner/notes.git').credential).toBe(false);
  });

  it('refuses anything else, and a URL holding a user name or password', () => {
    for (const url of [
      'http://github.com/owner/notes.git',
      'ssh://git@github.com/owner/notes.git',
      'git://github.com/owner/notes.git',
      'ext::sh -c touch% /tmp/x',
      'https://x-access-token:secret@github.com/owner/notes.git',
      'https://github.com/owner/notes.git?x=1',
    ]) {
      expect(() => checkCloneUrl(url), url).toThrow();
    }
  });
});
