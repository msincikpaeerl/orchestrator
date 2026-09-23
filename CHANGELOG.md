# Changelog

User-facing changes, newest first. One entry per change that users can see.

## Unreleased

- Tickets: each project page has a board of its tickets, by state (on a phone, the states are one below the other), with filters by type and text and a "Blocked" badge. Create and edit tickets (type, title, description, ordered acceptance criteria, priority, dependencies), comment on them, cancel, mark as done manually (with a required comment) and reopen them. The ticket page lists the tickets it waits for and the ones waiting for it, and says what to do when it waits for a cancelled ticket. The project list shows the number of tickets in each state. Descriptions and comments use Markdown, shown safely: no HTML, only web and e-mail links, images as links. Help: "Tickets".
- Every refusal is explained in plain words, and a text that is too long names the field and its limit.

- Projects: create a project with a new GitHub repository (private by default) or link one of your repositories, follow its setup on the project page, try a failed setup again, change its name and description, archive and unarchive it (the GitHub repository is never changed). A linked repository shows the harness elements it is missing, with **Check again**. "Needs you" lists projects whose setup failed. Help: "Projects".

## 0.1.0 — 2026-09-23

First version (lot 0, Foundations): install the Orchestrator with Docker Compose, create your account, connect GitHub and read the user guide in the Help section. Projects, machines and agents come in the next versions.

- The GitHub token check no longer reports Workflows as Missing when only Contents is missing: Workflows then shows "Could not verify" with "Requires Contents (Read and write) first", since GitHub cannot check Workflows without Contents.
- The Orchestrator has screens: open `http://localhost:8080`. A setup wizard creates your account and connects GitHub, with a "Create the token on GitHub" button that fills in GitHub's token form for you; then you log in with your username and password.
- "Needs you", the home page, warns you when the GitHub token expires within 14 days, has expired, is refused by GitHub or misses a permission. Settings > GitHub connection shows the token's account, expiry date and permissions, checks it again and replaces it.
- The Help section shows the user guide, with a search box, starting with "Getting started". Every screen links to its Help page.
- Every screen works on a phone: the menu is behind the "Menu" button.

- After several failed logins, the Orchestrator makes you wait before trying again, longer after each new mistake.
- If the secret key in `.env` is lost or changed, the Orchestrator keeps running and asks you to enter your GitHub token again (Help: "Back up your secret key").

- A forgotten password can be reset with `docker compose -f docker/compose.yml exec orchestrator orchestrator reset-password` (see the Help page "Reset a forgotten password"). The account and GitHub screens arrive in the next version.

- The Orchestrator starts with Docker Compose (`docker compose -f docker/compose.yml up --build`): the server and its database, with a health check. There is no screen yet.
