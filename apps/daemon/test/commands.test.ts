import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ControlStatus } from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';
import { serveControl } from '../src/control.js';
import { EXIT_REFUSED } from '../src/errors.js';
import { DAEMON_UNREACHABLE } from '../src/run-socket.js';
import { parseUnit } from '../src/unit.js';
import {
  DAEMON_COMMAND,
  createTestHome,
  fakeExecutable,
  recording,
  runDaemon,
  waitFor,
  type TestHome,
} from './testing.js';

// The `orchestrator-daemon` commands run as the owner types them, with fake `systemctl`,
// `loginctl`, `tmux` and `claude`.

let home: TestHome;
beforeEach(async () => {
  home = await createTestHome();
});
afterEach(async () => {
  await home.remove();
});

const RUN_ID = '0b6f2f7e-3c1a-4d5e-9f8a-1b2c3d4e5f60';

async function enroll() {
  await writeConfig(home.paths.config, {
    serverUrl: 'http://localhost:8080',
    machineId: '6f1c1a52-6c5e-4a53-9d7a-0a1d8f0f5b11',
    machineName: 'Desktop',
    machineToken: `omt_${'c'.repeat(43)}`,
    ca: null,
  });
}

function terminalDaemon(): ControlStatus {
  return {
    type: 'status',
    mode: 'terminal',
    pid: 4321,
    startedAt: new Date().toISOString(),
    serverUrl: 'http://localhost:8080',
    machineName: 'Desktop',
    connection: 'connected',
    connectedAt: null,
    lastError: null,
    daemonVersion: '0.2.0',
    protocolVersion: 1,
    claudeCodeVersion: null,
    os: 'linux',
    capabilities: [],
    processScopes: null,
    runs: [],
  };
}

describe('--version and help', () => {
  it('prints the version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(await runDaemon(['--version'], home.env)).toMatchObject({
      code: 0,
      stdout: `${pkg.version}\n`,
    });
  });

  it('refuses an unknown command or option with the usage', async () => {
    const unknown = await runDaemon(['fly'], home.env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown command "fly"[\s\S]*Commands:/);
    const option = await runDaemon(['status', '--loud'], home.env);
    expect(option.code).toBe(1);
    expect(option.stderr).toMatch(/Commands:/);
  });
});

describe('enroll', () => {
  it('refuses plain http to another computer, saying why', async () => {
    const result = await runDaemon(['enroll', 'http://192.168.1.20:8080', 'ABCD'], home.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/must start with https:\/\/.*GitHub token/);
    await expect(stat(home.paths.config)).rejects.toThrow();
  });

  it('refuses a --ca-file that is not a certificate', async () => {
    const file = join(home.root, 'ca.pem');
    await writeFile(file, 'hello');
    const result = await runDaemon(
      ['enroll', 'https://orchestrator.lan', '0123456789ABCDEFGHJKMNPQ', '--ca-file', file],
      home.env,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not a PEM certificate/);
  });
});

describe('start', () => {
  it('refuses when the machine is not enrolled', async () => {
    const result = await runDaemon(['start'], home.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/not enrolled yet/);
  });

  it('refuses when another daemon answers on the control socket', async () => {
    await enroll();
    const server = await serveControl(home.paths.controlSocket, terminalDaemon);
    try {
      const result = await runDaemon(['start', '--service'], home.env);
      expect(result.code).toBe(EXIT_REFUSED);
      expect(result.stderr).toMatch(/already running in a terminal \(process 4321\)/);
    } finally {
      server.close();
    }
  });
});

describe('install-service', () => {
  let systemctlLog: string;
  let loginctlLog: string;

  beforeEach(async () => {
    systemctlLog = join(home.root, 'systemctl.log');
    loginctlLog = join(home.root, 'loginctl.log');
    await recording(home.bin, 'systemctl', systemctlLog);
    await recording(home.bin, 'loginctl', loginctlLog);
  });

  it('writes the unit with absolute paths and the filtered PATH, enables and starts it, with lingering', async () => {
    await enroll();
    const env = {
      ...home.env,
      WSL_DISTRO_NAME: 'Ubuntu',
      PATH: `${home.env.PATH ?? ''}::.:relative/bin:/mnt/c/Windows/system32`,
    };
    const result = await runDaemon(['install-service'], env);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const text = await readFile(home.paths.unit, 'utf8');
    const unit = parseUnit(text);
    expect(unit.node).toBe(process.execPath);
    expect(unit.path).toBe(home.env.PATH);
    expect(text).toMatch(/ExecStart="[^"]+" "\/[^"]+\/src\/cli\.ts" start --service/);
    expect(text).toContain(`Environment="ORCHESTRATOR_HOME=${home.paths.home}"`);
    expect(text).toContain('RestartPreventExitStatus=78');
    expect(result.stdout).toContain(`  ${home.env.PATH ?? ''}\n`);
    expect(await readFile(systemctlLog, 'utf8')).toBe(
      '--user daemon-reload\n--user enable orchestrator-daemon\n--user restart orchestrator-daemon\n',
    );
    expect(await readFile(loginctlLog, 'utf8')).toBe('enable-linger\n');
  });

  it('says how to turn lingering on when loginctl refuses', async () => {
    await enroll();
    await fakeExecutable(home.bin, 'loginctl', 'exit 1');
    const result = await runDaemon(['install-service'], home.env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('sudo loginctl enable-linger');
  });

  it('stops with the systemd help when systemctl fails', async () => {
    await enroll();
    await fakeExecutable(home.bin, 'systemctl', 'echo "Failed to connect to bus" >&2; exit 1');
    const result = await runDaemon(['install-service'], home.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Failed to connect to bus.*Turn on systemd on WSL/);
  });

  it('refuses before enrollment, and while a daemon runs in a terminal', async () => {
    expect((await runDaemon(['install-service'], home.env)).stderr).toMatch(/not enrolled/);
    await enroll();
    const server = await serveControl(home.paths.controlSocket, terminalDaemon);
    try {
      const result = await runDaemon(['install-service'], home.env);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/running in a terminal.*Ctrl\+C/);
      await expect(stat(home.paths.unit)).rejects.toThrow();
    } finally {
      server.close();
    }
  });
});

