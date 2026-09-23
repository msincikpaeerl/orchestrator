# 0024 — Untrusted Markdown: no raw HTML, allow-listed links, images as links

- Status: accepted
- Date: 2026-09-24

## Context

Ticket descriptions, acceptance criteria and comments are Markdown written by the owner and, from lot 2, by agents. Agents read repositories and web pages, so their text can carry content written by someone else. It is untrusted: viewing it must never run a script (01, section 3.5), and must never contact another site (09, section 5). Help pages come with the application and keep their own rendering (ADR 0020).

react-markdown does not render raw HTML unless a plugin is added. Its default URL transform removes `javascript:`, `vbscript:` and `data:` addresses, but it lets relative addresses, fragments and other schemes through, and it does not change images.

## Decision

One component, `UntrustedMarkdown` (`apps/web/src/components/markdown.tsx`), renders every piece of untrusted Markdown:

- **react-markdown** with **remark-gfm**, and no plugin that lets HTML through (no `rehype-raw`). Raw HTML is shown as text.
- Links go through our own **allow-list**: an address is kept only if it is absolute and its scheme is `http`, `https` or `mailto` (`safeUrl`). Otherwise the link text is shown without a link. Relative addresses and fragments are refused too: they would point into the Orchestrator itself.
- Links open in a new tab with `rel="noopener noreferrer"`: the other site cannot control this page or learn its address.
- **Images are never loaded**. An image becomes a link "Image: <description>" to its address, if the address passes the allow-list. Otherwise it is shown as text.
- No heading anchors (no `rehype-slug`): content cannot create element ids of its own.

Unit tests feed script tags, event handler attributes, `javascript:`, `data:` and other addresses, including disguised ones (mixed case, entities, reference links, autolinks), and images. They check the output has no element that runs or loads anything, no `on…`, `style` or `src` attribute, and only allowed links. An end-to-end test shows such content in a browser and checks that no dialog opens and no request leaves the Orchestrator.

## Alternatives considered

- **react-markdown's default URL transform**: it keeps relative addresses and schemes such as `ftp:` or `tel:`. The rule should be a list of what is allowed, which does not change when the library does.
- **HTML sanitising (DOMPurify, rehype-sanitize) after rendering HTML**: needed only if raw HTML were rendered. Not rendering it is simpler, and it removes the need to trust a sanitiser's configuration.
- **Sanitising on the server when content is saved**: the stored text would no longer be what the author wrote (agents read it back through MCP), and every screen would still need safe rendering.

## Consequences

- An author cannot use HTML for layout (coloured text, `<details>`); Markdown alone must do.
- Relative links written by agents (for example to a file of the repository) are shown as text. Links to GitHub must be absolute.
- Images in tickets are one click away; screenshots are not shown inline.
- Every future screen showing untrusted text (requests, plans, run summaries) must use this component.
