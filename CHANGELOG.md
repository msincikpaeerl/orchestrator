# Changelog

User-facing changes, newest first. One entry per change that users can see.

## Unreleased

- After several failed logins, the Orchestrator makes you wait before trying again, longer after each new mistake.
- If the secret key in `.env` is lost or changed, the Orchestrator keeps running and asks you to enter your GitHub token again (Help: "Back up your secret key").

- A forgotten password can be reset with `docker compose -f docker/compose.yml exec orchestrator orchestrator reset-password` (see the Help page "Reset a forgotten password"). The account and GitHub screens arrive in the next version.

- The Orchestrator starts with Docker Compose (`docker compose -f docker/compose.yml up --build`): the server and its database, with a health check. There is no screen yet.
