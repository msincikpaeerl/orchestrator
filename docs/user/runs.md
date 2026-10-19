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
- **The ticket's branch has … commits not on GitHub, only on machine …**: an earlier run left commits on that machine that are not on GitHub, and only that machine can go on with them. Start it again (see [Where the work is](#where-the-work-is)).
- **The Claude account already runs its maximum**: wait for a run to finish, or raise the account's **Runs at the same time** in **Machines**.
- **This ticket is too large for an agent's first message**: shorten its description or its acceptance criteria.

You rarely need **Run now**: the scheduler starts runs by itself (below). **Run now** starts one at once, also outside the account's windows and over its daily budget.

## What starts by itself

From version 0.5.0 the Orchestrator's **scheduler** starts runs by itself, so tickets get done while you are away. It looks for work as soon as something changes (a ticket created or back in **To do**, a run ending, a machine connecting, a setting saved) and at least every **Scheduler check interval** (30 seconds by default, in [Settings](settings.md#settings-reference)).

**What it starts**, each time one Claude Code session from your Claude plan, exactly as you would with the button:

- a ticket in **To do** with an assignee, waiting for no other ticket: a run of its agent, as **Run now** does (one that addresses the request for changes, when Quality or you asked for some);
- a ticket **Ready for review**: Quality's review, as **Start review** does. If you do not want a review, use **Skip review** before it starts.

**In which order**: reviews first, then fixes after a request for changes, then new work. Within each of these, in this order:

1. a ticket whose last attempt failed (and counted as a failed attempt) goes behind the others, even a high-priority one;
2. then priority: high, then normal, then low;
3. then the tickets that the most other tickets wait for;
4. then the one waiting the longest.

Projects take turns, so one large project does not hold up the others.

