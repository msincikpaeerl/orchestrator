import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { DoctorCheck } from '@orchestrator/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config.js';
import { runDoctor, type DoctorEnvironment } from '../src/doctor.js';
import { unitText } from '../src/unit.js';
import { createTestHome, fakeExecutable, printing, type TestHome } from './testing.js';

// `doctor` against fake `git`, `tmux`, `claude`, `systemctl` and `loginctl` (05, section 8).

let home: TestHome;
let environment: DoctorEnvironment;
let etc: string;

beforeEach(async () => {
  home = await createTestHome();
  etc = join(home.root, 'etc-claude-code');
  environment = {
    paths: home.paths,
    toolPath: home.bin,
    toolPathLabel: "the daemon's PATH",
    systemPath: home.bin,
    nodePath: process.execPath,
    wsl: false,
    managedSettingsDirs: [etc],
    username: 'owner',
  };
});

afterEach(async () => {
  await home.remove();
});

async function checks(): Promise<Map<string, DoctorCheck>> {
  const result = await runDoctor(environment);
  return new Map(result.checks.map((check) => [check.name, check]));
}

async function grade(name: string): Promise<[DoctorCheck['status'], string]> {
  const check = (await checks()).get(name);
  if (!check) throw new Error(`no ${name} check`);
  return [check.status, check.message];
}

async function enroll(serverUrl = 'http://localhost:8080', ca: string | null = null) {
  await writeConfig(home.paths.config, {
    serverUrl,
    machineId: '6f1c1a52-6c5e-4a53-9d7a-0a1d8f0f5b11',
    machineName: 'Desktop',
    machineToken: `omt_${'b'.repeat(43)}`,
    ca,
  });
}

