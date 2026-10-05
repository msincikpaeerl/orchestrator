import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DAEMON_PACKAGE_NAME,
  EnrollmentResponse,
  NeedsYouResponse,
  PROTOCOL_VERSION,
  VersionResponse,
  daemonUpdateCommands,
} from '@orchestrator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daemonPackageFile } from '../src/downloads.js';
import { daemonInstallCommand } from '../src/machines/model.js';
import { SERVER_VERSION } from '../src/version.js';
import { enrollToken, ScriptedDaemon } from './daemon-client.js';
import { createOwner, startTestApp, type TestApp } from './helpers.js';

// The daemon package (lot 2 step E; 05, section 2; ADR 0026): built as `pnpm build` builds it,
// served by the server at /downloads/, installed with npm into a temporary prefix as the owner
// installs it (never globally, never in the home folder), then run. Its build identifier is the
// one the server reports, and its name the one the update commands use (lot 3 step B).

const run = promisify(execFile);
const daemonRoot = fileURLToPath(
  new URL('.', import.meta.resolve('@orchestrator/daemon/package.json')),
);
const tsxCli = createRequire(join(daemonRoot, 'package.json')).resolve('tsx/cli');

let folder: string;
let t: TestApp | undefined;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'orchestrator-daemon-package-'));
  await run(process.execPath, [
    tsxCli,
    '--conditions=source',
    join(daemonRoot, 'scripts', 'pack.ts'),
    '--out',
    join(folder, 'dist'),
  ]);
  t = await startTestApp({ listen: true, daemonPackageDir: join(folder, 'dist') });
}, 60_000);

afterAll(async () => {
  await t?.close();
  await rm(folder, { recursive: true, force: true });
});

describe('the daemon package', { timeout: 120_000 }, () => {
  it('installs from the server with npm and runs, with the build the server reports', async () => {
    const prefix = join(folder, 'prefix');
    await writeFile(join(folder, 'npmrc'), '');
    await writeFile(join(folder, 'npmrc-global'), '');
    // npm's cache, logs and settings stay in the test folder.
    const env = {
      PATH: [join(prefix, 'bin'), dirname(process.execPath)].join(delimiter),
      HOME: folder,
      npm_config_cache: join(folder, 'npm-cache'),
      npm_config_userconfig: join(folder, 'npmrc'),
      npm_config_globalconfig: join(folder, 'npmrc-global'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };
    // The command the Orchestrator shows, pointed at this test server.
    const shown = daemonInstallCommand('http://localhost:8080');
    const url = `${String(t?.url)}/downloads/${daemonPackageFile()}`;
    expect(shown).toBe(`npm install -g http://localhost:8080/downloads/${daemonPackageFile()}`);
    await run(join(dirname(process.execPath), 'npm'), ['install', '-g', '--prefix', prefix, url], {
      env,
    });
    const { stdout } = await run(join(prefix, 'bin', 'orchestrator-daemon'), ['--version'], {
      env,
    });
    const version = VersionResponse.parse(await (await fetch(`${String(t?.url)}/version`)).json());
    expect(version.daemonBuild).toMatch(/^[0-9a-f]{16}$/);
    expect(stdout).toBe(`${SERVER_VERSION} (build ${String(version.daemonBuild)})\n`);
    const help = await run(join(prefix, 'bin', 'orchestrator-daemon'), ['help'], { env });
    expect(help.stdout).toContain('enroll <url> <code> [--ca-file <path>]');
  });

  it('is installed under the name the update commands use, in Help and in "Needs you"', async () => {
    // The name in the package the server serves, not the workspace's `@orchestrator/daemon`.
    const { stdout } = await run('tar', [
      '--extract',
      '--gzip',
      '--to-stdout',
      '--file',
      join(folder, 'dist', daemonPackageFile()),
      'package/package.json',
    ]);
    const served = (JSON.parse(stdout) as { name: string }).name;
    expect(served).toBe(DAEMON_PACKAGE_NAME);

    // Help > Machines > "Update the daemon".
    const help = await readFile(
      fileURLToPath(new URL('../../../docs/user/machines.md', import.meta.url)),
      'utf8',
    );
    const section = /\n## Update the daemon\n([\s\S]*?)\n## /.exec(help)?.[1] ?? '';
    const block = /```sh\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
    expect(block.split('\n')).toEqual(daemonUpdateCommands('<server URL>', '<version>'));
    expect(block).toContain(`npm uninstall -g ${served}\n`);
    expect(block).toContain(`/downloads/${served}-<version>.tgz`);

    // The "Needs you" item of a daemon of the previous protocol, as a 0.3.0 daemon says hello.
    const cookie = t ? await createOwner(t.app) : '';
    const inject = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const answer = await t?.app.inject({ method, url, headers: { cookie }, payload });
      return answer?.json<unknown>();
    };
    const account = (await inject('POST', '/api/accounts', { label: 'Max', plan: 'max_5x' })) as {
      id: string;
    };
    const created = EnrollmentResponse.parse(
      await inject('POST', '/api/machines', { name: 'Laptop', accountId: account.id }),
    );
    const daemon = await ScriptedDaemon.connect(
      String(t?.url),
      await enrollToken(String(t?.url), created.enrollment.code),
    );
    try {
      await daemon.hello({ protocolVersion: PROTOCOL_VERSION - 1, daemonVersion: '0.3.0' });
      const { items } = NeedsYouResponse.parse(await inject('GET', '/api/needs-you'));
      const item = items.find((each) => each.type === 'daemon_outdated');
      expect(item?.updateCommands).toEqual(
        daemonUpdateCommands('http://localhost:8080', SERVER_VERSION),
      );
      expect(item?.updateCommands).toContain(`npm uninstall -g ${served}`);
      expect(item?.updateCommands).toContain(
        `npm install -g --prefer-online http://localhost:8080/downloads/${daemonPackageFile()}`,
      );
    } finally {
      await daemon.close();
    }
  });

  it("serves only the daemon of the server's own version", async () => {
    const other = await fetch(`${String(t?.url)}/downloads/orchestrator-daemon-0.0.1.tgz`);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: { code: 'not_found' } });
    const served = await fetch(`${String(t?.url)}/downloads/${daemonPackageFile()}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/gzip');
    // Read to the end: an unread body keeps the connection busy, and the server's close waits.
    expect((await served.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('answers not found when the package was not built', async () => {
    const empty = await startTestApp({ daemonPackageDir: join(folder, 'nothing') });
    try {
      const response = await empty.app.inject({ url: `/downloads/${daemonPackageFile()}` });
      expect(response.statusCode).toBe(404);
      expect(empty.logs.text).toContain('daemon package not built');
    } finally {
      await empty.close();
    }
  });
});
