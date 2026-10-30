The fixed acceptance criteria of a new project's bootstrap ticket (08, section 3.2): plan_propose adds each one the Project Manager's own criteria lack, after them, in this order. Each part is one criterion; `web-app` only for a project of kind web_app. The Android criterion comes with Android projects (lot 7).
<!-- part: stack -->
The stack is chosen and recorded in ADRs, following the default stack of the project's kind unless the request justifies another choice.
<!-- part: builds -->
The project builds, and a sample test runs at each test level the project uses.
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
