# Agents

Agents are the AI workers of the Orchestrator. Each one is Claude Code, running on one of your machines, with a role: what it is for, the instructions it follows, and the commands it may use. You choose which agent should do a ticket with its **Assignee** (see [Tickets](tickets.md#assignee)).

This version has two agents. More agents, and a screen to read and change them, come in a later version.

## Architect

Owns the structure of each project and keeps it working for the other agents: the choice of tools, the folders, the checks that run on every change (tests, lint, build), and `CLAUDE.md`, the file every agent reads first. Assign it:

- the first ticket of a new project, which sets it up;
- **Spike** tickets, a short investigation that ends with a written recommendation;
- **Chore** tickets that change the structure: upgrading tools, reorganising code.

It records every important technical choice in the project's decision records (ADRs), and does not build product features.

## Web Developer

Builds features and fixes bugs on web apps and websites. Assign it **Feature** and **Bug** tickets of those projects. For each ticket it:

- does what the acceptance criteria say, and nothing more;
- writes tests, and for a bug, first a test that shows the bug;
- updates the user documentation of the project when something visible changes;
- asks you rather than making a new technical decision alone, and proposes a new ticket for a problem it finds outside its ticket.

## What every agent follows

Every agent works on one ticket at a time, in its own copy of the project on your machine. It:

- reads the project's `CLAUDE.md` first;
- talks to you only through the Orchestrator: a short line showing what it is doing, notes, and questions that appear in **Needs you**;
- saves its work in commits on the ticket's branch, and never sends anything to GitHub itself;
- ends its work in one of three ways: it says the ticket is finished (with a report on each acceptance criterion), asks you a question and waits, or gives up with the reason.

## What an agent may run

Each agent has a list of the commands it may run: the package managers (`npm`, `pnpm`, `yarn`, `npx`) and `node`, the Git commands that stay on your machine (see changes, commit), and simple file commands (list, copy, move, create a folder). It may also read and edit the project's files, and search the web and read web pages to look up how a tool works. Anything else is refused at once, and the agent asks you instead of trying another way. Claude Code itself also lets through some commands it considers read-only, such as `od`, which shows a file's bytes; the refusals of [Agents on your own user](machines.md#agents-on-your-own-user) apply to them all the same.

This list saves time and keeps agents on task, but it does not protect your computer: see "Agents on your own user" in [Machines](machines.md#agents-on-your-own-user).

## Versions

Each agent has a version. It goes up when a new version of the Orchestrator changes the agent's instructions, its list of commands, or the rules every agent follows. The Activity page records it ("Agent profile updated").
