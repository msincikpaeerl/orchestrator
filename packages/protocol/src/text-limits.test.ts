import { describe, expect, it } from 'vitest';
import { SETTINGS } from './api/settings.js';
import { boundedText, requiredText, settingCeiling, TEXT_CEILING } from './text-limits.js';

describe('text ceilings', () => {
  it('come from the declared ranges of the settings', () => {
    expect(settingCeiling('ticketTitleMaxLength')).toBe(SETTINGS.ticketTitleMaxLength.max);
    const characterCeilings = Object.values(SETTINGS)
      .filter((setting) => setting.unit === 'characters')
      .map((setting) => setting.max);
    expect(characterCeilings).toContain(TEXT_CEILING);
    for (const ceiling of characterCeilings) expect(ceiling).toBeLessThanOrEqual(TEXT_CEILING);
  });

  it('refuse a text over the ceiling, and an empty required text', () => {
    expect(boundedText(3).safeParse('abc').success).toBe(true);
    expect(boundedText(3).safeParse('abcd').success).toBe(false);
    expect(boundedText().safeParse('x'.repeat(TEXT_CEILING + 1)).success).toBe(false);
    expect(requiredText().parse('  ok ')).toBe('ok');
    expect(requiredText().safeParse('   ').success).toBe(false);
  });
});
