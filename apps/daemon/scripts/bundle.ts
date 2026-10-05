import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { build, type Metafile, type Plugin } from 'esbuild';

// The daemon bundled into one file, and its build identifier (05, section 2; ADR 0026). Used by
// `pack.ts`; the tests call it to prove what the identifier depends on.

/** Stands for the build identifier in the bundle while it is hashed. */
export const BUILD_PLACEHOLDER = '@@ORCHESTRATOR_DAEMON_BUILD@@';

export interface DaemonBundle {
  /** The bundled script, the build identifier written into it. */
  script: string;
  /** 16 hexadecimal digits. */
  build: string;
  metafile: Metafile;
}

/**
 * The build identifier: the first 16 hexadecimal digits of the SHA-256 of the bundled script
 * (with `BUILD_PLACEHOLDER` where the identifier goes), a zero byte, and the package's
 * `package.json` text. So it changes with any change of the code the daemon runs (its sources,
 * the protocol package and the libraries it bundles, or esbuild's output) and with the package's
 * name, version or settings, and with nothing else: the bundle holds no date, no absolute path
 * and nothing of the machine (esbuild names the files it bundles relative to `apps/daemon`, and
 * comments are left out). A change that leaves the bundled code identical, such as a comment or
 * code the bundle does not use, gives the same build, as it should.
 */
export function buildIdentifier(placeholderScript: string, manifest: string): string {
  return createHash('sha256')
    .update(placeholderScript)
    .update('\0')
    .update(manifest)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Bundles `src/cli.ts` of the daemon at `root` with its libraries, for Node.js 24, and writes the
 * build identifier into it. `plugins` let tests change a source file as it is read.
 */
export async function bundleDaemon(
  root: string,
  manifest: string,
  plugins: Plugin[] = [],
): Promise<DaemonBundle> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'src', 'cli.ts')],
    outfile: join(root, 'dist', 'package', 'dist', 'orchestrator-daemon.js'),
    write: false,
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
    define: { __ORCHESTRATOR_DAEMON_BUILD__: JSON.stringify(BUILD_PLACEHOLDER) },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
    plugins,
  });
  const [output] = result.outputFiles;
  if (!output || result.outputFiles.length !== 1) throw new Error('expected one bundled file');
  if (!output.text.includes(BUILD_PLACEHOLDER)) {
    throw new Error('the build identifier has no place in the bundle (src/version.ts)');
  }
  const identifier = buildIdentifier(output.text, manifest);
  return {
    script: output.text.replaceAll(BUILD_PLACEHOLDER, identifier),
    build: identifier,
    metafile: result.metafile,
  };
}
