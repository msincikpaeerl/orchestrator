import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The common skeleton of a new repository (08, section 3.1): `templates/project-skeleton`. */
export function skeletonDirectory(): string {
  return fileURLToPath(
    new URL('project-skeleton/', import.meta.resolve('@orchestrator/templates/package.json')),
  );
}

/** Values of the skeleton's `{{placeholder}}` markers. */
export interface SkeletonValues {
  name: string;
  description: string;
  /** Read from GitHub's answer when the repository was created, never assumed. */
  defaultBranch: string;
  /** Date of ADR 0001, `YYYY-MM-DD`. */
  date: string;
}

export interface SkeletonFile {
  /** Relative to the repository root, with `/` separators. */
  path: string;
  content: string;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** In a YAML file, values sit between single quotes, where a quote is written twice. */
function escapeFor(path: string, value: string): string {
  return /\.ya?ml$/.test(path) ? value.replaceAll("'", "''") : value;
}

/**
 * Fills in the placeholders in one pass, so a value containing `{{name}}` is kept as written.
 * An unknown placeholder is a mistake in the template and throws.
 */
export function renderSkeletonFile(path: string, template: string, values: SkeletonValues): string {
  return template.replace(PLACEHOLDER, (marker, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`${path}: unknown placeholder ${marker}`);
    return escapeFor(path, values[key as keyof SkeletonValues]);
  });
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** Every skeleton file with its placeholders filled in, sorted by path. */
export async function renderSkeleton(
  values: SkeletonValues,
  directory = skeletonDirectory(),
): Promise<SkeletonFile[]> {
  const paths = await listFiles(directory);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      content: renderSkeletonFile(path, await readFile(join(directory, path), 'utf8'), values),
    })),
  );
}
