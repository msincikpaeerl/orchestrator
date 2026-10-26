# Orchestrator Help

The Orchestrator turns what you describe in plain words into web apps, websites and Android apps, by coordinating AI agents that work on your own computers. You describe what you want, approve the plan and merge the results on GitHub.

This version sets up the Orchestrator (your account and the connection to GitHub), manages your projects, their GitHub repositories and their tickets, connects the machines where agents work, and runs agents on tickets: you start a run, watch it live and answer its questions. The agent's work goes to GitHub as a pull request, whose automatic checks the agent fixes when they fail; the Quality agent reviews it when you ask; once you merge it on GitHub, the ticket is done and its branch deleted.

## Pages

- [Getting started](getting-started.md): install the Orchestrator on Windows (WSL), create your account and connect GitHub.
- [Connect GitHub](github-token.md): create the GitHub token, what each permission is for, replace the token.
- [Needs you](needs-you.md): the home page, and what to do for each item it shows.
- [Requests](requests.md): describe what you want in your own words, for a project or a new one, and add comments.
- [Projects](projects.md): create a project with a new repository or link one of yours, branch protection, missing harness elements, a setup that fails, archive a project.
- [Tickets](tickets.md): the board, create and edit tickets, the assignee, dependencies and blocked tickets, comments, tickets proposed by agents, cancel, mark as done manually, reopen.
- [Import tickets](import-tickets.md): create several tickets at once from a file Claude writes for you, the file's format, and what to ask Claude.
- [Runs](runs.md): start an agent on a ticket, watch it live, answer its questions, stop or resume it, usage limits, and where its work is.
- [Agents](agents.md): the Architect and the Web Developer, what each one does and may run.
- [Machines](machines.md): add your Claude account and the computers where agents work, install the daemon, keep WSL running, capabilities, disable and revoke a machine, fix a machine's problems.
- [Activity](activity.md): the event log, everything that changed in plain words, and its filters.
- [Settings](settings.md): change a limit, override a limit for one project, and the reference of every setting.
- [Reset a forgotten password](reset-password.md)
- [Back up your secret key](secret-key.md)
- [Open the Orchestrator from another device](network-access.md)

## Search

Type words in "Search Help" to list the pages containing all of them.
