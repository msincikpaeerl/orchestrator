import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST_TEMPLATE_FILE,
  RULES_FILES,
  TEMPLATE_NAMES,
  agentsDirectory,
} from '../src/agents/files.js';
import { renderSkeleton, skeletonDirectory } from '../src/github/skeleton.js';

// The image is built with `pnpm deploy` (docker/Dockerfile), which copies of each workspace package
// only what its `files` lists, as `pnpm pack` does. A file the server reads at start but left out
// of `files` passes every test run from the repository and stops the server in the image: lot 3
// step H5 added `agents/rules/` and only the docker job saw it missing.

/** The files `pnpm pack` (and so `pnpm deploy`) ships for the package in `directory`. */
function shippedFiles(directory: string): string[] {
  const execPath = process.env.npm_execpath;
  const [command, args] =
    execPath && /\.c?js$/.test(execPath)
      ? [process.execPath, [execPath]]
      : [execPath ?? 'pnpm', [] as string[]];
  const output = execFileSync(command, [...args, 'pack', '--dry-run', '--json'], {
    cwd: directory,
    encoding: 'utf8',
  });
  const packed = JSON.parse(output) as { files: { path: string }[] };
  return packed.files.map((file) => file.path);
}

describe('the files the server reads from its workspace packages are in their package files', () => {
  it('@orchestrator/agents: the profiles, the rules and every run message template', async () => {
    const directory = agentsDirectory();
    const profiles = (await readdir(directory)).filter((name) => name.endsWith('.md'));
    expect(profiles.length).toBeGreaterThan(0);
    const read = [
      ...profiles,
      ...Object.values(RULES_FILES),
      ALLOWLIST_TEMPLATE_FILE,
      ...TEMPLATE_NAMES.map((name) => `templates/${name}.md`),
    ];
    const shipped = shippedFiles(directory);
    expect(read.filter((file) => !shipped.includes(file))).toEqual([]);
  });

  it('@orchestrator/templates: every file of the project skeleton', async () => {
    const skeleton = await renderSkeleton({
      name: 'Sample',
      description: 'Sample',
      defaultBranch: 'main',
      date: '2026-10-11',
    });
    expect(skeleton.length).toBeGreaterThan(0);
    const directory = join(skeletonDirectory(), '..');
    const shipped = shippedFiles(directory);
    const read = skeleton.map((file) => `project-skeleton/${file.path}`);
    expect(read.filter((file) => !shipped.includes(file))).toEqual([]);
  });
});
