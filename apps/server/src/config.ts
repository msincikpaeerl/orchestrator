import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** Environment variables of the server (09, section 7.1). */
const Environment = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' }),
  // The encryption scheme using this key is defined in lot 0 step C.
  ORCHESTRATOR_SECRET_KEY: z.string().min(32, 'must be at least 32 characters'),
  // Optional: derived from PORT when unset or empty (see loadConfig).
  PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' })
    .optional()
    .or(z.literal('').transform(() => undefined)),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(logLevels).default('info'),
});

export interface Config {
  databaseUrl: string;
  secretKey: string;
  publicUrl: string;
  port: number;
  logLevel: (typeof logLevels)[number];
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Reads and validates the configuration. Error messages name the variables but never
 * include their values, which may be secret.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = Environment.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) =>
        `- ${issue.path.join('.')}: ${env[String(issue.path[0])] ? issue.message : 'missing'}`,
    );
    throw new ConfigError(`Invalid configuration (see .env.example):\n${problems.join('\n')}`);
  }
  const { DATABASE_URL, ORCHESTRATOR_SECRET_KEY, PUBLIC_URL, PORT, LOG_LEVEL } = result.data;
  return {
    databaseUrl: DATABASE_URL,
    secretKey: ORCHESTRATOR_SECRET_KEY,
    publicUrl: PUBLIC_URL ?? `http://localhost:${String(PORT)}`,
    port: PORT,
    logLevel: LOG_LEVEL,
  };
}
