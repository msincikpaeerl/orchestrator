import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { daemonPackageFile } from '../src/downloads.js';
import { daemonInstallCommand } from '../src/machines/model.js';
import { SERVER_VERSION } from '../src/version.js';
import { startTestApp, type TestApp } from './helpers.js';

// The daemon package (lot 2 step E; 05, section 2; ADR 0026): built as `pnpm build` builds it,
// served by the server at /downloads/, installed with npm into a temporary prefix as the owner
// installs it (never globally, never in the home folder), then run.

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
  it('installs from the server with npm and runs', async () => {
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
    expect(stdout).toBe(`${SERVER_VERSION}\n`);
    const help = await run(join(prefix, 'bin', 'orchestrator-daemon'), ['help'], { env });
    expect(help.stdout).toContain('enroll <url> <code> [--ca-file <path>]');
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
