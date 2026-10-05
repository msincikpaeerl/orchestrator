import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// One Vitest project per workspace package, each inheriting the settings below.
const packageDirs = ['apps', 'packages'].flatMap((parent) =>
  readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`),
);

// Resolve workspace packages to their TypeScript sources (see tsconfig.base.json customConditions).
const conditions = ['source', 'module', 'node', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    // An unhandled error or rejection fails the run, in every package (the default, kept on
    // purpose): in the daemon one would stop the Node.js process.
    dangerouslyIgnoreUnhandledErrors: false,
    // A test that tries to reach the real GitHub fails (working rule 9).
    setupFiles: [fileURLToPath(new URL('vitest.setup.ts', import.meta.url))],
    projects: packageDirs.map((root) => ({
      extends: true,
      root,
      test: { name: root },
    })),
  },
});
