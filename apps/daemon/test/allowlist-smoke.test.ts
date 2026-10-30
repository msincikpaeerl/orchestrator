import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import type { ScenarioInput } from './fake-claude/scenario.js';

// The dry run of the owner's allowlist smoke test (03, section 6; lot 2 plan, step I) against the
// fake `claude`: the script, its helper and the daemon's settings generation, end to end, with no
// login. The fake plays the refusals Claude Code 2.1.283 gives; the real ones are the owner's run.

const script = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tools',
  'smoke',
  'allowlist-smoke.sh',
);
const TIMEOUT = 120_000;

// Planted personal data (never anyone's real data): the owner's global Git user.
const GIT_NAME = 'Planted Owner';
const GIT_EMAIL = 'git.owner@example.org';

const dontAskRefusal =
  "Permission to use Bash has been denied because Claude Code is running in don't ask mode.";
const ruleRefusal = (command: string) =>
  `Permission to use Bash with command ${command} has been denied.`;

type Steps = NonNullable<NonNullable<ScenarioInput['turns']>[number]['steps']>;

/** What the allowlist should do with a command of the prompt. */
function expectedOutcome(command: string): 'ran' | 'refused' {
  return ['curl -sI https://example.com', 'sudo true', 'docker ps'].includes(command) ||
    command.startsWith('cat ')
    ? 'refused'
    : 'ran';
}

/** Every step of the prompt, answered as `outcome` says (as expected by default). */
function answers(
  outcome: (command: string) => 'ran' | 'refused' | 'skipped' = expectedOutcome,
): Steps {
  const commands = [
    'pnpm install',
    'pnpm test',
    'pnpm run lint',
    'pnpm run build',
    'npm test',
    'node --version',
    'mkdir -p src',
    'ls',
    'WRITE',
    'git status',
    'git add smoke-note.txt',
    'git commit -m "Allowlist smoke test"',
    'git log --oneline -1',
    'cat ../../config.json',
    'curl -sI https://example.com',
    'sudo true',
    'docker ps',
  ];
  return commands.flatMap((command): Steps => {
    const result = outcome(command);
    if (result === 'skipped') return [];
    if (command === 'WRITE') {
      return [
        {
          do: 'tool',
          name: 'Write',
          input: { file_path: 'smoke-note.txt', content: 'smoke' },
          result:
            result === 'ran'
              ? 'File created successfully at: smoke-note.txt'
              : 'Permission to use Write has been denied.',
        },
      ];
    }
    return [
      {
        do: 'tool',
        name: 'Bash',
        input: { command },
        result:
          result === 'ran'
            ? 'done'
            : command.startsWith('cat ')
              ? ruleRefusal(command)
              : dontAskRefusal,
      },
    ];
  });
}

/**
 * Quality's commands (lot 3 step H): reads allowed, then each kind that writes or moves HEAD.
 * `find` and `sort` without a writing option are in Claude Code's built-in read-only set, which
 * runs whatever the allowlist (the owner's run on 2.1.296, lot 3 step H2): their writing forms
 * must still be refused.
 */
const REVIEWER_ALLOWED = [
  'pnpm test',
  'pnpm run build',
  'node --version',
  'ls',
  'cat README.md',
  'find . -name README.md',
  'sort README.md',
  'git status',
  'git diff HEAD',
  'git log --oneline -1',
  'git show --stat HEAD',
];
const REVIEWER_REFUSED = [
  'WRITE',
  'mkdir -p src',
  'rm README.md',
  'find . -name smoke-note.txt -delete',
  'find . -name README.md -exec rm {} \\;',
  'find . -name README.md -execdir rm {} \\;',
  'find . -name README.md -ok rm {} \\;',
  'find . -name README.md -fprint smoke-find.txt',
  'find . -name README.md -fls smoke-find.txt',
  'sort -o README.md README.md',
  'sort --output=README.md README.md',
  "sed -i 's/smoke/check/' README.md",
  "sed -n 'w smoke-sed.txt' README.md",
  'echo smoke > smoke-note.txt',
  'uniq README.md smoke-uniq.txt',
  'git add README.md',
  'git commit --allow-empty -m "Smoke"',
  'git checkout -b smoke-other',
  'git switch -c smoke-switched',
  'git reset --hard HEAD',
  'git stash',
  'git pull',
  'git rebase main',
  'git cherry-pick HEAD',
  'git revert --no-edit HEAD',
  'git apply smoke.patch',
  'git am smoke.patch',
  'git clean -n',
  'git merge origin/main',
  'cat ../../config.json',
  'curl -sI https://example.com',
  'sudo true',
  'docker ps',
];
/**
 * The Project Manager's commands (owner's answer 16, lot 5 step E1): reading allowed, then what
 * writes, commits, installs or runs a program, refused.
 */
