The fixed acceptance criteria of a new project's bootstrap ticket (08, section 3.2): plan_propose adds each one the Project Manager's own criteria lack, after them, in this order. Each part is one criterion; `stack-website` only for a project of kind website, `stack-web-app` and `web-app` only for kind web_app, `end-to-end` for both. `scope` is added last, at the plan's approval only, when the plan has other tickets: `{{tickets}}` lists their final keys and titles (or their keys only, when that is too long). The Android criterion comes with Android projects (lot 7).
<!-- part: stack-website -->
The stack is the default for a website: Astro, TypeScript and static output, with Astro's Node.js server adapter only when the site saves what visitors send on a server. Each choice is recorded in an ADR; another stack needs an ADR naming this default and why it is not used.
<!-- part: stack-web-app -->
The stack is the default for a web app: React, Vite and TypeScript for the front end; Node.js, Fastify and TypeScript for the server; PostgreSQL; Docker Compose to run it locally. Each choice is recorded in an ADR; another stack needs an ADR naming this default and why it is not used.
<!-- part: builds -->
The project builds, and a sample test runs at each test level the project uses.
<!-- part: end-to-end -->
End-to-end tests use Playwright, with one sample test. It runs on the agent's machine with the browsers the machine already provides (never set PLAYWRIGHT_BROWSERS_PATH and never write a browser path in the project), and in CI in its own job, which installs the browsers itself and is listed in the needs of the ci job.
<!-- part: checks -->
Lint, format check and type check (when the language has one) are configured.
<!-- part: ci -->
CI runs the lint, the format check, the type check, the tests and the build on every pull request.
<!-- part: link-check -->
The documentation link check runs from the stack's own tooling (a pinned dev dependency and a script), replacing the skeleton's npm install command in CLAUDE.md and in CI, which stay identical.
<!-- part: claude-md -->
CLAUDE.md is complete: commands, folder map and conventions.
<!-- part: dev-docs -->
docs/dev/setup.md and docs/dev/testing.md are written.
<!-- part: getting-started -->
docs/user/getting-started.md explains how to run the product.
<!-- part: web-app -->
The database's integration tests run in CI only, since agents cannot run a database on their machine yet, and docs/dev/testing.md says so.
<!-- part: scope -->
It builds no feature of the plan's other tickets ({{tickets}}): only the structure, the tooling and one sample test of each test level.
