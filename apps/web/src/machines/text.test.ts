import {
  CLAUDE_CODE_MIN_VERSION,
  CLAUDE_CODE_VALIDATED_VERSION,
  NeedsYouItem,
  type Machine,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import {
  capabilitySourceText,
  claudeCodeText,
  needsYouText,
  statusText,
  unusableText,
} from './text';

const MACHINE_ID = '3f1e0e8c-3333-4000-8000-000000000000';
const ref = { id: MACHINE_ID, name: 'Desktop' };
const since = '2026-09-25T10:00:00.000Z';

function machine(fields: Partial<Machine>): Machine {
  return {
    id: MACHINE_ID,
    name: 'Desktop',
    account: { id: '3f1e0e8c-4444-4000-8000-000000000000', label: 'Personal' },
    state: 'online',
    online: true,
    os: 'wsl',
    daemonVersion: '0.3.0',
    protocolVersion: 1,
    daemonIncompatible: false,
    updateCommand: null,
    claudeCodeVersion: CLAUDE_CODE_VALIDATED_VERSION,
    claudeCodeSupport: 'supported',
    lastHeartbeatAt: since,
    capabilities: [],
    capabilitySources: [],
    doctor: [],
    unusable: [],
    enrolledAt: since,
    disabledAt: null,
    revokedAt: null,
    enrollmentCodeExpiresAt: null,
    createdAt: since,
    ...fields,
  };
}

describe('needsYouText', () => {
  const items = NeedsYouItem.options
    .map((option) => option.shape.type.value)
    .filter((type) => type !== 'project_setup_failed');

  const examples: Record<(typeof items)[number], NeedsYouItem> = {
    no_claude_account: { type: 'no_claude_account' },
    no_machine: { type: 'no_machine' },
    daemon_incompatible: {
      type: 'daemon_incompatible',
      machine: ref,
      daemonVersion: '9.0.0',
      protocolVersion: 7,
      updateCommand: 'npm install -g http://localhost:8080/downloads/orchestrator-daemon-0.3.0.tgz',
      since,
    },
    claude_code_unsupported: {
      type: 'claude_code_unsupported',
      machine: ref,
      version: '2.0.1',
      minimum: CLAUDE_CODE_MIN_VERSION,
      since,
    },
    machine_problem: {
      type: 'machine_problem',
      machine: ref,
      checks: [{ name: 'tmux', status: 'error', message: 'tmux not found', link: null }],
      since,
    },
  };

  it.each(items)('has a title and an explanation for %s', (type) => {
    const item = examples[type];
    if (item.type === 'project_setup_failed') throw new Error('not a machine item');
    const { title, detail } = needsYouText(item);
    expect(title.length).toBeGreaterThan(0);
    expect(detail).toMatch(/\.$/);
  });

  it('names the machine and what to do', () => {
    expect(needsYouText({ type: 'no_machine' }).title).toBe('No machine enrolled yet');
    expect(needsYouText({ type: 'no_claude_account' }).title).toBe('No Claude account yet');
    const unsupported = needsYouText({
      type: 'claude_code_unsupported',
      machine: ref,
      version: null,
      minimum: CLAUDE_CODE_MIN_VERSION,
      since,
    });
    expect(unsupported.title).toBe('Claude Code not supported on Desktop');
    expect(unsupported.detail).toContain('Claude Code was not found');
    expect(unsupported.detail).toContain(`${CLAUDE_CODE_MIN_VERSION} or later`);
    expect(unsupported.detail).toContain('restart the daemon');
    const incompatible = examples.daemon_incompatible;
    if (incompatible.type !== 'daemon_incompatible') throw new Error('wrong example');
    expect(needsYouText(incompatible).detail).toContain('daemon 9.0.0');
  });
});

describe('machine texts', () => {
  it('shows online or offline next to Disabled', () => {
    expect(statusText(machine({ state: 'disabled', online: false }))).toBe('Disabled (offline)');
    expect(statusText(machine({ state: 'disabled', online: true }))).toBe('Disabled (online)');
    expect(statusText(machine({ state: 'waiting_enrollment' }))).toBe('Waiting for enrollment');
  });

  it('explains why a machine cannot receive runs', () => {
    expect(
      unusableText({ type: 'claude_code_unsupported', version: '2.0.1', minimum: '2.1.280' }),
    ).toBe('Claude Code 2.0.1 is too old. Update it to 2.1.280 or later.');
    expect(
      unusableText({
        type: 'doctor_error',
        check: { name: 'git', status: 'error', message: 'git 2.30 is too old', link: null },
      }),
    ).toBe('Problem found by doctor: git: git 2.30 is too old');
  });

  it('warns about a Claude Code newer than the validated one, and only then', () => {
    expect(claudeCodeText(machine({})).warning).toBeNull();
    const newer = claudeCodeText(
      machine({ claudeCodeVersion: '9.9.9', claudeCodeSupport: 'above_validated' }),
    );
    expect(newer.text).toBe('9.9.9');
    expect(newer.warning).toContain(CLAUDE_CODE_VALIDATED_VERSION);
    expect(
      claudeCodeText(machine({ claudeCodeVersion: null, claudeCodeSupport: 'missing' })).text,
    ).toBe('Not found');
    expect(claudeCodeText(machine({ claudeCodeSupport: null })).text).toBe('Not reported yet');
  });

  it('says where each capability comes from', () => {
    expect(capabilitySourceText({ tag: 'git', source: 'detected', detected: true })).toBe(
      'detected',
    );
    expect(capabilitySourceText({ tag: 'android-sdk', source: 'added', detected: false })).toBe(
      'added by you, not detected',
    );
    expect(capabilitySourceText({ tag: 'docker', source: 'removed', detected: true })).toBe(
      'removed by you, detected',
    );
  });
});
