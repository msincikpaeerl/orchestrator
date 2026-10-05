import { z } from 'zod';

/** `GET /health`: used by Docker health checks (09, section 7.1). */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'error']),
  database: z.enum(['ok', 'error']),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** `GET /version`: server version and daemon protocol version (09, sections 6 and 7.1). */
export const VersionResponse = z.object({
  server: z.string().min(1),
  protocol: z.int().positive(),
  /**
   * Build identifier of the daemon package the server serves (05, section 2); null when it was not
   * built.
   */
  daemonBuild: z.string().nullable(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;
