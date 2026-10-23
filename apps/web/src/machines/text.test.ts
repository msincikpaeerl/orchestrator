import {
  CLAUDE_CODE_MIN_VERSION,
  CLAUDE_CODE_VALIDATED_VERSION,
  daemonUpdateCommands,
  type Machine,
} from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildText,
  capabilitySourceText,
  claudeCodeText,
  daemonUpdateText,
  needsYouText,
  statusText,
  unusableText,
  type MachineNeedsYouItem,
} from './text';

const MACHINE_ID = '3f1e0e8c-3333-4000-8000-000000000000';
const ref = { id: MACHINE_ID, name: 'Desktop' };
const since = '2026-09-25T10:00:00.000Z';
const UPDATE_COMMANDS = daemonUpdateCommands('http://localhost:8080', '0.4.0');

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
    daemonBuild: null,
    providedDaemonBuild: null,
    daemonBuildDiffers: false,
    daemonIncompatible: false,
    updateCommands: null,
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
  const examples: Record<MachineNeedsYouItem['type'], MachineNeedsYouItem> = {
    no_claude_account: { type: 'no_claude_account' },
    no_machine: { type: 'no_machine' },
    daemon_incompatible: {
      type: 'daemon_incompatible',
      machine: ref,
      daemonVersion: '9.0.0',
      protocolVersion: 7,
      updateCommands: UPDATE_COMMANDS,
      since,
    },
    daemon_outdated: {
      type: 'daemon_outdated',
      machine: ref,
      daemonVersion: '0.3.0',
      serverVersion: '0.4.0',
      updateCommands: UPDATE_COMMANDS,
      since,
    },
    daemon_build_differs: {
      type: 'daemon_build_differs',
      machine: ref,
      daemonVersion: '0.4.0',
      daemonBuild: 'fedcba9876543210',
      serverVersion: '0.4.0',
      providedBuild: '0123456789abcdef',
      updateCommands: UPDATE_COMMANDS,
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
    machine_offline_with_runs: {
      type: 'machine_offline_with_runs',
      machine: ref,
      tickets: ['WEB-12', 'WEB-14'],
      since,
    },
  };

  const items = Object.keys(examples) as MachineNeedsYouItem['type'][];

  it.each(items)('has a title and an explanation for %s', (type) => {
    const { title, detail } = needsYouText(examples[type]);
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

  it('asks to update a daemon of the previous protocol, as the specification words it', () => {
    const outdated = needsYouText(examples.daemon_outdated);
    expect(outdated.title).toBe('Update the daemon on Desktop');
    expect(outdated.detail).toMatch(
      /^Daemon 0\.3\.0 is older than this Orchestrator \(0\.4\.0\)\./,
    );
    expect(outdated.detail).toContain(
      'Update the daemon to 0.4.0: the machine receives no runs until then.',
    );
    // A server built between two releases has the same version number: still true.
    const same = needsYouText({
      ...examples.daemon_outdated,
      serverVersion: '0.3.0',
    } as MachineNeedsYouItem);
    expect(same.detail).toContain('older than this Orchestrator, though both say version 0.3.0');
  });

  it('says another build is not the one provided, without calling it older or newer', () => {
    const { title, detail } = needsYouText(examples.daemon_build_differs);
    expect(title).toBe('The daemon on Desktop is not the one this Orchestrator provides');
    expect(detail).toContain('build fedcba9876543210');
    expect(detail).toContain('build 0123456789abcdef');
    expect(detail).toContain('may be older or newer');
    expect(detail).toContain('still receives runs');
    expect(`${title} ${detail}`).not.toMatch(/\b(is|are) (older|newer|outdated)\b|too old|too new/);
    const sources = needsYouText({
      ...examples.daemon_build_differs,
      daemonBuild: null,
    } as MachineNeedsYouItem);
    expect(sources.detail).toContain('(0.4.0, run from its sources)');
  });
});

describe('machine texts', () => {
  it('shows online or offline next to Disabled', () => {
    expect(statusText(machine({ state: 'disabled', online: false }))).toBe('Disabled (offline)');
    expect(statusText(machine({ state: 'disabled', online: true }))).toBe('Disabled (online)');
    expect(statusText(machine({ state: 'waiting_enrollment' }))).toBe('Waiting for enrollment');
  });

  it('explains why the update commands are shown, or shows none', () => {
    expect(daemonUpdateText(machine({}))).toBeNull();
    expect(
      daemonUpdateText(machine({ daemonIncompatible: true, updateCommands: UPDATE_COMMANDS })),
    ).toContain('so it cannot connect');
    expect(
      daemonUpdateText(
        machine({
          updateCommands: UPDATE_COMMANDS,
          unusable: [
            {
              type: 'daemon_outdated',
              daemonVersion: '0.3.0',
              protocolVersion: 1,
              serverVersion: '0.4.0',
              serverProtocolVersion: 2,
            },
          ],
        }),
      ),
    ).toMatch(
      /^Daemon 0\.3\.0 is older than this Orchestrator \(0\.4\.0\)\. Update the daemon to 0\.4\.0: the machine receives no runs until then\./,
    );
    const other = daemonUpdateText(
      machine({ daemonBuildDiffers: true, updateCommands: UPDATE_COMMANDS }),
    );
    expect(other).toContain('another build, older or newer');
    expect(other).toContain('still receives runs');
  });

  it('shows a build, or why there is none', () => {
    expect(buildText('0123456789abcdef', 2)).toBe('0123456789abcdef');
    expect(buildText(null, 2)).toBe('None (run from its sources)');
    expect(buildText(null, 1)).toBe('Not reported (older daemon)');
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
