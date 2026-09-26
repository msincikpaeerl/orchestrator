import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiError } from '@orchestrator/protocol';
import type { FastifyInstance } from 'fastify';
import { SERVER_VERSION } from './version.js';

/** The daemon package built by `apps/daemon` (`pnpm build`), a dependency of the server (ADR 0026). */
export function defaultDaemonPackageDir(): string {
  return fileURLToPath(new URL('dist/', import.meta.resolve('@orchestrator/daemon/package.json')));
}

/** File name of the daemon package of the server's own version (05, section 2). */
export function daemonPackageFile(version = SERVER_VERSION): string {
  return `orchestrator-daemon-${version}.tgz`;
}

/**
 * `GET /downloads/orchestrator-daemon-<version>.tgz`: the daemon of the server's own version, for
 * `npm install -g <url>` (05, section 2). No session: npm sends none, and the package holds no
 * secret. Any other version is not found.
 */
export function registerDownloads(app: FastifyInstance, packageDir: string) {
  app.get<{ Params: { file: string } }>('/downloads/:file', (request, reply) => {
    const path = join(packageDir, daemonPackageFile());
    if (request.params.file !== daemonPackageFile() || !existsSync(path)) {
      if (request.params.file === daemonPackageFile()) {
        request.log.error({ path }, 'daemon package not built: run pnpm build');
      }
      return reply.code(404).send({
        error: {
          code: 'not_found',
          message: `Only the daemon of this Orchestrator's version is available: ${daemonPackageFile()}`,
        },
      } satisfies ApiError);
    }
    return reply
      .type('application/gzip')
      .header('cache-control', 'no-cache')
      .send(createReadStream(path));
  });
}
