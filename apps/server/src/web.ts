import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { ApiError } from '@orchestrator/protocol';
import type { FastifyInstance } from 'fastify';

/** The built UI: `apps/web/dist`, a dependency of the server (ADR 0018). */
export function defaultWebRoot(): string {
  return fileURLToPath(new URL('dist/', import.meta.resolve('@orchestrator/web/package.json')));
}

/** Addresses that are never a screen of the UI: the server's own, and the UI's files. */
function isScreenPath(url: string): boolean {
  return !/^\/(api|health|version|assets|downloads|daemon)(\/|\?|$)/.test(url);
}

/**
 * Serves the UI's files, and its `index.html` for any other browser address (`/settings/github`),
 * where the UI's router takes over. Unknown API addresses get an API error. Without a built UI
 * (`pnpm dev` serves it with Vite), only the API is served.
 */
export function registerWeb(app: FastifyInstance, webRoot: string | null) {
  const hasUi = webRoot !== null && existsSync(join(webRoot, 'index.html'));
  if (webRoot !== null && !hasUi) {
    app.log.warn({ webRoot }, 'UI not built: serving the API only');
  }
  if (hasUi) {
    void app.register(fastifyStatic, {
      root: webRoot,
      // File names under assets/ contain a hash of their content: they never change.
      setHeaders: (reply, path) => {
        reply.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasUi && request.method === 'GET' && isScreenPath(request.url)) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply
      .code(404)
      .send({ error: { code: 'not_found', message: 'No such address' } } satisfies ApiError);
  });
}
