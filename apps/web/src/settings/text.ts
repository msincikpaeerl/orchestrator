import {
  SETTINGS,
  settingValue,
  type SettingGroup,
  type SettingName,
} from '@orchestrator/protocol';

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

/** Shown for settings of later versions: they can be set now but change nothing yet. */
export function laterText(name: SettingName): string | null {
  const { usedFrom } = SETTINGS[name];
  return usedFrom ? `Used from version ${usedFrom}: it changes nothing in this version.` : null;
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
