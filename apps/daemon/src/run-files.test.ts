import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeArguments, launchCommand, type LaunchTexts } from './run-files.js';

// The launcher of 05 section 4.3 (lot 5 step 5bis C): the texts go through the run's files and
// reach Claude Code byte for byte, while the command given to tmux stays small. A text that reads
// as empty starts no Claude Code (lot 5 step 5bis D).

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder with `instructions` and `message` written as the daemon writes them. */
function texts(instructions: string, message: string) {
  const folder = mkdtempSync(join(tmpdir(), 'launch-'));
  folders.push(folder);
  const files = {
    instructions: join(folder, 'system-prompt.md'),
    message: join(folder, 'message.md'),
    error: join(folder, 'launch-error'),
  };
  writeFileSync(files.instructions, instructions);
  writeFileSync(files.message, message);
  // Stands for `claude`: writes the arguments it was given, as JSON.
  const claude = join(folder, 'claude');
  writeFileSync(
    claude,
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
  );
  chmodSync(claude, 0o755);
  return { files, claude };
}

const launch = {
  mcpConfig: '/home/owner/.orchestrator/runs/r1/mcp.json',
  settings: '/home/owner/.orchestrator/runs/r1/settings.json',
  model: 'sonnet',
};

/** Every character a shell could take for its own, non-ASCII text and trailing newlines. */
const TRICKY = [
  'Ligne «été» 漢字 🙂 "double" \'single\' $HOME ${PATH} $(id) `id` \\back\\slash\\',
  '\ttab, %s %% *glob* ?[a] ~ ! # & ; | < > (x) {y} \r carriage return',
  '-- --resume not-an-option',
  '',
].join('\n');

/** dash on Debian and Ubuntu, bash elsewhere (in a UTF-8 locale, where it counts characters). */
const SHELLS = ['/bin/sh', '/bin/bash'].filter((shell) => existsSync(shell));

const CAT = '/bin/cat';

/** Runs `command` as tmux would, with an empty `PATH`: the launcher finds its tools by path. */
function argumentsGiven(command: string[]): string[] {
  const [file = '', ...args] = command;
  const result = spawnSync(file, args, { encoding: 'utf8', env: { PATH: '', LC_ALL: 'C.UTF-8' } });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as string[];
}

describe('the launch command', () => {
  it.each([
    ['ends with two newlines', `${TRICKY}\n\n`],
    ['ends with x, the marker the shell removes', `${TRICKY}x`],
    ['ends with x and a newline', `${TRICKY}x\n`],
    ['is one character', 'x'],
    ['is 100 KB', TRICKY.repeat(Math.ceil(100_000 / Buffer.byteLength(TRICKY)))],
  ])('gives Claude Code the exact text when it %s', (_, text) => {
    const message = `Message: ${text}`;
    const { files, claude } = texts(text, message);
    expect(SHELLS).toContain('/bin/sh');
    for (const shell of SHELLS) {
      for (const resumeSessionId of [null, '0b0e2f4a-8d5b-4d6e-9a43-0c1f2b3c4d5e']) {
        const command = launchCommand({ shell, cat: CAT }, claude, {
          ...launch,
          resumeSessionId,
          texts: files,
        });
        expect(argumentsGiven(command)).toEqual(
          claudeArguments({ ...launch, resumeSessionId, instructions: text, message }),
        );
      }
    }
  });

  it('is the same whatever the size of the texts, and never holds them', () => {
    const small = texts('Rules.', 'Hello.');
    const large = texts(TRICKY.repeat(2000), TRICKY.repeat(2000));
    const command = (files: LaunchTexts) =>
      launchCommand({ shell: '/bin/sh', cat: CAT }, '/usr/bin/claude', {
        ...launch,
        resumeSessionId: null,
        texts: files,
      });
    const sizes = [small, large].map(({ files }) => Buffer.byteLength(command(files).join('\0')));
    expect(sizes[0]).toBe(sizes[1]);
    // Far below the 16 KB a tmux command can hold.
    expect(sizes[1]).toBeLessThan(2000);
    expect(command(large.files).join('\0')).not.toContain('Ligne');
  });

  it.each([
    ['the instructions', 'instructions'],
    ['the message', 'message'],
  ] as const)('starts no Claude Code when %s read as empty', (what, empty) => {
    const { files, claude } = texts('Rules.', 'Hello.');
    writeFileSync(files[empty], '');
    for (const shell of SHELLS) {
      rmSync(files.error, { force: true });
      const [file = '', ...args] = launchCommand({ shell, cat: CAT }, claude, {
        ...launch,
        resumeSessionId: null,
        texts: files,
      });
      const result = spawnSync(file, args, { encoding: 'utf8', env: { PATH: '' } });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(readFileSync(files.error, 'utf8')).toBe(
        `${what} (${files[empty]}) ${empty === 'message' ? 'reads' : 'read'} as empty\n`,
      );
    }
  });

  it('starts no Claude Code when a text cannot be read', () => {
    const { files, claude } = texts('Rules.', 'Hello.');
    rmSync(files.message);
    const [file = '', ...args] = launchCommand({ shell: '/bin/sh', cat: CAT }, claude, {
      ...launch,
      resumeSessionId: null,
      texts: files,
    });
    const result = spawnSync(file, args, { encoding: 'utf8', env: { PATH: '' } });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readFileSync(files.error, 'utf8')).toBe(`${files.message} could not be read\n`);
  });
});
