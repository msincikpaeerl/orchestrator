import { z } from 'zod';
import { SETTINGS, type SettingName } from './api/settings.js';

/**
 * Size ceilings of the daemon messages and MCP tools (05, section 3.3; 06, section 3). They come
 * from the settings' declared ranges, never from copied numbers: a text tied to a setting is
 * capped at the highest value that setting allows, so no configuration could accept it, and the
 * server still checks the setting's current value. Other texts take the largest such ceiling
 * (owner's decision, lot 2 step B).
 */
export function settingCeiling(name: SettingName): number {
  return SETTINGS[name].max;
}

/** Largest ceiling of the settings counted in characters: the cap of every other text. */
export const TEXT_CEILING = Math.max(
  ...Object.values(SETTINGS)
    .filter((setting) => setting.unit === 'characters')
    .map((setting) => setting.max),
);

/** A string of at most `max` characters (`TEXT_CEILING` by default). */
export function boundedText(max: number = TEXT_CEILING) {
  return z.string().max(max, `at most ${String(max)} characters`);
}

/** A non-empty trimmed string of at most `max` characters (`TEXT_CEILING` by default). */
export function requiredText(max: number = TEXT_CEILING) {
  return z
    .string()
    .trim()
    .min(1, 'cannot be empty')
    .max(max, `at most ${String(max)} characters`);
}
