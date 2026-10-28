import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAgentProfileFile,
  type AgentProfileFile,
  type AgentRole,
  type RunPurpose,
} from '@orchestrator/protocol';

// The shipped files of `agents/` (03, sections 3 and 6): the rules, one file per default profile,
// and the run message templates. The server reads them at start; nothing agent-facing
// is written in the server's code (03, section 3.2).

/** The `agents/` folder of the `@orchestrator/agents` package. */
export function agentsDirectory(): string {
  return fileURLToPath(new URL('./', import.meta.resolve('@orchestrator/agents/package.json')));
}

/**
 * Layer 1 of 03, section 3: the shared rules, with the slots `{{work}}`, `{{files}}`, `{{needs}}`
 * and `{{task}}` that the rules of the run's kind fill in (main text: `work`; parts: the others).
 */
export const RULES_FILES = {
  shared: 'rules/shared.md',
  builder: 'rules/builder.md',
  reviewer: 'rules/reviewer.md',
} as const;
export type RulesKind = Exclude<keyof typeof RULES_FILES, 'shared'>;

/**
 * The rules each run purpose receives (03, section 3; owner's answers 1 and 3, lot 3 step H5):
 * those who build get the builder rules, a review the reviewer rules. Planning runs get rules of
 * their own in lot 5.
 */
export const PURPOSE_RULES: Readonly<Record<RunPurpose, RulesKind | null>> = {
  implement: 'builder',
  fix_review: 'builder',
  document: 'builder',
  review: 'reviewer',
  plan: null,
};

/** The rules the runs of a role can receive, which count in its profiles' version. */
export const ROLE_RULES: Readonly<Record<AgentRole, readonly RulesKind[]>> = {
  builder: ['builder'],
  writer: ['builder'],
  reviewer: ['reviewer'],
  planner: [],
};

export type Rules = Readonly<Record<keyof typeof RULES_FILES, Template>>;
/**
 * The section of the run instructions listing the profile's Bash rules. Part of every profile's
 * instructions, so it counts in their version like the rules.
 */
export const ALLOWLIST_TEMPLATE_FILE = 'templates/allowlist.md';

/** A default profile as its file describes it, with what its version covers. */
export interface ShippedProfile extends AgentProfileFile {
  /**
   * SHA-256 of the shared rules, the rules its role's runs receive, the allowlist template and the
   * profile's file: what the profile's version covers.
   */
  shippedHash: string;
}

export interface ShippedAgents {
  rules: Rules;
  allowlist: Template;
  profiles: ShippedProfile[];
}

/** The rules and every default profile, sorted by key. */
export async function loadShippedAgents(directory = agentsDirectory()): Promise<ShippedAgents> {
  const rulesTexts = Object.fromEntries(
    await Promise.all(
      Object.entries(RULES_FILES).map(
        async ([kind, file]) => [kind, await readFile(join(directory, file), 'utf8')] as const,
      ),
    ),
  ) as Record<keyof typeof RULES_FILES, string>;
  const allowlistText = await readFile(join(directory, ALLOWLIST_TEMPLATE_FILE), 'utf8');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();
  const profiles = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(directory, file), 'utf8');
      const profile = parseAgentProfileFile(file, text);
      const hash = createHash('sha256').update(rulesTexts.shared);
      for (const kind of ROLE_RULES[profile.role]) hash.update('\0').update(rulesTexts[kind]);
      const shippedHash = hash
        .update('\0')
        .update(allowlistText)
        .update('\0')
        .update(text)
        .digest('hex');
      return { ...profile, shippedHash };
    }),
  );
  const rules = Object.fromEntries(
    Object.entries(rulesTexts).map(([kind, text]) => [kind, parseTemplate(`rules ${kind}`, text)]),
  ) as Rules;
  return { rules, allowlist: parseTemplate('allowlist', allowlistText), profiles };
}

let shipped: Promise<ShippedAgents> | undefined;

/** `loadShippedAgents` of the default folder, read once: its files do not change while it runs. */
export function shippedAgents(): Promise<ShippedAgents> {
  shipped ??= loadShippedAgents();
  return shipped;
}

/** The run message templates of 03, section 3.2, by file name in `agents/templates/`. */
export const TEMPLATE_NAMES = [
  'implement',
  'review',
  'continue',
  'answer',
  'request-answer',
  'nudge',
  'submit-checks',
  'pull-request',
  'review-comment',
  'ci-status',
  'ci-failed',
  'fix-review',
  'mcp-tools',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/**
 * A run message template: its main text, and named parts for the repeated or optional pieces
 * (a criterion, a comment, the marker of a cut description), each after a `<!-- part: name -->`
 * line.
 */
export interface Template {
  name: string;
  main: string;
  parts: ReadonlyMap<string, string>;
}

const PART_MARKER = /^<!-- part: ([a-z][a-z-]*) -->\n/gm;

export function parseTemplate(name: string, text: string): Template {
  const markers = [...text.matchAll(PART_MARKER)];
  const main = text.slice(0, markers[0]?.index ?? text.length).trimEnd();
  const parts = new Map<string, string>();
  markers.forEach((marker, index) => {
    const partName = marker[1] ?? '';
    if (parts.has(partName)) throw new Error(`template ${name}: part ${partName} is given twice`);
    const start = marker.index + marker[0].length;
    const end = markers[index + 1]?.index ?? text.length;
    parts.set(partName, text.slice(start, end).replace(/\n$/, ''));
  });
  if (main === '') throw new Error(`template ${name}: the main text is empty`);
  return { name, main, parts };
}

export type Templates = Readonly<Record<TemplateName, Template>>;

export async function loadTemplates(directory = agentsDirectory()): Promise<Templates> {
  const entries = await Promise.all(
    TEMPLATE_NAMES.map(async (name) => {
      const text = await readFile(join(directory, 'templates', `${name}.md`), 'utf8');
      return [name, parseTemplate(name, text)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<TemplateName, Template>;
}