describe('tools against their minimums', () => {
  it.each([
    ['git', 'Git', null, 'error', /not found in the daemon's PATH/],
    ['git', 'Git', 'git version 2.39.5', 'error', /2\.39\.5 is older than 2\.40/],
    ['git', 'Git', 'git version 2.40.0', 'ok', /Git 2\.40\.0/],
    ['git', 'Git', 'git version 2.53.0', 'ok', /Git 2\.53\.0/],
    ['tmux', 'tmux', null, 'error', /not found/],
    ['tmux', 'tmux', 'tmux 3.1c', 'error', /3\.1 is older than 3\.2/],
    ['tmux', 'tmux', 'tmux 3.2a', 'ok', /tmux 3\.2/],
    ['tmux', 'tmux', 'tmux next-3.7', 'ok', /tmux 3\.7/],
    ['tmux', 'tmux', 'tmux master', 'error', /could not be read/],
    ['claude', 'Claude Code', null, 'error', /not found/],
    ['claude', 'Claude Code', '2.1.279 (Claude Code)', 'error', /older than 2\.1\.280/],
    ['claude', 'Claude Code', '2.1.280 (Claude Code)', 'ok', /2\.1\.280/],
    ['claude', 'Claude Code', '2.2.0 (Claude Code)', 'warning', /newer than .*still allowed/],
  ] as const)('%s printing %s gives %s', async (command, name, output, status, message) => {
    if (output !== null) await printing(home.bin, command, output);
    const [actual, text] = await grade(name);
    expect(actual).toBe(status);
    expect(text).toMatch(message);
  });

  it('reports the Claude Code version it read, for hello', async () => {
    await printing(home.bin, 'claude', '2.1.282 (Claude Code)');
    expect((await runDoctor(environment)).claudeCodeVersion).toBe('2.1.282');
    await rm(join(home.bin, 'claude'));
    expect((await runDoctor(environment)).claudeCodeVersion).toBeNull();
  });

  it('warns when node or npm is not in the PATH, and names that PATH', async () => {
    environment.toolPathLabel = "the service's PATH";
    expect(await grade('Node.js')).toEqual([
      'warning',
      expect.stringMatching(/service's PATH.*npm|node/),
    ]);
    expect((await grade('npm'))[0]).toBe('warning');
    await printing(home.bin, 'node', 'v24.21.0');
    await printing(home.bin, 'npm', '11.0.0');
    expect((await grade('Node.js'))[0]).toBe('ok');
    expect((await grade('npm'))[0]).toBe('ok');
  });
});

describe('Claude Code login', () => {
  it('is an error until the login file exists in the dedicated folder, never read', async () => {
    expect(await grade('Claude Code login')).toEqual([
      'error',
      expect.stringMatching(/orchestrator-daemon login/),
    ]);
    await mkdir(home.paths.claudeConfig, { recursive: true });
    // Unreadable: only its presence counts.
    await writeFile(join(home.paths.claudeConfig, '.credentials.json'), 'secret', { mode: 0o000 });
    expect((await grade('Claude Code login'))[0]).toBe('ok');
  });
});

describe('systemd, lingering and the service', () => {
  it('warns when systemd does not run or is missing', async () => {
    expect((await grade('systemd'))[0]).toBe('warning');
    await fakeExecutable(home.bin, 'systemctl', 'echo degraded; exit 1');
    expect(await grade('systemd')).toEqual(['warning', expect.stringContaining('degraded')]);
    await fakeExecutable(home.bin, 'systemctl', 'echo running');
    expect((await grade('systemd'))[0]).toBe('ok');
  });

  it("asks loginctl for the user's lingering", async () => {
    const log = join(home.root, 'loginctl.log');
    await fakeExecutable(home.bin, 'loginctl', `echo "$*" > '${log}'; echo no`);
    expect((await grade('Lingering'))[0]).toBe('warning');
    expect(await readFile(log, 'utf8')).toBe('show-user owner --property=Linger --value\n');
    await fakeExecutable(home.bin, 'loginctl', 'echo yes');
    expect((await grade('Lingering'))[0]).toBe('ok');
  });

  async function installUnit(node: string) {
    await mkdir(join(home.paths.unit, '..'), { recursive: true });
    await writeFile(
      home.paths.unit,
      unitText({ node, script: '/opt/daemon.js', path: home.bin, orchestratorHome: undefined }),
    );
  }

  it('warns when the service is not installed', async () => {
    expect(await grade('Service')).toEqual(['warning', expect.stringMatching(/install-service/)]);
  });

  it("is an error when the unit's node no longer exists", async () => {
    await installUnit(join(home.root, 'gone', 'node'));
    expect(await grade('Service')).toEqual([
      'error',
      expect.stringMatching(/no longer exists.*install-service/),
    ]);
  });

  it("is an error when the unit's node differs from the running one", async () => {
    const other = await printing(home.bin, 'other-node', '');
    await installUnit(other);
    expect(await grade('Service')).toEqual(['error', expect.stringContaining(process.execPath)]);
  });

  it('is ok when the unit starts the running node', async () => {
    await installUnit(process.execPath);
    expect((await grade('Service'))[0]).toBe('ok');
  });
});

describe('managed Claude Code settings', () => {
  it('is ok without them', async () => {
    expect((await grade('Managed Claude Code settings'))[0]).toBe('ok');
  });

  it.each(['managed-settings.json', 'managed-mcp.json', 'managed-settings.d/10-team.json'])(
    'is an error when %s exists',
    async (file) => {
      await mkdir(join(etc, 'managed-settings.d'), { recursive: true });
      await writeFile(join(etc, file), '{}');
      const [status, message] = await grade('Managed Claude Code settings');
      expect(status).toBe('error');
      expect(message).toContain(etc);
    },
  );

  it('ignores an empty drop-in folder', async () => {
    await mkdir(join(etc, 'managed-settings.d'), { recursive: true });
    expect((await grade('Managed Claude Code settings'))[0]).toBe('ok');
  });
});

describe('enrollment, WSL and the documentation links', () => {
  it('is an error when not enrolled, and has no server checks', async () => {
    const all = await checks();
    expect(all.get('Enrollment')?.status).toBe('error');
    expect(all.has('Server address')).toBe(false);
  });

  it('is an error when config.json is damaged', async () => {
    await mkdir(home.paths.home, { recursive: true });
    await writeFile(home.paths.config, '{"serverUrl": 1}');
    expect(await grade('Enrollment')).toEqual(['error', expect.stringMatching(/damaged/)]);
  });

  it('reports http on this computer', async () => {
    await enroll();
    expect(await grade('Server address')).toEqual([
      'ok',
      'http://localhost:8080: this computer only (http)',
    ]);
    expect((await checks()).has('Server certificate')).toBe(false);
  });

  it('has no WSL checks on Linux', async () => {
    const all = await checks();
    expect(all.has('WSL')).toBe(false);
    expect(all.has('WSL idle timeout')).toBe(false);
  });

  it('prints the WSL idle timeout as "check this yourself" with the Help link', async () => {
    environment.wsl = true;
    await enroll();
    const all = await checks();
    expect(all.get('WSL')?.status).toBe('ok');
    expect(all.get('WSL idle timeout')).toEqual({
      name: 'WSL idle timeout',
      status: 'check_yourself',
      message: expect.stringContaining('instanceIdleTimeout=-1') as string,
      link: 'http://localhost:8080/help/machines#keep-wsl-running',
    });
  });
});

describe('the server certificate (05, section 3.2)', () => {
  let pki: string;
  let ca: string;

  /** A certificate for localhost signed by the test authority, valid for `days`. */
  function certificate(days: number): { key: string; cert: string } {
    const name = `server-${String(days)}`;
    const key = join(pki, `${name}.key`);
    execFileSync(
      'openssl',
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        join(pki, `${name}.csr`),
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'openssl',
      [
        'x509',
        '-req',
        '-in',
        join(pki, `${name}.csr`),
        '-CA',
        join(pki, 'ca.pem'),
        '-CAkey',
        join(pki, 'ca.key'),
        '-CAcreateserial',
        '-days',
        String(days),
        '-out',
        join(pki, `${name}.pem`),
        '-extfile',
        join(pki, 'san.ext'),
      ],
      { stdio: 'ignore' },
    );
    return {
      key: execFileSync('cat', [key], { encoding: 'utf8' }),
      cert: execFileSync('cat', [join(pki, `${name}.pem`)], { encoding: 'utf8' }),
    };
  }

  async function serve(days: number): Promise<{ url: string; server: Server }> {
    const server = createServer(certificate(days), (_request, response) => response.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `https://localhost:${String((server.address() as AddressInfo).port)}`, server };
  }

  beforeAll(async () => {
    const folder = await createTestHome();
    pki = folder.root;
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(pki, 'ca.key'),
        '-out',
        join(pki, 'ca.pem'),
        '-days',
        '30',
        '-subj',
        '/CN=Orchestrator test authority',
      ],
      { stdio: 'ignore' },
    );
    await writeFile(join(pki, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    ca = await readFile(join(pki, 'ca.pem'), 'utf8');
  });

  afterAll(async () => {
    await rm(pki, { recursive: true, force: true });
  });

  it('is an error when the certificate is not trusted, pointing to --ca-file', async () => {
    const { url, server } = await serve(60);
    try {
      await enroll(url, null);
      expect(await grade('Server address')).toEqual(['ok', `${url}: encrypted (https)`]);
      expect(await grade('Server certificate')).toEqual([
        'error',
        expect.stringMatching(/Not trusted.*--ca-file/),
      ]);
    } finally {
      server.close();
    }
  });

  it('is ok with the authority given at enrollment, with the expiry date', async () => {
    const { url, server } = await serve(60);
    try {
      await enroll(url, ca);
      expect(await grade('Server certificate')).toEqual([
        'ok',
        expect.stringMatching(/^Valid until \d{4}-\d\d-\d\d$/),
      ]);
    } finally {
      server.close();
    }
  });

  it('warns when the certificate expires within 14 days', async () => {
    const { url, server } = await serve(10);
    try {
      await enroll(url, ca);
      expect(await grade('Server certificate')).toEqual([
        'warning',
        expect.stringMatching(/expires on/),
      ]);
    } finally {
      server.close();
    }
  });

  it('warns when the server cannot be reached', async () => {
    const { url, server } = await serve(60);
    server.close();
    await enroll(url, ca);
    expect(await grade('Server certificate')).toEqual([
      'warning',
      expect.stringMatching(/cannot be reached/),
    ]);
  });
});
