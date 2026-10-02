import { SETTINGS, SettingName, isLaterVersion } from '@orchestrator/protocol';
import { version } from '../../package.json';
import { describe, expect, it } from 'vitest';
import { findPage } from '../help/content';
import { amount, laterText, parseTyped } from './text';

describe('the settings reference of the Help section', () => {
  const reference = findPage('settings')?.markdown ?? '';

  // docs/user/settings.md must list every setting as the screen names it, with its default.
  it.each(SettingName.options)('lists %s with its name, default and range', (name) => {
    const { label, usedFrom, min, max, perProject } = SETTINGS[name];
    const row = reference
      .split('\n')
      .find((line) =>
        line.startsWith(
          `| ${label}${usedFrom && isLaterVersion(usedFrom, version) ? ` (from version ${usedFrom})` : ''} |`,
        ),
      );
    expect(row).toBeDefined();
    expect(row).toContain(`| ${amount(name, SETTINGS[name].default)} |`);
    expect(row).toContain(`| ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} |`);
    expect(row).toContain(`| ${perProject ? 'Yes' : 'No'} |`);
  });

  it('keeps the setting name other Help pages give', () => {
    expect(findPage('projects')?.markdown).toContain(
      `**${SETTINGS.githubClockToleranceSeconds.label}** setting (**Settings > Limits**`,
    );
    expect(findPage('github-token')?.markdown).toContain(
      `**${SETTINGS.githubTokenExpiryWarningDays.label}**`,
    );
  });
});

describe('parseTyped', () => {
  it('accepts whole numbers in the range, with thousands separators', () => {
    expect(parseTyped('commentMaxLength', ' 20,000 ')).toEqual({ value: 20_000, error: null });
    expect(parseTyped('githubClockToleranceSeconds', '0')).toEqual({ value: 0, error: null });
  });

  it.each(['', 'abc', '1.5', '0', '366', '-3', '1e2'])(
    'refuses %j and says what is allowed',
    (typed) => {
      expect(parseTyped('sessionLifetimeDays', typed)).toEqual({
        value: null,
        error: 'Enter a whole number from 1 to 365 days.',
      });
    },
  );
});

describe('laterText', () => {
  it('names the version for settings of versions later than the running one only', () => {
    expect(laterText('maxRunDurationMinutes', '0.2.0')).toBe(
      'Used from version 0.3.0: it changes nothing in this version.',
    );
    expect(laterText('maxRunDurationMinutes', '0.3.0')).toBeNull();
    expect(laterText('maxRunDurationMinutes', '0.4.0')).toBeNull();
    expect(laterText('ciWaitTimeoutMinutes', '0.3.0')).toBe(
      'Used from version 0.4.0: it changes nothing in this version.',
    );
    expect(laterText('commentMaxLength', '0.2.0')).toBeNull();
  });

  it('compares with the running version by default', () => {
    // 0.3.0 uses the run limits: no note on them in 0.3.0 (lot 2 plan, step N).
    expect(version).toBe('0.3.0');
    expect(laterText('maxRunDurationMinutes')).toBeNull();
    expect(laterText('ciWaitTimeoutMinutes')).toBe(
      'Used from version 0.4.0: it changes nothing in this version.',
    );
  });
});
