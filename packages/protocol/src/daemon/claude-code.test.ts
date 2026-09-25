import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_MIN_VERSION,
  CLAUDE_CODE_VALIDATED_VERSION,
  claudeCodeSupport,
  compareVersions,
} from './claude-code.js';

describe('Claude Code versions', () => {
  it('declares a minimum no newer than the highest validated version', () => {
    expect(
      compareVersions(CLAUDE_CODE_MIN_VERSION, CLAUDE_CODE_VALIDATED_VERSION),
    ).toBeLessThanOrEqual(0);
  });

  it('compares versions number by number, not as text', () => {
    expect(compareVersions('2.1.280', '2.1.28')).toBeGreaterThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.282', '2.1.282')).toBe(0);
  });

  it('classifies missing, old, supported and newer versions', () => {
    expect(claudeCodeSupport(null)).toBe('missing');
    expect(claudeCodeSupport('not a version')).toBe('missing');
    expect(claudeCodeSupport('2.1.279')).toBe('below_minimum');
    expect(claudeCodeSupport(CLAUDE_CODE_MIN_VERSION)).toBe('supported');
    expect(claudeCodeSupport(`${CLAUDE_CODE_VALIDATED_VERSION} (Claude Code)`)).toBe('supported');
    expect(claudeCodeSupport('2.2.0')).toBe('above_validated');
  });
});
