import { maskSecrets } from '@orchestrator/protocol';
import { KNOWN_TRANSCRIPT_TYPES } from '../src/transcript.js';

// Fixtures of the Claude Code probe (lot 2 plan, step H; owner's decisions after the first run):
// what is kept of a real session, how it is sanitised, and the final guard that refuses to write
// anything when the owner's personal data still appears; and the checks read on a transcript
// alone, so the fixtures of each Claude Code version can be read with them again.

/**
 * The transcript entries the daemon reads (05, section 4.5). Everything else goes, above all the
 * `attachment` entries, where Claude Code puts the account's e-mail address, the global Git user,
 * the organisation id and a snapshot of its internal prompt.
 */
const KEPT_TRANSCRIPT_TYPES = new Set(['user', 'assistant', 'system', 'cost-state']);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Claude Code names a transcript folder after its path, with non-alphanumerics as `-`. */
export const encodedPath = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');

function parsedLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** The transcript lines the daemon reads, as JSON lines. */
export function keptTranscript(text: string): string {
  return parsedLines(text)
    .filter((entry) => typeof entry.type === 'string' && KEPT_TRANSCRIPT_TYPES.has(entry.type))
    .map((entry) => `${JSON.stringify(entry)}\n`)
    .join('');
}

/**
 * The transcript's line types with their counts, names only, and those the daemon does not know
 * (a run's log counts them as unreadable): the fixtures keep only what the daemon reads, so this
 * line is where a new type shows (owner's decision, lot 2 step N).
 */
export function transcriptTypes(text: string): string {
  const counts = new Map<string, number>();
  for (const entry of parsedLines(text)) {
    // A name only: anything that does not look like one is not shown.
    const type =
      typeof entry.type === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(entry.type)
        ? entry.type
        : '<other>';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const list = (names: string[]) =>
    names.length === 0
      ? 'none'
      : names.map((name) => `${name} ${String(counts.get(name))}`).join(', ');
  const names = [...counts.keys()].sort();
  const unknown = names.filter((name) => !KNOWN_TRANSCRIPT_TYPES.has(name));
  return `Transcript line types: ${list(names)}. Unknown to the daemon: ${list(unknown)}.`;
}

export interface SanitiseOptions {
  /** Paths replaced by `<probe>` (and their transcript folder form by `-probe-`). */
  scratch: string[];
  home: string;
}

/** Scratch paths as `<probe>`, the home folder as `~`, e-mail addresses and credentials masked. */
export function sanitise(value: string, options: SanitiseOptions): string {
  const replacements: [string, string][] = [
    ...options.scratch.flatMap((scratch): [string, string][] => [
      [scratch, '<probe>'],
      [encodedPath(scratch), '-probe-'],
    ]),
    [options.home, '~'],
    [encodedPath(options.home), '-home-'],
  ];
  let result = value;
  for (const [from, to] of replacements) result = result.split(from).join(to);
  return maskSecrets(result.replace(EMAIL, '<email>'));
}

/** The owner's data the fixtures must never hold, each with what it is (never its value). */
export interface PersonalValue {
  kind: string;
  value: string;
}

/**
 * The account's e-mail addresses and organisation ids found in the session's data: the raw
 * transcript's attachments (`session_context`, `credential_org`) and the probe's own
 * `.claude.json` (`oauthAccount`).
 */
export function sessionPersonalValues(rawTranscript: string, claudeJson: unknown): PersonalValue[] {
  const values: PersonalValue[] = [];
  for (const entry of parsedLines(rawTranscript)) {
    const attachment = entry.attachment as { type?: unknown } | undefined;
    if (attachment?.type === 'session_context') {
      for (const email of JSON.stringify(attachment).match(EMAIL) ?? []) {
        values.push({ kind: "the Claude account's e-mail address", value: email });
      }
    }
    if (attachment?.type === 'credential_org') {
      for (const id of JSON.stringify(attachment).match(UUID) ?? []) {
        values.push({ kind: 'the organisation id', value: id });
      }
    }
  }
  const account = (claudeJson as { oauthAccount?: Record<string, unknown> } | undefined)
    ?.oauthAccount;
  if (typeof account?.emailAddress === 'string') {
    values.push({ kind: "the Claude account's e-mail address", value: account.emailAddress });
  }
  if (typeof account?.accountUuid === 'string') {
    values.push({ kind: 'the account id', value: account.accountUuid });
  }
  if (typeof account?.organizationUuid === 'string') {
    values.push({ kind: 'the organisation id', value: account.organizationUuid });
  }
  return values;
}

/** Shorter values would match ordinary text: a one-letter Git name, for example. */
const SHORTEST_CHECKED = 3;

/**
 * The final guard: each personal value still found in a fixture, as "<kind> in <file>". The
 * comparison ignores case; the home folder is also looked for in its transcript folder form.
 */
export function personalDataFound(
  files: Record<string, string>,
  personal: PersonalValue[],
  home: string,
): string[] {
  const checked = [
    ...personal,
    { kind: 'the home folder path', value: home },
    { kind: 'the home folder path', value: encodedPath(home) },
  ].filter((item) => item.value.trim().length >= SHORTEST_CHECKED);
  const found = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    const lower = text.toLowerCase();
    for (const item of checked) {
      if (lower.includes(item.value.trim().toLowerCase())) found.add(`${item.kind} in ${file}`);
    }
  }
  return [...found];
}

