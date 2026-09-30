# Activity

**Activity** in the menu shows what agents are doing and what happened in the Orchestrator: [Live runs](#live-runs), the queue (coming in a later version), the run [History](#history) and the [Event log](#event-log).

## Live runs

Every run in progress, oldest first, including runs waiting for your answer or paused by a usage limit (their status says so). Each one shows:

- its ticket, agent and machine, its status, the time spent working and waiting, and its estimated usage;
- the agent's latest progress line;
- **Now**: the latest entry of its log, what the agent is doing at this moment. It changes as the agent works, without reloading. **Open the run and its full log** shows everything (see [Watch a run](runs.md#watch-a-run));
- **Stop run**, and **Resume** for a paused run (see [Runs](runs.md));
- **Watch it in a terminal**: a command to type on that machine, `orchestrator-daemon attach <run>`, which shows the agent's Claude Code session as it works, without letting you type in it.

When no run is in progress, the section says so.

## Queue

Coming in a later version: the tickets waiting to run, and why each one is not running yet.

## History

Every run that ended, newest first: its ticket and attempt, agent, machine, how it ended, when, the time spent and the estimated usage. A failed run also says why it failed, for example "Failed: it ran out of time". Click a run to open its page and its log.

Filter the list with the fields above it:

- **Project** and **Agent**: only the runs of one project, or of one agent.
- **Outcome**: **Finished** (the agent submitted its work), **Failed** or **Cancelled** (stopped by you, or its ticket was cancelled or marked as done).
- **Ended from** and **Ended to**: only the runs that ended on these days, both days included.

**Clear run filters** shows every run again. The first page shows the 50 most recent runs; **Show older runs** shows the 50 before them.

## Event log

The event log lists everything that changed, newest first, each in plain words: "WEB-12 marked as done manually: “Works now”", "Session lifetime set to 7 days (was the default)". Under each event you see when it happened and who caused it:

- **You**: something you did in the Orchestrator.
- **Orchestrator**: something the Orchestrator did by itself, for example a step of a repository setup, or a delay after failed logins.
- **Server command**: a command run on the server, for example [resetting the password](reset-password.md).

Project keys and ticket numbers are links: click one to open the project or the ticket.

Titles, names and comments are quoted as plain text, on one line, and cut after about 120 characters (the cut ends with "…"). A quote is a link: click it to open the ticket or project page that shows the full text.

The log never shows your GitHub token, your password or any other credential.

The first page shows the 50 most recent events. Click **Show older events** at the bottom to see the 50 before them. Events that happen while you read do not move the pages: reload the page to see them at the top.

## Filter the event log

Use the fields above the list. The list updates as soon as you change one; each filter narrows the others.

- **Project**: only the events of one project, its tickets and its settings. Archived projects are in the list too. With "All projects", the log also shows the events about no project: logins, the GitHub connection, global settings, Claude accounts and machines.
- **Ticket number**: after choosing a project, type a ticket's number (`12` for `WEB-12`) to see only that ticket's events.
- **Kind**: only the events about projects, tickets, settings, Claude accounts, machines, the GitHub connection, login sessions or your owner account.
- **Event**: only one kind of event, for example "Ticket status changed" or "Setting changed".
- **From** and **To**: only the events of these days, both days included.

Click **Clear filters** to see everything again. The filters are part of the page's address, so you can bookmark a filtered log.

On the **Projects** list, **Last activity** gives the time of each project's most recent event; click it to open the event log filtered on that project.
