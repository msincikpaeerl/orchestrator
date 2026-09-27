# Changelog

User-facing changes, newest first. One entry per change that users can see.

## 0.3.0 — in progress

Lot 2, Machines and manual runs.

- Help: "Machines" > "Agents on your own user" says that Claude Code shows every agent your Claude account's e-mail address and your Git user name and e-mail address.
- Machines: agents are kept out of the Orchestrator's folder, the Claude configuration folders, your home folder and everything outside the project; they cannot run Git commands that reach GitHub or another computer (which could use your own GitHub login, as Git Credential Manager keeps it on WSL), `gh`, or `tmux`. Each refusal tells the agent why. Help: "Machines" > "Agents on your own user".
- Settings > Limits, Runs: new **MCP call timeout** (30 seconds), how long a machine waits for the Orchestrator's answer to an agent's tool call, and **Claude Code MCP tool timeout** (120 seconds), always above it: a value breaking this is refused, naming both limits and their values. Both are used from version 0.3.0. Help: "Settings".
- Settings > Limits, Runs: new **Session start timeout** (30 seconds), how long a machine waits for Claude Code to start a run's session. **Idle timeout** now stops a run whose agent shows no activity, without a reminder; time running a command does not count. Both are used from version 0.3.0. Help: "Settings".
- Activity: the event log also hides machine keys (`omt_…`) if one ever appears in a comment or a change.
- Help: "Machines" > "Agents on your own user" explains that an agent could send false news about its own run, and that it can never touch another ticket or project.
- Settings > Limits has a Machines group: **Enrollment code lifetime** (15 minutes), **Heartbeat interval** (15 seconds) and **Machine offline after** (60 seconds, at least twice the heartbeat interval: a value breaking this is refused, naming both limits and their values). Help: "Settings".
- Activity: the event log shows what happens to Claude accounts and machines (added, enrolled, connected, offline, disabled, revoked, capabilities edited), in plain words, with a filter for each.
- Machines: add your Claude accounts (label, plan, runs at the same time) and the computers where agents will work. **Add machine** shows the commands to type on the computer (install the daemon from the Orchestrator, enroll with a one-time code, log in to Claude, start the service) and shows when it connects. Each machine's page shows its status, versions (with a warning for a Claude Code newer than the one checked), the daemon's checks, and lets you edit its capabilities, disable, enable or revoke it, and get a new enrollment code. Help: "Machines", including how to keep WSL running.
- The machine daemon: `orchestrator-daemon` installs from the Orchestrator with the command shown on **Add machine**, then `enroll` (with `--ca-file` for an Orchestrator using its own certificate authority), `login`, `install-service` (the service, with the tools of your terminal), `start`, `status` and `doctor`. The daemon reconnects by itself after a network problem or a restart of the Orchestrator, and stops with a message saying what to do when it was revoked, is outdated, or another daemon uses its key. A plain `http://` address is accepted only for an Orchestrator on the same computer: machines on other computers need HTTPS. Help: "Machines", including "Orchestrator on another computer" and Troubleshooting.
- Needs you: shows "No Claude account yet" and "No machine enrolled yet" until you add them, and machines that cannot work (daemon to update, Claude Code missing or too old, a problem found by the daemon's checks), each with the commands to fix it. Help: "Needs you", "Machines".
- The Orchestrator keeps running when its database restarts, even during a change in progress: it notes the lost connection in its log and uses a new one; only that change fails, and can be made again.

## 0.2.0 — 2026-09-24

Lot 1, Projects and tickets: create projects with a new or linked GitHub repository, manage their tickets, change the limits and read the event log. Agents, machines and runs come in the next versions.

- Activity: the event log lists everything that changed, newest first, in plain words, with links to the project or ticket, and filters by project, ticket, kind, event and days. Quoted titles, names and comments are shortened plain text linking to the full text; credentials are never shown. The project list shows each project's last activity (time of its latest event, opening its event log) instead of "Last change". Help: "Activity".
- Settings > Limits: change the limits and timeouts of the Orchestrator (login and sessions, GitHub, tickets, and those of later versions, marked "Used from version ..."), each with its default and **Reset to default**. A change applies at once, without a restart, and is recorded. Project settings show the limits a project can override. Nothing changes for you until you change a value: every limit keeps the value it had. Help: "Settings".
- Tickets: each project page has a board of its tickets, by state (on a phone, the states are one below the other), with filters by type and text and a "Blocked" badge. Create and edit tickets (type, title, description, ordered acceptance criteria, priority, dependencies), comment on them, cancel, mark as done manually (with a required comment) and reopen them. The ticket page lists the tickets it waits for and the ones waiting for it, and says what to do when it waits for a cancelled ticket. The project list shows the number of tickets in each state. Descriptions and comments use Markdown, shown safely: no HTML, only web and e-mail links, images as links. Help: "Tickets".
- Tickets: **Mark as done manually** warns when the ticket still waits for tickets that are not done, naming them with their states, and asks you to confirm with **Mark as done anyway**. Help: "Tickets", "Mark as done manually".
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
