import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSkeleton, renderSkeletonFile, skeletonDirectory } from './skeleton.js';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const values = {
  name: 'Shop',
  description: 'Sells things.',
  defaultBranch: "it's-main",
  date: '2026-09-23',
};

describe('renderSkeleton', () => {
  it('fills in every placeholder of the 08 section 2 layout', async () => {
    const files = await renderSkeleton(values);
    expect(files.map((file) => file.path)).toEqual([
      '.github/pull_request_template.md',
      '.github/workflows/ci.yml',
      '.remarkrc.json',
      'CHANGELOG.md',
      'CLAUDE.md',
      'README.md',
      'docs/adr/0000-template.md',
      'docs/adr/0001-record-architecture-decisions.md',
      'docs/dev/architecture.md',
      'docs/dev/setup.md',
      'docs/dev/testing.md',
      'docs/user/getting-started.md',
      'docs/user/index.md',
    ]);
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    expect(byPath.get('README.md')).toMatch(/^# Shop\n\nSells things\.\n/);
    expect(byPath.get('docs/adr/0001-record-architecture-decisions.md')).toContain(
      '- Date: 2026-09-23',
    );
    for (const [path, content] of byPath) expect(content, path).not.toMatch(/\{\{\w+\}\}/);
  });

  it('inserts values as written, never filling them in again', () => {
    expect(renderSkeletonFile('README.md', '# {{name}}', { ...values, name: '{{date}}' })).toBe(
      '# {{date}}',
    );
  });

  it('keeps YAML valid when a value contains a quote', async () => {
    const files = await renderSkeleton(values);
    const ci = files.find((file) => file.path === '.github/workflows/ci.yml')?.content;
    expect(ci).toContain("branches: ['it''s-main']");
  });

  it('refuses a template with an unknown placeholder', () => {
    expect(() => renderSkeletonFile('README.md', '# {{title}}', values)).toThrow(
      'README.md: unknown placeholder {{title}}',
    );
  });

  it("pins the CI's link checker to the versions and Node.js used by this repository", async () => {
    const ci = await readFile(join(skeletonDirectory(), '.github/workflows/ci.yml'), 'utf8');
    const rootPackage = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    const nodeVersion = (await readFile(join(repositoryRoot, '.nvmrc'), 'utf8')).trim();
    for (const name of ['remark-cli', 'remark-validate-links']) {
      expect(ci).toContain(`${name}@${rootPackage.devDependencies[name] ?? 'missing'}`);
    }
    expect(ci).toContain(`node-version: ${nodeVersion}`);
  });
});

describe("the skeleton's own documentation link check", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  /** Writes the rendered skeleton, and runs the CI's check with this repository's remark. */
  async function linkCheck(change?: (dir: string) => Promise<void>) {
    directory = await mkdtemp(join(tmpdir(), 'orchestrator-skeleton-'));
    for (const file of await renderSkeleton(values)) {
      const target = join(directory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    await change?.(directory);
    // The CI installs remark-cli and remark-validate-links in node_modules; this repository has
    // them at the same versions (test above).
    await symlink(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
    return promisify(execFile)(
      join(repositoryRoot, 'node_modules/.bin/remark'),
      ['.', '--frail', '--quiet', '--no-stdout'],
      { cwd: directory },
    );
  }

  it('passes on the rendered skeleton', async () => {
    await expect(linkCheck()).resolves.toBeDefined();
  }, 30_000);

  it('fails on a broken link, so the check really runs', async () => {
    await expect(
      linkCheck((dir) => writeFile(join(dir, 'docs/user/broken.md'), '[Nowhere](nowhere.md)\n')),
    ).rejects.toThrow(/nowhere\.md/);
  }, 30_000);
});
