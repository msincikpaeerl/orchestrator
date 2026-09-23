import { describe, expect, it } from 'vitest';
import { CreateProjectRequest, ProjectKey, RepositoryName, slugify } from './projects.js';

describe('slugify', () => {
  it.each([
    ['Online Shop', 'online-shop'],
    ['  Café & Crème!  ', 'cafe-creme'],
    ['my_app.v2', 'my_app.v2'],
    ['---', ''],
  ])('%s gives %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it('always gives a valid repository name, or nothing', () => {
    for (const name of ['Online Shop', '.hidden', 'Été 2026', 'a'.repeat(150)]) {
      expect(RepositoryName.safeParse(slugify(name)).success).toBe(true);
    }
  });
});

describe('ProjectKey', () => {
  it('accepts 2 to 6 uppercase letters only', () => {
    expect(['WE', 'WEB', 'SHOPPY'].every((key) => ProjectKey.safeParse(key).success)).toBe(true);
    expect(
      ['W', 'SHOPPER', 'web', 'W3B', 'WÉB'].some((key) => ProjectKey.safeParse(key).success),
    ).toBe(false);
  });
});

describe('CreateProjectRequest', () => {
  const base = { name: 'Shop', key: 'SHOP', kind: 'web_app' };

  it('takes a new repository with its visibility, or a linked one', () => {
    expect(
      CreateProjectRequest.parse({
        ...base,
        repository: { origin: 'created', name: 'shop', private: true },
      }).description,
    ).toBe('');
    expect(
      CreateProjectRequest.safeParse({ ...base, repository: { origin: 'linked', name: 'shop' } })
        .success,
    ).toBe(true);
  });

  it('needs the visibility of a new repository', () => {
    expect(
      CreateProjectRequest.safeParse({ ...base, repository: { origin: 'created', name: 'shop' } })
        .success,
    ).toBe(false);
  });
});