const PLANNER_ALLOWED = [
  'READ',
  'git status',
  'git log --oneline -1',
  'ls',
  'cat README.md',
  'find . -name README.md',
];
const PLANNER_REFUSED = [
  'WRITE',
  'mkdir -p src',
  'rm README.md',
  'git add README.md',
  'git commit --allow-empty -m "Smoke"',
  'pnpm install',
  'npm test',
  'node --version',
  'cat ../../config.json',
  'curl -sI https://example.com',
  'sudo true',
  'docker ps',
];

/** The Project Manager's steps, each answered as expected unless `ran` names it. */
function plannerAnswers(ran: readonly string[] = []): Steps {
  return [...PLANNER_ALLOWED, ...PLANNER_REFUSED].map((command) => {
    const allowed = PLANNER_ALLOWED.includes(command) || ran.includes(command);
    if (command === 'READ') {
      return {
        do: 'tool',
        name: 'Read',
        input: { file_path: 'README.md' },
        result: '# Allowlist smoke test',
      };
    }
    if (command === 'WRITE') {
      return {
        do: 'tool',
        name: 'Write',
        input: { file_path: 'smoke-note.txt', content: 'smoke' },
        result: allowed
          ? 'File created successfully at: smoke-note.txt'
          : "Permission to use Write has been denied because Claude Code is running in don't ask mode.",
      };
    }
    return {
      do: 'tool',
      name: 'Bash',
      input: { command },
      result: allowed
        ? 'done'
        : command.startsWith('cat ../')
          ? ruleRefusal(command)
          : dontAskRefusal,
    };
  });
}

// Claude Code 2.1.296's words (the owner's quality run, lot 3 step H2; 06, section 5).
const UNLISTED_ANSWER =
  '<tool_use_error>Error: No such tool available: mcp__orchestrator__ticket_submit</tool_use_error>';

/**
 * Quality's steps, each answered as expected unless `ran` names it; then the unlisted tool.
 * `written` gives the text the agent typed for a step, when not the prompt's own.
 */
function reviewerAnswers(
  ran: readonly string[] = [],
  written: Readonly<Record<string, string>> = {},
): Steps {
  const steps: Steps = [...REVIEWER_ALLOWED, ...REVIEWER_REFUSED].map((command) => {
    const allowed = REVIEWER_ALLOWED.includes(command) || ran.includes(command);
    if (command === 'WRITE') {
      return {
        do: 'tool',
        name: 'Write',
        input: { file_path: 'smoke-note.txt', content: 'smoke' },
        result: allowed
          ? 'File created successfully at: smoke-note.txt'
          : "Permission to use Write has been denied because Claude Code is running in don't ask mode.",
      };
    }
    return {
      do: 'tool',
      name: 'Bash',
      input: { command: written[command] ?? command },
      result: allowed
        ? 'done'
        : command.startsWith('cat ../')
          ? ruleRefusal(command)
          : dontAskRefusal,
    };
  });
  return [
    ...steps,
    { do: 'tool', name: 'mcp__orchestrator__ticket_submit', input: {}, result: UNLISTED_ANSWER },
  ];
}

const session = (steps: Steps): ScenarioInput => ({
  turns: [{ steps: [...steps, { do: 'text', text: 'DONE' }] }, { steps: [{ do: 'exit' }] }],
});

