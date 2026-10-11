# Agents

Agents are the AI workers of the Orchestrator. Each one is Claude Code, running on one of your machines, with a role: what it is for, the instructions it follows, and the commands it may use. You choose which agent should do a ticket with its **Assignee** (see [Tickets](tickets.md#assignee)).

This version has three agents: two that do the work of tickets, and **Quality**, which reviews it. More agents, and a screen to read and change them, come in a later version.

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

## Quality

Reviews the work another agent submitted for a ticket, as a demanding reviewer would if they read code: does the change do what the acceptance criteria say, and nothing unrelated; do the tests really test it; does the user documentation describe the change for someone who never reads code; does the code follow the project's `CLAUDE.md`. It then approves the work or asks for changes, with points the agent can act on.

Quality never changes the work: it may read the project, see the changes, and run its tests and build, but not edit a file, commit, or move the branch. When CI passed on GitHub it does not run the tests again unless it has a reason; when no CI ran, it runs them itself. It is never a ticket's assignee, and never reviews a ticket it implemented. You start a review with **Start review** on a ticket **In review**, or skip it with **Skip review**: see [Review by Quality](tickets.md#review-by-quality). A review uses one Claude Code session; a review that does not finish never counts as a failed attempt.

## What every agent follows

Every agent works on one ticket at a time, in its own copy of the project on your machine. It:

- reads the project's `CLAUDE.md` first;
- runs one command at a time, so a refusal names the command really refused;
- talks to you only through the Orchestrator: a short line showing what it is doing, notes, and questions that appear in **Needs you**;
- never sends anything to GitHub itself.

The Architect and the Web Developer also:

- change files with Claude Code's editing tools, and save their work in commits on the ticket's branch;
- end their work in one of three ways: they say the ticket is finished (with a report on each acceptance criterion), ask you a question and wait, or give up with the reason.

Quality changes no file itself and commits nothing (what installing, building and testing the project leave behind is expected). It ends its review in one of four ways: it approves the work, asks for changes, asks you a question and waits, or gives up with the reason. What it finds goes into its approval or its points, not into separate notes.

## What an agent may run

Each agent has a list of the commands it may run: the package managers (`npm`, `pnpm`, `yarn`, `npx`) and `node`, the Git commands that stay on your machine (see changes, commit, and from version 0.4.0 bring the project's latest changes into the ticket's branch with `git merge origin/main`), and simple file commands (list, copy, move, create a folder). It may also read and edit the project's files, and search the web and read web pages to look up how a tool works. Each agent is told this list. Anything else is refused at once. The agent does not try another way: it asks you, but only about what you can decide (what the result should be, information it lacks, whether the ticket can be done another way), never to allow a command. When the ticket really needs a command it may not run, it says so in plain words, and asks you how to go on or gives up the ticket. Claude Code itself also lets through some commands it considers read-only, such as `od`, which shows a file's bytes; the refusals of [Agents on your own user](machines.md#agents-on-your-own-user) apply to them all the same.

This list saves time and keeps agents on task, but it does not protect your computer: see "Agents on your own user" in [Machines](machines.md#agents-on-your-own-user).

## Versions

Each agent has a version. It goes up when a new version of the Orchestrator changes the agent's instructions, its list of commands, or the rules it follows (those every agent follows, and those of the agents that do the work or of Quality). The Activity page records it ("Agent profile updated").
