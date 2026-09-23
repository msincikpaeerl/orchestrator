# Changelog

User-facing changes, newest first. One entry per change that users can see.

## Unreleased

- The Orchestrator has screens: open `http://localhost:8080`. A setup wizard creates your account and connects GitHub, with a "Create the token on GitHub" button that fills in GitHub's token form for you; then you log in with your username and password.
- "Needs you", the home page, warns you when the GitHub token expires within 14 days, has expired, is refused by GitHub or misses a permission. Settings > GitHub connection shows the token's account, expiry date and permissions, checks it again and replaces it.
- The Help section shows the user guide, with a search box, starting with "Getting started". Every screen links to its Help page.
- Every screen works on a phone: the menu is behind the "Menu" button.

- After several failed logins, the Orchestrator makes you wait before trying again, longer after each new mistake.
- If the secret key in `.env` is lost or changed, the Orchestrator keeps running and asks you to enter your GitHub token again (Help: "Back up your secret key").

- A forgotten password can be reset with `docker compose -f docker/compose.yml exec orchestrator orchestrator reset-password` (see the Help page "Reset a forgotten password"). The account and GitHub screens arrive in the next version.

- The Orchestrator starts with Docker Compose (`docker compose -f docker/compose.yml up --build`): the server and its database, with a health check. There is no screen yet.
