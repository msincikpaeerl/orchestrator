import { describe, expect, it } from 'vitest';
import {
  encodedPath,
  keptTranscript,
  personalDataFound,
  sanitise,
  sessionPersonalValues,
} from './claude-code-probe-fixtures.js';

// Planted values: nothing here is anyone's real data.
const EMAIL = 'planted.owner@example.org';
const ORG = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
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
      oauthAccount: { emailAddress: 'other@example.org', organizationUuid: ORG },
    });
    expect(values).toEqual([
      { kind: "the Claude account's e-mail address", value: EMAIL },
      { kind: 'the organisation id', value: ORG },
      { kind: "the Claude account's e-mail address", value: 'other@example.org' },
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
});
