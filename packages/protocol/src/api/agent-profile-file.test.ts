import { describe, expect, it } from 'vitest';
import { parseAgentProfileFile } from './agent-profile-file.js';

const valid = `---
name: Web Developer
description: Builds web apps.
role: builder
model: sonnet
allowed_tools:
  - Read
  - Bash(pnpm *)
---

# Your role

Build things.
`;

describe('parseAgentProfileFile', () => {
  it('reads the header and the role instructions', () => {
    expect(parseAgentProfileFile('web_dev.md', valid)).toEqual({
      key: 'web_dev',
      name: 'Web Developer',
      description: 'Builds web apps.',
      role: 'builder',
      model: 'sonnet',
      allowedTools: ['Read', 'Bash(pnpm *)'],
      instructions: '# Your role\n\nBuild things.',
    });
  });

  it.each([
    ['a file name that is not a key', 'Web-Dev.md', valid, 'not a profile key'],
    ['no header', 'web_dev.md', '# Your role\n', 'header'],
    ['an unknown role', 'web_dev.md', valid.replace('builder', 'boss'), 'role'],
    ['an unknown field', 'web_dev.md', valid.replace('model:', 'colour: red\nmodel:'), 'colour'],
    ['a field given twice', 'web_dev.md', valid.replace('model:', 'name: X\nmodel:'), 'twice'],
    ['an empty allowlist', 'web_dev.md', valid.replace(/ {2}- .*\n/g, ''), 'allowed_tools'],
    [
      'no instructions',
      'web_dev.md',
      valid.replace(/---\n\n# Your role[\s\S]*$/, '---\n'),
      'empty',
    ],
  ])('refuses %s, naming the file', (_case, file, text, problem) => {
    expect(() => parseAgentProfileFile(file, text)).toThrow(problem);
    expect(() => parseAgentProfileFile(file, text)).toThrow(`agents/${file}`);
  });
});
