import { settingsPermissions } from '../src/permissions.js';

// Which default profiles the allowlist smoke test (`tools/smoke/allowlist-smoke.sh`) runs: a
// profile whose settings permissions (allowlist and deny rules) are those of a profile already
// checked is not run again, since the quota is shared with the owner's daily use (owner's
// decision, lot 2 step M).

/** One line per profile: its key, then the key of an earlier profile with the same rules, if any. */
export function profileLines(
  scope: { daemonHome: string; userHome: string },
  profiles: readonly { key: string; allowedTools: readonly string[] }[],
): string {
  const seen = new Map<string, string>();
  return profiles
    .map((profile) => {
      const { allow, deny } = settingsPermissions(scope, profile.allowedTools);
      const rules = JSON.stringify([[...allow].sort(), [...deny].sort()]);
      const same = seen.get(rules);
      if (same === undefined) seen.set(rules, profile.key);
      return same === undefined ? `${profile.key}\n` : `${profile.key} ${same}\n`;
    })
    .join('');
}
