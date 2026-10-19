import { schema } from '@orchestrator/db';
import {
  AccountPlan,
  AccountState,
  CLAUDE_CODE_MIN_VERSION,
  Capability,
  DoctorCheck,
  MachineOs,
  PROTOCOL_VERSION,
  claudeCodeSupport,
  daemonPackageFileName,
  DailyBudget,
  Schedule,
  daemonUpdateCommands as updateCommandsFor,
  type AccountToday,
  type ClaudeAccount,
  type Machine,
  type MachineCapability,
  type MachineState,
  type UnusableReason,
} from '@orchestrator/protocol';
import { z } from 'zod';
import { HttpError } from '../http.js';
import { effectiveAccountState } from '../runs/model.js';
import { SERVER_VERSION } from '../version.js';

export type AccountRow = typeof schema.claudeAccounts.$inferSelect;
export type MachineRow = typeof schema.machines.$inferSelect;

const Tags = z.array(Capability);

export function toAccount(row: AccountRow, today: AccountToday, now: Date): ClaudeAccount {
  const effective = effectiveAccountState(row, now);
  return {
    id: row.id,
    label: row.label,
    plan: AccountPlan.parse(row.plan),
    maxConcurrentRuns: row.maxConcurrentRuns,
    // A limit whose time has passed is shown available at once (07, section 3).
    state: AccountState.parse(effective.state),
    limitedUntil: effective.limitedUntil?.toISOString() ?? null,
    limitedUntilEstimated: effective.estimated,
    schedule: Schedule.parse(row.schedule),
    dailyBudget: DailyBudget.parse(row.dailyBudget),
    today,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The status label (02, section 9.2), the first that applies: revoked, waiting for enrollment,
 * disabled, online, offline.
 */
export function machineState(row: MachineRow): MachineState {
  if (row.revokedAt) return 'revoked';
  if (!row.enrolledAt) return 'waiting_enrollment';
  if (row.disabledAt) return 'disabled';
  return row.status === 'online' ? 'online' : 'offline';
}

export interface CapabilityLists {
  detected: string[];
  added: string[];
  removed: string[];
}

export function capabilityLists(row: MachineRow): CapabilityLists {
  return {
    detected: Tags.parse(row.detectedCapabilities),
    added: Tags.parse(row.addedCapabilities),
    removed: Tags.parse(row.removedCapabilities),
  };
}

/** The machine's capabilities: detected and added, minus removed (01, section 3.8). */
export function effectiveCapabilities({ detected, added, removed }: CapabilityLists): string[] {
  const tags = new Set([...detected, ...added]);
  for (const tag of removed) tags.delete(tag);
  return [...tags].sort();
}

/** Every tag with where it comes from, for the capabilities editor (02, section 9.2). */
export function capabilitySources({
  detected,
  added,
  removed,
}: CapabilityLists): MachineCapability[] {
  const all = [...new Set([...detected, ...added, ...removed])].sort();
  return all.map((tag) => ({
    tag,
    source: removed.includes(tag) ? 'removed' : added.includes(tag) ? 'added' : 'detected',
    detected: detected.includes(tag),
  }));
}

/**
 * The owner sets the tags the machine should have; where each comes from is kept. A detected tag
 * left out becomes removed, and stays removed even when it is no longer detected; any other tag
 * kept is added. A tag the owner added keeps that source even once detected.
 */
export function editCapabilities(lists: CapabilityLists, wanted: string[]): CapabilityLists {
  const want = new Set(wanted);
  const detected = new Set(lists.detected);
  const added = wanted.filter((tag) => !detected.has(tag) || lists.added.includes(tag));
  const removed = [...new Set([...lists.removed, ...lists.detected])].filter(
    (tag) => !want.has(tag),
  );
  return { detected: lists.detected, added: added.sort(), removed: removed.sort() };
}

/** The `doctor` checks reporting an error: they make the machine unusable (01, section 3.8). */
export function doctorErrors(doctor: DoctorCheck[]): DoctorCheck[] {
  return doctor.filter((check) => check.status === 'error');
}

/** Why the machine cannot receive runs, from what its last connection reported. */
export function unusableReasons(row: MachineRow): UnusableReason[] {
  if (row.daemonVersion === null) return [];
  const reasons: UnusableReason[] = [];
  const support = claudeCodeSupport(row.claudeCodeVersion);
  if (row.daemonOutdatedSince !== null) {
    reasons.push({
      type: 'daemon_outdated',
      daemonVersion: row.daemonVersion,
      protocolVersion: row.protocolVersion ?? 0,
      serverVersion: SERVER_VERSION,
      serverProtocolVersion: PROTOCOL_VERSION,
    });
  }
  if (support === 'missing' || support === 'below_minimum') {
    reasons.push({
      type: 'claude_code_unsupported',
      version: row.claudeCodeVersion,
      minimum: CLAUDE_CODE_MIN_VERSION,
    });
  }
  for (const check of doctorErrors(z.array(DoctorCheck).parse(row.doctor))) {
    reasons.push({ type: 'doctor_error', check });
  }
  return reasons;
}

export function toMachine(
  row: MachineRow,
  account: Pick<AccountRow, 'id' | 'label'>,
  publicUrl: string,
  providedBuild: string | null,
): Machine {
  const update =
    row.daemonIncompatibleSince !== null ||
    row.daemonOutdatedSince !== null ||
    row.daemonBuildDiffersSince !== null;
  const lists = capabilityLists(row);
  const state = machineState(row);
  return {
    id: row.id,
    name: row.name,
    account: { id: account.id, label: account.label },
    state,
    online: row.status === 'online',
    os: row.os === null ? null : MachineOs.parse(row.os),
    daemonVersion: row.daemonVersion,
    protocolVersion: row.protocolVersion,
    daemonBuild: row.daemonBuild,
    providedDaemonBuild: providedBuild,
    daemonBuildDiffers: row.daemonBuildDiffersSince !== null,
    daemonIncompatible: row.daemonIncompatibleSince !== null,
    updateCommands: update ? daemonUpdateCommands(publicUrl) : null,
    claudeCodeVersion: row.claudeCodeVersion,
    claudeCodeSupport: row.daemonVersion === null ? null : claudeCodeSupport(row.claudeCodeVersion),
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    capabilities: effectiveCapabilities(lists),
    capabilitySources: capabilitySources(lists),
    doctor: z.array(DoctorCheck).parse(row.doctor),
    unusable: unusableReasons(row),
    enrolledAt: row.enrolledAt?.toISOString() ?? null,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    enrollmentCodeExpiresAt:
      state === 'waiting_enrollment' && row.enrollmentCodeUsedAt === null
        ? (row.enrollmentCodeExpiresAt?.toISOString() ?? null)
        : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Installs the daemon of the server's own version from the server (05, section 2). */
export function daemonInstallCommand(publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  return `npm install -g ${base}/downloads/${daemonPackageFileName(SERVER_VERSION)}`;
}

/** Help > Machines > "Update the daemon": to the package of the server's own version (05, section 2). */
export function daemonUpdateCommands(publicUrl: string): string[] {
  return updateCommandsFor(publicUrl, SERVER_VERSION);
}

/** The server's base address, as given to `orchestrator-daemon enroll`. */
export function serverAddress(publicUrl: string): string {
  return publicUrl.replace(/\/+$/, '');
}

export const accountNotFound = () =>
  new HttpError(404, 'account_not_found', 'No Claude account with this id');
export const machineNotFound = () =>
  new HttpError(404, 'machine_not_found', 'No machine with this id');
