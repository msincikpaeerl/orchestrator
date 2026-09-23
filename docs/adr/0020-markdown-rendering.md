# 0020 — Help: Markdown rendered in the browser with react-markdown

- Status: accepted
- Date: 2026-09-23

## Context

The Help section shows `docs/user/` with navigation and search (02, section 11). The pages are plain Markdown with tables, links between pages and links to headings (08, section 2.2). They are written in the repository and change only with a new version.

## Decision

- `docs/user/*.md` are bundled into the UI at build time (`import.meta.glob`), so Help always matches the running version and needs no API.
- **react-markdown** renders them, with **remark-gfm** for tables and **rehype-slug** for heading anchors (the same anchors as GitHub's, which `pnpm docs:links` checks). Raw HTML in Markdown is not rendered.
- Links to another page (`reset-password.md`) become Help addresses (`/help/reset-password`); links to other sites open in a new tab.
- Navigation lists the pages in the order `index.md` links to them (a unit test checks every page is linked there); titles come from each page's first heading.
- Search is a few lines of our own code: the pages containing every typed word, those matching in their title first, with an extract. There are few pages; a search library would add weight for nothing.

## Alternatives considered

- Rendering on the server: needs an API and HTML sanitising, for content that is known at build time.
- `marked` with `dangerouslySetInnerHTML`: smaller, but produces HTML strings that must be sanitised, and links cannot become router links.
- MiniSearch or Lunr for search: ranking and fuzzy matching are not needed for about ten pages.

## Consequences

- Changing `docs/user/` changes the UI build: the Help section of a running Orchestrator changes only with a new image.
- Pages must not link outside `docs/user/` with relative links: they would not work in the application.
