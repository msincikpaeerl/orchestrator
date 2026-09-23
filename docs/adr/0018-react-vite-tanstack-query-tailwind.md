# 0018 — React, Vite, TanStack Query and Tailwind CSS for the UI

- Status: accepted
- Date: 2026-09-23

## Context

09, section 3 chooses React + Vite + TanStack Query + Tailwind CSS for the web UI, served by the server as static files. Every screen must work on a phone (02, section 1). The owner runs one container (ADR 0014).

## Decision

- **React** (19) renders the UI; **Vite** builds it into `apps/web/dist` and serves it in development (`pnpm dev` starts Vite on port 5173 and forwards `/api` to the server).
- **TanStack Query** holds everything read from the API; answers are validated with the `packages/protocol` schemas before use, and a 401 answer returns the UI to the login page.
- **Tailwind CSS** (4, through its Vite plugin) styles the screens, mobile first: the navigation sits beside the page from the `md` width and behind a "Menu" button below it.
- The server serves `apps/web/dist` with `@fastify/static`, and `index.html` for any other `GET` address outside `/api`, `/health`, `/version` and `/assets`, so screen addresses can be opened directly. Files under `assets/` have content hashes in their names and are cached for a year; `index.html` is never cached.
- `@orchestrator/web` is a dependency of the server: `pnpm deploy` puts its `dist` in the image. Every library of the UI is a development dependency, since it is bundled: none reaches the server image.
- The Help section is loaded on demand: Markdown rendering is most of the UI's size.

## Alternatives considered

- Next.js or another server-rendering framework: a second server process, for a single user who does not need search engines.
- A separate web server (Nginx) for the UI: a second container, against the one-container deployment.
- CSS modules or a component library: more to learn for agents than utility classes, and component libraries bring their own look and weight.

## Consequences

- The server image contains the UI of the same version: they can never mismatch.
- Screens are tested end to end (ADR 0021); UI logic without a screen (Help search, wording of problems) has unit tests with Vitest.
- `pnpm dev` without `pnpm build` serves the UI from Vite only; the server logs "UI not built: serving the API only".
