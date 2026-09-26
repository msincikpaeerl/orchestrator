/**
 * How to run this daemon again from a command Claude Code or Git starts (hooks, status line,
 * MCP relay, credential helper): the same Node.js, with the same options (the `tsx` loader in
 * development), and the same script, as absolute paths.
 */
export function selfCommand(): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1] ?? ''];
}

/** Quotes each argument for `sh`: hooks, the status line and Git helpers are shell strings. */
export function shellCommand(args: readonly string[]): string {
  return args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(' ');
}