describe('attach', () => {
  let log: string;

  beforeEach(async () => {
    log = join(home.root, 'tmux.log');
    await fakeExecutable(home.bin, 'tmux', `echo "$* TMUX=$TMUX" >> '${log}'`);
  });

  it("watches read-only on the daemon's tmux server, without the owner's TMUX", async () => {
    const result = await runDaemon(['attach', RUN_ID], {
      ...home.env,
      TMUX: '/tmp/tmux-1000/default,1,0',
    });
    expect(result.code).toBe(0);
    expect(await readFile(log, 'utf8')).toBe(
      `-L orchestrator has-session -t =orch-${RUN_ID} TMUX=\n-L orchestrator attach-session -r -t =orch-${RUN_ID} TMUX=\n`,
    );
  });

  it('types in the session with --write only after "yes", with a warning', async () => {
    const refused = await runDaemon(['attach', RUN_ID, '--write'], home.env, 'no\n');
    expect(refused.code).toBe(1);
    expect(refused.stdout).toMatch(/interferes with its work[\s\S]*Not attached/);
    expect(await readFile(log, 'utf8')).not.toContain('attach-session');

    const accepted = await runDaemon(['attach', RUN_ID, '--write'], home.env, 'yes\n');
    expect(accepted.code).toBe(0);
    expect(await readFile(log, 'utf8')).toContain(
      `-L orchestrator attach-session -t =orch-${RUN_ID} TMUX=\n`,
    );
  });

  it('says when the run has no live session, and refuses a wrong id', async () => {
    await fakeExecutable(home.bin, 'tmux', 'exit 1');
    expect((await runDaemon(['attach', RUN_ID], home.env)).stderr).toMatch(
      /No live session for run/,
    );
    expect((await runDaemon(['attach', 'abc'], home.env)).stderr).toMatch(/not a run id/);
  });
});

describe('login', () => {
  it('opens claude with the dedicated configuration folder', async () => {
    const log = join(home.root, 'claude.log');
    await fakeExecutable(home.bin, 'claude', `echo "$CLAUDE_CONFIG_DIR $*" > '${log}'`);
    const result = await runDaemon(['login'], home.env);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Log in with the Claude account/);
    expect(await readFile(log, 'utf8')).toBe(`${home.paths.claudeConfig} \n`);
    expect((await stat(home.paths.home)).mode & 0o777).toBe(0o700);
    expect((await stat(home.paths.claudeConfig)).mode & 0o777).toBe(0o700);
  });

  it('says what to install when claude is missing', async () => {
    const result = await runDaemon(['login'], home.env);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Claude Code \(claude\) is not installed/);
  });
});

describe('hook and status-line (internal)', () => {
  it('denies a tool call when the daemon cannot be reached, and lets other events pass', async () => {
    const pre = await runDaemon(['hook', 'PreToolUse', '--run', RUN_ID], home.env, '{}');
    expect(pre.code).toBe(0);
    expect(JSON.parse(pre.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Orchestrator daemon unavailable',
      },
    });
    for (const args of [
      ['hook', 'Stop', '--run', RUN_ID],
      ['status-line', '--run', RUN_ID],
    ]) {
      expect(await runDaemon(args, home.env, '{}')).toMatchObject({ code: 0, stdout: '' });
    }
  });

  it('answers UNAVAILABLE from the MCP relay when the daemon cannot be reached', async () => {
    const [command = '', ...args] = DAEMON_COMMAND;
    const relay = spawn(command, [...args, 'mcp', '--run', RUN_ID], { env: home.env });
    const answers: { id?: number; result?: unknown }[] = [];
    createInterface({ input: relay.stdout }).on('line', (line) => {
      answers.push(JSON.parse(line) as { id?: number; result?: unknown });
    });
    const write = (message: unknown) => relay.stdin.write(`${JSON.stringify(message)}\n`);
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ticket_get', arguments: {} },
    });
    await waitFor(() => answers.some((answer) => answer.id === 2), 20_000, 'the tool result');
    relay.stdin.end();
    expect(answers.find((answer) => answer.id === 2)?.result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(DAEMON_UNREACHABLE.ok ? {} : DAEMON_UNREACHABLE.error),
        },
      ],
      isError: true,
    });
    expect(await new Promise((resolve) => relay.on('close', resolve))).toBe(0);
    expect((await runDaemon(['mcp', '--run', 'x'], home.env)).code).toBe(1);
  });

  it('refuses an unknown event or run id', async () => {
    expect((await runDaemon(['hook', 'Other', '--run', RUN_ID], home.env, '{}')).code).toBe(1);
    expect((await runDaemon(['hook', 'Stop', '--run', 'x'], home.env, '{}')).code).toBe(1);
  });
});
