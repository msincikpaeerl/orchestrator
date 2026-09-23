import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The UI is built into dist/ and served by the server (ADR 0018). In development, `vite`
// serves it on its own port and forwards API calls to the server started by `pnpm dev`.
export default defineConfig(({ mode }) => {
  const serverPort = loadEnv(mode, repoRoot, '').PORT || '8080';
  return {
    plugins: [react(), tailwindcss()],
    // Workspace packages are bundled from their TypeScript sources (tsconfig.base.json).
    resolve: { conditions: ['source', ...defaultClientConditions] },
    server: {
      // The Help section reads docs/user/ at the repository root.
      fs: { allow: [repoRoot] },
      proxy: { '/api': `http://localhost:${serverPort}` },
    },
  };
});
