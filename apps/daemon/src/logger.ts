import { pino, type Logger } from 'pino';

/**
 * The running daemon's log (CLAUDE.md: Pino, structured): JSON lines on standard output, read
 * with `journalctl --user -u orchestrator-daemon` when it runs as the service.
 */
export function createLogger(level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ level, base: { app: 'orchestrator-daemon' } });
}
