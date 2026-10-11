import { describe, expect, it } from 'vitest';
import { FIRST_MESSAGE_MAX_BYTES } from './agents.js';
import {
  FIRST_MESSAGE_CRITERIA_MAX_CHARACTERS,
  inOrder,
  isLaterVersion,
  PROJECT_SETTINGS,
  SETTING_ORDER,
  SETTING_PRODUCTS,
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

  it('compares versions number by number', () => {
    expect(isLaterVersion('0.4.0', '0.3.0')).toBe(true);
    expect(isLaterVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isLaterVersion('1.0.0', '0.12.3')).toBe(true);
    expect(isLaterVersion('0.3.1', '0.3.0')).toBe(true);
    expect(isLaterVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isLaterVersion('0.3.0', '0.4.0')).toBe(false);
    expect(isLaterVersion('0.9.0', '0.10.0')).toBe(false);
  });

  it('lets projects override only the settings marked so in 04, section 8', () => {
    expect(PROJECT_SETTINGS).toEqual([
      'maxTicketsPerPlan',
      'maxAgentTicketsPerRun',
      'maxFailedAttempts',
      'ciWaitTimeoutMinutes',
      'ciStartWaitMinutes',
      'maxCiFailuresPerRun',
      'maxReviewRounds',
    ]);
  });

  it('keeps ordered pairs global only, with defaults in order', () => {
    for (const order of SETTING_ORDER) {
      const { smaller, larger } = order;
      // An overridable pair would need checks across projects when a global value changes.
      expect([SETTINGS[smaller].perProject, SETTINGS[larger].perProject]).toEqual([false, false]);
      expect(inOrder(order, SETTINGS[smaller].default, SETTINGS[larger].default)).toBe(true);
      // The smallest value of `smaller` fits under the largest of `larger`: never a dead end.
      expect(inOrder(order, SETTINGS[smaller].min, SETTINGS[larger].max)).toBe(true);
      expect(SETTINGS[smaller].unit).toBe(SETTINGS[larger].unit);
    }
  });

  it('keeps the machine offline delay at least twice the heartbeat interval', () => {
    const order = SETTING_ORDER.find((each) => each.larger === 'machineOfflineAfterSeconds');
    expect(order).toMatchObject({ smaller: 'heartbeatIntervalSeconds', factor: 2, strict: false });
  });

  it('compares a pair as never above, at least a multiple, or strictly below', () => {
    const pair = { smaller: 'loginFirstDelaySeconds', larger: 'loginMaxDelaySeconds' } as const;
    expect(inOrder({ ...pair, factor: 1, strict: false }, 10, 10)).toBe(true);
    expect(inOrder({ ...pair, factor: 1, strict: false }, 11, 10)).toBe(false);
    expect(inOrder({ ...pair, factor: 2, strict: false }, 15, 30)).toBe(true);
    expect(inOrder({ ...pair, factor: 2, strict: false }, 15, 29)).toBe(false);
    expect(inOrder({ ...pair, factor: 1, strict: true }, 30, 31)).toBe(true);
    expect(inOrder({ ...pair, factor: 1, strict: true }, 30, 30)).toBe(false);
  });

  it('refuses values outside the range and fractions', () => {
    const schema = settingValue('sessionLifetimeDays');
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(366).success).toBe(false);
    expect(schema.safeParse(1.5).success).toBe(false);
    expect(schema.safeParse(1).success).toBe(true);
  });
});

describe('SETTING_PRODUCTS', () => {
  it('fits the defaults, and keeps the criteria within the first message budget', () => {
    for (const { first, second, max } of SETTING_PRODUCTS) {
      expect(SETTINGS[first].default * SETTINGS[second].default).toBeLessThanOrEqual(max);
    }
    // 4 bytes per character at most in UTF-8, and 20,000 bytes left for the rest (03, 3.2).
    expect(4 * FIRST_MESSAGE_CRITERIA_MAX_CHARACTERS).toBe(FIRST_MESSAGE_MAX_BYTES - 20_000);
  });
});
