# Activity

**Activity** in the menu shows what agents are doing and what happened in the Orchestrator: [Live runs](#live-runs), the [Queue](#queue), the run [History](#history) and the [Event log](#event-log).

## Live runs

Every run in progress, oldest first, including runs waiting for your answer or paused by a usage limit (their status says so). Each one shows:

- its ticket, agent and machine, its status, the time spent working and waiting, and its estimated usage. The waiting time says what the run waited for: "waiting 1 h 5 min (for you 5 min, for CI 1 h)", with **for you** (your answer to its question), **for CI** (GitHub's checks of its pull request) and **for the usage limit** (paused at the Claude usage limit); a part with no time is left out;
- the agent's latest progress line;
- **Now**: the latest entry of its log, what the agent is doing at this moment. It changes as the agent works, without reloading. **Open the run and its full log** shows everything (see [Watch a run](runs.md#watch-a-run));
- **Stop run**, and **Resume** for a paused run (see [Runs](runs.md));
- **Watch it in a terminal**: a command to type on that machine, `orchestrator-daemon attach <run>`, which shows the agent's Claude Code session as it works, without letting you type in it.

When no run is in progress, the section says so.

## Queue

What the scheduler starts next, in its order, and why each one is not running yet (see [What starts by itself](runs.md#what-starts-by-itself)). Looking at it starts nothing: it only shows.

**Each Claude account first**, on its own line: its state (**Available**, **Paused** or **Limited until** a time), its window ("in its window until 7:00 AM"), how many runs it has now against its **Runs at the same time** ("0 of 1 run at a time"), and its day so far against its daily budget ("Today: working 45 min · estimated usage $1.20 of $5.00 · 3 runs."). When it cannot start a run, the line says why:

- "Starts no run by itself until its window opens at 10:00 PM. Run now still starts one.";
- "Starts no run by itself: its daily budget is used for today, until 12:00 AM. Run now still starts one.";
- "Starts no run: you stopped new runs on it. Resume it to let the scheduler start runs again.", with the **Resume** button on the line (**Stop new runs** otherwise);
- "Starts no run until its usage limit resets.";
- "Starts no other run: it already runs its maximum of 1 run at a time.".

**Then each ticket waiting**, numbered in the order the scheduler takes them: its ticket (a link to its page), what would start ("Implement", "Fix after review", "Review by Quality", "Resume its paused run") with what places it ("high priority", "1 ticket waits for it", "after a failed attempt"), then why it is not running, in the words **Run now** would use. For example:

- "No machine can take the run: Laptop: its Claude account Personal is outside its window until 10:00 PM." The ticket starts when the window opens;
- "This ticket waits for WEB-3, which is not done yet.";
- "Held: you stopped its run. Run now releases it and starts it." (a review you stopped: "Start review releases it and starts it."). A held ticket's line always says how to release it;
- "The Claude account Personal reached its usage limit. You can resume after 3:45 PM." for a paused run, or "Paused on a possible usage limit: the scheduler resumes it at 4:10 AM, 2 hours after it paused.";
- "The ticket's branch has 2 commits not on GitHub, only on machine Laptop, and it is offline since 3:12 PM. The run can only continue there.";
- "Waiting for you in Needs you: …", for a ticket with an item to handle first, such as "it could not start on Laptop" or "the scheduler resumed its run as many times as Most resumes per run allows, and it still hits a usage limit";
- "The scheduler starts it at its next check, on machine Laptop." when nothing stops it: it starts within **Scheduler check interval**.

A line has the button that starts it now, **Run now** (**Start review** for a review, **Resume** for a paused run), when that button can help: on a ticket the scheduler would start at its next check, and where the button goes past what stops it (outside the window, the daily budget used, held, a machine left out after its failures, a paused run's wait, reviews not started by themselves). It goes through the same checks as on the ticket page: a ticket that cannot start shows the reason under the button, and one that starts opens its run page.

A line without the button waits for something you do elsewhere: the ticket it waits for done (or the dependency removed), an assignee, the project or GitHub set up again, **Try again** on a stopped ticket, the button of its item in "Needs you", or the account or a machine available again.

**It follows by itself**, without reloading: the queue is read again at every change of a ticket, a project, a run, a machine, a Claude account, a setting, the GitHub connection or an agent, at the time a line names (a window opening, a limit or a wait ending, the day's end), and at least every minute.

When nothing waits, it says "Nothing is waiting: no ticket in To do or In review, and no paused run, for the scheduler to start."

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
