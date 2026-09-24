# Settings

**Settings** holds the GitHub connection (see [Connect GitHub](github-token.md)) and **Limits**: the limits and timeouts of the Orchestrator, each with a default you can change.

## Change a limit

1. Open **Settings**, then **Limits**. Limits are grouped: login and sessions, GitHub, projects, tickets, runs and scheduler.
2. Each limit shows what it does, its value and its default. Type a new value in **Value** and click **Save**. The value must be a whole number within the allowed range listed in the [reference](#settings-reference) below; if it is not, the field says which numbers are allowed.
3. To go back to the default, click **Reset to default**. The button is available only when you have saved a value of your own.

Some limits come in pairs that must stay in order: **Longest login delay** cannot be less than **First login delay**, and **Longest quota wait** cannot be less than **Quota wait when the reset time is unknown**. A value or a **Reset to default** that would break this is refused, naming both: change the other one first.

What a change affects:

- It applies to what happens next, without restarting anything. Work already started keeps the values it started with. For example, a new **Session lifetime** applies to your next login; the session you are using keeps its end date.
- Existing tickets and comments keep their text when you lower a length limit. When you edit one of them, it must fit the new limit: the message names the field that is too long.
- Every change is recorded in the [event log](activity.md#event-log).

Limits marked "Used from version ..." belong to features of later versions (agents, runs, the scheduler). You can already set them, but they change nothing yet.

## Override a limit for one project

Some limits can have a different value for one project: the reference below says **Yes** under "Per project".

1. Open the project, click **Project settings**, then find **Limits for this project**.
2. Each limit says whether the project uses the global value (the one in **Settings > Limits**) or its own value. Type a value and click **Save**: it applies to this project only.
3. **Reset to default** removes the project's own value: the project uses the global value again, and follows it when you change it.

The limits of an archived project cannot be changed: unarchive it first (see [Archive a project](projects.md#archive-a-project)). In this version, only limits of later versions can be overridden per project.

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

### Projects

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Setup progress refresh | 2 seconds | 1 to 60 | No | How often the project page refreshes while its repository is being set up. |

### Tickets

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Longest ticket title | 200 characters | 1 to 1,000 | No | Most characters in a ticket title. |
| Longest ticket description | 20,000 characters | 1 to 100,000 | No | Most characters in a ticket description. |
| Most acceptance criteria | 20 criteria | 1 to 100 | No | Most acceptance criteria on one ticket. |
| Longest acceptance criterion | 500 characters | 1 to 5,000 | No | Most characters in one acceptance criterion. |
| Longest comment | 20,000 characters | 1 to 100,000 | No | Most characters in one comment. |
| Most tickets per plan (from version 0.6.0) | 15 tickets | 1 to 100 | Yes | A plan proposing more tickets than this is refused. |
| Most tickets an agent creates per run (from version 0.3.0) | 3 tickets | 0 to 20 | Yes | Tickets an agent may create during one run, outside a plan. |
| Failed attempts before asking you (from version 0.4.0) | 2 attempts | 1 to 10 | Yes | After this many failed attempts on a ticket, it waits for you instead of trying again. |
| CI wait at submission (from version 0.4.0) | 20 minutes | 1 to 240 | Yes | How long a submitted ticket waits for its CI result before the attempt fails. |

### Runs

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Waiting run lifetime (from version 0.3.0) | 30 minutes | 1 to 1,440 | No | How long a run stays alive after asking you a question; after that it stops and continues when you answer. |
| Longest run (from version 0.3.0) | 90 minutes | 1 to 1,440 | No | Working time after which a run is stopped. Time waiting for CI, for you or for the quota does not count. |
| Idle timeout (from version 0.3.0) | 10 minutes | 1 to 120 | No | A run neither working nor waiting for something gets a reminder after this time, then is stopped. |
| Most reminders per run (from version 0.3.0) | 2 reminders | 0 to 10 | No | Reminders sent to an agent that stops without finishing, before the run is stopped. |
| Machine answer timeout (from version 0.3.0) | 60 seconds | 5 to 600 | No | How long the Orchestrator waits for a machine to confirm it starts a run; without an answer the run is cancelled and does not count as a failed attempt. |

### Scheduler

| Setting | Default | Allowed | Per project | What it does |
|---|---|---|---|---|
| Scheduler check interval (from version 0.5.0) | 30 seconds | 5 to 600 | No | The scheduler looks for work to start at least this often. |
| Quota wait when the reset time is unknown (from version 0.5.0) | 60 minutes | 1 to 1,440 | No | When the Claude usage limit is reached without a reset time, the account waits this long; the wait doubles each time the limit is still reached. |
| Longest quota wait (from version 0.5.0) | 240 minutes | 1 to 2,880 | No | The doubling wait above never goes above this. |
