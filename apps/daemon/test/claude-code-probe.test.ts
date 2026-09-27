import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import type { ScenarioInput } from './fake-claude/scenario.js';

// The dry run of the owner's Claude Code probe (lot 2 plan, step H) against the fake `claude`:
// the script, its helper and the daemon's settings generation, end to end, with no login.

const script = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tools',
  'smoke',
  'claude-code-probe.sh',
);
const TIMEOUT = 120_000;

// Planted personal data (never anyone's real data): the owner's global Git user, in a home folder
// of the test, and the account's e-mail and organisation id, in the session's attachments.
const GIT_NAME = 'Planted Owner';
const GIT_EMAIL = 'git.owner@example.org';
const ACCOUNT_EMAIL = 'planted.owner@example.org';
const ORG = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const PLANTED = [GIT_NAME, GIT_EMAIL, ACCOUNT_EMAIL, ORG];

/** The attachments Claude Code adds to a transcript, holding the owner's data. */
const sessionData = [
  {
    do: 'transcript' as const,
    line: JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'session_context',
        context: {
          userEmail: `The user's email address is ${ACCOUNT_EMAIL}. Git user: ${GIT_NAME}`,
        },
      },
    }),
  },
  {
    do: 'transcript' as const,
    line: JSON.stringify({
      type: 'attachment',
      attachment: { type: 'credential_org', organizationUuid: ORG },
    }),
  },
];

/** Claude Code's refusals, as 2.1.283 words them. */
const ruleRefusal = (command: string) =>
  `Permission to use Bash with command ${command} has been denied.`;
const dontAskRefusal =
  "Permission to use Bash has been denied because Claude Code is running in don't ask mode.";

let root: string;
let fake: FakeClaude;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'od-probe-'));
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

