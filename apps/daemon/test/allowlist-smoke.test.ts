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
    'curl -sI https://example.com',
    'sudo true',
    'docker ps',
    'cat ../../config.json',
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
    'prints PASS for every command of every profile and deletes the scratch folder',
    async () => {
      await fake.play(session(answers()), 'architect');
      await fake.play(session(answers()), 'web_dev');
      const { code, output } = await runSmoke();
      expect(output).toMatch(/Profiles: +architect web_dev/);
      expect(resultLines(output, 'PASS')).toHaveLength(34);
      expect(output).toMatch(
        /^web_dev: PASS +git commit -m "Allowlist smoke test": allowed, expected allowed$/m,
      );
      expect(output).toMatch(
        /^architect: PASS +curl -sI https:\/\/example\.com: refused \(not in the allowlist\), expected refused$/m,
      );
      expect(output).toMatch(
        /^web_dev: PASS +cat <probe>\/home\/\.orchestrator\/config\.json: refused by a deny rule, expected refused$/m,
      );
      expect(output).toMatch(/Every command passed\./);
      expect(code).toBe(0);
      // The block to paste holds no path of the owner's computer.
      const pasted = output.split('===== paste from here to Claude =====')[1] ?? '';
      expect(pasted).toContain('===== to here =====');
      expect(pasted).not.toContain(root);
      expect(pasted).not.toContain(home);
      expect(await scratchFolders()).toEqual([]);

      // Each session is launched with the daemon's argument list, on haiku.
      const launches = (await fake.log()).filter((entry) => entry.event === 'start');
      expect(launches.map((entry) => entry.cwd.split('/').at(-1))).toEqual([
        'architect',
        'web_dev',
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
    expect(output).toMatch(/STOPPED: no default profile designer \(profiles: architect web_dev\)/);
    expect(code).toBe(3);
  });
});
