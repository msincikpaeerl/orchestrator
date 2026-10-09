import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentProfileFile, type AgentProfileFile } from '@orchestrator/protocol';

// The shipped files of `agents/` (03, sections 3 and 6): the common rules, one file per default
// profile, and the run message templates. The server reads them at start; nothing agent-facing
// is written in the server's code (03, section 3.2).

/** The `agents/` folder of the `@orchestrator/agents` package. */
export function agentsDirectory(): string {
  return fileURLToPath(new URL('./', import.meta.resolve('@orchestrator/agents/package.json')));
}

export const COMMON_RULES_FILE = 'common-rules.md';
/**
 * The section of the run instructions listing the profile's Bash rules. Part of every profile's
 * instructions, so it counts in their version like the common rules.
 */
export const ALLOWLIST_TEMPLATE_FILE = 'templates/allowlist.md';

/** A default profile as its file describes it, with what its version covers. */
export interface ShippedProfile extends AgentProfileFile {
  /**
   * SHA-256 of the common rules, the allowlist template and the profile's file: what the
   * profile's version covers.
   */
  shippedHash: string;
}

export interface ShippedAgents {
  commonRules: string;
  allowlist: Template;
  profiles: ShippedProfile[];
}

/** The common rules and every default profile, sorted by key. */
export async function loadShippedAgents(directory = agentsDirectory()): Promise<ShippedAgents> {
  const commonRules = (await readFile(join(directory, COMMON_RULES_FILE), 'utf8')).trim();
  const allowlistText = await readFile(join(directory, ALLOWLIST_TEMPLATE_FILE), 'utf8');
  const files = (await readdir(directory))
    .filter((name) => name.endsWith('.md') && name !== COMMON_RULES_FILE)
    .sort();
  const profiles = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(directory, file), 'utf8');
      const shippedHash = createHash('sha256')
        .update(commonRules)
        .update('\0')
        .update(allowlistText)
        .update('\0')
        .update(text)
        .digest('hex');
      return { ...parseAgentProfileFile(file, text), shippedHash };
    }),
  );
  return { commonRules, allowlist: parseTemplate('allowlist', allowlistText), profiles };
}

/** The run message templates of 03, section 3.2, by file name in `agents/templates/`. */
export const TEMPLATE_NAMES = [
  'implement',
  'continue',
  'answer',
  'nudge',
  'submit-checks',
  'pull-request',
  'ci-status',
  'ci-failed',
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