let root: string;
let fake: FakeClaude;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'od-smoke-'));
  await mkdir(join(root, 'bin'));
  home = join(root, 'owner-home');
  await mkdir(home);
  await writeFile(
    join(home, '.gitconfig'),
    `[user]\n\tname = ${GIT_NAME}\n\temail = ${GIT_EMAIL}\n`,
  );
  fake = await installFakeClaude(join(root, 'bin'), join(root, 'fake'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runSmoke(...args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(
      'bash',
      [script, '--dry-run', '--claude', join(root, 'bin', 'claude'), ...args],
      {
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_GLOBAL: undefined,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          TMPDIR: root,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('exit', (code) => {
      done({ code: code ?? 1, output });
    });
  });
}

const scratchFolders = async () =>
  (await readdir(root)).filter((name) => name.startsWith('allowlist-smoke.'));

const resultLines = (output: string, verdict: string) =>
  output.split('\n').filter((line) => new RegExp(`^\\w+: ${verdict} `).test(line));

describe('allowlist smoke test, dry run with the fake claude', () => {
  it(
    'prints PASS for every command, runs a profile with the same rules only once, and deletes the scratch folder',
    async () => {
      await fake.play(session(answers()), 'architect');
      await fake.play(session(answers()), 'web_dev');
      await fake.play(session(plannerAnswers()), 'pm');
      await fake.play(session(reviewerAnswers()), 'quality');
      const { code, output } = await runSmoke();
      // The builders share one allowlist and the same deny rules (03, section 2.2); Quality's
      // and the Project Manager's differ (03, sections 2.5 and 2.1).
      expect(output).toMatch(/Profiles: +architect pm quality$/m);
      expect(output).toMatch(
        /^Not run again: +web_dev \(same allowlist and deny rules as architect\)$/m,
      );
      expect(
        resultLines(output, 'PASS').filter((line) => line.startsWith('architect:')),
      ).toHaveLength(17);
      expect(
        resultLines(output, 'PASS').filter((line) => line.startsWith('quality:')),
      ).toHaveLength(REVIEWER_ALLOWED.length + REVIEWER_REFUSED.length);
      expect(resultLines(output, 'PASS').filter((line) => line.startsWith('pm:'))).toHaveLength(
        PLANNER_ALLOWED.length + PLANNER_REFUSED.length,
      );
      expect(output).toMatch(
        /^architect: PASS +git commit -m "Allowlist smoke test": allowed, expected allowed$/m,
      );
      expect(output).toMatch(
        /^architect: PASS +curl -sI https:\/\/example\.com: refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(
        /^architect: PASS +cat <probe>\/home\/\.orchestrator\/config\.json: refused by a deny rule, expected refused$/m,
      );
      // The machine's key is checked before the other refusals: `haiku` skipped the last step in
      // the owner's run (lot 2 step N).
      const commands = resultLines(output, 'PASS')
        .filter((line) => line.startsWith('architect:'))
        .map((line) => line.split(/ {2,}/)[1] ?? '');
      expect(commands.slice(-4).map((command) => command.split(':')[0])).toEqual([
        'cat <probe>/home/.orchestrator/config.json',
        'curl -sI https',
        'sudo true',
        'docker ps',
      ]);
      expect(output).not.toMatch(/^web_dev:/m);
      expect(output).toMatch(/Every command passed\./);
      expect(code).toBe(0);
      // The block to paste holds no path of the owner's computer.
      const pasted = output.split('===== paste from here to Claude =====')[1] ?? '';
      expect(pasted).toContain('===== to here =====');
      expect(pasted).not.toContain(root);
      expect(pasted).not.toContain(home);
      expect(await scratchFolders()).toEqual([]);

      // The session is launched with the daemon's argument list, on haiku.
      const launches = (await fake.log()).filter((entry) => entry.event === 'start');
      expect(launches.map((entry) => entry.cwd.split('/').at(-1))).toEqual([
        'architect',
        'pm',
        'quality',
      ]);
      for (const launch of launches) {
        expect(launch.args.slice(0, 11)).toEqual([
          '--mcp-config',
          expect.stringMatching(/\/runs\/\w+\/mcp\.json$/) as unknown,
          '--strict-mcp-config',
          '--setting-sources',
          'user',
          '--settings',
          expect.stringMatching(/\/runs\/\w+\/settings\.json$/) as unknown,
          '--permission-mode',
          'dontAsk',
          '--model',
          'haiku',
        ]);
      }
      expect((await fake.log()).some((entry) => entry.event === 'arguments_refused')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "asks for the builder's commit in so many words, right after the git add, and names another form of it the agent ran",
    async () => {
      // The owner's check (lot 3 step N): `haiku` never tried the commit, in two runs.
      const heredoc = `git commit -m "$(cat <<'EOF'\nAllowlist smoke test\n\nCo-Authored-By: Claude\nEOF\n)"`;
      await fake.play(
        session(
          answers().map((step) =>
            step.do === 'tool' && step.input?.command === 'git commit -m "Allowlist smoke test"'
              ? { ...step, input: { command: heredoc } }
              : step,
          ),
        ),
        'architect',
      );
      const { code, output } = await runSmoke('--profile', 'architect');
      const message = (await fake.log()).find((entry) => entry.event === 'message');
      const steps = String(message?.text).split('\n');
      expect(steps[0]).toContain('Type each command exactly as written.');
      expect(steps.slice(11, 13)).toEqual([
        '11. Run this command with the Bash tool: git add smoke-note.txt',
        '12. Make the commit this check asks for: run exactly this command with the Bash tool, as written, with no other option, no message file and no added line: git commit -m "Allowlist smoke test"',
      ]);
      expect(output).toMatch(
        /^architect: NOT ATTEMPTED +git commit -m "Allowlist smoke test": the agent ran another form of it instead: git commit -m "\$\(cat <<'EOF' Allowlist smoke test Co-Authored-By: Claude EOF \)"$/m,
      );
      expect(resultLines(output, 'NOT ATTEMPTED')).toHaveLength(1);
      expect(code).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "checks Quality's refusals of every command that writes a file or moves HEAD, and records the words for a tool not listed",
    async () => {
      await fake.play(
        session(
          reviewerAnswers(['git stash', 'WRITE', 'sort -o README.md README.md'], {
            // The same command, quoted another way.
            'find . -name README.md -exec rm {} \\;': "find . -name README.md -exec rm {} ';'",
          }),
        ),
        'quality',
      );
      const { code, output } = await runSmoke('--profile', 'quality');
      expect(output).toMatch(/Profiles: +quality$/m);
      expect(output).toMatch(
        /^quality: PASS +git merge origin\/main: refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(/^quality: PASS +git diff HEAD: allowed, expected allowed$/m);
      expect(output).toMatch(/^quality: FAIL +git stash: allowed, expected refused$/m);
      // Read-only forms run outside the allowlist; their writing forms must not (lot 3 step H2).
      expect(output).toMatch(
        /^quality: PASS +find \. -name README\.md: allowed, expected allowed$/m,
      );
      expect(output).toMatch(
        /^quality: FAIL +sort -o README\.md README\.md: allowed, expected refused$/m,
      );
      expect(output).toMatch(
        /^quality: PASS +find \. -name README\.md -exec rm \{\} \\;: refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(
        /^quality: PASS +echo smoke > smoke-note\.txt: refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(
        /^quality: FAIL +Create the file smoke-note\.txt with the Write tool, containing the word smoke: allowed, expected refused$/m,
      );
      // Never a verdict: what Claude Code answers for a tool the run does not list (answer 1).
      expect(output).toMatch(
        /^quality: INFO +a tool not listed \(mcp__orchestrator__ticket_submit\): Claude Code answered: <tool_use_error>Error: No such tool available: mcp__orchestrator__ticket_submit<\/tool_use_error>$/m,
      );
      expect(code).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "checks the Project Manager's reading, and its refusals of everything that writes, installs or runs a program (owner's answer 16, lot 5 step E1)",
    async () => {
      await fake.play(session(plannerAnswers(['node --version'])), 'pm');
      const { code, output } = await runSmoke('--profile', 'pm');
      expect(output).toMatch(/Profiles: +pm$/m);
      expect(output).toMatch(
        /^pm: PASS +Read the file README\.md with the Read tool: allowed, expected allowed$/m,
      );
      expect(output).toMatch(/^pm: PASS +git log --oneline -1: allowed, expected allowed$/m);
      expect(output).toMatch(
        /^pm: PASS +git commit --allow-empty -m "Smoke": refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(
        /^pm: PASS +pnpm install: refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(
        /^pm: PASS +Create the file smoke-note\.txt with the Write tool, containing the word smoke: refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(/^pm: FAIL +node --version: allowed, expected refused$/m);
      expect(code).toBe(1);
    },
    TIMEOUT,
  );

  it(
    'prints FAIL for a needed command refused or a forbidden one run, NOT ATTEMPTED for one never tried',
    async () => {
      await fake.play(
        session(
          answers((command) =>
            command === 'pnpm run build' || command.startsWith('cat ')
              ? 'refused'
              : command === 'curl -sI https://example.com' ||
                  command === 'sudo true' ||
                  command === 'docker ps'
                ? 'ran'
                : command === 'npm test'
                  ? 'skipped'
                  : 'ran',
          ),
        ),
        'web_dev',
      );
      const { code, output } = await runSmoke('--profile', 'web_dev', '--keep');
      expect(output).toMatch(/Profiles: +web_dev$/m);
      expect(output).toMatch(
        /^web_dev: FAIL +pnpm run build: refused \(not in the allowlist\), expected allowed$/m,
      );
      expect(output).toMatch(
        /^web_dev: FAIL +curl -sI https:\/\/example\.com: allowed, expected refused$/m,
      );
      expect(output).toMatch(/^web_dev: NOT ATTEMPTED +npm test: the agent never tried it$/m);
      expect(output).not.toMatch(/^architect:/m);
      expect(code).toBe(1);
      // --keep: the scratch folder stays, and the owner is told it holds credentials.
      expect(await scratchFolders()).toHaveLength(1);
      expect(output).toMatch(/It contains Claude credentials/);
    },
    TIMEOUT,
  );

  it(
    'exits with 2 when commands were only not attempted',
    async () => {
      await fake.play(
        session(
          answers((command) => (command.startsWith('git') ? 'skipped' : expectedOutcome(command))),
        ),
        'architect',
      );
      const { code, output } = await runSmoke('--profile', 'architect');
      expect(resultLines(output, 'NOT ATTEMPTED')).toHaveLength(4);
      expect(resultLines(output, 'FAIL')).toEqual([]);
      expect(output).toMatch(/run the smoke test again/);
      expect(code).toBe(2);
    },
    TIMEOUT,
  );

  it(
    "shows no report and deletes the recorded files when the owner's data is still in them",
    async () => {
      await fake.play(
        session([
          ...answers(),
          { do: 'tool', name: 'Bash', input: { command: `echo ${GIT_NAME}` }, result: 'x' },
        ]),
        'web_dev',
      );
      const { code, output } = await runSmoke('--profile', 'web_dev', '--keep');
      expect(output).toMatch(
        /REPORT WITHHELD: personal data still found after sanitising \(the global Git user name in record\/hooks-web_dev\.jsonl\)/,
      );
      expect(output).not.toContain(GIT_NAME);
      expect(output).not.toMatch(/: PASS /);
      expect(code).toBe(3);
      const [scratch] = await scratchFolders();
      expect(await readdir(join(root, scratch ?? '', 'record'))).toEqual([]);
    },
    TIMEOUT,
  );

  it('refuses an unknown profile', async () => {
    const { code, output } = await runSmoke('--profile', 'designer');
    expect(output).toMatch(
      /STOPPED: no default profile designer \(profiles: architect pm quality web_dev\)/,
    );
    expect(code).toBe(3);
  });
});
