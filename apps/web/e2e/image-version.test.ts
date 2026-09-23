import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };

// Local runs and CI use the same Playwright image (ADR 0021); its browsers only work with the
// @playwright/test version they were built for.
const expected = `mcr.microsoft.com/playwright:v${packageJson.devDependencies['@playwright/test']}-noble`;

function imagesIn(path: string): string[] {
  const text = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
  return [...text.matchAll(/mcr\.microsoft\.com\/playwright:\S+/g)].map((match) => match[0]);
}

describe('the Playwright image', () => {
  it.each(['tools/e2e-docker.sh', '.github/workflows/ci.yml'])(
    'in %s matches the @playwright/test version',
    (path) => {
      const images = imagesIn(path);
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) expect(image).toBe(expected);
    },
  );
});
