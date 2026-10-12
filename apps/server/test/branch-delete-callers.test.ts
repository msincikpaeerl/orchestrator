import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// One function of the product deletes a branch on GitHub (owner's answer 5, lot 3 step J):
// `deleteMergedTicketBranch`, which refuses by itself what must never be deleted. Outside it,
// only the owner's smoke script calls the GitHub layer's `deleteBranch`.

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Every TypeScript source of the product: apps, packages and tools, tests left out. */
async function sources(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test', 'e2e', 'coverage'].includes(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|e2e)\.tsx?$/.test(entry.name))
      found.push(path);
  }
  return found;
}

describe('the deletion of a branch on GitHub', () => {
  it('has one caller of deleteBranch in the product, besides the smoke script', async () => {
    const files = [
      ...(await sources(join(ROOT, 'apps'))),
      ...(await sources(join(ROOT, 'packages'))),
      ...(await sources(join(ROOT, 'tools'))),
    ];
    expect(files.length).toBeGreaterThan(100);
    const using: string[] = [];
    for (const file of files) {
      if (/\bdeleteBranch\b/.test(await readFile(file, 'utf8'))) {
        using.push(relative(ROOT, file));
      }
    }
    expect(using.sort()).toEqual([
      // Its definition, the one function, and the owner's smoke script.
      'apps/server/scripts/github-smoke.ts',
      'apps/server/src/github/pull-requests.ts',
      'apps/server/src/tickets/branch-delete.ts',
    ]);
  });

  it('deletes nothing in the one function without its refusals first', async () => {
    const text = await readFile(join(ROOT, 'apps/server/src/tickets/branch-delete.ts'), 'utf8');
    const body = text.slice(text.indexOf('export async function deleteMergedTicketBranch'));
    expect(body.indexOf('ownRefusal(')).toBeGreaterThan(0);
    expect(body.indexOf('ownRefusal(')).toBeLessThan(body.indexOf('deleteBranch('));
    expect(body.match(/\bdeleteBranch\(/g)).toHaveLength(1);
  });
});
