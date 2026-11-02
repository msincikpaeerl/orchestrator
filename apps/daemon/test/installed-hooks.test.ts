import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DAEMON_PACKAGE_NAME } from '@orchestrator/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bundleDaemon } from '../scripts/bundle.js';
import { writeConfig } from '../src/config.js';
import { TMUX_SOCKET_NAME } from '../src/paths.js';
import { shellCommand } from '../src/self.js';
import { installFakeClaude, type FakeClaude } from './fake-claude/install.js';
import { startGitHttpServer, type GitHttpServer } from './git-http-server.js';
import { createRemote } from './remote.js';
import { runStartPayload } from './run-start.js';
import { ScriptedServer, TOKEN } from './scripted-server.js';
import {
  DAEMON_COMMAND,
  createTestHome,
  linkSystemTool,
  stopHomeProcesses,
  waitFor,
  type TestHome,
} from './testing.js';

// An agent's `package.json` in the worktree and the installed daemon's hooks (owner's question,
// review of lot 5 step K). The hooks run in the worktree, where agents write `package.json` all
// the time. The installed daemon writes its hook command as `node <its bundled script> hook ...`
// (`selfCommand()`, no Node.js option), and Node.js finds an entry script's package scope from the
// script's own folder, never from the current one: these tests start the daemon from its built
// bundle, laid out as npm installs it, and check that every hook still answers after the agent
// writes a `package.json` with "type": "module", or one that is not JSON. Only the daemon run from
// its sources (the tests' `tsx`, whose `--require` preload Node.js resolves from the current
// folder) fails on an invalid one, which the last test pins down.

const TIMEOUT = 90_000;
const root = resolve(import.meta.dirname, '..');

/** The bundled daemon as `npm install --global` lays out its package: the script and its manifest. */
let installed: string;
let script: string;

beforeAll(async () => {
  installed = await mkdtemp(join(tmpdir(), 'od-test-installed-'));
  const folder = join(installed, 'lib', 'node_modules', DAEMON_PACKAGE_NAME);
  await mkdir(join(folder, 'dist'), { recursive: true });
  // The manifest `scripts/pack.ts` writes, "type": "module" included.
  const manifest = `${JSON.stringify(
    {
      name: DAEMON_PACKAGE_NAME,
      version: '0.0.0-test',
      type: 'module',
      bin: { [DAEMON_PACKAGE_NAME]: 'dist/orchestrator-daemon.js' },
    },
    null,
    2,
  )}\n`;
  const bundle = await bundleDaemon(root, manifest);
  await writeFile(join(folder, 'package.json'), manifest);
  script = join(folder, 'dist', 'orchestrator-daemon.js');
  await writeFile(script, bundle.script);
  await chmod(script, 0o755);
}, 60_000);

afterAll(async () => {
  await rm(installed, { recursive: true, force: true });
});

let home: TestHome;
let fake: FakeClaude;
let server: ScriptedServer;
let git: GitHttpServer;
let daemon: ReturnType<typeof spawn> | undefined;

beforeEach(async () => {
  home = await createTestHome();
  await linkSystemTool(home.bin, 'git');
  await linkSystemTool(home.bin, 'tmux');
  fake = await installFakeClaude(home.bin, join(home.root, 'fake'));
  const tmuxDir = join(home.root, 'tmux');
  await mkdir(tmuxDir, { mode: 0o700 });
  home.env.TMUX_TMPDIR = tmuxDir;
  home.env.PATH = `${home.env.PATH ?? ''}:/usr/bin:/bin`;
  const remotes = join(home.root, 'remotes');
  await createRemote(remotes, 'owner', 'notes', home.env);
  git = await startGitHttpServer(remotes, { username: 'x-access-token', password: TOKEN });
  server = new ScriptedServer();
  await server.listen();
  await writeConfig(home.paths.config, {
    serverUrl: server.url,
    machineId: randomUUID(),
    machineName: 'Desktop',
    machineToken: `omt_${'d'.repeat(43)}`,
    ca: null,
  });
});

afterEach(async () => {
  if (daemon) {
    const exited = new Promise((done) => daemon?.once('exit', done));
    daemon.kill('SIGTERM');
    await exited;
    daemon = undefined;
  }
  spawnSync(join(home.bin, 'tmux'), ['-L', TMUX_SOCKET_NAME, 'kill-server'], { env: home.env });
  await stopHomeProcesses(home);
  await server.close();
  await git.close();
  await home.remove();
});

