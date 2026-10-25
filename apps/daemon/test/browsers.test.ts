import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BROWSER_TESTS_CAPABILITY,
  PLAYWRIGHT_CHROMIUM_REVISION,
  PLAYWRIGHT_VERSION,
  type DoctorCheck,
} from '@orchestrator/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { headlessShellPath, LIBRARIES_COMMAND } from '../src/browsers.js';
import { writeConfig } from '../src/config.js';
import { runDoctor } from '../src/doctor.js';
import { ScriptedServer } from './scripted-server.js';
import {
  createTestHome,
  fakeExecutable,
  healthyTools,
  linkSystemTool,
  printing,
  runDaemon,
  spawnDaemon,
  stopHomeProcesses,
  waitFor,
  type TestHome,
} from './testing.js';

// Browser tests on the machine (05, sections 2 and 8; lot 5 step C1): `orchestrator-daemon
// browsers` and `doctor`'s **Browser tests** check against a fake `npx`, a fake Chromium and a
// fake `ldd`. No real browser is downloaded or started.

const TIMEOUT = 60_000;

let home: TestHome;
/** What the fake `npx` copies into `PLAYWRIGHT_BROWSERS_PATH`: the pinned headless shell. */
let download: string;
let npxLog: string;

const PAGE = '<html><head></head><body></body></html>';
const LDD_FOUND = '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)';
const LDD_MISSING = ['\tlibnss3.so => not found', '\tlibasound.so.2 => not found'].join('\n');

beforeEach(async () => {
  home = await createTestHome();
  download = join(home.root, 'download');
  npxLog = join(home.root, 'npx.txt');
  await linkSystemTool(home.bin, 'cp');
  await fakeChromium(`printf '%s\\n' '${PAGE}'`);
  await printing(home.bin, 'ldd', LDD_FOUND);
});

afterEach(async () => {
  await stopHomeProcesses(home);
  await home.remove();
});

/** The download's headless shell, running `script`, as Playwright unpacks it. */
async function fakeChromium(script: string): Promise<void> {
  const shell = headlessShellPath(download) ?? '';
  await mkdir(join(shell, '..'), { recursive: true });
  await fakeExecutable(join(shell, '..'), 'chrome-headless-shell', script);
  await writeFile(
    join(
      download,
      `chromium_headless_shell-${PLAYWRIGHT_CHROMIUM_REVISION}`,
      'INSTALLATION_COMPLETE',
    ),
    '',
  );
}

/** A fake `npx` recording its arguments and variable, then copying the download or failing. */
async function fakeNpx(outcome: 'downloads' | 'refused'): Promise<void> {
  await fakeExecutable(
    home.bin,
    'npx',
    [
      `echo "$* PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH" >> '${npxLog}'`,
      outcome === 'downloads'
        ? `cp -R '${download}/.' "$PLAYWRIGHT_BROWSERS_PATH/"`
        : "echo 'Error: getaddrinfo ENOTFOUND cdn.playwright.dev' >&2; exit 1",
    ].join('\n'),
  );
}

/** The test home's PATH without Node.js's folder, whose own `npx` would be found otherwise. */
const withoutNode = () => ({ ...home.env, PATH: home.bin });

