import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { DAEMON_PACKAGE_NAME, daemonPackageFileName } from '@orchestrator/protocol';
import { bundleDaemon } from './bundle.js';

// Builds the daemon's npm package (ADR 0026): the daemon and its libraries bundled into one file,
// packed as `orchestrator-daemon-<version>.tgz`, which the server of the same version serves at
// `/downloads/` (05, section 2), with its build identifier in `<package>.build` next to it.
// Usage: `tsx --conditions=source scripts/pack.ts [--out <folder>]` (default `dist`).

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(values.out ?? join(root, 'dist'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const staging = join(out, 'package');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(staging, 'dist'), { recursive: true });

const manifest = `${JSON.stringify(
  {
    name: DAEMON_PACKAGE_NAME,
    version,
    description: "The Orchestrator's daemon: runs agents on this machine.",
    type: 'module',
    bin: { [DAEMON_PACKAGE_NAME]: 'dist/orchestrator-daemon.js' },
    engines: { node: '>=24 <25' },
    os: ['linux'],
  },
  null,
  2,
)}\n`;
const result = await bundleDaemon(root, manifest);
const script = join(staging, 'dist', 'orchestrator-daemon.js');
writeFileSync(script, result.script);
chmodSync(script, 0o755);

// The license of every bundled library, as their licenses require.
const libraries = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match?.[1]) libraries.add(resolve(root, match[1]));
}
const notices: string[] = [];
for (const folder of [...libraries].sort()) {
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string;
  };
  const file = readdirSync(folder).find((name) => /^licen[sc]e/i.test(name));
  if (!file) throw new Error(`no license file in ${folder}`);
  notices.push(
    `${manifest.name} ${manifest.version} (${manifest.license ?? 'see below'})\n\n${readFileSync(join(folder, file), 'utf8').trim()}\n`,
  );
}
writeFileSync(join(staging, 'THIRD-PARTY-LICENSES.txt'), notices.join(`\n${'-'.repeat(72)}\n\n`));

writeFileSync(join(staging, 'package.json'), manifest);

// A reproducible archive: files by name, no owner, a fixed date, gzip without a timestamp.
const tar = execFileSync(
  'tar',
  [
    '--create',
    '--sort=name',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--mtime=@0',
    '--format=ustar',
    '--directory',
    out,
    'package',
  ],
  { maxBuffer: 64 * 1024 * 1024 },
);
const archive = join(out, daemonPackageFileName(version));
writeFileSync(archive, gzipSync(tar, { level: 9 }));
// The build the server reports as the one it provides (05, section 2).
writeFileSync(`${archive}.build`, `${result.build}\n`);
rmSync(staging, { recursive: true });
console.log(`Daemon package: ${archive} (build ${result.build})`);
