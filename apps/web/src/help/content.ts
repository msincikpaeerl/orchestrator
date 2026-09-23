import { buildPages } from './pages';

// docs/user/ is bundled into the UI at build time: the Help section always matches the version.
const files = import.meta.glob<string>('../../../../docs/user/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const helpPages = buildPages(files);

export function findPage(slug: string) {
  return helpPages.find((page) => page.slug === slug);
}
