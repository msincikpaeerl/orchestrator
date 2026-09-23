import { describe, expect, it } from 'vitest';
import {
  PROJECT_SETTINGS,
  SETTING_ORDER,
  SETTINGS,
  SettingName,
  settingValue,
} from './settings.js';

describe('SETTINGS', () => {
  it.each(SettingName.options)('%s has a default inside its allowed range', (name) => {
    const { min, max, default: value } = SETTINGS[name];
    expect(Number.isInteger(min) && Number.isInteger(max) && Number.isInteger(value)).toBe(true);
    expect(min).toBeLessThanOrEqual(value);
    expect(value).toBeLessThanOrEqual(max);
    expect(settingValue(name).safeParse(value).success).toBe(true);
  });

  it('names versions of later lots as x.y.z, after 0.2.0 (lot 1)', () => {
    for (const name of SettingName.options) {
      const { usedFrom } = SETTINGS[name];
      if (usedFrom === undefined) continue;
      expect(usedFrom).toMatch(/^0\.[3-9]\.0$/);
    }
  });

  it('lets projects override only the settings marked so in 04, section 8', () => {
    expect(PROJECT_SETTINGS).toEqual([
      'maxTicketsPerPlan',
      'maxAgentTicketsPerRun',
      'maxFailedAttempts',
      'ciWaitTimeoutMinutes',
    ]);
  });

  it('keeps ordered pairs global only, with defaults in order', () => {
    for (const { smaller, larger } of SETTING_ORDER) {
      // An overridable pair would need checks across projects when a global value changes.
      expect([SETTINGS[smaller].perProject, SETTINGS[larger].perProject]).toEqual([false, false]);
      expect(SETTINGS[smaller].default).toBeLessThanOrEqual(SETTINGS[larger].default);
      expect(SETTINGS[smaller].unit).toBe(SETTINGS[larger].unit);
    }
  });

  it('refuses values outside the range and fractions', () => {
    const schema = settingValue('sessionLifetimeDays');
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(366).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
    expect(schema.safeParse(1).success).toBe(true);
  });
});