describe('orchestrator-daemon browsers', () => {
  it(
    "downloads the pinned version's Chromium into the daemon's folder and checks it",
    async () => {
      await fakeNpx('downloads');
      const result = await runDaemon(['browsers'], withoutNode());
      expect(result.code).toBe(0);
      expect(await readFile(npxLog, 'utf8')).toBe(
        `--yes playwright@${PLAYWRIGHT_VERSION} install chromium PLAYWRIGHT_BROWSERS_PATH=${home.paths.browsers}\n`,
      );
      expect(result.stdout).toContain(
        `Downloading the Chromium of Playwright ${PLAYWRIGHT_VERSION}`,
      );
      expect(result.stdout).toContain(`capability ${BROWSER_TESTS_CAPABILITY}`);
      expect(result.stdout).toContain('systemctl --user restart orchestrator-daemon');
      // Only the owner's user reaches the folder.
      expect((await stat(home.paths.browsers)).mode & 0o777).toBe(0o700);
    },
    TIMEOUT,
  );

  it(
    'says when npx is not found, and downloads nothing',
    async () => {
      const result = await runDaemon(['browsers'], withoutNode());
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("npx not found in this terminal's PATH");
      await expect(stat(home.paths.browsers)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    'says when the download is refused',
    async () => {
      await fakeNpx('refused');
      const result = await runDaemon(['browsers'], withoutNode());
      expect(result.code).toBe(1);
      // Playwright's own words reach the terminal, then the daemon's.
      expect(result.stderr).toContain('ENOTFOUND cdn.playwright.dev');
      expect(result.stdout).toContain('The download failed (npx ended with exit code 1)');
      expect(result.stdout).toContain("check this computer's internet connection");
    },
    TIMEOUT,
  );

  it(
    'names the missing system libraries with the command installing them',
    async () => {
      await fakeNpx('downloads');
      await printing(home.bin, 'ldd', LDD_MISSING);
      const result = await runDaemon(['browsers'], withoutNode());
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('System libraries missing: libnss3.so, libasound.so.2.');
      expect(result.stdout).toContain(LIBRARIES_COMMAND);
      expect(result.stdout).not.toContain('restart');
    },
    TIMEOUT,
  );

  it(
    'says when Chromium does not start, with its last words',
    async () => {
      await fakeChromium(
        "echo 'chrome-headless-shell: error while loading shared libraries: libgbm.so.1' >&2; exit 127",
      );
      await fakeNpx('downloads');
      const result = await runDaemon(['browsers'], withoutNode());
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('Chromium does not start headless');
      expect(result.stdout).toContain('libgbm.so.1');
      expect(result.stdout).toContain(LIBRARIES_COMMAND);
    },
    TIMEOUT,
  );

  it(
    'says when the download ended without the pinned revision',
    async () => {
      await fakeExecutable(home.bin, 'npx', 'exit 0');
      const result = await runDaemon(['browsers'], withoutNode());
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        `the folder holds no Chromium ${PLAYWRIGHT_CHROMIUM_REVISION}`,
      );
    },
    TIMEOUT,
  );
});

describe("doctor's Browser tests check", () => {
  async function browserCheck(): Promise<DoctorCheck | undefined> {
    const result = await runDoctor({
      paths: home.paths,
      toolPath: home.bin,
      toolPathLabel: "the daemon's PATH",
      systemPath: home.bin,
      nodePath: process.execPath,
      wsl: false,
      managedSettingsDirs: [],
      username: 'owner',
    });
    const check = result.checks.find((each) => each.name === 'Browser tests');
    expect(result.browserTests).toBe(check?.status === 'ok');
    return check;
  }

  /** What `orchestrator-daemon browsers` leaves in the daemon's folder. */
  const install = () => cp(download, home.paths.browsers, { recursive: true });

  it('warns, never errs, while nothing is set up, with the link to Help', async () => {
    await writeConfig(home.paths.config, {
      serverUrl: 'http://localhost:8080',
      machineId: randomUUID(),
      machineName: 'Desktop',
      machineToken: `omt_${'b'.repeat(43)}`,
      ca: null,
    });
    expect(await browserCheck()).toEqual({
      name: 'Browser tests',
      status: 'warning',
      message:
        'Not set up: type "orchestrator-daemon browsers" so agents can run browser tests on this machine.',
      link: 'http://localhost:8080/help/machines#browser-tests',
    });
  });

  it('warns with the missing libraries and the command installing them', async () => {
    await install();
    await printing(home.bin, 'ldd', LDD_MISSING);
    const check = await browserCheck();
    expect(check?.status).toBe('warning');
    expect(check?.message).toBe(
      `System libraries missing: libnss3.so, libasound.so.2. Install them once with: ${LIBRARIES_COMMAND}`,
    );
  });

  it('warns when Chromium does not start headless', async () => {
    await fakeChromium("echo 'Trace/breakpoint trap' >&2; exit 133");
    await install();
    const check = await browserCheck();
    expect(check?.status).toBe('warning');
    expect(check?.message).toMatch(/^Chromium does not start headless \(Trace\/breakpoint trap\)/);
  });

  it('is ok when Chromium prints a blank page, run without its sandbox', async () => {
    const args = join(home.root, 'chromium-args.txt');
    await fakeChromium(`echo "$*" > '${args}'\nprintf '%s\\n' '${PAGE}'`);
    await install();
    const check = await browserCheck();
    expect(check?.status).toBe('ok');
    expect(check?.message).toContain(`Chromium ${PLAYWRIGHT_CHROMIUM_REVISION}`);
    expect(await readFile(args, 'utf8')).toBe('--no-sandbox --dump-dom about:blank\n');
  });

  describe('in hello', () => {
    let server: ScriptedServer;

    beforeEach(async () => {
      await healthyTools(home);
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
      await stopHomeProcesses(home);
      await server.close();
    });

    /** The `hello` of a newly started daemon, which is then stopped. */
    async function hello() {
      const count = server.hellos().length;
      const daemon = spawnDaemon(['start'], home.env);
      await waitFor(() => server.hellos().length > count, 30_000, 'hello');
      const payload = server.hellos()[count]?.payload;
      await daemon.stop('SIGTERM');
      return payload;
    }

    it(
      'reports browser-tests once the check passes, and not before',
      async () => {
        const before = await hello();
        expect(before?.capabilities).not.toContain(BROWSER_TESTS_CAPABILITY);
        expect(before?.doctor.find((check) => check.name === 'Browser tests')).toMatchObject({
          status: 'warning',
          link: `${server.url}/help/machines#browser-tests`,
        });

        await install();
        const after = await hello();
        expect(after?.capabilities).toContain(BROWSER_TESTS_CAPABILITY);
        expect(after?.doctor.find((check) => check.name === 'Browser tests')?.status).toBe('ok');
      },
      TIMEOUT * 2,
    );
  });
});