/**
 * What looks like a credential or an account identifier, whatever its value (owner's decision,
 * lot 2 step M, for the usage-limit capture): such a fixture is never written. Checked after
 * sanitising, so a credential that `maskSecrets` hid still counts.
 */
const CREDENTIAL_LIKE: { kind: string; pattern: RegExp }[] = [
  { kind: 'a masked credential', pattern: /\[hidden\]/ },
  {
    kind: 'a token',
    pattern:
      /\b(?:gh[pousr]_|github_pat_|sk-ant-|omt_|ort_)[A-Za-z0-9_-]{8,}|\b(?:access|refresh|id|bearer|session)[_-]?token\b|\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/i,
  },
  { kind: 'an API key', pattern: /\b(?:x-)?api[_-]?key\b|\bsk-[A-Za-z0-9_-]{20,}/i },
  {
    kind: 'an OAuth credential',
    pattern: /\boauth|\bclient[_-]?secret\b|\bexpires[_-]?at\b|\bcredentials?\.json\b/i,
  },
  {
    kind: 'an account or organisation id',
    pattern: /\b(?:account|organi[sz]ation|org|user)[_-]?(?:uuid|id)\b/i,
  },
  {
    // Upper and lower case letters and digits, 40 characters or more, as random secrets are.
    kind: 'a long token-like string',
    pattern:
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/,
  },
];

/** Each kind of credential or account identifier found in the files, as "<kind> in <file>". */
export function credentialLikeFound(files: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    for (const { kind, pattern } of CREDENTIAL_LIKE) {
      if (pattern.test(text)) found.add(`${kind} in ${file}`);
    }
  }
  return [...found];
}

/**
 * Check 6 of the probe (lot 3 decision Q31): whether the session ran in `dontAsk` mode, as its
 * transcript records it. Claude Code writes the mode on the line of each message
 * (`permissionMode`, seen in the 2.1.283 and 2.1.287 fixtures). Null: no transcript was found.
 */
export function permissionModeCheck(text: string | null): {
  verdict: 'PASS' | 'FAIL';
  detail: string;
} {
  if (text === null) return { verdict: 'FAIL', detail: 'no transcript was found' };
  const modes = parsedLines(text)
    .map((entry) => entry.permissionMode)
    .filter((mode): mode is string => typeof mode === 'string');
  if (modes.length === 0) {
    return { verdict: 'FAIL', detail: 'no permission mode recorded in the transcript' };
  }
  const dontAsk = modes.filter((mode) => mode === 'dontAsk').length;
  // A mode's name only: anything that does not look like one is not shown.
  const others = [
    ...new Set(
      modes
        .filter((mode) => mode !== 'dontAsk')
        .map((mode) => (/^[A-Za-z]{1,40}$/.test(mode) ? mode : '<other>')),
    ),
  ];
  return others.length > 0
    ? {
        verdict: 'FAIL',
        detail: `recorded: ${others.join(', ')} (dontAsk on ${String(dontAsk)} of ${String(modes.length)} lines)`,
      }
    : {
        verdict: 'PASS',
        detail: `dontAsk on ${String(modes.length)} transcript line(s), no other mode`,
      };
}
