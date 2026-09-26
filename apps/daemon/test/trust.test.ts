import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrustRegistry } from '../src/trust.js';

// Workspace trust in the dedicated configuration (05, section 4.2.1): atomic, serialised writes,
// made while no session is starting, and checked again before each launch.

let folder: string;
let file: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'od-trust-'));
  file = join(folder, '.claude.json');
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

const read = async () =>
  JSON.parse(await readFile(file, 'utf8')) as {
    projects: Record<string, { hasTrustDialogAccepted?: boolean; lastCost?: number }>;
    writerCount?: number;
  };

/**
 * Another process standing for Claude Code: it keeps rewriting the file atomically (read, change
 * its own key, write a temporary file, rename) until `stop` exists.
 */
function outsideWriter(stop: string) {
  const script = `
    const fs = require('fs');
    const [file, stop] = process.argv.slice(1);
    let count = 0;
    while (!fs.existsSync(stop)) {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.writerCount = ++count;
      fs.writeFileSync(file + '.writer.tmp', JSON.stringify(config, null, 2));
      fs.renameSync(file + '.writer.tmp', file);
    }`;
  const child = spawn(process.execPath, ['-e', script, file, stop], { stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

describe('trust registry', () => {
  it('keeps every entry of registrations made at once, and the owner-readable mode', async () => {
    await writeFile(file, JSON.stringify({ projects: { '/kept': { lastCost: 1 } }, other: true }));
    const registry = new TrustRegistry(file);
    const paths = Array.from({ length: 10 }, (_, index) => `/repos/owner/r${String(index)}.git`);
    await Promise.all(paths.map((path) => registry.ensure(path)));
    const config = await read();
    for (const path of paths) expect(config.projects[path]?.hasTrustDialogAccepted).toBe(true);
    expect(config.projects['/kept']).toEqual({ lastCost: 1 });
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600');
  });

  it('never shows a partial file while another process rewrites it, and restores a lost entry', async () => {
    await writeFile(file, JSON.stringify({ projects: {} }));
    const stop = join(folder, 'stop');
    const writer = outsideWriter(stop);
    const registry = new TrustRegistry(file);
    const paths = Array.from({ length: 10 }, (_, index) => `/repos/owner/r${String(index)}.git`);
    let reads = 0;
    const reading = (async () => {
      while (
        !(await stat(stop).then(
          () => true,
          () => false,
        ))
      ) {
        await read(); // Throws on a partial file.
        reads++;
      }
    })();
    await Promise.all(paths.map((path) => registry.ensure(path)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(stop, '');
    expect(await writer).toBe(0);
    await reading;
    expect(reads).toBeGreaterThan(0);

    // The outside writer may have dropped entries it read before a rename: the check made before
    // each launch writes them again.
    for (const path of paths) await registry.ensure(path);
    const config = await read();
    for (const path of paths) expect(config.projects[path]?.hasTrustDialogAccepted).toBe(true);
    expect(config.writerCount).toBeGreaterThan(0);
  });

  it('writes only while no session is starting, and starts none while writing', async () => {
    const registry = new TrustRegistry(file);
    const release = await registry.beginStart();
    let written = false;
    const writing = registry.ensure('/repos/a.git').then(() => (written = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toBe(false);
    release();
    await writing;
    expect(written).toBe(true);
    expect(await registry.isTrusted('/repos/a.git')).toBe(true);
    // Released twice changes nothing.
    release();
    const again = await registry.beginStart();
    again();
  });

  it('refuses a damaged configuration instead of replacing it', async () => {
    await writeFile(file, '{"projects": ');
    await expect(new TrustRegistry(file).ensure('/repos/a.git')).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, 'utf8')).toBe('{"projects": ');
  });
});
