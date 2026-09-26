import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

// Builds the daemon's npm package (ADR 0026): the daemon and its libraries bundled into one file,
// packed as `orchestrator-daemon-<version>.tgz`, which the server of the same version serves at
// `/downloads/` (05, section 2). Usage: `tsx scripts/pack.ts [--out <folder>]` (default `dist`).

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = resolve(values.out ?? join(root, 'dist'));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const staging = join(out, 'package');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(staging, 'dist'), { recursive: true });

const script = join(staging, 'dist', 'orchestrator-daemon.js');
const result = await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'cli.ts')],
  outfile: script,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Workspace packages from their TypeScript sources, as in development.
  conditions: ['source'],
  // Optional native speed-ups of `ws`, loaded in a try: without them `ws` uses JavaScript.
  external: ['bufferutil', 'utf-8-validate'],
  // The bundled CommonJS libraries (`ws`, `pino`) call `require` for Node.js modules.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});
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

writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'orchestrator-daemon',
      version,
      description: "The Orchestrator's daemon: runs agents on this machine.",
      type: 'module',
      bin: { 'orchestrator-daemon': 'dist/orchestrator-daemon.js' },
      engines: { node: '>=24 <25' },
      os: ['linux'],
    },
    null,
    2,
  )}\n`,
);

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
const archive = join(out, `orchestrator-daemon-${version}.tgz`);
writeFileSync(archive, gzipSync(tar, { level: 9 }));
rmSync(staging, { recursive: true });
console.log(`Daemon package: ${archive}`);
