import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Workspace trust in the dedicated Claude Code configuration (05, section 4.2.1; ADR 0002):
// `projects["<bare clone>"].hasTrustDialogAccepted = true` in `claude-config/.claude.json`.
// Claude Code writes the same file, above all when a session starts, so the daemon's writes are
// serialised, atomic (temporary file then rename) and made while no session is starting, and a
// launch waits for a write in progress. Claude Code's own writes could still drop an entry, so
// the entry is checked before each launch and written again when missing.

type ClaudeConfig = Record<string, unknown> & {
  projects?: Record<string, Record<string, unknown> | undefined>;
};

export class TrustRegistry {
  private writing = false;
  private starting = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Set<() => void>();

  /** `file` is `.claude.json` of the dedicated configuration folder. */
  constructor(private readonly file: string) {}

  private notify(): void {
    for (const waiter of this.waiters) waiter();
  }

  private async until(condition: () => boolean): Promise<void> {
    while (!condition()) {
      await new Promise<void>((resolve) => {
        const waiter = () => {
          this.waiters.delete(waiter);
          resolve();
        };
        this.waiters.add(waiter);
      });
    }
  }

  /** Makes sure `path` is trusted; writes the entry only when it is missing. */
  ensure(path: string): Promise<void> {
    const next = this.chain.then(async () => {
      if (await this.isTrusted(path)) return;
      await this.until(() => this.starting === 0);
      this.writing = true;
      try {
        const config = await this.read();
        config.projects ??= {};
        config.projects[path] = { ...config.projects[path], hasTrustDialogAccepted: true };
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.orchestrator-${String(process.pid)}.tmp`;
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.file);
      } finally {
        this.writing = false;
        this.notify();
      }
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async isTrusted(path: string): Promise<boolean> {
    return (await this.read()).projects?.[path]?.hasTrustDialogAccepted === true;
  }

  /**
   * Marks a session as starting once no trust write is in progress. Call the returned function
   * when its `SessionStart` arrives or the start fails.
   */
  async beginStart(): Promise<() => void> {
    await this.until(() => !this.writing);
    this.starting++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.starting--;
      this.notify();
    };
  }

  private async read(): Promise<ClaudeConfig> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      return JSON.parse(text) as ClaudeConfig;
    } catch {
      throw new Error(`${this.file} is not valid JSON: Claude Code's configuration is damaged`);
    }
  }
}
