import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PLAYWRIGHT_CHROMIUM_REVISION, PLAYWRIGHT_VERSION } from '@orchestrator/protocol';
import { describe, expect, it } from 'vitest';
import { headlessShellPath, LIBRARIES_COMMAND, missingLibraries } from './browsers.js';
import { PLAYWRIGHT_LOCK, PLAYWRIGHT_PACKAGE } from './playwright-install.js';

const require = createRequire(import.meta.url);

describe('the pinned Playwright version', () => {
  it("is the devDependency's, whose headless Chromium has the pinned revision", () => {
    const manifest = require.resolve('playwright-core/package.json');
    const read = (file: string): unknown =>
      JSON.parse(readFileSync(join(dirname(manifest), file), 'utf8'));
    expect((read('package.json') as { version: string }).version).toBe(PLAYWRIGHT_VERSION);
    // Not exported by the package: read next to its package.json.
    const browsers = read('browsers.json') as { browsers: { name: string; revision: string }[] };
    const shell = browsers.browsers.find((browser) => browser.name === 'chromium-headless-shell');
    expect(shell?.revision).toBe(PLAYWRIGHT_CHROMIUM_REVISION);
  });

  it("is the daemon's install's, whose playwright-core is the devDependency's own package", () => {
    expect(PLAYWRIGHT_PACKAGE.dependencies.playwright).toBe(PLAYWRIGHT_VERSION);
    const { packages } = PLAYWRIGHT_LOCK;
    expect(packages[''].dependencies.playwright).toBe(PLAYWRIGHT_VERSION);
    expect(packages['node_modules/playwright'].version).toBe(PLAYWRIGHT_VERSION);
    expect(packages['node_modules/playwright'].dependencies['playwright-core']).toBe(
      PLAYWRIGHT_VERSION,
    );
    const core = packages['node_modules/playwright-core'];
    expect(core.version).toBe(PLAYWRIGHT_VERSION);
    // The same published files as the package the pin test above reads.
    const pnpmLock = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'pnpm-lock.yaml'),
      'utf8',
    );
    expect(pnpmLock).toContain(
      `  playwright-core@${PLAYWRIGHT_VERSION}:\n    resolution: {integrity: ${core.integrity}}`,
    );
  });

  it('is the one Help > Machines gives in the libraries command', () => {
    const help = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'user', 'machines.md'),
      'utf8',
    );
    expect(help).toContain(LIBRARIES_COMMAND);
  });
});

describe('the headless shell', () => {
  it('is where Playwright puts it for each processor, and nowhere on others', () => {
    expect(headlessShellPath('/b', 'x64')).toBe(
      `/b/chromium_headless_shell-${PLAYWRIGHT_CHROMIUM_REVISION}/chrome-headless-shell-linux64/chrome-headless-shell`,
    );
    expect(headlessShellPath('/b', 'arm64')).toBe(
      `/b/chromium_headless_shell-${PLAYWRIGHT_CHROMIUM_REVISION}/chrome-headless-shell-linux-arm64/chrome-headless-shell`,
    );
    expect(headlessShellPath('/b', 'ia32')).toBeNull();
  });
});

describe("ldd's missing libraries", () => {
  it('are the "not found" lines, each once', () => {
    const output = [
      '\tlinux-vdso.so.1 (0x00007ffd)',
      '\tlibnss3.so => not found',
      '\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f)',
      '\tlibasound.so.2 => not found',
      '\tlibnss3.so => not found',
    ].join('\n');
    expect(missingLibraries(output)).toEqual(['libnss3.so', 'libasound.so.2']);
    expect(missingLibraries('\tlibc.so.6 => /lib/libc.so.6 (0x1)')).toEqual([]);
  });
});
