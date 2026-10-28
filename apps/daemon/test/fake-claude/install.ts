import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeExecutable } from '../testing.js';
import type { FakeLogEntry, ScenarioInput } from './scenario.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const tsxCli = createRequire(join(here, '..', '..', 'package.json')).resolve('tsx/cli');

/** Runs a TypeScript file of this folder with Node.js and tsx: `[node, tsx, file]`. */
export function nodeCommand(file: string): string[] {
  return [process.execPath, tsxCli, join(here, file)];
}

export interface FakeClaude {
  /** Holds `scenario.json`, `scenarios/` and `log.jsonl`. */
  folder: string;
  /** The scenario of every session, or of the session whose worktree is named `runId`. */
  play(scenario: ScenarioInput, runId?: string): Promise<void>;
  /** What the fake recorded, in order. */
  log(): Promise<FakeLogEntry[]>;
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Writes a `claude` executable in `bin` that runs the fake with its folder (ADR 0027). The
 * default scenario answers each message with "Done.".
 */
export async function installFakeClaude(bin: string, folder: string): Promise<FakeClaude> {
  await mkdir(join(folder, 'scenarios'), { recursive: true });
  await fakeExecutable(
    bin,
    'claude',
    `FAKE_CLAUDE_DIR=${quote(folder)} exec ${nodeCommand('fake-claude.ts').map(quote).join(' ')} "$@"`,
  );
  return {
    folder,
    play: (scenario, runId) =>
      writeFile(
        runId ? join(folder, 'scenarios', `${runId}.json`) : join(folder, 'scenario.json'),
        JSON.stringify(scenario),
      ),
    log: async () => {
      let text: string;
      try {
        text = await readFile(join(folder, 'log.jsonl'), 'utf8');
      } catch {
        return [];
      }
      // Each entry is one line ending with '\n'; a long one may be read half written, so the
      // part after the last '\n' is left for the next read.
      return text
        .split('\n')
        .slice(0, -1)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeLogEntry);
    },
  };
}
