import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

let root: string;
let fake: FakeClaude;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'od-probe-'));
  await mkdir(join(root, 'bin'));
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

describe('Claude Code probe, dry run with the fake claude', () => {
  it(
    'prints PASS for every check when Claude Code behaves as documented, then deletes the scratch folder',
    async () => {
      await fake.play(control(true), 'control');
      await fake.play(
        {
          turns: [
            {
              steps: [
                {
                  do: 'tool',
                  name: 'Bash',
                  input: { command: './probe-marker.sh' },
                  result: 'Permission denied.',
                },
                {
                  do: 'tool',
                  name: 'Bash',
                  input: { command: 'cat ../../config.json' },
                  result: 'Permission denied.',
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
              ],
            },
            exit,
          ],
        },
        'probe',
      );
      const { code, output } = await runProbe();
      expect(output).toMatch(/Claude Code 2\.1\.282, model haiku/);
      for (const check of [1, 2, 3, 4, 5])
        expect(output).toMatch(new RegExp(`^${String(check)}\\. PASS `, 'm'));
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
      }
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
        {
          turns: [
            {
              steps: [
                // Run for real: the repository's allow rule would have applied.
                { do: 'bash', command: './probe-marker.sh' },
                { do: 'bash', command: 'cat ../../config.json' },
                { do: 'text', text: 'DONE' },
              ],
            },
            exit,
          ],
        },
        'probe',
      );
      const { code, output } = await runProbe('--keep');
      expect(output).toMatch(/^1\. FAIL .*the marker command ran/m);
      expect(output).toMatch(/^2\. NOT ATTEMPTED .*never called the ping tool/m);
      expect(output).toMatch(/^3\. FAIL .*the denied file was read/m);
      expect(output).toMatch(/^4\. FAIL .*the status line command never ran/m);
      expect(output).toMatch(/^5\. FAIL .*cannot be proved this way/m);
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
        {
          turns: [
            {
              steps: [
                { do: 'mcp', tool: 'ping' },
                { do: 'statusLine', input: { rate_limits: {}, cost: { total_cost_usd: 0 } } },
                { do: 'text', text: 'DONE' },
              ],
            },
            exit,
          ],
        },
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
});
