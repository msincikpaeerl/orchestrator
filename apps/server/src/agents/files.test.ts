import { describe, expect, it } from 'vitest';
import { loadShippedAgents, loadTemplates, parseTemplate } from './files.js';

describe('parseTemplate', () => {
  it('splits the main text and the named parts', () => {
    const template = parseTemplate(
      'sample',
      'Hello {{name}}\n<!-- part: item -->\n- {{text}}\n<!-- part: cut -->\n\n[cut]\n',
    );
    expect(template.main).toBe('Hello {{name}}');
    expect(Object.fromEntries(template.parts)).toEqual({ item: '- {{text}}', cut: '\n[cut]' });
  });

  it('refuses a part given twice and an empty main text', () => {
    expect(() => parseTemplate('x', 'A\n<!-- part: a -->\n1\n<!-- part: a -->\n2\n')).toThrow(
      'twice',
    );
    expect(() => parseTemplate('x', '<!-- part: a -->\n1\n')).toThrow('empty');
  });
});

describe('the shipped files of agents/ (03, sections 2 and 6)', () => {
  it('ship the Architect and the Web Developer only, as builders on Sonnet', async () => {
    const { profiles } = await loadShippedAgents();
    expect(profiles.map((profile) => [profile.key, profile.role, profile.model])).toEqual([
      ['architect', 'builder', 'sonnet'],
      ['web_dev', 'builder', 'sonnet'],
    ]);
  });

  it('keep role instructions short (03, section 1, rule 3)', async () => {
    for (const profile of (await loadShippedAgents()).profiles) {
      expect(profile.instructions.split('\n').length, profile.key).toBeLessThanOrEqual(60);
    }
  });

  it('give both builders the allowlist of 03, section 2.2, with ToolSearch', async () => {
    const [architect, webDev] = (await loadShippedAgents()).profiles;
    expect(architect?.allowedTools).toEqual(webDev?.allowedTools);
    const tools = webDev?.allowedTools ?? [];
    for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch']) {
      expect(tools).toContain(tool);
    }
    expect(tools).toContain('ToolSearch');
    for (const command of ['npm', 'npx', 'pnpm', 'yarn', 'node', 'git commit', 'git add', 'ls']) {
      expect(tools).toContain(`Bash(${command} *)`);
    }
    // Never a rule that would reach GitHub or change branches (05, section 4.6).
    for (const tool of tools) {
      expect(tool).not.toMatch(/git (push|fetch|pull|clone|remote|checkout|switch)|\bgh\b|curl/);
      // Claude Code's documented rule syntax (03, section 6).
      expect(tool).toMatch(/^([A-Z]\w+|Bash\([^()]+\))$/);
    }
  });

  it('tell the agent to read CLAUDE.md first and never to push (06, section 6)', async () => {
    const { commonRules } = await loadShippedAgents();
    expect(commonRules).toContain('Read `CLAUDE.md`');
    expect(commonRules).toMatch(/Never push/);
    for (const tool of ['ticket_submit', 'ticket_ask', 'ticket_give_up']) {
      expect(commonRules).toContain(tool);
    }
  });

  it("tell the agent to edit files with its tools, one command per call, and what to ask the owner (owner's check, lot 2 step N)", async () => {
    const { commonRules } = await loadShippedAgents();
    expect(commonRules).toMatch(
      /Change files with the `Edit` and `Write` tools, never with the shell/,
    );
    expect(commonRules).toMatch(/One command per Bash call/i);
    expect(commonRules).toMatch(/A refused chained command says nothing about its parts/);
    expect(commonRules).toMatch(/Ask the owner only for what the owner can decide/);
  });

  it('ship the run message templates of 03, section 3.2, with the texts of ticket_submit', async () => {
    const templates = await loadTemplates();
    expect(Object.keys(templates)).toEqual([
      'implement',
      'continue',
      'answer',
      'nudge',
      'submit-checks',
    ]);
  });
});
