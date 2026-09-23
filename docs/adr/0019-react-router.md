# 0019 — React Router for the UI's addresses

- Status: accepted
- Date: 2026-09-23

## Context

Each screen needs its own address: Help pages are linked from other pages and from the documentation, the login page must return to the address that was opened, and the browser's back button must work. React has no router of its own.

## Decision

React Router (package `react-router`), in declarative mode (`BrowserRouter` and `Routes`), with real paths (`/settings/github`, `/help/github-token#required-permissions`). The server answers `index.html` for these paths (ADR 0018). Routes are declared in `apps/web/src/app.tsx`, which also sends the owner to the wizard or the login page when needed.

## Alternatives considered

- TanStack Router: typed routes, but less known by agents and more setup (code generation or a route tree).
- A hand-written router: small today, but every later lot would extend it (parameters, nested layouts, search parameters).
- Hash addresses (`/#/settings`): no server change needed, but anchors inside Help pages would conflict with them.

## Consequences

- Links between screens are `Link` and `NavLink` elements; a full page load is never needed.
- Navigation is a React transition: code that changes both the address and cached data must not rely on their order: for example the wizard's Done page, not the wizard, refreshes the setup state (`apps/web/src/pages/setup.tsx`).
