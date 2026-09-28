import { z } from 'zod';
import { AgentKey, AgentRole } from './agents.js';

// The format of a default profile's file, `agents/<key>.md` (03, section 3): read by the server,
// which seeds the profiles from it, and by the owner's allowlist smoke test (03, section 6).

/** A default profile as its file describes it. */
export interface AgentProfileFile {
  key: AgentKey;
  name: string;
  description: string;
  role: AgentRole;
  model: string;
  allowedTools: string[];
  /** The role instructions: the file's text after its header. */
  instructions: string;
}

const Header = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  role: AgentRole,
  model: z.string().min(1),
  allowed_tools: z.array(z.string().min(1)).min(1),
});

/**
 * Reads a profile file: a header between `---` lines, with `name: value` lines and the list
 * `allowed_tools:` of `  - rule` lines, then the role instructions. Anything else is a mistake in
 * the shipped file and throws, naming the file.
 */
export function parseAgentProfileFile(file: string, text: string): AgentProfileFile {
  const fail = (problem: string): never => {
    throw new Error(`agents/${file}: ${problem}`);
  };
  const key = AgentKey.safeParse(file.replace(/\.md$/, ''));
  if (!key.success) fail('the file name is not a profile key');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) fail('the header between --- lines is missing');
  const [, header = '', body = ''] = match ?? [];
  const fields: Record<string, string | string[]> = {};
  let list: string[] | null = null;
  for (const line of header.split('\n')) {
    const item = /^ {2}- (.+)$/.exec(line);
    if (item?.[1] !== undefined) {
      if (list === null) fail(`a list item outside a list: ${line}`);
      list?.push(item[1].trim());
      continue;
    }
    const field = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (!field?.[1]) fail(`cannot read the header line: ${line}`);
    const [, name = '', value] = field ?? [];
    if (Object.hasOwn(fields, name)) fail(`${name} is given twice`);
    if (value === undefined || value.trim() === '') {
      list = [];
      fields[name] = list;
    } else {
      list = null;
      fields[name] = value.trim();
    }
  }
  const parsed = Header.safeParse(fields);
  if (!parsed.success) fail(z.prettifyError(parsed.error));
  const instructions = body.trim();
  if (instructions === '') fail('the role instructions are empty');
  const valid = parsed.data as z.infer<typeof Header>;
  return {
    key: key.data as AgentKey,
    name: valid.name,
    description: valid.description,
    role: valid.role,
    model: valid.model,
    allowedTools: valid.allowed_tools,
    instructions,
  };
}
