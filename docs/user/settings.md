# Settings

**Settings** holds the GitHub connection (see [Connect GitHub](github-token.md)), **Limits**: the limits and timeouts of the Orchestrator, each with a default you can change, and the **Time zone**.

## Set the time zone

The Claude accounts' windows, the day of their daily budget and their runs of the day are read in the Orchestrator's time zone. In **Settings** > **Time zone**, your browser's time zone is filled in until you save one; choose another if the Orchestrator should follow a different one, then click **Save the time zone**. Until you save it, the Orchestrator uses UTC, and each account's page says so. Summer and winter time are followed by themselves. See [Keep Claude usage for yourself](machines.md#keep-claude-usage-for-yourself).

## Change a limit

1. Open **Settings**, then **Limits**. Limits are grouped: login and sessions, GitHub, projects, tickets, runs, machines and scheduler.
2. Each limit shows what it does, its value and its default. Type a new value in **Value** and click **Save**. The value must be a whole number within the allowed range listed in the [reference](#settings-reference) below; if it is not, the field says which numbers are allowed.
3. To go back to the default, click **Reset to default**. The button is available only when you have saved a value of your own.

Some limits come in pairs that must stay in order: **Longest login delay** cannot be less than **First login delay**, **Longest quota wait** cannot be less than **Quota wait when the reset time is unknown**, and **Machine offline after** must be at least twice the **Heartbeat interval** (so one lost heartbeat never shows a machine offline). A value or a **Reset to default** that would break this is refused, naming both with their values: change the other one first.

Two limits of tickets are tied together: **Most acceptance criteria** times **Longest acceptance criterion** is at most 20,000 characters, so the acceptance criteria of any ticket fit in the first message an agent receives (for example 20 criteria of 500 characters, or 40 of 500). A value or a **Reset to default** going above it is refused, naming both limits, their values and the 20,000 characters: lower the other one first.

What a change affects:

- It applies to what happens next, without restarting anything. Work already started keeps the values it started with. For example, a new **Session lifetime** applies to your next login; the session you are using keeps its end date.
- Existing tickets and comments keep their text when you lower a length limit. When you edit one of them, it must fit the new limit: the message names the field that is too long.
- Every change is recorded in the [event log](activity.md#event-log).

Limits marked "Used from version ..." in **Settings > Limits**, and "(from version ...)" in the reference below, belong to features of later versions (the scheduler from version 0.5.0, plans from version 0.6.0). You can already set them, but they change nothing yet; the mark goes away in the version that uses them.

## Override a limit for one project

Some limits can have a different value for one project: the reference below says **Yes** under "Per project".

1. Open the project, click **Project settings**, then find **Limits for this project**.
2. Each limit says whether the project uses the global value (the one in **Settings > Limits**) or its own value. Type a value and click **Save**: it applies to this project only.
3. **Reset to default** removes the project's own value: the project uses the global value again, and follows it when you change it.

The limits of an archived project cannot be changed: unarchive it first (see [Archive a project](projects.md#archive-a-project)). In version 0.4.0, every limit a project can override already changes something (**Most tickets an agent creates per run**, **Failed attempts before asking you**, **CI wait at submission**, **Wait for CI to start**, **Most CI failures per run** and **Most review rounds per ticket**), except **Most tickets per plan**, which belongs to plans (version 0.6.0).

## Settings reference

### Login and sessions

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Session lifetime | 30 days | 1 to 365 | No | How long a login lasts before you must log in again. |
| Failed logins before a delay | 5 failures | 1 to 100 | No | Failed logins allowed for one username or one address before the next attempt must wait. |
| First login delay | 10 seconds | 1 to 3,600 | No | Wait after the first failure over the limit; it doubles with each further failure. |
| Longest login delay | 900 seconds | 1 to 86,400 | No | The wait between login attempts never goes above this. |
| Failed login memory | 60 minutes | 1 to 10,080 | No | Failed logins older than this are forgotten. |

### GitHub

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| GitHub token expiry warning | 14 days | 1 to 90 | No | "Needs you" warns this many days before the GitHub token expires. |
| GitHub request timeout | 15 seconds | 1 to 300 | No | How long the Orchestrator waits for GitHub to answer one request. |
| GitHub clock tolerance | 120 seconds | 0 to 3,600 | No | Allowed difference between this computer's clock and GitHub's, when Try again checks whether a repository was created by an earlier attempt. |
| GitHub check interval | 60 seconds | 15 to 600 | No | How often the Orchestrator asks GitHub about tickets that wait on it, such as a submission waiting for its CI result, or a pull request waiting to be merged. |

### Tickets

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Longest ticket title | 200 characters | 1 to 1,000 | No | Most characters in a ticket title. |
| Longest ticket description | 20,000 characters | 1 to 100,000 | No | Most characters in a ticket description. |
| Most acceptance criteria | 20 criteria | 1 to 100 | No | Most acceptance criteria on one ticket. |
| Longest acceptance criterion | 500 characters | 1 to 5,000 | No | Most characters in one acceptance criterion. |
| Longest comment | 20,000 characters | 1 to 100,000 | No | Most characters in one comment. |
| Most tickets per plan (from version 0.6.0) | 15 tickets | 1 to 100 | Yes | A plan proposing more tickets than this is refused. |
| Most tickets an agent creates per run | 3 tickets | 0 to 20 | Yes | Tickets an agent may create during one run, outside a plan. |
| Failed attempts before asking you | 2 attempts | 1 to 10 | Yes | After this many failed attempts on a ticket, it waits for you instead of trying again. |
| Machine failures before asking you (from version 0.5.0) | 2 failures | 1 to 10 | No | After this many failures in a row caused by a machine, not by the ticket's work, the scheduler stops starting the ticket on that machine and asks you. See [When a machine keeps failing a ticket](runs.md#when-a-machine-keeps-failing-a-ticket). |
| CI wait at submission | 20 minutes | 1 to 240 | Yes | How long a run waits for CI on GitHub after the agent's work is accepted. When it is reached, the run stops without counting as a failed attempt, and Needs you offers Check CI again, or Run now when CI had failed or the pull request conflicts. |
| Wait for CI to start | 5 minutes | 1 to 60 | Yes | When no CI run or status appears on GitHub for this long after the pull request is open, the submission passes as "No CI found" (unless the pull request conflicts with its base branch, or is closed on GitHub). |
| Most CI failures per run | 2 failures | 1 to 10 | Yes | How many CI failures an agent gets back to fix in one run; a conflict with the default branch counts as one. One more ends the run as a failed attempt. |
| Most review rounds per ticket | 2 rounds | 1 to 10 | Yes | How many times Quality may ask for changes on one ticket before it waits for you. One request more is applied, then stops the ticket until you use Try again, Cancel or Mark as done manually; Try again and Reopen count the rounds from 0 again. Your own Request changes never counts. See [Too many review rounds](tickets.md#too-many-review-rounds). |
| Longest CI log excerpt | 4,000 characters | 500 to 20,000 | No | How much of each failed CI step's log an agent receives, keeping its end. |
| Longest CI log read | 20 megabytes | 1 to 500 | No | How much of a failed CI job's log the Orchestrator downloads from GitHub to find each failed step's part. Beyond it, the agent gets the end of what was read and is told so. |

### Runs

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Waiting run lifetime | 30 minutes | 1 to 1,440 | No | How long a run stays alive after asking you a question; after that it stops and continues when you answer. |
| Longest run | 90 minutes | 1 to 1,440 | No | Working time after which a run is stopped. Time waiting for CI, for you or for the quota does not count. |
| Idle timeout | 10 minutes | 1 to 120 | No | A run whose agent shows no activity for this long is stopped. Time waiting for you, for CI or for the quota, and time running a command, does not count. |
| Most reminders per run | 2 reminders | 0 to 10 | No | Reminders sent to an agent that stops without finishing, before the run is stopped. |
| Session start timeout | 30 seconds | 5 to 600 | No | How long a machine waits for Claude Code to start a run's session; after that the run fails (a startup dialog or a change in Claude Code is likely). |
| MCP call timeout | 30 seconds | 5 to 300 | No | How long a machine waits for the Orchestrator's answer to an agent's tool call; after that the agent is told to try again later. Must be below the Claude Code MCP tool timeout. |
| Claude Code MCP tool timeout | 120 seconds | 10 to 1,800 | No | How long Claude Code waits for an Orchestrator tool call before giving up on it. Must be above the MCP call timeout, so the machine always answers first: a value breaking this is refused, naming both limits and their values. |
| Longest push | 60 seconds | 10 to 600 | No | How long a machine lets one push of a ticket branch take before stopping it; a push stopped this way is reported as "GitHub could not be reached". It also limits each download of the project from GitHub when a run starts: the first download on a new machine is the longest, and a run whose download is stopped fails without counting as a failed attempt, its page naming this limit (see [When the project cannot be downloaded from GitHub](machines.md#when-the-project-cannot-be-downloaded-from-github)). The MCP call timeout plus this limit must stay below the Claude Code MCP tool timeout, because the push at submission happens while the agent waits for its tool call: a value breaking this is refused, naming the three limits and their values. |
| Machine answer timeout | 60 seconds | 5 to 600 | No | How long the Orchestrator waits for a machine to confirm it starts a run; without an answer the run is cancelled and does not count as a failed attempt. |
| Progress update interval | 60 seconds | 0 to 3,600 | No | Shortest time between two new progress lines shown for a run. The agent's updates are never refused: the latest one is shown when this time has passed. |
| Longest stored log entry | 2,000 characters | 100 to 100,000 | No | Most characters kept of one entry of a run's log, such as a command's output; the rest is cut and the cut is marked. |

### Machines

What these limits apply to: see [Machines](machines.md).

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Enrollment code lifetime | 15 minutes | 1 to 1,440 | No | How long the code shown by **Add machine** can be used to connect the machine; after that, click **New enrollment code** on the machine's page. |
| Heartbeat interval | 15 seconds | 5 to 120 | No | How often a connected machine tells the Orchestrator it is still there. A machine uses the value it received when it connected. |
| Machine offline after | 60 seconds | 15 to 600 | No | A machine that sends nothing for this long is shown offline. At least twice the heartbeat interval. |

### Scheduler

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Scheduler check interval (from version 0.5.0) | 30 seconds | 5 to 600 | No | The scheduler looks for work to start at least this often. |
| Quota wait when the reset time is unknown | 60 minutes | 1 to 1,440 | No | When the Claude usage limit is reached without a reset time, the account waits this long; the wait doubles each time the limit is still reached. |
| Longest quota wait (from version 0.5.0) | 240 minutes | 1 to 2,880 | No | The doubling wait above never goes above this. |
