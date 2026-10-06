# Runs

A **run** is one agent working on one ticket, on one of your machines. You start it with **Run now**, watch it live, answer its questions, and find its work on a branch of that machine.

## Before a first run

You need:

- a Claude account and a machine connected with it (see [Machines](machines.md));
- a project whose setup is **Ready** (see [Projects](projects.md));
- a ticket in **To do** with an **Assignee**, for example the **Web Developer** (see [Assignee](tickets.md#assignee)), and not waiting for another ticket (see [Blocked tickets](tickets.md#blocked-tickets)).

## Try it with a small ticket

Every run uses your Claude account's usage, the same quota as your own use of Claude. To try the Orchestrator, or a machine you just connected, start with a ticket so small that the agent needs only a few steps. This one also shows a question and a ticket proposed by the agent:

- **Type**: **Documentation**
- **Title**: `Add one line to README.md`
- **Description**: `Before changing anything, ask me with ticket_ask which line to add. Add the line I give you at the end of README.md and commit it. Also propose one ticket with ticket_create: title "Add a CONTRIBUTING.md file", type docs, assignee web_dev. Do nothing else.`
- **Acceptance criteria**, two of them, each in its own box (click **Add a criterion** for the second):
  1. `README.md ends with the line given in the answer`
  2. `A ticket "Add a CONTRIBUTING.md file" was proposed`
- **Assignee**: **Web Developer**

When the agent asks, answer `Add this line: Checked by the Orchestrator.` Such a run is usually one session with two messages (the ticket, then your answer), and about 10 to 20 short steps of the agent.

## Start a run

Open the ticket and click **Run now**. The Orchestrator chooses a machine that can take the run and sends the ticket to it; the run page opens. The ticket moves to **In progress**.

When the run cannot start, the ticket page says why, in plain words. The most common reasons:

- **Choose an assignee first**: edit the ticket and choose the agent.
- **This ticket waits for …**: finish or remove the tickets it waits for.
- **No machine can take the run**: each machine is listed with its reason, for example "offline" or "its Claude account reached its usage limit". Start the machine's daemon, or wait for the limit to reset.
- **The ticket's work is on machine …**: an earlier run left commits on that machine, and only that machine can go on with them. Start it again (see [Where the work is](#where-the-work-is)).
- **The Claude account already runs its maximum**: wait for a run to finish, or raise the account's **Runs at the same time** in **Machines**.
- **This ticket is too large for an agent's first message**: shorten its description or its acceptance criteria.

## Watch a run

The screens update on their own while you look at them: you never need to reload. If the connection drops (a phone going to sleep, a network change), they catch up as soon as it comes back.

- The **board** shows the run on the ticket's card: running, paused or waiting for you, on which machine, with the agent's latest progress line.
- The **ticket page** shows the run in progress with its progress line and times, and **Watch the run live**.
- **Activity > Live runs** shows every run in progress at once, with what each agent does now: its latest log entry, updated as it works. See [Live runs](activity.md#live-runs).
- The **run page** shows:
  - its status, with the reason when it is paused or has failed;
  - the agent, the machine and the Claude account;
  - the time spent **working**, and **waiting** for you or for the usage limit;
  - the **estimated usage**: what the run would cost in US dollars, as Claude Code estimates it. With a Pro or Max plan you pay nothing more: it only helps compare runs;
  - the agent's latest progress line, and its outcome at the end;
  - the **log**: what the agent writes, each tool it uses with a short input, the results (long ones shortened, see **Longest stored log entry** in [Settings](settings.md#runs)), and the messages sent to it. Passwords and tokens are hidden.

The agent sends a progress line when it moves to another part of the work. A new one is shown at most once per **Progress update interval** (60 seconds by default).

The **Runs** list of the ticket page shows every run of the ticket, newest first, with its result, and **Failed attempts**: the runs that failed in a way that counts (see [When a run ends](#when-a-run-ends)).

## Questions

When the agent needs a decision only you can make, it asks a question. The ticket moves to **Waiting for you**, and the question appears in a yellow box on the ticket page and on the run page.

1. Read the question.
2. Write your answer in **Your answer**. Markdown is allowed.
3. Click **Send answer**.

The answer is added to the ticket's timeline, the ticket goes back to **In progress** and the agent goes on:

- within the **Waiting run lifetime** (30 minutes by default), the agent receives the answer at once, in the same session;
- after it, the agent's session was closed to free the machine; your answer starts it again on the same machine, where it finds its work and your answer;
- if that machine is offline, the run fails because of it (this does not count as a failed attempt), the ticket goes back to **To do**, and your answer stays in the timeline: the next run reads it.

## Stop a run

On the ticket page or the run page, click **Stop run**, then confirm. The agent stops at once and the ticket goes back to **To do**. The branch and its commits stay on the machine, and the next run goes on from them. From version 0.4.0 the machine also sends the commits GitHub does not have yet to the ticket's branch on GitHub, once the agent's programs are stopped (see [Where the work is](#where-the-work-is)). A run you stop never counts as a failed attempt.

If the machine is offline, the run is marked as failed because of that, and its session is stopped when the machine reconnects.

## Usage limits

Your Claude plan limits how much agents can work in a period. When a run reaches the limit, it is **paused**: its work is kept, and it does not count as a failed attempt.

- **Claude usage limit reached: you can resume after 3:45 PM**: the machine recognised Claude's usage limit message. The run and the Claude account wait until the limit resets: the time Claude gave or, when it gave none, **Quota wait when the reset time is unknown** later; the time then shows "(estimated)". **Resume** becomes available only at that time, and no other run starts on that account until then.
- **Run paused: possible Claude usage limit** (a *suspected* limit): the agent stopped on an error that may be the usage limit, but may also be Claude being overloaded or a network problem. The account is not marked as limited, and you can click **Resume** at once: the run may pause again if it was the limit.

In this version, a paused run never resumes by itself. [Needs you](needs-you.md#agents-work) lists it. To resume, click **Resume** there, on the ticket or on the run. The agent picks up where it stopped, on the same machine; if that machine cannot take it now, the page says why and the run stays paused.

## When a run ends

- The agent reports its work done, every acceptance criterion met, with its commits: the ticket moves to **In review**. In this version, **In review** means the work is finished and waits for you to check it. The ticket page shows the **Agent's report**: its summary, and for each acceptance criterion whether it is met and why.
- The agent gives up, runs out of time, or its session stops unexpectedly: the run **fails**, the ticket goes back to **To do** with a comment saying why, and **Failed attempts** goes up by one. The run's page says why, with the machine's own words when it gave some (for example "Downloading the project from GitHub took longer than Longest push (60 seconds, in Settings > Limits)", see [Machines > Troubleshooting](machines.md#troubleshooting)).
- Some failures never count as a failed attempt: a run you stopped, a machine offline or revoked, a machine whose Claude Code is too old, a machine that could not start Claude Code in a process scope (see [Process scopes](machines.md#process-scopes)), or a machine that did not confirm the start in time.

## Check finished work

When an agent finishes, its ticket is **In review** and [Needs you](needs-you.md#agents-work) lists it as **Work finished: check it**, with the agent's summary. Read the summary, the **Agent's report** and the commits on the ticket page (see [Where the work is](#where-the-work-is)), then:

- if the work is right, click **Mark as done manually** and say why (see [Mark as done manually](tickets.md#mark-as-done-manually));
- if something must change, click **Request changes**, write what should change (required), and confirm. The ticket goes back to **To do** with your comment. Its branch and commits are kept and it does not count as a failed attempt. The next dialog offers **Run now**: click it to start the next run at once, or **Later** to start it from the ticket page. The next run continues the earlier commits, on the same machine, and reads your comment first. If it cannot start (the account is limited, the machine is offline), the dialog says why, as **Run now** does on the ticket page.

## Where the work is

Agents commit their work on the ticket's branch, for example `t/12-contact-form`. The branch lives on the machine that ran the agent. From version 0.4.0 the machine also pushes it to GitHub, only that branch and never by force: when the agent submits its work, and when a run ends without a finished submission (the agent gave up, ran out of time or reminders, its session stopped, you stopped the run or cancelled the ticket) while the branch has commits GitHub does not have, so that work is not lost. That last push is a best effort: when it fails (GitHub unreachable, or the branch changed on GitHub meanwhile), the run's outcome is the same and the commits stay on the machine. If the branch changed on GitHub and contains the machine's commits (for example after GitHub's **Update branch**), the next run on that machine starts from GitHub's branch.

The ticket page shows **Branch**: its name, "on machine Laptop, not on GitHub yet", and the commits of the last run that reported them, newest first. The next run of the ticket goes on from them, on that same machine: if it is offline, **Run now** says so.

On the machine itself, `orchestrator-daemon status` lists every ticket branch kept there, for each repository, with its latest commit and the commits not on GitHub yet. It works whether the daemon runs or not, and changes nothing. If that machine was revoked, the next run starts again from the project's default branch on another machine, and a comment says how many commits were lost.
