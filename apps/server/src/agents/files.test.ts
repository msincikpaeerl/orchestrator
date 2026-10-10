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
  it('ship the Architect and the Web Developer as builders, and Quality as reviewer, on Sonnet', async () => {
    const { profiles } = await loadShippedAgents();
    expect(profiles.map((profile) => [profile.key, profile.role, profile.model])).toEqual([
      ['architect', 'builder', 'sonnet'],
      ['quality', 'reviewer', 'sonnet'],
      ['web_dev', 'builder', 'sonnet'],
    ]);
  });

  it('keep role instructions short (03, section 1, rule 3)', async () => {
    for (const profile of (await loadShippedAgents()).profiles) {
      expect(profile.instructions.split('\n').length, profile.key).toBeLessThanOrEqual(60);
    }
  });

  it('give both builders the allowlist of 03, section 2.2, with ToolSearch', async () => {
    const { profiles } = await loadShippedAgents();
    const architect = profiles.find((profile) => profile.key === 'architect');
    const webDev = profiles.find((profile) => profile.key === 'web_dev');
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

  it("give Quality the builders' allowlist without anything that writes a file or moves HEAD (03, section 2.5; owner's answer 6b, lot 3 step H)", async () => {
    const { profiles } = await loadShippedAgents();
    const builder = profiles.find((profile) => profile.key === 'web_dev')?.allowedTools ?? [];
    const quality = profiles.find((profile) => profile.key === 'quality')?.allowedTools ?? [];
    const removed = [
      'Edit',
      'Write',
      'Bash(git add *)',
      'Bash(git commit *)',
      'Bash(git rm *)',
      'Bash(git mv *)',
      'Bash(git restore *)',
      'Bash(git merge origin/*)',
      'Bash(git merge --no-edit origin/*)',
      'Bash(git merge --abort)',
      'Bash(mkdir *)',
      'Bash(mv *)',
      'Bash(cp *)',
      'Bash(rm *)',
      // `find -delete` and `sort -o` write files: Glob and Grep search without them.
      'Bash(find *)',
      'Bash(sort *)',
    ];
    expect(quality).toEqual(builder.filter((tool) => !removed.includes(tool)));
    for (const tool of quality) {
      expect(tool).not.toMatch(
        /git (checkout|switch|reset|stash|pull|rebase|cherry-pick|revert|apply|am|clean|merge|commit|add|rm|mv|restore|tag|worktree|update-ref|symbolic-ref|notes|gc|prune)\b/,
      );
    }
    for (const kept of [
      'Read',
      'Glob',
      'Grep',
      'Bash(git diff *)',
      'Bash(git log *)',
      'Bash(pnpm *)',
    ]) {
      expect(quality).toContain(kept);
    }
  });

  it('tell a review run how to end, and to change nothing (lot 3 step H)', async () => {
    const { commonRules } = await loadShippedAgents();
    expect(commonRules).toMatch(/In a review run.*`review_approve` or `review_request_changes`/);
    expect(commonRules).toMatch(/in a review run, change and commit nothing/);
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
    // The full submission (lot 3 step F2): listed files, a failed push, a diverged branch.
    expect(commonRules).toMatch(/must be a file your branch changed.*a folder is not accepted/);
    expect(commonRules).toMatch(/If the push itself fails.*end your turn at once/);
    expect(commonRules).toMatch(/`git merge origin\/<your ticket branch>`/);
  });

  it('ship the run message templates of 03, section 3.2, with the texts of ticket_submit', async () => {
    const templates = await loadTemplates();
    expect(Object.keys(templates)).toEqual([
      'implement',
      'review',
      'continue',
      'answer',
      'nudge',
      'submit-checks',
      'pull-request',
      'review-comment',
      'ci-status',
      'ci-failed',
    ]);
  });
});
