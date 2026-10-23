/**
 * Claude Code versions the daemon supports (05, section 2). Below the minimum a machine is
 * unusable; above the highest version validated with the spike and probe scripts it is accepted
 * with a warning, because Claude Code updates itself often. Raised when a newer version passes
 * the owner's checks.
 */
export const CLAUDE_CODE_MIN_VERSION = '2.1.280';
export const CLAUDE_CODE_VALIDATED_VERSION = '2.1.308';

/** How a machine's Claude Code version compares with the supported versions. */
export type ClaudeCodeSupport = 'missing' | 'below_minimum' | 'supported' | 'above_validated';

/** `2.1.282` as numbers; null for anything that is not three dot-separated numbers. */
function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative, zero or positive, as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) throw new Error(`not a version: ${left ? b : a}`);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The support of a reported version (`claude --version` prints `2.1.282 (Claude Code)`). A
 * version that cannot be read counts as missing.
 */
export function claudeCodeSupport(version: string | null): ClaudeCodeSupport {
  if (version === null || parts(version) === null) return 'missing';
  if (compareVersions(version, CLAUDE_CODE_MIN_VERSION) < 0) return 'below_minimum';
  if (compareVersions(version, CLAUDE_CODE_VALIDATED_VERSION) > 0) return 'above_validated';
  return 'supported';
}
