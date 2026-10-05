import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUILD_PLACEHOLDER, bundleDaemon, type DaemonBundle } from './bundle.js';

// The build identifier (05, section 2): the same for two builds of the same sources, different as
// soon as the bundled code changes, and independent of the time, the machine and the folder.

const root = resolve(import.meta.dirname, '..');
const manifest = `${JSON.stringify({ name: 'orchestrator-daemon', version: '0.4.0' }, null, 2)}\n`;

/** Changes the text of the source files matching `file` as esbuild reads them. */
function changing(file: RegExp, change: (text: string) => string): Plugin {
  return {
    name: 'change-source',
    setup(build) {
      build.onLoad({ filter: file }, async (args) => {
        const text = await readFile(args.path, 'utf8');
        const changed = change(text);
        if (changed === text) throw new Error(`nothing changed in ${args.path}`);
        return { contents: changed, loader: 'ts', resolveDir: dirname(args.path) };
      });
    },
  };
}

let first: DaemonBundle;

beforeAll(async () => {
  first = await bundleDaemon(root, manifest);
}, 60_000);

describe('the build identifier', { timeout: 60_000 }, () => {
  it('is 16 hexadecimal digits, written into the bundle in place of the placeholder', () => {
    expect(first.build).toMatch(/^[0-9a-f]{16}$/);
    expect(first.script).toContain(JSON.stringify(first.build));
    expect(first.script).not.toContain(BUILD_PLACEHOLDER);
  });

  it('is the same for a second build of the same sources, later', async () => {
    // A second apart, so a date in the bundle would show.
    await new Promise((done) => setTimeout(done, 1100));
    const second = await bundleDaemon(root, manifest);
    expect(second.build).toBe(first.build);
    expect(second.script).toBe(first.script);
  });

  it('holds nothing of the folder or the machine', () => {
    for (const input of Object.keys(first.metafile.inputs)) expect(isAbsolute(input)).toBe(false);
    expect(first.script).not.toContain(root);
    expect(first.script).not.toContain(resolve(root, '../..'));
    expect(first.script).not.toContain(homedir());
    expect(first.script).not.toContain(hostname());
  });

  it("changes when the daemon's own code changes", async () => {
    const changed = await bundleDaemon(root, manifest, [
      changing(/[/\\]apps[/\\]daemon[/\\]src[/\\]cli\.ts$/, (text) =>
        text.replace("runs the Orchestrator's agents", "runs the Orchestrator's agents!"),
      ),
    ]);
    expect(changed.build).not.toBe(first.build);
  });

  it('changes when bundled code of another package changes (the protocol)', async () => {
    const changed = await bundleDaemon(root, manifest, [
      changing(/[/\\]packages[/\\]protocol[/\\]src[/\\]version\.ts$/, (text) =>
        text.replace('PROTOCOL_VERSION = 2', 'PROTOCOL_VERSION = 3'),
      ),
    ]);
    expect(changed.build).not.toBe(first.build);
  });

  it('changes with the package manifest (its version)', async () => {
    const other = await bundleDaemon(root, manifest.replace('0.4.0', '0.4.1'));
    expect(other.build).not.toBe(first.build);
    expect(other.script.replaceAll(other.build, first.build)).toBe(first.script);
  });

  it('stays the same for a change that leaves the bundled code identical (a comment)', async () => {
    const commented = await bundleDaemon(root, manifest, [
      changing(/[/\\]apps[/\\]daemon[/\\]src[/\\]cli\.ts$/, (text) => `// A comment.\n${text}`),
    ]);
    expect(commented.build).toBe(first.build);
  });
});
