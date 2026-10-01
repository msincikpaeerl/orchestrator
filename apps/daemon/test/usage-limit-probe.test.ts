import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import type { ScenarioInput } from './fake-claude/scenario.js';

// The usage-limit capture of the spike script (lot 2 plan, step M; 05, section 4.10):
// `--probe-limit` in a dry run against the fake `claude` (the real one is the owner's, only while
// limited), and `--scan-limit` on planted transcripts. Nothing here is anyone's real data.

const script = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'tools',
  'spike',
  'claude-code-spike.sh',
);
const TIMEOUT = 120_000;
const LIMIT_MESSAGE = "You've hit your session limit · resets 3:45pm";
const PLANTED_EMAIL = 'planted.owner@example.org';

let root: string;
let home: string;
let fake: FakeClaude;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'od-limit-'));
  await mkdir(join(root, 'bin'));
  home = join(root, 'owner-home');
  await mkdir(home);
  fake = await installFakeClaude(join(root, 'bin'), join(root, 'fake'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function runSpike(...args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    const child = spawn('bash', [script, ...args], {
      env: {
        ...process.env,
        HOME: home,
        ORCHESTRATOR_HOME: undefined,
        GIT_CONFIG_GLOBAL: undefined,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
        TMPDIR: root,
        PROBE_STATUS_LINE_WAIT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.on('exit', (code) => {
      done({ code: code ?? 1, output });
    });
  });
}

const probeLimit = (...args: string[]) =>
  runSpike(
    '--probe-limit',
    '--dry-run',
    '--claude',
    join(root, 'bin', 'claude'),
    '--fixtures',
    join(root, 'fixtures'),
    ...args,
  );

const scratchFolders = async () =>
  (await readdir(root)).filter((name) => name.startsWith('usage-limit-probe.'));

/** The one message answered by `turn`, then `/exit`. */
const session = (turn: NonNullable<ScenarioInput['turns']>[number]): ScenarioInput => ({
  turns: [turn, { steps: [{ do: 'exit' }] }],
});

/** A limit as documented: a full status line window, then `StopFailure` with the message. */
const limited = session({
  steps: [{ do: 'statusLine', fullForSeconds: 3600, input: { cost: { total_cost_usd: 0 } } }],
  end: { kind: 'stopFailure', error: 'rate_limit', message: LIMIT_MESSAGE },
});

describe('usage-limit capture (--probe-limit), dry run with the fake claude', () => {
  it(
    'records a limit, shows what the daemon detects, writes the fixtures and deletes the scratch folder',
    async () => {
      await fake.play(limited);
      const { code, output } = await probeLimit();
      expect(output).toMatch(
        /Hooks received: SessionStart ×1, UserPromptSubmit ×2, StopFailure ×1, SessionEnd ×1/,
      );
      expect(output).toMatch(
        /End of turn: StopFailure, error rate_limit, message "You've hit your session limit · resets 3:45pm"/,
      );
      expect(output).toMatch(/five_hour: 100 %, resets \d{4}-/);
      expect(output).toMatch(/Screen: Claude Code does not say it continues automatically/);
      expect(output).toMatch(/Daemon detection: detected, reset \d{4}-/);
      expect(output).toMatch(/^LIMIT CAPTURED$/m);
      expect(output).toMatch(/The fixtures are NOT committed: have them reviewed/);
      expect(code).toBe(0);
      expect((await readdir(join(root, 'fixtures'))).sort()).toEqual([
        'hooks.jsonl',
        'results.txt',
        'status-line.jsonl',
        'transcript.jsonl',
      ]);
      const hooks = await readFile(join(root, 'fixtures', 'hooks.jsonl'), 'utf8');
      expect(hooks).toContain('"event":"StopFailure"');
      expect(hooks).not.toContain(root);
      expect(await scratchFolders()).toEqual([]);

      // One session with the daemon's argument list on sonnet, and the one short message.
      const launches = (await fake.log()).filter((entry) => entry.event === 'start');
      expect(launches).toHaveLength(1);
      const args = launches[0]?.args ?? [];
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
      expect(args.at(-1)).toBe('Reply with the word OK.');
      const messages = (await fake.log()).flatMap((entry) =>
        entry.event === 'message' ? [entry.text] : [],
      );
      expect(messages).toEqual(['Reply with the word OK.', '/exit']);
      // The message's own hook is recorded besides the daemon's.
      expect(hooks).toContain('"event":"UserPromptSubmit"');
    },
    TIMEOUT,
  );

  it(
    'writes nothing when the session answers normally (no limit)',
    async () => {
      await fake.play(session({ steps: [{ do: 'text', text: 'OK' }] }));
      const { code, output } = await probeLimit();
      expect(output).toMatch(/End of turn: Stop, message "OK"/);
      expect(output).toMatch(/Daemon detection: nothing/);
      expect(output).toMatch(/NO LIMIT SEEN/);
      expect(output).toMatch(/No limit was seen: nothing to capture/);
      expect(code).toBe(2);
      await expect(readdir(join(root, 'fixtures'))).rejects.toThrow();
      expect(await scratchFolders()).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'withholds the fixtures when something looks like a credential or an account id',
    async () => {
      await fake.play(
        session({
          steps: [
            {
              do: 'transcript',
              line: JSON.stringify({
                type: 'system',
                content: 'Login refreshed',
                organizationUuid: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b',
              }),
            },
            { do: 'apiError', text: `API Error: ${LIMIT_MESSAGE}` },
          ],
          end: { kind: 'stopFailure', error: 'rate_limit', message: LIMIT_MESSAGE },
        }),
      );
      const { code, output } = await probeLimit('--keep');
      expect(output).toMatch(/^LIMIT CAPTURED$/m);
      expect(output).toMatch(
        /FIXTURES NOT WRITTEN: an account or organisation id in transcript\.jsonl\. Nothing was written\./,
      );
      expect(code).toBe(3);
      await expect(readdir(join(root, 'fixtures'))).rejects.toThrow();
      // --keep: the scratch folder stays, and the owner is told it holds credentials.
      expect(await scratchFolders()).toHaveLength(1);
      expect(output).toMatch(/It contains Claude credentials/);
    },
    TIMEOUT,
  );
});

describe('usage-limit scan (--scan-limit)', () => {
  const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

  it('prints only the whole lines holding an API error or a limit message, masked', async () => {
    const own = join(home, '.claude', 'projects', '-home-owner-site');
    const daemon = join(home, '.orchestrator', 'claude-config', 'projects', '-worktrees-run');
    await mkdir(own, { recursive: true });
    await mkdir(daemon, { recursive: true });
    const apiError = line({
      type: 'assistant',
      isApiErrorMessage: true,
      cwd: join(home, 'site'),
      message: { role: 'assistant', content: [{ type: 'text', text: LIMIT_MESSAGE }] },
    });
    await writeFile(
      join(own, 'a.jsonl'),
      [
        line({ type: 'user', message: { role: 'user', content: `Mail ${PLANTED_EMAIL}` } }),
        apiError,
        // A conversation quoting the message, and a tool result holding it: not signals.
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `The documented text is "${LIMIT_MESSAGE}".` }],
          },
        }),
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'x', content: LIMIT_MESSAGE }],
          },
        }),
      ].join('\n'),
    );
    await writeFile(
      join(daemon, 'b.jsonl'),
      `${line({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `API Error: 429 for ${PLANTED_EMAIL}` }],
        },
      })}\n`,
    );
    // An old transcript is not read.
    await writeFile(join(own, 'old.jsonl'), `${apiError}\n`);
    const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    await utimes(join(own, 'old.jsonl'), old, old);

    const { code, output } = await runSpike('--scan-limit');
    expect(code).toBe(0);
    expect(output).toMatch(
      /~\/\.claude\/projects\/-home-owner-site\/a\.jsonl \(1 line\(s\)\)\n2: \{/,
    );
    expect(output).toMatch(
      /~\/\.orchestrator\/claude-config\/projects\/-worktrees-run\/b\.jsonl \(1 line\(s\)\)\n1: \{.*API Error: 429 for <email>/,
    );
    // The whole line, the home folder masked.
    expect(output).toContain('"cwd":"~/site"');
    expect(output).toContain('"isApiErrorMessage":true');
    expect(output).not.toContain('old.jsonl');
    expect(output).not.toContain('The documented text');
    expect(output).not.toContain('tool_result');
    expect(output).not.toContain(PLANTED_EMAIL);
    expect(output).not.toContain(home);
    expect(output).toMatch(/2 line\(s\) found\./);
    // No session: the scan never starts Claude Code.
    expect(await fake.log()).toEqual([]);
  });

  it('says so when nothing is found', async () => {
    const { code, output } = await runSpike('--scan-limit');
    expect(code).toBe(0);
    expect(output).toMatch(/No API error or usage-limit message found\./);
  });
});
