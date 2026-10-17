import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  credentialLikeFound,
  encodedPath,
  keptTranscript,
  permissionModeCheck,
  personalDataFound,
  sanitise,
  sessionPersonalValues,
  transcriptTypes,
} from './claude-code-probe-fixtures.js';

// Planted values: nothing here is anyone's real data.
const EMAIL = 'planted.owner@example.org';
const ORG = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const ACCOUNT = '1a2b3c4d-5e6f-4789-9abc-def012345678';
const HOME = '/home/planted-owner';
const SCRATCH = '/tmp/claude-code-probe.AbC123';

const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;

const rawTranscript = [
  line({ type: 'user', message: { role: 'user', content: 'Do the four actions.' } }),
  line({
    type: 'attachment',
    attachment: {
      type: 'session_context',
      context: {
        userEmail: `The user's email address is ${EMAIL}.`,
        git: 'Git user: Planted Owner',
      },
    },
  }),
  line({ type: 'attachment', attachment: { type: 'credential_org', organizationUuid: ORG } }),
  line({ type: 'attachment', attachment: { type: 'prompt_snapshot', prompt: 'internal' } }),
  line({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] },
  }),
  line({ type: 'cost-state', costUsd: 0.001 }),
  line({ type: 'system', subtype: 'turn_duration' }),
  'not json\n',
].join('');

describe('probe fixtures', () => {
  it('keeps only the transcript entries the daemon reads, dropping every attachment', () => {
    const kept = keptTranscript(rawTranscript)
      .split('\n')
      .filter(Boolean)
      .map((text) => (JSON.parse(text) as { type: string }).type);
    expect(kept).toEqual(['user', 'assistant', 'cost-state', 'system']);
    expect(keptTranscript(rawTranscript)).not.toContain(EMAIL);
    expect(keptTranscript(rawTranscript)).not.toContain(ORG);
  });

  it('lists the line types with their counts, names only, and those unknown to the daemon', () => {
    const text = [
      { type: 'assistant' },
      { type: 'ai-title', aiTitle: 'Private title' },
      { type: 'assistant' },
      { type: 'something-new' },
      { type: 'Not A Name, maybe personal' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    expect(transcriptTypes(text)).toBe(
      'Transcript line types: <other> 1, ai-title 1, assistant 2, something-new 1. Unknown to the daemon: <other> 1, something-new 1.',
    );
    expect(transcriptTypes('')).toBe('Transcript line types: none. Unknown to the daemon: none.');
  });

  it('replaces the scratch and home paths, in both forms, and masks e-mail addresses and keys', () => {
    const text = [
      `${SCRATCH}/home/.orchestrator/worktrees/probe`,
      `projects/${encodedPath(SCRATCH)}-home--orchestrator`,
      `${HOME}/.local/bin/claude`,
      `projects/${encodedPath(HOME)}-orchestrator`,
      `mail ${EMAIL}`,
      'key sk-ant-abcdefghijklmnop',
    ].join('\n');
    const result = sanitise(text, { scratch: [SCRATCH], home: HOME });
    expect(result.split('\n')).toEqual([
      '<probe>/home/.orchestrator/worktrees/probe',
      'projects/-probe--home--orchestrator',
      '~/.local/bin/claude',
      'projects/-home--orchestrator',
      'mail <email>',
      'key [hidden]',
    ]);
  });

  it("reads the account's e-mail and organisation id from the session data", () => {
    const values = sessionPersonalValues(rawTranscript, {
      oauthAccount: {
        emailAddress: 'other@example.org',
        accountUuid: ACCOUNT,
        organizationUuid: ORG,
      },
    });
    expect(values).toEqual([
      { kind: "the Claude account's e-mail address", value: EMAIL },
      { kind: 'the organisation id', value: ORG },
      { kind: "the Claude account's e-mail address", value: 'other@example.org' },
      { kind: 'the account id', value: ACCOUNT },
      { kind: 'the organisation id', value: ORG },
    ]);
    expect(sessionPersonalValues('', undefined)).toEqual([]);
  });

  it('finds every planted value left in a fixture, naming what and where, never the value', () => {
    const personal = [
      { kind: "the Claude account's e-mail address", value: EMAIL },
      { kind: 'the organisation id', value: ORG },
      { kind: 'the global Git user name', value: 'Planted Owner' },
      { kind: 'the global Git e-mail address', value: 'git.owner@example.org' },
    ];
    expect(
      personalDataFound(
        {
          'transcript.jsonl': `{"text":"planted owner wrote this, ${ORG.toUpperCase()}"}`,
          'hooks.jsonl': `{"cwd":"${HOME}/work","mail":"GIT.OWNER@example.org"}`,
          'status-line.jsonl': `{"dir":"-tmp-${encodedPath(HOME)}-x","to":"${EMAIL}"}`,
          'results.txt': 'clean',
        },
        personal,
        HOME,
      ).sort(),
    ).toEqual([
      "the Claude account's e-mail address in status-line.jsonl",
      'the global Git e-mail address in hooks.jsonl',
      'the global Git user name in transcript.jsonl',
      'the home folder path in hooks.jsonl',
      'the home folder path in status-line.jsonl',
      'the organisation id in transcript.jsonl',
    ]);
    expect(personalDataFound({ 'results.txt': 'all clean ~ <probe>' }, personal, HOME)).toEqual([]);
  });

  it('ignores empty and very short values, which would match ordinary text', () => {
    expect(
      personalDataFound(
        { 'results.txt': 'a b' },
        [
          { kind: 'the global Git user name', value: '' },
          { kind: 'the global Git user name', value: 'a' },
        ],
        HOME,
      ),
    ).toEqual([]);
  });

  it('finds whatever looks like a credential or an account id, naming what and where', () => {
    const planted: [string, string][] = [
      ['a masked credential', 'token [hidden] here'],
      ['a token', 'Authorization: Bearer abcdefghijklmnop'],
      ['a token', '{"refresh_token":"x"}'],
      ['a token', 'sk-ant-oat01-plantedValue'],
      ['an API key', '{"apiKey":"x"}'],
      ['an OAuth credential', '{"oauthAccount":{}}'],
      ['an OAuth credential', '{"expiresAt":1}'],
      ['an account or organisation id', '{"organizationUuid":"x"}'],
      ['an account or organisation id', '{"account_uuid":"x"}'],
      ['an account or organisation id', '{"orgId":"x"}'],
      ['a long token-like string', `"${'aB3'.repeat(14)}"`],
    ];
    for (const [kind, text] of planted) {
      expect(credentialLikeFound({ 'hooks.jsonl': text }), text).toContain(
        `${kind} in hooks.jsonl`,
      );
    }
  });

  it('lets an ordinary capture through: session ids, message ids, paths and git hashes', () => {
    const capture = [
      line({
        session_id: '0f7a3c52-9d7e-4e8f-a4b1-111111111111',
        transcript_path: '<probe>/home/.orchestrator/claude-config/projects/-probe-/x.jsonl',
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        last_assistant_message: "You've hit your session limit · resets 3:45pm",
      }),
      line({ type: 'assistant', requestId: 'req_011CQp5x9MZ4aR2vYbT7uX3w', uuid: ORG }),
      line({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 1790000000 } } }),
      `commit ${'a1b2c3d4e5'.repeat(4)}\n`,
    ].join('');
    expect(credentialLikeFound({ 'hooks.jsonl': capture })).toEqual([]);
  });
});

