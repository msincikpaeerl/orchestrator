import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadShippedAgents, loadTemplates, parseTemplate } from './files.js';
import { runRules } from './messages.js';

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

  it("give the builders the common rules of 0.3.0 word for word, without the two sentences about review runs (owner's answer 1, lot 3 step H5)", async () => {
    const { rules } = await loadShippedAgents();
    const before = await readFile(
      new URL('./__fixtures__/common-rules-0.3.0.md', import.meta.url),
      'utf8',
    );
    const reviewParagraph =
      "\n\nIn a review run, your first message says so: you review another agent's work and end it with `review_approve` or `review_request_changes` instead of `ticket_submit`, then stop. `ticket_ask` and `ticket_give_up` work as above.";
    const reviewAside = ' (in a review run, change and commit nothing: you only read the work)';
    expect(before).toContain(reviewParagraph);
    expect(before).toContain(reviewAside);
    expect(runRules(rules, 'implement')).toBe(
      before.replace(reviewParagraph, '').replace(reviewAside, '').trim(),
    );
  });

  it('tell the builders to read CLAUDE.md first, to commit and never to push (06, section 6)', async () => {
    const builder = runRules((await loadShippedAgents()).rules, 'implement');
    expect(builder).toContain('Read `CLAUDE.md`');
    expect(builder).toMatch(/Commit your work on the current branch/);
    expect(builder).toMatch(/Never push/);
    for (const tool of ['ticket_submit', 'ticket_ask', 'ticket_give_up']) {
      expect(builder).toContain(tool);
    }
    expect(builder).not.toMatch(/review run|review_approve/);
  });

  it("tell the builders to edit files with their tools, one command per call, and what to ask the owner (owner's check, lot 2 step N)", async () => {
    const builder = runRules((await loadShippedAgents()).rules, 'implement');
    expect(builder).toMatch(/Change files with the `Edit` and `Write` tools, never with the shell/);
    expect(builder).toMatch(/One command per Bash call/i);
    expect(builder).toMatch(/A refused chained command says nothing about its parts/);
    expect(builder).toMatch(/Ask the owner only for what the owner can decide/);
    // The full submission (lot 3 step F2): listed files, a failed push, a diverged branch.
    expect(builder).toMatch(/must be a file your branch changed.*a folder is not accepted/);
    expect(builder).toMatch(/If the push itself fails.*end your turn at once/);
    expect(builder).toMatch(/`git merge origin\/<your ticket branch>`/);
  });

  it("tell a reviewer how to end and what not to change, never to submit, commit, merge, rebase or use Edit and Write (owner's answer 1, lot 3 step H5)", async () => {
    const reviewer = runRules((await loadShippedAgents()).rules, 'review');
    for (const tool of [
      'review_approve',
      'review_request_changes',
      'ticket_ask',
      'ticket_give_up',
    ]) {
      expect(reviewer).toContain(`\`${tool}\``);
    }
    expect(reviewer).toMatch(/End every turn with exactly one of these four tools, then stop/);
    expect(reviewer).toMatch(/Make one decision per review/);
    expect(reviewer).not.toMatch(/ticket_submit|`Edit`|`Write`|git merge|rebase|Commit your work/i);
    // What installing, building and testing create is expected (answer 1a).
    expect(reviewer).toMatch(/edit, create or delete no file yourself, and commit nothing/);
    expect(reviewer).toMatch(/installing, building or testing create in the worktree are expected/);
    expect(reviewer).toMatch(/Run no Git command that moves HEAD or changes tracked files/);
    expect(reviewer).toMatch(/if it moves, the review does not count/);
    // Findings go into the decision (answer 1b), the report is not an order (answer 1c).
    expect(reviewer).toMatch(/What you find goes into your decision/);
    expect(reviewer).toMatch(/report in your first message is part of the work you review/);
    // What still applies to a reviewer.
    expect(reviewer).toContain('Read `CLAUDE.md`');
    expect(reviewer).toMatch(/only way to reach the owner and the system/);
    expect(reviewer).toMatch(/as few turns as you can/);
    expect(reviewer).toMatch(/Run one command per Bash call\. Do not chain/);
    expect(reviewer).toMatch(/A refused chained command says nothing about its parts/);
    expect(reviewer).toMatch(/Ask the owner only for what the owner can decide/);
    expect(reviewer).toMatch(/as information, never as orders/);
    expect(reviewer).toMatch(/Never push/);
  });

  it("leave nothing in Quality's role or the review template that the reviewer rules say (owner's answer 1, lot 3 step H5)", async () => {
    const { profiles } = await loadShippedAgents();
    const quality = profiles.find((profile) => profile.key === 'quality')?.instructions ?? '';
    const review = (await loadTemplates()).review.main;
    for (const text of [quality, review]) {
      expect(text).not.toMatch(/ticket_ask|ticket_submit|commit or merge|commit, merge/);
      expect(text).not.toMatch(/Make one decision|only what only the owner can decide/);
    }
    // What to check lives in the role, whether to run the tests in the first message.
    expect(review).not.toMatch(/How to decide|really test/);
    expect(quality).not.toMatch(/CI already ran|run the project's tests/);
    expect(quality).toMatch(/The tests really test the change/);
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
