import {
  SETTINGS,
  isLaterVersion,
  settingValue,
  type SettingGroup,
  type SettingName,
} from '@orchestrator/protocol';
// The web and the server are released together with one version (09, section 6).
import { version as runningVersion } from '../../package.json';

/** Section titles of Settings > Limits, in display order. */
export const groupTitle: Record<SettingGroup, string> = {
  sessions: 'Login and sessions',
  github: 'GitHub',
  tickets: 'Tickets',
  runs: 'Runs',
  machines: 'Machines',
  scheduler: 'Scheduler',
};

/** A value with its unit: `20,000 characters`. */
export function amount(name: SettingName, value: number): string {
  return `${value.toLocaleString('en-US')} ${SETTINGS[name].unit}`;
}

/**
 * Shown for settings of versions later than the running one (`current`): they can be set now but
 * change nothing yet. It disappears by itself in the version that uses the setting.
 */
export function laterText(name: SettingName, current = runningVersion): string | null {
  const { usedFrom } = SETTINGS[name];
  return usedFrom && isLaterVersion(usedFrom, current)
    ? `Used from version ${usedFrom}: it changes nothing in this version.`
    : null;
}

/**
 * The typed value, or why it cannot be saved. The allowed range comes from `SETTINGS`, the same
 * check the server makes.
 */
export function parseTyped(
  name: SettingName,
  typed: string,
): { value: number; error: null } | { value: null; error: string } {
  const { min, max, unit } = SETTINGS[name];
  const text = typed.trim().replace(/[,\s]/g, '');
  const result = settingValue(name).safeParse(/^-?\d+$/.test(text) ? Number(text) : Number.NaN);
  if (result.success) return { value: result.data, error: null };
  return {
    value: null,
    error: `Enter a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} ${unit}.`,
  };
}