describe("check 6, the session's permission mode (lot 3 step L)", () => {
  const fixture = (version: string) =>
    readFileSync(
      new URL(`../test/fixtures/claude-code-${version}/transcript.jsonl`, import.meta.url),
      'utf8',
    );

  it("passes on the transcripts the owner's probe runs recorded with Claude Code 2.1.283 and 2.1.287", () => {
    for (const version of ['2.1.283', '2.1.287']) {
      expect(permissionModeCheck(fixture(version)), version).toEqual({
        verdict: 'PASS',
        detail: 'dontAsk on 1 transcript line(s), no other mode',
      });
    }
  });

  it('fails when a line records another mode, or when none records a mode', () => {
    const message = (permissionMode?: string) =>
      line({ type: 'user', message: { role: 'user', content: 'Go.' }, permissionMode });
    expect(permissionModeCheck(message('dontAsk') + message('auto'))).toEqual({
      verdict: 'FAIL',
      detail: 'recorded: auto (dontAsk on 1 of 2 lines)',
    });
    expect(permissionModeCheck(message('<b>"x"</b>'))).toEqual({
      verdict: 'FAIL',
      detail: 'recorded: <other> (dontAsk on 0 of 1 lines)',
    });
    expect(permissionModeCheck(message())).toEqual({
      verdict: 'FAIL',
      detail: 'no permission mode recorded in the transcript',
    });
    expect(permissionModeCheck(null)).toEqual({
      verdict: 'FAIL',
      detail: 'no transcript was found',
    });
  });
});