/**
 * A run whose agent writes `content` as the worktree's `package.json` with Bash, then calls a
 * tool, waits a moment and ends its turn. The hooks after the write: `PostToolUse` of that Bash
 * call, `PreToolUse` and `PostToolUse` of the tool, then `Stop`. With no reminder allowed, the run
 * ends `nudges_exhausted` only once `Stop` has reached the daemon (the session is then closed,
 * so the fake may not record `Stop`'s own answer). The run's files are read during the wait,
 * before the end removes them.
 */
async function runWritingPackageJson(content: string) {
  await fake.play({
    turns: [
      {
        steps: [
          { do: 'bash', command: `printf '%s\\n' '${content}' > package.json` },
          { do: 'tool', name: 'Read', input: { file_path: 'package.json' } },
          { do: 'sleep', ms: 2000 },
          { do: 'text', text: 'Read it.' },
        ],
      },
    ],
  });
  // `orchestrator-daemon start`, as the owner or the service runs the installed command.
  daemon = spawn(process.execPath, [script, 'start'], { env: home.env, stdio: 'ignore' });
  await waitFor(() => server.hellos().length === 1, 20_000, 'hello');
  const payload = runStartPayload(`${git.url}/owner/notes.git`, {
    limits: { maxNudgesPerRun: 0 },
  });
  server.send({ type: 'run.start', id: randomUUID(), payload });

  /** The hooks after the agent's write, with their exit codes. */
  const hooksAfterWrite = async () => {
    const log = await fake.log();
    const written = log.findIndex((entry) => entry.event === 'bash');
    if (written === -1) return [];
    return log
      .slice(written + 1)
      .flatMap((entry) => (entry.event === 'hook' ? [[entry.hook, entry.exitCode] as const] : []));
  };
  await waitFor(
    async () => (await hooksAfterWrite()).length === 3,
    30_000,
    "the tool's hooks after the write",
  );
  const settings = JSON.parse(
    await readFile(join(home.paths.home, 'runs', payload.runId, 'settings.json'), 'utf8'),
  ) as { hooks: Record<string, { hooks: { command: string }[] }[] | undefined> };
  const packageJson = await readFile(
    join(home.paths.home, 'worktrees', payload.runId, 'package.json'),
    'utf8',
  );
  await waitFor(
    () => server.states(payload.runId).some((state) => state.payload.state === 'ended'),
    30_000,
    'the end of the run, after its Stop hook',
  );
  return {
    runId: payload.runId,
    states: server.states(payload.runId).map((state) => state.payload),
    hookCommand: settings.hooks.Stop?.[0]?.hooks[0]?.command,
    hooks: (await hooksAfterWrite()).slice(0, 3),
    packageJson,
  };
}

describe("the installed daemon's hooks after the agent writes package.json in the worktree", () => {
  for (const [what, content] of [
    ['with "type": "module"', '{ "name": "site", "type": "module" }'],
    ['that is not JSON', 'Set up the website'],
  ] as const) {
    it(
      `all answer with a package.json ${what}`,
      async () => {
        const result = await runWritingPackageJson(content);
        expect(result.packageJson).toBe(`${content}\n`);
        // The command as the installed daemon writes it: Node.js and the bundled script only.
        expect(result.hookCommand).toBe(
          shellCommand([process.execPath, script, 'hook', 'Stop', '--run', result.runId]),
        );
        expect(result.hooks).toEqual([
          ['PostToolUse', 0],
          ['PreToolUse', 0],
          ['PostToolUse', 0],
        ]);
        // `Stop` reached the daemon: the session idle, then the run ended with no reminder left.
        expect(result.states.map((state) => state.state).slice(-2)).toEqual(['idle', 'ended']);
        expect(result.states.at(-1)).toMatchObject({ reason: 'nudges_exhausted' });
      },
      TIMEOUT,
    );
  }
});

describe('the daemon run from its sources (the tests only)', () => {
  it("cannot start in a folder whose package.json is not JSON, because of tsx's --require preload", async () => {
    const folder = join(home.root, 'not-json');
    await mkdir(folder);
    await writeFile(join(folder, 'package.json'), 'Set up the website\n');
    const [node = '', ...args] = DAEMON_COMMAND;
    const sources = spawnSync(node, [...args, '--version'], { cwd: folder, env: home.env });
    expect(sources.status).not.toBe(0);
    expect(sources.stderr.toString()).toContain('ERR_INVALID_PACKAGE_CONFIG');
    // The installed one, from the same folder, starts.
    const bundled = spawnSync(process.execPath, [script, '--version'], {
      cwd: folder,
      env: home.env,
    });
    expect(bundled.stderr.toString()).toBe('');
    expect(bundled.status).toBe(0);
  });
});
