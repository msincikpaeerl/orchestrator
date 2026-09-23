import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_CHECK } from './repositories.js';
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
      '.gitignore',
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
    expect(ci).toContain("contains(needs.*.result, 'failure')");
  });

  it('refuses a template with an unknown placeholder', () => {
    expect(() => renderSkeletonFile('README.md', '# {{title}}', values)).toThrow(
      'README.md: unknown placeholder {{title}}',
    );
  });

  it('pins the link checker of CI and CLAUDE.md to the versions and Node.js of this repository', async () => {
    const rootPackage = JSON.parse(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
    ) as { devDependencies: Record<string, string> };
    const nodeVersion = (await readFile(join(repositoryRoot, '.nvmrc'), 'utf8')).trim();
    for (const file of ['.github/workflows/ci.yml', 'CLAUDE.md']) {
      const content = await readFile(join(skeletonDirectory(), file), 'utf8');
      for (const name of ['remark-cli', 'remark-validate-links']) {
        expect(content, file).toContain(
          `${name}@${rootPackage.devDependencies[name] ?? 'missing'}`,
        );
      }
    }
    const ci = await readFile(join(skeletonDirectory(), '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain(`node-version: ${nodeVersion}`);
  });

  it("documents in CLAUDE.md the CI's link check command, word for word", async () => {
    const claude = await readFile(join(skeletonDirectory(), 'CLAUDE.md'), 'utf8');
    const ci = await readFile(join(skeletonDirectory(), '.github/workflows/ci.yml'), 'utf8');
    const command = /^\| Documentation link check[^|]*\| `([^`]+)` \|$/m.exec(claude)?.[1];
    expect(command).toBeDefined();
    expect(ci).toContain(`run: ${command ?? 'missing'}\n`);
    // It installs into node_modules, which Git must ignore.
    expect(command).toContain('npm install --no-save --no-package-lock');
    expect(await readFile(join(skeletonDirectory(), '.gitignore'), 'utf8')).toMatch(
      /^node_modules\/$/m,
    );
  });
});

/** Jobs of a workflow, by id, with their lines (indented by 4). Enough for the skeleton's CI. */
function workflowJobs(workflow: string): Map<string, string[]> {
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of workflow.slice(workflow.indexOf('\njobs:\n')).split('\n').slice(2)) {
    const job = /^ {2}([\w-]+):$/.exec(line);
    if (job?.[1]) jobs.set(job[1], (current = []));
    else if (line.startsWith('    ')) current?.push(line.trim());
  }
  return jobs;
}

describe('the check required by branch protection', () => {
  it("is the skeleton CI's final job, which needs every other job", async () => {
    const ci = await readFile(join(skeletonDirectory(), '.github/workflows/ci.yml'), 'utf8');
    const jobs = workflowJobs(ci);
    const required = jobs.get(REQUIRED_CHECK);
    expect(required, `job ${REQUIRED_CHECK}`).toBeDefined();
    // GitHub names the check after the job id unless the job has a name.
    expect(required?.some((line) => line.startsWith('name:'))).toBe(false);
    // It runs when a job it needs failed, and fails for failed, cancelled or skipped jobs.
    expect(required).toContain('if: always()');
    for (const result of ['failure', 'cancelled', 'skipped']) {
      expect(required?.join('\n')).toContain(`contains(needs.*.result, '${result}')`);
    }
    const others = [...jobs.keys()].filter((job) => job !== REQUIRED_CHECK);
    expect(others.length).toBeGreaterThan(0);
    expect(required).toContain(`needs: [${others.join(', ')}]`);
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