**Where and how many**: only on a Claude account that can start a run: inside its windows, under its daily budget, not paused and not at its usage limit (see [Keep Claude usage for yourself](machines.md#keep-claude-usage-for-yourself)), and on a machine that can take the run, as for **Run now**. It starts one run per account at a time, until the account runs its **Runs at the same time**; the next ticket starts when a run ends.

**How you can tell**: the ticket's timeline says "Started by the scheduler: attempt 1 on machine Laptop." (for a review: "Started by the scheduler: Quality's review of attempt 1 on machine Laptop."), and Activity shows "the scheduler started a run".

**What it never starts by itself**, so nothing is started again and again without you:

- a ticket whose run you stopped with **Stop run**: it waits for your **Run now** (a review you stopped waits for **Start review**);
- a ticket stopped after repeated failures (see [When a ticket keeps failing](#when-a-ticket-keeps-failing)): a ticket gets at most **Failed attempts before asking you** failed runs (2 by default) before it waits for you;
- a ticket waiting for another ticket, also a cancelled one (see [A ticket waits for a cancelled ticket](tickets.md#a-ticket-waits-for-a-cancelled-ticket));
- a ticket with an item in [Needs you](needs-you.md) about its CI, its push or its download, or a review that did not finish, until you handle the item;
- a ticket on a machine that did not confirm its start in time, or refused it: that machine is left out for that ticket until you use **Run now** on it; another machine can still take the ticket;
- a run paused at a usage limit: it waits for your **Resume**.

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
  - the **Branch**: the ticket's branch on the run's machine as the run left it, with its commits. When the run ended because the machine could not download the project from GitHub, it says "No branch was made on machine …", or shows the branch as it was before the run when the machine already had it from an earlier run;
  - from version 0.4.0, while the agent's accepted work waits for CI on GitHub, the status **Waiting for CI** and a **CI** card (see [Waiting for CI](#waiting-for-ci) below);
  - from version 0.4.0, the **Latest refused submission**: when the checks refused the agent's work in this run, each check's result and why, in plain words (see [The checks](tickets.md#the-checks)). An agent refused again and again shows here what it keeps getting wrong. The latest refusal stays on the page after the work is accepted: the card then says "The agent then handed its work in again, and it was accepted on …", so it is never the run's outcome, which the run's status gives;
  - the **log**: what the agent writes, each tool it uses with a short input, the results (long ones shortened, see **Longest stored log entry** in [Settings](settings.md#runs)), and the messages sent to it. Passwords and tokens are hidden.

The agent sends a progress line when it moves to another part of the work. A new one is shown at most once per **Progress update interval** (60 seconds by default).

The **Runs** list of the ticket page shows every run of the ticket, newest first, with its result, and **Failed attempts**: the runs that failed in a way that counts (see [When a run ends](#when-a-run-ends)).

### Waiting for CI

From version 0.4.0, once the checks accept the agent's work, the run waits for CI: GitHub's automatic checks of the pull request (what the Orchestrator decides then is in [Tickets > Waiting for CI](tickets.md#waiting-for-ci)). The run's status reads **Waiting for CI**, on the run page, in Activity and on the board's card ("Waiting for CI on Laptop"). The run page's **CI** card says:

- which commit it waits for, with the pull request's number, since when, and the time after which the run stops without counting as a failed attempt (**CI wait at submission**); then when GitHub was last checked;
- while the pull request is not opened yet, that CI cannot start, and the time after which the run stops; the ticket page says why it is not opened;
- while nothing has appeared on GitHub, the time after which the work passes as "No CI found" (**Wait for CI to start**), unless the pull request conflicts with the default branch; after that time, that GitHub is still working out whether it conflicts;
- while nothing has appeared on GitHub and the pull request is closed on GitHub, that the work is not accepted as "No CI found" while it is closed: the run keeps waiting until you reopen the pull request, or until **CI wait at submission** ends it;
- when the pull request conflicts with the default branch, that GitHub started no CI and the work cannot be accepted: the agent is told to merge the default branch and resolve the conflict;
- when GitHub could not be checked at the latest check, since when and why: GitHub could not be reached, its request limit (with the time it allows requests again, when GitHub says), an answer that could not be read, the token, a permission missing, or GitHub's own words. The run keeps waiting and the Orchestrator asks again;
- each check of the commit on its own line, with **Not finished**, **Passed** or **Failed**, and a link "on GitHub" when GitHub gives one:
  - "CI · workflow": a workflow run is one run of a GitHub Actions workflow, a file in the project's `.github/workflows/` folder, named as the workflow names itself;
  - "deploy/preview · status": a status is a result another service reports on the commit, such as a deployment preview, named as that service names it.

Names and links come from GitHub, so they are shown as plain text, with tokens hidden. The agent can read the same result, with the part of the log of each failed step, through the Orchestrator's `ci_status` tool; it says which commit the result is for and when it was read.

**CI rounds.** When CI fails or the pull request conflicts, the result goes back to the agent in the same session (see [Tickets > Waiting for CI](tickets.md#waiting-for-ci)). Each result sent back is a **CI round**. Once the run ends, or while it works again after a round, the run page's **CI** card lists one line per result, the latest with its checks open and the earlier ones folded (click a line to open its checks):

| Line | Meaning |
|---|---|
| **Round 1 · commit … · Failed at …** (or **Conflicts with main at …**) **· sent back to the agent** | The result reached the agent, which fixed its work and handed it in again. It counts within **Most CI failures per run**. |
| **Not sent back · … · the run ended: one failure more than Most CI failures per run (2)** | The result that ended the run, counted as a failed attempt. |
| **Not confirmed · … · machine … did not confirm it received the result …; not counted** | The result was sent, but the machine never confirmed it before the run ended. It does not count. |
| **Not sent back · … · read on GitHub only after CI wait at submission was reached; not counted** | The result came too late for the agent. |
| **Not sent back · … · Downloading main from GitHub failed: …; not counted** | The machine could not take it, here because it could not download the default branch the agent was to merge. |
| **Commit … · Passed at …**, **No CI found at …**, **Not finished when CI wait at submission (20 minutes) was reached**, **Cancelled on GitHub … because the branch changed there** | How the run's last wait ended. |
| **Accepted later · Check CI again found CI passed at …** | You accepted the work with **Check CI again** (see [Tickets > Check CI again](tickets.md#check-ci-again)); after one failure too many, the run's failed attempt no longer counts. |

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

On the ticket page or the run page, click **Stop run**, then confirm. The agent stops at once and the ticket goes back to **To do**. The branch and its commits stay on the machine, and the next run goes on from them. From version 0.4.0 the machine also sends the commits GitHub does not have yet to the ticket's branch on GitHub, once the agent's programs are stopped (see [Where the work is](#where-the-work-is)). A run you stop never counts as a failed attempt. Stopping a run frees its Claude usage at once, and the ticket is not started again by itself: start it with **Run now** when you want (see [Keep Claude usage for yourself](machines.md#keep-claude-usage-for-yourself)).

If the machine is offline, the run is marked as failed because of that, and its session is stopped when the machine reconnects.

## Usage limits

Your Claude plan limits how much agents can work in a period. When a run reaches the limit, it is **paused**: its work is kept, and it does not count as a failed attempt.

- **Claude usage limit reached: you can resume after 3:45 PM**: the machine recognised Claude's usage limit message. The run and the Claude account wait until the limit resets: the time Claude gave or, when it gave none, **Quota wait when the reset time is unknown** later; the time then shows "(estimated)". **Resume** becomes available only at that time, and no other run starts on that account until then.
- **Run paused: possible Claude usage limit** (a *suspected* limit): the agent stopped on an error that may be the usage limit, but may also be Claude being overloaded or a network problem. The account is not marked as limited, and you can click **Resume** at once: the run may pause again if it was the limit.

In this version, a paused run never resumes by itself. [Needs you](needs-you.md#agents-work) lists it. To resume, click **Resume** there, on the ticket or on the run. The agent picks up where it stopped, on the same machine; if that machine cannot take it now, the page says why and the run stays paused.

## When a run ends

- The agent reports its work done, every acceptance criterion met, with its commits: the ticket moves to **In review**. **In review** means the work is finished and waits for a review by Quality, or for you to skip it (see [Review by Quality](tickets.md#review-by-quality)). The ticket page shows the **Agent's report**: its summary, for each acceptance criterion whether it is met and why, the files it lists, and from version 0.4.0 the result of each check and the pull request.
- The agent gives up, runs out of time, or its session stops unexpectedly: the run **fails**, the ticket goes back to **To do** with a comment saying why, and **Failed attempts** goes up by one. The run's page says why, with the machine's own words when it gave some (for example "The workspace could not be prepared: …").
- Some failures never count as a failed attempt: a run you stopped, a machine offline or revoked, a machine whose Claude Code is too old, a machine that could not start Claude Code in a process scope (see [Process scopes](machines.md#process-scopes)), a machine that did not confirm the start in time, or, from version 0.4.0, a run whose branch could not be pushed to GitHub when the agent submitted its work, a run that reached **CI wait at submission**, a run whose CI GitHub cancelled because the branch changed there, and a run whose machine could not download the project from GitHub at its start (see [When the project cannot be downloaded from GitHub](machines.md#when-the-project-cannot-be-downloaded-from-github)). A run ended by one CI failure too many counts, unless **Check CI again** later finds CI passed for the same commit.

### When a ticket keeps failing

From version 0.4.0, **Failed attempts before asking you** (2 by default, in [Settings](settings.md#settings-reference), also per project) stops a ticket whose failed attempts reach it, so an agent that keeps failing does not use your Claude plan again and again. The run that fails last says so in its comment on the ticket: "It counts as a failed attempt: 2 failed attempts, as many as Failed attempts before asking you allows (2), so the ticket is stopped." The ticket stays in **To do**, shows **Stopped** on the board and on its page, and [Needs you](needs-you.md#agents-work) lists it as **Stopped after repeated failures**. **Run now** is refused while it is stopped: "This ticket is stopped after 2 failed attempts (Failed attempts before asking you: 2): use Try again, Cancel or Mark as done manually."

Read the comments of the failed runs in the timeline, and their run pages, to see why they failed: often something only you can fix (a missing tool on the machine, a ticket that asks too much in one go, a description that needs more detail). Then choose, on the ticket page or in Needs you:

- **Try again**: the ticket can go on. It starts no session and needs no confirmation: the failed attempts and the review rounds count from 0 again, and a dialog offers **Run now** at once (or **Later**).
- **Cancel the ticket**: the work is abandoned (see [Cancel a ticket](tickets.md#cancel-a-ticket)).
- **Mark as done manually**: the work is good enough as it is (see [Mark as done manually](tickets.md#mark-as-done-manually)).

Only the failures that count stop a ticket (see the list above). A ticket that had already failed more often with version 0.3.0 stops at its next failure that counts. When the last failure was one CI failure too many and **Check CI again** then finds CI passed for the same commit, the work is accepted and the ticket is no longer stopped (see [Check CI again](tickets.md#check-ci-again)).

## Check finished work

When an agent finishes and CI has passed, its ticket is **In review** and [Needs you](needs-you.md#agents-work) lists it as **Ready for review**: start a review by Quality, or skip it and check the work yourself (see [Review by Quality](tickets.md#review-by-quality)). A ticket left **In review** by version 0.3.0, without a pull request, is listed as **Work finished: check it**, with the agent's summary, and checked as below. Read the summary, the **Agent's report** with its **Checks**, and the commits on the ticket page (see [Where the work is](#where-the-work-is)). From version 0.4.0 the work is also on GitHub: **Pull request** on the ticket page opens its pull request, where GitHub shows every change and the automatic checks (see [Submission and the pull request](tickets.md#submission-and-the-pull-request)). Then:

- if the work is right, click **Mark as done manually** and say why (see [Mark as done manually](tickets.md#mark-as-done-manually));
- if something must change, click **Request changes**, write what should change (required), and confirm. The ticket goes back to **To do** with your comment. Its branch and commits are kept and it does not count as a failed attempt. The next dialog offers **Run now**: click it to start the next run at once, or **Later** to start it from the ticket page. The next run continues the earlier commits, on the machine holding them (any machine when they are all on GitHub), and reads your comment first; from version 0.4.0 it is a **Fix after review** run (see [The round after a request](tickets.md#the-round-after-a-request)). If it cannot start (the account is limited, the machine is offline), the dialog says why, as **Run now** does on the ticket page.

## Where the work is

Agents commit their work on the ticket's branch, for example `t/12-contact-form`. The branch lives on the machine that ran the agent. From version 0.4.0 the machine also pushes it to GitHub, only that branch and never by force: when the agent submits its work, and when a run ends without a finished submission (the agent gave up, ran out of time or reminders, its session stopped, you stopped the run or cancelled the ticket) while the branch has commits GitHub does not have, so that work is not lost. That last push is a best effort: when it fails (GitHub unreachable, or the branch changed on GitHub meanwhile), the run's outcome is the same and the commits stay on the machine. If the branch changed on GitHub and contains the machine's commits (for example after GitHub's **Update branch**), the next run on that machine starts from GitHub's branch.

The ticket page shows **Branch**: its name, where its commits are, and the commits of the last run that reported them, newest first.

| The page says | What it means | The next run |
|---|---|---|
| no commits reported yet | No run has reported commits, and nothing was pushed. | Any machine that can take it. |
| on machine Laptop, not on GitHub yet | The commits exist only on Laptop: nothing was pushed (always so for tickets started before version 0.4.0), or the push failed. When it failed, the page says when and why. | Only on Laptop. |
| every commit reported was on GitHub when machine Laptop last pushed or downloaded the branch | Every commit is on GitHub, as Laptop knew it: pushed by the Orchestrator, or downloaded from GitHub, such as the commit **Update branch** adds. The last push is shown with its date: "Last pushed to GitHub on … from machine Laptop". **Branch on GitHub** opens it. | Any machine that can take it: one that never ran the ticket downloads the branch from GitHub. A machine that already has the project is preferred. |
| N newer commits on machine Laptop, not on GitHub yet | The older commits are on GitHub, the newer ones exist only on Laptop, for example a commit the agent made after submitting its work. The two lists are shown apart. A branch with more than 500 commits lists the newest 500, and says how many older ones are not on GitHub either. | Only on Laptop. |
| on machine Laptop, not on GitHub yet: GitHub's branch has commits this machine does not have | The branch changed on GitHub since the Orchestrator's last push (a push made by hand, or **Update branch** while Laptop had newer commits), so Laptop's push was refused: the Orchestrator never overwrites GitHub's branch. | Only on Laptop. Until both branches are brought together, its pushes are refused again: the next run on Laptop does it with a merge (see [When the work cannot be pushed to GitHub](tickets.md#when-the-work-cannot-be-pushed-to-github)). |

A review never changes where the work is: it reads the branch as it is on GitHub, and leaves no commit on its machine.

When only one machine holds commits that are not on GitHub and it cannot take the run (offline, disabled, its account at its limit), **Run now** refuses and says so: "The ticket's branch has 2 commits not on GitHub, only on machine Laptop, and it is offline." Start that machine again.

**What "on GitHub" means.** The **Branch** section does not read the ticket's branch on GitHub itself: it knows what its machines pushed, and what they downloaded from GitHub when a run started. If the branch changes on GitHub (**Update branch**, a push by hand) or is deleted there, the section still shows the last push. The Orchestrator does read the ticket's pull request at each check of GitHub (every **GitHub check interval**), and uses it in three ways:

- when the pull request's latest commit is exactly the latest commit a machine reported, that machine's commits count as on GitHub, so **Run now** can take any machine, for example after a push the machine made but could not report;
- on **Awaiting merge**, when the pull request's latest commit is not the one Quality approved (or whose review you skipped), the **Pull request** section says so, with the commits added (see [When GitHub changes the pull request](tickets.md#when-github-changes-the-pull-request));
- **Start review** checks that the pull request's latest commit is still the one CI checked, and is refused when the branch was changed on GitHub (see [Review by Quality](tickets.md#review-by-quality)).

A deleted branch is not brought back: the next run on a machine that does not have the commits starts again from the project's default branch.

On the machine itself, `orchestrator-daemon status` lists every ticket branch kept there, for each repository, with its latest commit and the commits not on GitHub yet. It works whether the daemon runs or not, and changes nothing. If the machine holding commits not on GitHub was revoked, the next run starts on another machine, from the branch as last pushed to GitHub, or from the project's default branch when nothing was pushed, and a comment says how many commits were lost.
