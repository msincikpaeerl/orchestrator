# 0007 — ESLint, Prettier and documentation link check

- Status: accepted
- Date: 2026-09-23

## Context

Mistakes must be caught by machines first (08, section 1). 08 requires lint, format check and a documentation link check in CI, with ESLint and Prettier for TypeScript.

## Decision

- **ESLint** (flat config, `eslint.config.js`) with `typescript-eslint` `strictTypeChecked` rules, and `eslint-config-prettier` to leave formatting to Prettier.
- **Prettier** formats code, JSON and YAML. **Markdown is not formatted**: Prettier pads every table cell to the column width, which adds many tokens to files agents read at every run (08, section 1, goal 5) and makes diffs noisy.
- **Documentation link check** with `remark-cli` and `remark-validate-links`: checks, offline, that every relative link in Markdown points to an existing file and heading. External URLs are not checked, so CI does not depend on other websites.
- `pnpm lint` runs ESLint and the Prettier check; `pnpm docs:links` runs the link check; both are part of `pnpm verify`.

## Alternatives considered

- Biome instead of ESLint and Prettier: faster, but no equivalent of type-aware `typescript-eslint` rules, and 08 names ESLint and Prettier.
- Prettier on Markdown: consistent style, but padded tables cost context.
- `linkinator`: found no links in Markdown files during testing. `markdown-link-check`: does not check headings in other files.
- `lychee`: fast and complete, but a native binary, not installed by `pnpm install`.

## Consequences

- `pnpm format` fixes formatting; Markdown style is kept by hand.
- Links to headings break when a heading is renamed; the check reports them.