function runProbe(...args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(
      'bash',
      [
        script,
        '--dry-run',
        '--claude',
        join(root, 'bin', 'claude'),
        '--fixtures',
        join(root, 'fixtures'),
        ...args,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_GLOBAL: undefined,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
          TMPDIR: root,
          PROBE_SETTLE: '1',
          PROBE_STATUS_LINE_WAIT: '1',
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
  (await readdir(root)).filter((name) => name.startsWith('claude-code-probe.'));

/** The control session: reports the made-up setting when `reported`, then exits at `/exit`. */
function control(reported: boolean): ScenarioInput {
  return {
    debugLog: reported
      ? ['[WARN] Settings Warning: unknown setting orchestratorProbeUnknownSetting ignored']
      : ['[DEBUG] Settings loaded'],
    turns: [{ steps: [{ do: 'exit' }] }],
  };
}

const exit = { steps: [{ do: 'exit' as const }] };

/** The probe session: one turn of `steps`, then `/exit`. */
const probe = (steps: NonNullable<ScenarioInput['turns']>[number]['steps']): ScenarioInput => ({
  turns: [{ steps }, exit],
});

describe('Claude Code probe, dry run with the fake claude', () => {
  it(
    'prints PASS for every check (INFO for check 5), writes sanitised fixtures and deletes the scratch folder',
    async () => {
      await fake.play(control(true), 'control');
      await fake.play(
        probe([
          ...sessionData,
          {
            do: 'tool',
            name: 'Bash',
            input: { command: './probe-marker.sh' },
            result: dontAskRefusal,
          },
          {
            do: 'tool',
            name: 'Bash',
            input: { command: 'cat ../../config.json' },
            result: ruleRefusal('cat ../../config.json'),
          },
          { do: 'bash', command: 'cat ../../control.txt' },
          { do: 'mcp', tool: 'ping' },
          {
            do: 'statusLine',
            input: {
              rate_limits: { five_hour: { used_percentage: 3, resets_at: 1_900_000_000 } },
              cost: { total_cost_usd: 0.002 },
            },
          },
          { do: 'text', text: 'DONE' },
        ]),
        'probe',
      );
      const { code, output } = await runProbe();
      expect(output).toMatch(/Claude Code 2\.1\.282, model haiku/);
      for (const check of [1, 2, 3, 4])
        expect(output).toMatch(new RegExp(`^${String(check)}\\. PASS `, 'm'));
      expect(output).toMatch(
        /^3\. PASS .*rule's message, while the control file next to it was read/m,
      );
      expect(output).toMatch(/^5\. INFO .*the made-up key was reported/m);
      expect(output).toMatch(/Fixtures written to: /);
      expect(output).toMatch(/Every check passed\./);
      expect(code).toBe(0);
      expect(await scratchFolders()).toEqual([]);

      // Fixtures: the payloads, sanitised.
      const files = (await readdir(join(root, 'fixtures'))).sort();
      expect(files).toEqual([
        'control-hooks.jsonl',
        'hooks.jsonl',
        'results.txt',
        'status-line.jsonl',
        'transcript.jsonl',
      ]);
      for (const file of files) {
        const text = await readFile(join(root, 'fixtures', file), 'utf8');
        expect(text).not.toContain(root);
        // Nor in the transcript folder's name, where Claude Code writes the path with dashes.
        expect(text).not.toContain('claude-code-probe');
        expect(text).not.toContain(root.replace(/[^A-Za-z0-9]/g, '-'));
        for (const value of PLANTED) expect(text.toLowerCase()).not.toContain(value.toLowerCase());
      }
      // Only the entries the daemon reads: the attachments are gone.
      const transcript = await readFile(join(root, 'fixtures', 'transcript.jsonl'), 'utf8');
      expect(transcript).not.toContain('"attachment"');
      expect(transcript).toContain('DONE');
      expect(await readFile(join(root, 'fixtures', 'hooks.jsonl'), 'utf8')).toContain(
        '<probe>/home/.orchestrator',
      );
      // The daemon's argument list, with the debug file before --.
      const [launch] = (await fake.log()).filter(
        (entry) => entry.event === 'start' && entry.cwd.endsWith('/probe'),
      );
      expect(launch?.event === 'start' && launch.args.slice(0, 11)).toEqual([
        '--mcp-config',
        expect.stringMatching(/\/runs\/probe\/mcp\.json$/) as unknown,
        '--strict-mcp-config',
        '--setting-sources',
        'user',
        '--settings',
        expect.stringMatching(/\/runs\/probe\/settings\.json$/) as unknown,
        '--permission-mode',
        'dontAsk',
        '--model',
        'haiku',
      ]);
      expect((await fake.log()).some((entry) => entry.event === 'arguments_refused')).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'prints FAIL and NOT ATTEMPTED, and asks for another run, when the agent skips actions',
    async () => {
      await fake.play(control(false), 'control');
      await fake.play(
        probe([
          // Run for real: the repository's allow rule would have applied.
          { do: 'bash', command: './probe-marker.sh' },
          { do: 'bash', command: 'cat ../../config.json' },
          { do: 'text', text: 'DONE' },
        ]),
        'probe',
      );
      const { code, output } = await runProbe('--keep');
      expect(output).toMatch(/^1\. FAIL .*the marker command ran/m);
      expect(output).toMatch(/^2\. NOT ATTEMPTED .*never called the ping tool/m);
      expect(output).toMatch(/^3\. FAIL .*the denied file was read/m);
      expect(output).toMatch(/^4\. FAIL .*the status line command never ran/m);
      expect(output).toMatch(/^5\. INFO .*was not reported either/m);
      expect(output).toMatch(/run the probe again/);
      expect(code).toBe(1);
      // --keep: the scratch folder stays, and the owner is told it holds credentials.
      expect(await scratchFolders()).toHaveLength(1);
      expect(output).toMatch(/It contains Claude credentials/);
    },
    TIMEOUT,
  );

  it(
    'prints NOT ATTEMPTED alone with exit code 2 when only actions are missing',
    async () => {
      await fake.play(control(true), 'control');
      await fake.play(
        probe([
          { do: 'mcp', tool: 'ping' },
          { do: 'statusLine', input: { rate_limits: {}, cost: { total_cost_usd: 0 } } },
          { do: 'text', text: 'DONE' },
        ]),
        'probe',
      );
      const { code, output } = await runProbe();
      expect(output).toMatch(/^1\. NOT ATTEMPTED /m);
      expect(output).toMatch(/^3\. NOT ATTEMPTED .*cat config\.json or cat control\.txt/m);
      expect(output).toMatch(/run the probe again/);
      expect(code).toBe(2);
    },
    TIMEOUT,
  );

  it(
    'fails check 3 when dontAsk mode, not the deny rule, refused the denied file',
    async () => {
      await fake.play(control(true), 'control');
      await fake.play(
        probe([
          {
            do: 'tool',
            name: 'Bash',
            input: { command: './probe-marker.sh' },
            result: dontAskRefusal,
          },
          {
            do: 'tool',
            name: 'Bash',
            input: { command: 'cat ../../config.json' },
            result: dontAskRefusal,
          },
          { do: 'bash', command: 'cat ../../control.txt' },
          { do: 'mcp', tool: 'ping' },
          { do: 'text', text: 'DONE' },
        ]),
        'probe',
      );
      const { code, output } = await runProbe();
      expect(output).toMatch(/^3\. FAIL .*refused by dontAsk mode, not by the deny rule/m);
      expect(code).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "writes no fixture at all when the owner's data is still in one after sanitising",
    async () => {
      await fake.play(control(true), 'control');
      await fake.play(
        probe([
          ...sessionData,
          {
            do: 'tool',
            name: 'Bash',
            input: { command: './probe-marker.sh' },
            result: dontAskRefusal,
          },
          // Kept entries: the agent repeating the Git user and the organisation id.
          { do: 'text', text: `Hello ${GIT_NAME} of organisation ${ORG}.` },
        ]),
        'probe',
      );
      const { code, output } = await runProbe();
      expect(output).toMatch(
        /FIXTURES NOT WRITTEN: personal data still found after sanitising \(.*the global Git user name in transcript\.jsonl.*\)/,
      );
      expect(output).toMatch(/the organisation id in transcript\.jsonl/);
      // What was found is named, never shown.
      for (const value of PLANTED) expect(output).not.toContain(value);
      expect(await readdir(root)).not.toContain('fixtures');
      expect(code).toBe(3);
      expect(await scratchFolders()).toEqual([]);
    },
    TIMEOUT,
  );
});
