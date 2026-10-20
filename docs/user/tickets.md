# Tickets

A ticket is one piece of work on a project: a feature to add, a bug to fix, a page to write. Each ticket has a number made of the project's key and a count, for example `WEB-12`. Numbers are never reused.

You create tickets, and an agent does the work when you click **Run now** (see [Runs](runs.md)). Agents can also propose new tickets they found while working (see [Tickets proposed by agents](#tickets-proposed-by-agents)).

## The board

Open **Projects**, then a project: its tickets are on the project page, under **Tickets**, once the repository setup is **Ready**.

- Tickets are grouped by state: **To do**, **In progress**, **Waiting for you**, **In review** and **Awaiting merge**. See [Ticket states](#ticket-states).
- **Done** and **Cancelled** are closed at the bottom. Click one to open it.
- **Proposed** shows the tickets agents proposed, while there is at least one (see [Tickets proposed by agents](#tickets-proposed-by-agents)).
- Each card shows the ticket's number, title, type and assignee, **Blocked** when it waits for another ticket (see [Blocked tickets](#blocked-tickets)), **Stopped** when it was stopped after too many review rounds (see [Too many review rounds](#too-many-review-rounds)), **created by agent** for a ticket an agent proposed, and the run in progress with the agent's latest progress line (see [Watch a run](runs.md#watch-a-run)).
- The board updates on its own while you look at it.
- **Type** shows only tickets of one type. **Assignee** shows only the tickets of one agent, or the **Unassigned** ones. **Search** finds a ticket by its number (`WEB-12` or `12`) or by words of its title.

On a computer the states sit side by side. On a phone they are one below the other: scroll down to see them all.

## Create a ticket

1. Open the project and click **New ticket**.
2. Fill in the form:
   - **Type**: **Feature** (something new), **Bug** (something broken), **Chore** (maintenance), **Documentation**, or **Spike** (a short investigation to answer a question).
   - **Title**: a short sentence, for example "Add a search box to the recipe list".
   - **Description**: what must be done and why. See [Formatting](#formatting-descriptions-and-comments).
   - **Acceptance criteria**: the statements that must be true when the work is done, one per criterion, for example "Typing a word shows only the recipes that contain it". Use **Add a criterion**, and **Move up** or **Move down** to put them in order. Empty criteria are left out. Write only what the agent can show in its own work: the agent must report every criterion as met before it can hand its work in. Don't write "the automatic checks pass" as a criterion: the Orchestrator checks that itself after the agent hands its work in.
   - **Priority**: **Low**, **Normal** or **High**. Higher priority tickets come first in their column.
   - **Assignee**: the agent expected to do the work, for example **Web Developer** (see [Assignee](#assignee)). Optional.
   - **Blocked by**: the tickets that must be done before this one can start (see [Dependencies](#dependencies)). Optional.
3. Click **Create the ticket**. The ticket starts in **To do** and its page opens.

## Edit a ticket

Open the ticket and click **Edit**. You can change the type, title, description, acceptance criteria, priority and assignee, then click **Save**.

A ticket can be edited only while it is **To do** (or **Proposed**). Once work has started, it cannot be edited: add a comment instead.

The tickets it waits for are not in this form: change them on the ticket's page (see [Dependencies](#dependencies)).

## Assignee

The assignee is the agent expected to do the work of a ticket: the **Architect** for the project's structure and tools, the **Web Developer** for features and fixes of a web app or website (see [Agents](agents.md)). The ticket page shows it under **Assignee**, and each card of the board shows it too.

Choose it when you create the ticket, or later with **Edit**, while the ticket is **To do** (or **Proposed**). Choose **No assignee** to remove it. Any agent that does the work can be assigned to any ticket in this version; the Orchestrator will check that an agent suits the ticket in a later version. **Quality** is never an assignee: it reviews the work of the others, so the list does not offer it.

A run starts only on a ticket that has an assignee (see [Start a run](runs.md#start-a-run)).

## Formatting descriptions and comments

Descriptions, acceptance criteria and comments use Markdown: `**bold**`, `*italic*`, lists starting with `-` or `1.`, `` `code` ``, tables, and links such as `[the design](https://example.com/design)`.

For your safety, and because agents also write in tickets:

- HTML is shown as plain text, never used for layout.
- Only links starting with `https://`, `http://` or `mailto:` work. Other links show only their text. Links open in a new tab.
- Images are never shown inside the ticket: each one appears as a link "Image: …" that you can click to open it.

## Dependencies

A dependency says that a ticket waits for another one: work on it starts only once the other ticket is **Done**. On the ticket page, **Dependencies** shows:

- **Blocked by**: the tickets it waits for, with their state;
- **Blocks**: the tickets waiting for it.

To add one, choose a ticket in **Add a ticket it waits for** and click **Add**. To remove one, click **Remove** next to it. The ticket it waits for can be in any state.

The rules:

- Dependencies can be changed only while the waiting ticket is **To do** (or **Proposed**).
- A ticket can only wait for tickets of the same project, and never for itself.
- Tickets cannot wait for each other in a loop, for example `WEB-1` waiting for `WEB-2` while `WEB-2` waits for `WEB-1`: none of them could ever start. The Orchestrator refuses such a dependency and shows the loop, for example "WEB-3 → WEB-1 → WEB-2 → WEB-3". Remove one of the dependencies of the loop first if the order has changed.

## Blocked tickets

A ticket is **Blocked** while at least one ticket it waits for is not **Done**. The board shows a **Blocked** badge, and the ticket page says which tickets it waits for. Being blocked is not a state: the ticket stays in **To do**, and it is unblocked as soon as every ticket it waits for is done. The badge is shown for tickets that have not started (**To do** or **Proposed**).

### A ticket waits for a cancelled ticket

A cancelled ticket is not done, so **a ticket waiting for a cancelled ticket stays blocked**: nothing starts it, not even overnight. The ticket page tells you when this happens, and **Run now** says it in its own words, for example "Blocked by WEB-3 (cancelled): remove the dependency to let it start." You can:

- **remove the dependency**, if the ticket no longer needs the cancelled work: on the waiting ticket's page, click **Remove** next to the cancelled ticket under **Blocked by**; or
- **reopen the cancelled ticket**, if the work is needed after all: open it and click **Reopen**. The waiting ticket is unblocked when it is done.

## Comments

At the bottom of a ticket's page, **Timeline** lists the comments and the changes of state, oldest first. To add a note, write it in **Add a comment** and click **Add comment**. You can comment on any ticket, even a done or cancelled one, except in an archived project.

## Cancel a ticket

Tickets are never deleted: a ticket created by mistake, or whose work is abandoned, is cancelled.

**Cancel or mark as done?** Cancel when the work is abandoned: nobody will do it. Tickets waiting for a cancelled ticket stay blocked. If the result exists because the work was done another way, use [Mark as done manually](#mark-as-done-manually) instead: it unblocks the tickets waiting for it.

1. Open the ticket and click **Cancel the ticket**.
2. Confirm with **Cancel the ticket**, or click **Keep it** to change your mind.

The ticket moves to **Cancelled** with its history. Tickets waiting for it stay blocked (see [A ticket waits for a cancelled ticket](#a-ticket-waits-for-a-cancelled-ticket)). Any ticket that is not done or cancelled can be cancelled.

From version 0.4.0, cancelling a ticket whose pull request is open also **closes the pull request** on GitHub, without merging it. Nothing else is deleted: the branch stays on GitHub and on the machines, so **Reopen** finds the work where it was. If GitHub cannot close it (for example it cannot be reached), the ticket is cancelled all the same, its page says why the pull request is not closed yet, and the Orchestrator tries again at each **GitHub check interval**; if it finds the pull request merged meanwhile, it stops trying (see [Merging the pull request](#merging-the-pull-request)). See [Closed at Cancel](#when-github-changes-the-pull-request).

## Mark as done manually

Use **Mark as done manually** when the result exists but was done another way, for example you fixed it yourself. Tickets waiting for it are then unblocked. If the work is abandoned instead, [cancel the ticket](#cancel-a-ticket): tickets waiting for it stay blocked.

1. Open the ticket and click **Mark as done manually**.
2. Write **why it is done**. This comment is required: without it, the ticket is not marked as done. It is added to the timeline.
3. Click **Mark as done**.

If the ticket still waits for tickets that are not done, the dialog warns you and names them with their states, for example "WEB-4 still waits for WEB-2 (Cancelled) and WEB-3 (To do)". You can still mark it as done: the button becomes **Mark as done anyway**. Do it only if its work no longer needs them; the tickets it waits for do not change.

The ticket moves to **Done**, and tickets waiting for it are no longer blocked by it. This is possible from **To do**, **In progress**, **Waiting for you**, **In review** and **Awaiting merge**, but not from **Proposed**: accept or reject a proposed ticket instead.

You do not need it after merging the ticket's pull request on GitHub: the ticket moves to **Done** by itself (see [Merging the pull request](#merging-the-pull-request)), and once it has, **Mark as done manually** is refused with "WEB-12 is already done: pull request #12 was merged on GitHub.".

## Request changes

Use **Request changes** when the agent's work is not right yet: on a ticket **In review** (not while Quality is reviewing it: wait for the review to end, or stop its run first), or on a ticket **Awaiting merge** that Quality approved or whose review you skipped (see [Request changes after an approval](#request-changes-after-an-approval)).

1. Open the ticket, or find it in [Needs you](needs-you.md#agents-work), and click **Request changes**.
2. Write **what should change**. This comment is required; it is added to the timeline and the next agent reads it.
3. From version 0.5.0, check **Hold WEB-12 so I can edit its acceptance criteria first** if you want to change the ticket before its next run: the scheduler then does not start the fix by itself, and the ticket shows **Held** until you click **Run now**. Unchecked (the default), the scheduler starts the fix by itself.
4. Click **Request changes**.

The ticket goes back to **To do**. Its branch and commits are kept, and this does not count as a failed attempt. The next dialog offers **Run now** to start the next run at once (not when you checked the hold box); click **Later** to start it yourself later. While your request waits, the ticket page says "Run now starts a run that addresses your request.". The next run is a **Fix after review** run: the agent reads your comment first and continues on the same branch and pull request (see [The round after a request](#the-round-after-a-request)). Your **Request changes** never counts as a review round. See also [Check finished work](runs.md#check-finished-work).

**A request that contradicts an acceptance criterion.** The acceptance criteria stay as you wrote them: a request does not change them. The dialog says so: "If your request contradicts one of the acceptance criteria, edit that criterion too: once WEB-12 is back in To do, use Edit on its page. Until then, the agent does what your request asks and says so when it reports on that criterion." Quality's next review is told the same: your request wins over the criterion, so the work is not sent back for following it. For example, if a criterion says README.md ends with a line and you ask for another line after it, edit the criterion to say what you now want, so that the next run, Quality's review and the ticket's history agree with your request.

## Reopen a cancelled ticket

Open the cancelled ticket and click **Reopen**. It goes back to **To do** with its number, history and dependencies.

## Tickets proposed by agents

While working, an agent may find more work outside its ticket, for example a bug it noticed. It then proposes a ticket: the ticket is **Proposed**, shows **created by agent** on the board, and its page says which agent created it. An agent can propose only a few tickets per run (**Most tickets an agent creates per run**, 3 by default, in [Settings](settings.md#runs)).

Open the ticket and:

- click **Accept** to keep it: it moves to **To do**, ready for **Run now**. You can **Edit** it before or after accepting it;
- or click **Reject**, write why if you like, and confirm: the ticket is **Cancelled** with its history. You can reopen it later.

## Submission and the pull request

From version 0.4.0, when an agent has finished a ticket, it hands its work in with a report: a summary, each acceptance criterion met or not with why, and the files of tests, documentation and architecture decisions it changed (or why none were needed). Its machine first pushes the ticket's branch to GitHub. The Orchestrator then checks the work, and:

- when the checks pass, it accepts the work and opens the ticket's pull request on GitHub just after (see [The pull request](#the-pull-request)). The run then waits for CI, GitHub's automatic checks of the pull request: when CI passes, the run ends and the ticket moves to **In review** (see [Waiting for CI](#waiting-for-ci));
- when a check fails, it refuses the work and tells the agent why; the agent fixes it and hands it in again, in the same run. Only a branch that could not be pushed to GitHub ends the run at once (see [When the work cannot be pushed to GitHub](#when-the-work-cannot-be-pushed-to-github)).

### The checks

The ticket page shows them under **Agent's report** > **Checks**, for the work accepted. The run page shows them under **Latest refused submission**, for the last work of that run the checks refused: there you see why an agent was refused, also when it is refused again and again.

| Check | What the Orchestrator checks |
|---|---|
| **Acceptance criteria met** | The agent reports every acceptance criterion of the ticket as met. |
| **All work committed** | No change is left uncommitted on the machine. |
| **Commits on the branch** | The ticket's branch has commits of its own, compared with the project's default branch. |
| **Branch pushed to GitHub** | The machine pushed the ticket's branch to GitHub. |
| **Rules of the ticket type** | A **Documentation** ticket lists at least one documentation file its branch changed (a README.md counts). A **Spike** lists at least one architecture decision or document its branch changed. An explanation does not replace them. Other types have no rule of their own. |
| **Listed files changed on the branch** | Every file the agent lists for tests, documentation and architecture decisions is a file its branch changed. A folder is not accepted, nor a path outside the project's files. |

Each check shows one result:

| Result | Meaning |
|---|---|
| **Passed** | The check found nothing wrong. |
| **Failed** | The check found a problem, and the work was refused. The lines below it say why, for example "Documentation listed: “docs/user/contact.md” is not a file the ticket's branch changed." |
| **Could not be fully done** | The machine could not send the whole list of files the branch changed (a very large change, or a daemon older than 0.4.0), so some listed files could not be compared. The lines below say how many. This never refuses the work. |
| **Not checked** | The branch was not pushed because the work was not ready: changes not committed, or no commits. The checks that failed say which. |

Under each check that failed or could not be fully done, **What the agent was told** opens the message the agent received, word for word. It is written for an agent, in the terms an agent works with; the lines above it say the same in plain words. Paths and sentences written by an agent are always shown as plain text, with any secret hidden. A long list shows its first 10 lines; **Show the other …** opens the rest.

Work accepted by version 0.3.0 has no result per check: its page says it was checked by an earlier version.

### The pull request

When the work is accepted, the Orchestrator opens a pull request for the ticket on GitHub, from the ticket's branch into the project's default branch. Its title is the ticket's number and title, and its description holds the agent's summary, the acceptance criteria, the tests, documentation and architecture decisions it lists, a warning when the work may change a GitHub workflow, and a link to the ticket in the Orchestrator. A later accepted submission updates the same pull request; one you closed without merging is reopened. If a pull request of the ticket was already merged, a new one is opened.

Nothing in it can act on GitHub by itself: secrets are hidden, HTML is shown as text, and an invisible space is added after `@`, `#` and `GH-` (and in links to issues), so the text notifies nobody and closes no issue. A ticket title longer than GitHub allows for a pull request is cut, and so is a very long description, with a note saying so. One limit remains: a commit message an agent wrote with "fixes #3" still closes issue 3 when you merge, since the Orchestrator never rewrites the agent's commits.

The ticket page shows it under **Pull request**:

- **Pull request #12 · Open**: the link opens it on GitHub. The state is **Open**, **Closed without merging** or **Merged**. It is the state the Orchestrator saw at its latest check of GitHub, made every **GitHub check interval** (in [Settings > Limits](settings.md#settings-reference)), so it can be behind GitHub for that long; the link always shows its current state on GitHub.
- **Opening the pull request on GitHub…**: the work was just accepted, and the pull request is being opened or updated.
- **Pull request not opened**, with the reason, for example "Pull request not opened: GitHub could not be reached": GitHub could not open it. The work itself is safe on GitHub. The page says what to do, then click **Try again**. [Needs you](needs-you.md#pull-request-not-opened) lists the same, with every reason.
- **Pull request not updated**, under an open pull request: a later accepted submission could not update it. The pull request is there, but its description still shows the report of the earlier submission; the new commits are on GitHub, in the pull request. Click **Try again** as above. A pull request closed without merging, or merged, says **Pull request not opened**, since the next try reopens it or opens a new one.
- What GitHub said of the pull request since: closed without merging (with **Reopen pull request**), closed when you cancelled the ticket, merged into another branch than the default one, a conflict with the default branch, a head that moved after Quality's review, or GitHub that could not be checked. Each is explained in [When GitHub changes the pull request](#when-github-changes-the-pull-request).

### Waiting for CI

CI is the set of automatic checks GitHub runs on the pull request: the GitHub Actions workflows of the project, and any other service reporting a status on GitHub. While it runs, the run's status reads **Waiting for CI**, and the run page's **CI** card shows each check and its state (see [Runs > Waiting for CI](runs.md#waiting-for-ci)). The agent's session stays open, idle: it uses none of your Claude usage, and its time counts as waiting, not working (so **Longest run** and **Idle timeout** do not apply). The run still counts in its Claude account's **Runs at the same time**, so with the default of 1, another ticket of that account waits for it.

What the Orchestrator reads:

- Only the commit the machine pushed when the agent handed its work in: never an older commit of the branch, even one whose CI passed, nor a commit added to the branch on GitHub afterwards (for example by **Update branch**).
- It asks GitHub every **GitHub check interval** (60 seconds by default, in **Settings > Limits**). The wait starts when the pull request is open; a pull request that was already open counts at once.

What it decides:

| CI result | What happens |
|---|---|
| **Passed**: every workflow run and status finished and passed (a skipped one counts as passed) | The run ends as succeeded, and the ticket moves to **In review**. When only statuses of other services passed (no workflow run), the Orchestrator first asks GitHub whether the pull request conflicts with the default branch, since GitHub runs no workflow on a pull request with a conflict: a conflict is handled as in the next row but one, and while GitHub has not said yet, the run keeps waiting until the next check. |
| **No CI found**: nothing appeared within **Wait for CI to start** (5 minutes by default) | The work is accepted as if CI had passed, and the ticket moves to **In review**. Not while the pull request is closed on GitHub: the run keeps waiting until it is reopened, or until **CI wait at submission**. A project without workflows always gets this. When the work also changed workflow files, Activity says both in one sentence: the agent may have removed or weakened CI, so read the changes in `.github/workflows/` before merging (see [Workflow files](#workflow-files)). |
| **Conflicts with the default branch**: nothing appeared, or only statuses of other services, and the pull request conflicts with the project's default branch | Never accepted: GitHub runs no CI on a pull request with a conflict, so the work was not tested. The machine downloads the latest default branch, and the agent is told, in the same session, to merge it and resolve the conflict, then hand its work in again. This counts as one of the run's **Most CI failures per run**. Not while the pull request is closed on GitHub: nothing is sent to the agent, and the run keeps waiting until it is reopened, or until **CI wait at submission**. |
| **Failed**: a workflow run failed, was cancelled or timed out, or a status failed | The agent gets the failure back in the same session: each failed job and step, with its part of the log. It fixes its work and hands it in again, checked from the start; handing in the same commit again is refused. After **Most CI failures per run** (2 by default, failures and conflicts together), one more failure ends the run as **failed**, counted as a failed attempt; the ticket goes back to **To do** with a comment naming what failed. Runs GitHub cancelled because the branch changed there (a workflow cancelling its run when the branch is pushed) do not count: the run ends at once, not counted, and the next run starts from GitHub's branch. |
| **CI wait at submission** (20 minutes by default) reached before a result the agent got | The run ends as **failed**, without counting as a failed attempt. The ticket goes back to **To do** with its branch, its pull request and a comment saying what was found: CI not finished, CI failed but the agent did not receive the result (its machine did not confirm it, or the result came too late), or a conflict not resolved. [Needs you](needs-you.md#ci-items) shows it with what to do. |

If GitHub cannot be reached, refuses because of its request limit, or answers something the Orchestrator cannot read, the run keeps waiting and the Orchestrator asks again: only **CI wait at submission** ends the wait. [Activity](activity.md) shows when GitHub could not be checked, and when it could again. A problem with the token shows in [Needs you](needs-you.md) as usual.

If the agent's session stops while it waits (Claude Code closed, or the machine restarted), nothing is lost: CI still decides, and a run whose CI passes ends as succeeded. If the Orchestrator itself restarts, it goes on waiting where it stopped. A result GitHub gave meanwhile counts, even after **CI wait at submission**.

### The CI line

Under **Pull request**, the ticket page says in one line what CI came to for the ticket's latest run that waited for it, with **Open the run** for each check. It is hidden while a later run works and has not handed its work in yet. A frame marks it when the work was not accepted:

| Line | What to do |
|---|---|
| **CI: waiting on GitHub for commit …** | Nothing: the run decides by itself. |
| **CI passed on GitHub for commit …**, or **No CI found** | Nothing: the ticket is in review. With **No CI found** and workflow files changed, read `.github/workflows/` before merging. |
| **CI failed on GitHub for commit …** **The run ended after 3 CI failures** (or **failures or conflicts**) | **Run now** gives the failure to the next run's agent. If you re-ran the failed jobs on GitHub yourself, **Check CI again**. |
| **CI had not finished on GitHub for commit …** | **Check CI again** once CI has finished. |
| **CI failed on GitHub for commit …, and the run's wait ended before the agent received the result** | **Run now**, or **Check CI again** after a re-run on GitHub. |
| **The pull request conflicts with main …** | **Run now**: the agent merges the default branch and resolves the conflict. |
| **CI was cancelled on GitHub because the branch changed there** | **Run now**: the next run starts from GitHub's branch. |
| **… sent back to the agent as CI round 1, and the run then ended** | **Run now**: the run ended for another reason after the agent got the result. |

### Check CI again

**Check CI again** reads the CI of the commit the agent handed in on GitHub once, without starting a Claude Code session. It is offered after **CI wait at submission** was reached (not for a conflict), and after a run ended with one CI failure too many. The Orchestrator never reads a finished result again by itself, so it is also the way to read CI again after you re-ran a workflow by hand on GitHub.

| It finds | What happens |
|---|---|
| CI passed, or **No CI found** (nothing on GitHub after the pull request has been open for **Wait for CI to start**; before that it counts as not finished) | The work is accepted: the ticket moves to **In review**, with a comment. After a run ended with too many CI failures, that run's failed attempt no longer counts, since the same commit passed: the failure was not the agent's. A ticket that failure had stopped (see [When a ticket keeps failing](runs.md#when-a-ticket-keeps-failing)) is no longer stopped, and its item leaves Needs you. |
| CI not finished | Nothing changes: "CI has still not finished on GitHub (2 of 3 checks finished …). Try again later." |
| CI failed | Nothing changes: **Run now** gives the failure to the agent. |
| A conflict | Nothing changes: **Run now** lets the agent merge the default branch. |
| GitHub could not be checked | Nothing changes: try again later. |

It is refused while a run is working on the ticket, when newer work was accepted since, when the branch changed on GitHub after that commit (**Run now** hands the work in again), when the pull request is closed or merged (a pull request merged into the default branch moves the ticket to **Done** by itself, see [Merging the pull request](#merging-the-pull-request)), and when the pull request was never opened: use **Try again** in "Pull request not opened" first.

### Workflow files

Workflows are the files of `.github/workflows/`: the automatic checks GitHub runs on the pull request. A workflow runs on GitHub before anyone reads it, and an agent changing one could weaken the checks that judge its own work. So the ticket page warns you under **Pull request**, and the pull request's description, **Ready for review** in Needs you and Quality's instructions for its review say the same:

| Warning | Why | What to do |
|---|---|---|
| **Workflow files changed** | The work changes files in `.github/workflows/`. | Before merging, open the pull request's **Files changed** tab and read the changes in `.github/workflows/` first. |
| **Workflow files may have changed** | The machine could not send the whole list of files the work changed, so a workflow change cannot be ruled out. Work accepted before this warning kept its reason also shows it. | Before merging, look at every changed file on the pull request's **Files changed** tab, `.github/workflows/` first. |

### When the work cannot be pushed to GitHub

From version 0.4.0, when an agent submits its work, its machine first pushes the ticket's branch to GitHub. If GitHub refuses the push or cannot be reached, the agent can do nothing about it, so it stops at once:

- the run ends as **failed**, with the reason "its branch could not be pushed to GitHub". It does **not** count as a failed attempt;
- the ticket goes back to **To do**, with a comment saying what happened. The work stays committed on that machine;
- [Needs you](needs-you.md#agents-work) shows what to do, as one of these items:

| Item | Why | What to do |
|---|---|---|
| GitHub refused the push of …: the token needs Contents (Read and write) | The GitHub token is not allowed to write to the repository. | Click **Open your tokens on GitHub**, open the Orchestrator's token, set **Contents** to **Read and write**, and save it. Do not regenerate the token: a new token would have to be entered again in the Orchestrator. Then **Run now**. |
| GitHub refused the push of …: the token needs Workflows (Read and write) | The work changes a GitHub workflow, a file in `.github/workflows/`, and the token is not allowed to. GitHub's own message speaks of a "`workflow` scope": this is the **Workflows** permission of the token page. | Same, with **Workflows** set to **Read and write**. Before you do, keep in mind that a workflow change runs on GitHub before anyone reads it, and could weaken the checks that judge the agent's work. |
| GitHub refused the push of … (other reasons) | GitHub refused for another reason, for example a rule of the repository. The item shows GitHub's own words, with any secret hidden. | Fix the cause on GitHub, then **Run now**. |
| The branch of … changed on GitHub | GitHub's copy of the ticket's branch has commits the machine does not have, for example after **Update branch** on GitHub or a push by hand. The Orchestrator never overwrites GitHub's branch. | **Run now**: the next run, on the same machine, first brings GitHub's commits in with a merge, then continues and pushes. |
| GitHub could not be reached to push … | The machine could not connect to GitHub. | Check that the machine is connected to the internet and that GitHub works, then **Run now**. |

**Run now** starts the next run on the machine that holds the work, and tells the agent that its work is committed but was not pushed. The item disappears as soon as a push of the ticket's branch succeeds, including the push a machine makes when a run ends, or when the ticket is cancelled or marked as done, or the machine is revoked (its work not on GitHub is then lost, see [Runs](runs.md#where-the-work-is)). It stays while the next run works.

## Review by Quality

When a ticket's work is accepted and CI has passed (or found nothing to run), the ticket is **In review** and [Needs you](needs-you.md#agents-work) lists it as **Ready for review**, with its pull request, the CI result and a line when the work changed workflow files. You choose:

- **Start review**: Quality, the reviewing agent (see [Agents](agents.md#quality)), reads the work and approves it or asks for changes. It starts at once, without a confirmation, like **Run now**, and the run page opens.
- **Skip review**: you check the pull request yourself. After a confirmation, the ticket moves to **Awaiting merge** with the comment "The owner skipped the review.".

Both are also on the ticket page, under **Review**, while the ticket is **In review** with a pull request and no run is working on it.

**By itself, from version 0.5.0.** The scheduler starts the review by itself when a machine and its Claude account can take it (see [What starts by itself](runs.md#what-starts-by-itself)). **Start review** starts it at once instead of waiting its turn, and **Skip review** before it starts means no review. "Ready for review" and the ticket page say what will happen:

- "The review starts by itself as soon as a machine and its Claude account can take it. Start review starts it now; Skip review before then if you want none.";
- "Start reviews by themselves is off in this project's settings: the review waits for you to use Start review." when you turned the switch off for the project (see [Reviews by themselves](projects.md#reviews-by-themselves));
- "The review does not start by itself: you stopped its review run. Start review starts it again." after you stopped a review with **Stop run**;
- "The review does not start again by itself after a review that did not finish: use Start review to try again, or Skip review." (see [When the review did not finish](#when-the-review-did-not-finish)).

### What a review costs

A review by Quality uses one Claude Code session, from the usage of your Claude plan, like a run of an agent. **Skip review** uses none. Quality reviews one commit: the one CI checked. When CI passed on GitHub, Quality does not run the tests again unless the changes or the CI result give it a reason, which keeps the session short. With **No CI found**, nothing on GitHub tested the work, so Quality runs the project's tests and build itself when there are any, and says what it ran.

### The result

- **Approved**: the ticket moves to **Awaiting merge**. Merge the pull request on GitHub: the ticket then moves to **Done** by itself (see [Merging the pull request](#merging-the-pull-request)).
- **Changes requested**: each point becomes a comment on the ticket, which goes back to **To do**. From version 0.5.0 the scheduler starts the next run of its assignee by itself, which addresses the points; **Run now** starts it at once (see [The round after a request](#the-round-after-a-request)). Quality's request never counts as a failed attempt, but it counts as a review round (see [Too many review rounds](#too-many-review-rounds)).

The ticket page's **Review** shows the latest review: "Approved by Quality · commit abc1234 · <time>" with Quality's summary, or "Changes requested by Quality · commit abc1234 · 3 points" with each point and the file it is about, "Review skipped by you on <date>", or "Review in progress on <machine>". When that review is about an earlier submission (the agent changed the work since), it says so, with the commit now in review, which nobody has reviewed yet. Earlier reviews stay in the timeline. The review's run page shows the commit reviewed and the decision.

Quality's text is shown as plain text: it is an agent's writing, not the Orchestrator's.

### The round after a request

After a request for changes, Quality's or yours, the ticket page says what **Run now** will do: "Run now starts a run that addresses Quality's points (round 1 of at most 2)." or "Run now starts a run that addresses your request.". From version 0.5.0 the scheduler starts that run by itself (unless you checked the hold box of **Request changes**), also when **Start reviews by themselves** is off; **Run now** starts it at once. It is a **Fix after review** run (its run page says so):

1. The agent receives the points first (Quality's, numbered with the file they are about, or your comment whole), and continues the work on the same branch and pull request.
2. It addresses every point. When one cannot or should not be done, it says why in a comment on the ticket, or asks you a question.
3. It hands in a new commit. The same commit as the one the request was about is refused: the run page's **Latest refused submission** says "Same commit as the one Quality asked changes on (abc1234)" or "… the one you asked changes on (abc1234)", and the agent is told to commit its changes first.
4. As after the first run: the pull request on GitHub gets the new commits, CI runs, and the ticket comes back **In review**, ready for review.

The ticket page's **Review** then shows the earlier review as "…, on an earlier submission.", with the commit now in review, which nobody has reviewed yet. When you **Start review** again, Quality is told of the earlier points and of what the agent said about them: it checks that each point was addressed, or that the agent's reason for leaving it holds, then reviews the rest of the work as usual.

A **Fix after review** run that fails (it gives up, runs out of time, its session stops) counts as a failed attempt, like any run; the next run, started by the scheduler or by **Run now**, gets the same points again. After **Failed attempts before asking you** (2 by default) the ticket stops and waits for you (see [When a ticket keeps failing](runs.md#when-a-ticket-keeps-failing)).

### Too many review rounds

Each request for changes by Quality is a review round. **Most review rounds per ticket** (2 by default, in [Settings](settings.md#settings-reference), also per project) says how many Quality may make on one ticket. Your own **Request changes** never counts.

When Quality asks for changes once more than that, its request is applied in full (its points on the ticket and on GitHub, the ticket back in **To do**), then the ticket stops: it shows **Stopped** on the board and on its page, and [Needs you](needs-you.md#agents-work) lists it as **Stopped after too many review rounds**, for example "Quality requested changes 3 times, more than Most review rounds per ticket allows (2).". **Run now** is refused while it is stopped. Read the points and the earlier rounds in the timeline, then choose, on the ticket page or in Needs you:

- **Try again**: the ticket can go on. It starts no session and needs no confirmation: the review rounds and the failed attempts count from 0 again, and a dialog offers **Run now** at once (or **Later**). The next run addresses Quality's latest points.
- **Cancel the ticket**: the work is abandoned (see [Cancel a ticket](#cancel-a-ticket)).
- **Mark as done manually**: the work is good enough as it is (see [When you disagree with Quality](#when-you-disagree-with-quality)).

**Reopen** of a cancelled ticket also starts the review rounds again from 0.

### Request changes after an approval

On a ticket **Awaiting merge** you can still **Request changes**, for example when you read the pull request and something must change before you merge it. The dialog says what it comes after: "Quality approved commit abc1234." or "You skipped the review.", then "The ticket goes back to To do with your comment, and its next run addresses it; the pull request stays open.".

Nothing is posted on GitHub for your request, and the pull request stays open: the next run adds its commits to it. Until the fix is in review, the ticket page's **Review** keeps the approval (or the skip) with "You requested changes after this approval, at <time>." (or "… after skipping the review, at <time>."); once the fix is in review, it shows the approval as one of an earlier submission, and the new work waits for its review.

### When you disagree with Quality

Quality's request for changes is advice, and you decide. When you think the work is right as it is, you do not need another run:

1. Open the pull request on GitHub (**Pull request** on the ticket page) and merge it there.
2. Nothing else is needed: at its next check of GitHub the Orchestrator finds the merge and moves the ticket to **Done**, with a comment saying that Quality's request for changes was not addressed (see [Merging the pull request](#merging-the-pull-request)).

To write why in the ticket, add a comment, or use [Mark as done manually](#mark-as-done-manually) before merging and write why there, for example "Merging as it is: point 2 is not needed.": the merge found afterwards is then only recorded, with a comment. This works while the ticket is in **To do** with Quality's request waiting, and also when the ticket is stopped after too many review rounds. Mark as done manually is never refused because a request for changes is waiting.

### The review on GitHub

The Orchestrator also posts the review on the pull request, as a comment review, so you see it next to the changes: "**Quality review: approved**" or "**Quality review: changes requested**" with the points. GitHub does not let anyone approve or request changes on their own pull request, and every pull request is yours, so it is a comment. Nothing in it can notify anyone or close an issue, and secrets are hidden. The ticket page shows **Posted on GitHub** with a link, **Posting on GitHub…** for a moment, or a note when it is not known to be there, such as "Not posted on GitHub: the token needs Pull requests (Read and write). The decision stands in the Orchestrator.". A post that failed is not tried again: the decision stands either way, and the ticket page holds the whole review.

When GitHub could not be read as Quality decided, the ticket page says "The pull request's head could not be checked on GitHub when Quality decided: check it is still abc1234 before merging." Open the pull request and check its latest commit before merging.

### When the review did not finish

A review run can end without a decision applied: Quality gave up, its time ran out, its session stopped, its machine went offline, you stopped it, or the work changed during the review (the pull request changed on GitHub, before or during the review, or the branch changed on the machine). The ticket stays **In review**, nothing counts as a failed attempt, and [Needs you](needs-you.md#agents-work) shows **Review did not finish**, saying why, or which decision Quality had made and why it was not applied. Use **Start review** to review again, or **Skip review**. When you stop a review before Quality decided anything, the item is plain **Ready for review** again.

**Start review** is refused when it cannot start, saying why, for example when the pull request's latest commit on GitHub is not the one CI checked (someone pushed to it, or used **Update branch**): use **Skip review** and check it yourself, or **Request changes** so the agent continues.

### When GitHub changes the pull request

The Orchestrator reads the ticket's pull request at each **GitHub check interval** (in [Settings > Limits](settings.md#settings-reference)). When something changed on GitHub, the ticket page shows it under **Pull request**, in the same words as [Needs you](needs-you.md#pull-requests-to-merge). The page says when GitHub did it; how soon the Orchestrator sees it depends on that interval.

**Closed without merging.** "Pull request #12 was closed on GitHub at … without merging. The ticket is unchanged (Awaiting merge)." Someone closed it on GitHub; the ticket keeps its state, and [Needs you](needs-you.md#closed-pull-requests) lists it too.

- **Reopen pull request** reopens it on GitHub. If GitHub refuses, the page shows GitHub's reason ("GitHub refused to reopen it: …"); when the ticket's branch is gone from GitHub, the next accepted submission opens a new pull request instead.
- Reopening it on GitHub yourself works too: the line goes at the next check.
- **Start review** is refused while it is closed: "Pull request #12 is closed on GitHub, so there is nothing to review. Reopen it first, …". Reopen it, then start the review.
- While it is closed, a run waiting for CI never accepts the work as "No CI found" (see [Waiting for CI](#waiting-for-ci)).
- If the work is abandoned, [cancel the ticket](#cancel-a-ticket); the pull request stays closed.

**Closed at Cancel.** "Pull request #12 was closed on GitHub at … without merging, since WEB-12 was cancelled." The Orchestrator closed it when you cancelled the ticket (see [Cancel a ticket](#cancel-a-ticket)). Until it has, the page says "Closing pull request #12 on GitHub…", or, when GitHub refused or could not be reached, "Pull request #12 not closed on GitHub yet, though WEB-12 was cancelled at …: at …, <reason>. The Orchestrator tries again at each GitHub check." When the reason is the token, the line links to your tokens on GitHub or to Settings > GitHub. If you [reopen the ticket](#reopen-a-cancelled-ticket), the pull request stays closed until the agent's next accepted submission, which reopens it; the page says so.

**Merged into another branch.** "Pull request #12 was merged into release on GitHub at …, not into the project's default branch, so the work is not done. The ticket is unchanged (Awaiting merge). …" Someone changed the pull request's base on GitHub and merged it there: the work did not reach the default branch, so the ticket keeps its state, and [Needs you](needs-you.md#closed-pull-requests) lists it too. GitHub never reopens a merged pull request: mark the ticket as done if the work is done this way, or cancel it; otherwise the next accepted submission opens a new pull request into the default branch. Once the ticket is done or cancelled, the page only says where the pull request was merged.

**Conflicts with main.** "Conflicts with main: GitHub cannot merge it as it is." GitHub says the pull request conflicts with the project's default branch: other work changed the same lines since. On **Awaiting merge**, **Request changes** comes with its comment already written, asking the agent to merge the default branch and resolve the conflicts. You can change the comment: the agent is told to merge the default branch whatever it says, because GitHub reported the conflict when you sent it. The line goes when GitHub no longer reports a conflict, or when the pull request's head changes. While a run waits for CI, a conflict is sent to the agent by itself (see [Waiting for CI](#waiting-for-ci)).

**The head moved.** On **Awaiting merge**: "Pull request #12's head on GitHub is now def5678, not abc1234, which Quality approved: it changed on GitHub since Quality's review." (or "…the commit you skipped the review of."). Someone pushed to the branch, or used **Update branch** on GitHub. The page lists the titles of the commits added since, newest first (the five newest, then "and N more"), or says the approved commit is no longer part of the pull request when its history was rewritten. If GitHub could not compare them, the sentence comes alone; the Orchestrator does not ask again for the same two commits. Quality did not review those commits: look at them on GitHub before merging, or use **Request changes**.

**GitHub could not be checked.** "GitHub could not be checked for this pull request at … (since …): <reason>. A merge is not found while this lasts; the Orchestrator asks again at each GitHub check." The reason is the same as for CI: GitHub could not be reached, the token cannot be used or lacks a permission, GitHub's request limit, or an answer the Orchestrator could not read. Nothing is decided while it lasts: a merge, a close or a conflict is found at the first check that works. Fix the cause the line names, for example the token in [Settings > GitHub](github-token.md).

### Merging the pull request

You merge the pull request on GitHub, with the method you prefer: a merge commit, squash, or rebase. While the ticket is on **Awaiting merge**, [Needs you](needs-you.md#pull-requests-to-merge) lists it as **Pull request to merge**, with the review, the CI result and anything to look at before merging. The Orchestrator checks GitHub every **GitHub check interval** (60 seconds by default, in [Settings > Limits](settings.md#settings-reference)); the ticket page's **Awaiting merge** line says the current value. At the first check after the merge:

- The ticket moves to **Done**, from any state where its pull request was open, even before Quality's review. Tickets waiting for it are no longer blocked by it, and its items leave [Needs you](needs-you.md).
- A run still working on the ticket (the agent, or Quality's review) is stopped. It does not count as a failed attempt.
- A comment says when GitHub merged it and its latest commit then, for example "Pull request #12 was merged on GitHub at 2026-10-11 16:02 UTC (head def5678).", then what CI said of that commit ("CI passed for this commit.", or why the Orchestrator's CI result does not cover it), and Quality's review ("Quality approved this commit.", "It was merged before Quality's review.", or a request for changes that was not addressed). Times in comments are in UTC.

Only a merge into the project's default branch counts. If you change the pull request's base on GitHub and merge it into another branch, the ticket does not change, and Needs you shows it with what you can do (see [Closed pull requests](needs-you.md#closed-pull-requests)).

If the Orchestrator was stopped when you merged, it finds the merge when it starts again, and the comment gives GitHub's time of the merge. A ticket you already marked as done manually only gets a comment saying the pull request was merged after you marked it. A ticket you cancelled stays **Cancelled**: the comment says the pull request was merged anyway; to record it as done, use **Reopen**, then **Mark as done manually**.

A pull request you closed without merging stays watched while its ticket is not done or cancelled: if you reopen it on GitHub, the Orchestrator sees it open again, and if you reopen and merge it, the ticket moves to **Done** as above.

### What the Orchestrator deletes after a merge

Once a ticket's pull request is merged into the project's default branch and the ticket is **Done**, the Orchestrator deletes the ticket's branch (its name starts with `t/` and the ticket's number, for example `t/12-add-faq`), and only it:

- **On GitHub**: the ticket branch. The pull request stays on GitHub, shown as merged, and the merged work stays in the default branch.
- **On each machine** where a run worked on the ticket: the ticket branch in the machine's copy of the repository. The folder each run worked in is already removed when the run ends.

Nothing else is deleted: no other branch, no commit of the default branch, no pull request. **Nothing is deleted after a cancellation**: **Reopen** finds the work where it was. A ticket you marked as done manually gets the same clean-up once the Orchestrator finds its pull request merged.

The ticket page's **Clean-up after the merge** section has one line for GitHub and one per machine, with the branch's real name: deleted (with the time), already gone (deleted on GitHub by you or by GitHub's "Automatically delete head branches" setting), kept with the reason, or what it waits for.

**When a branch is kept.** The Orchestrator deletes only a branch it is sure holds nothing more than the merged work. It keeps the branch on GitHub, and says why, when:

- another open pull request uses it, as its branch or as the branch it merges into;
- commits were pushed to it after the merge;
- the pull request was merged into another branch than the project's default branch, or comes from another repository (a fork);
- the repository's default branch on GitHub is no longer the project's (renamed on GitHub);
- GitHub refused the deletion (for example a protected branch) or answered in a way the Orchestrator could not read: it is not tried again.

On a machine, it keeps the branch when the branch's latest commit is not the merged one ("it may hold work that was not merged"), when the branch is the current branch of the machine's copy of the repository, or when you revoked the machine before it was asked. A kept branch is never deleted later by the Orchestrator: delete it yourself once you no longer need it.

**What the clean-up waits for.**

- **A run's end report**: a run the merge stopped may still push its last commits. The branch on GitHub is deleted only once that run's machine reports the run's end. If the machine is offline, the line names it and says since when; it reports at its reconnection, or you can revoke the machine (see [Disable, revoke, enroll again](machines.md#disable-revoke-enroll-again)) to stop the wait.
- **An offline machine**: it is asked when it reconnects.
- **A busy machine**: when a run on that machine has the branch open, or another run of the same repository was working, the machine is asked again at the next check, until it can answer.
- **An outdated daemon**: a machine with a daemon older than this version cannot be asked; it is asked once its daemon is updated (see [Update the daemon](machines.md#update-the-daemon)).
- **A failure tried again**: GitHub could not be reached, its request limit was reached, the saved token cannot be used, or the token lacks a permission. The line says which; the Orchestrator tries again at each **GitHub check interval**. A missing permission also appears in [Needs you](needs-you.md): deleting a branch needs **Contents (Read and write)** (see [Connect GitHub](github-token.md#required-permissions)).

**Known limits.**

- A push made by hand to the ticket branch after its deletion is not seen: the branch is back on GitHub and the Orchestrator does not say so. A push by a run that the Orchestrator records after the deletion is shown ("is on GitHub again"), and that branch is kept.
- After **Update branch** on GitHub, the machine's branch is behind the merged commit: it is kept on the machine, though it holds no work that was not merged.
- A machine that stays busy is asked again at every check; its line says why it waits.

**Getting a deleted branch back on GitHub.** In the repository on GitHub, open **Pull requests**, click **Closed**, open the ticket's pull request, and near the bottom of the page click **Restore branch**. A branch deleted on a machine needs no restoring: its merged work is in the default branch, which every new run starts from.

## Ticket states

| State | Meaning |
|---|---|
| **Proposed** | Proposed by an agent and waiting for you to accept or reject it. From a later version, also part of a plan not approved yet. |
| **To do** | Waiting for work. |
| **In progress** | An agent is working on it (see [Runs](runs.md)). |
| **Waiting for you** | An agent asked you a question (see [Questions](runs.md#questions)). |
| **In review** | The agent finished its work and the checks accepted it; its pull request is on GitHub, and CI passed or found nothing to run (see [Submission and the pull request](#submission-and-the-pull-request)). **Start review** asks Quality to review it, which uses one Claude Code session from your Claude plan; **Skip review** moves it to **Awaiting merge** without a review and uses none. A review that does not finish never counts as a failed attempt (see [Review by Quality](#review-by-quality)). |
| **Awaiting merge** | The work was approved by Quality, or you skipped the review: merge the pull request on GitHub. The ticket then moves to **Done** by itself at the next check of GitHub (see [Merging the pull request](#merging-the-pull-request)). If something must change first, use [Request changes](#request-changes-after-an-approval): the ticket goes back to **To do**. |
| **Done** | Finished: merged, or marked as done manually. |
| **Cancelled** | Abandoned. It can be reopened. |

Agents move tickets through **In progress**, **Waiting for you** and **In review**; Quality's approval, or your **Skip review**, moves them to **Awaiting merge**, and Quality's request for changes, or yours, back to **To do**. A ticket in **To do** can also be **Stopped** after too many review rounds: it waits for your **Try again**, **Cancel** or **Mark as done manually** (see [Too many review rounds](#too-many-review-rounds)). A ticket left **In review** by version 0.3.0, without a pull request, is checked by you as before: [Mark as done manually](#mark-as-done-manually) if it is right, or [Request changes](#request-changes) if it is not.

## If an action is refused

The page says why in plain words. The most common reasons:

- **A text is too long**: the message names the field and its limit, for example "The title can have at most 200 characters." Shorten it and try again. These limits can be changed in **Settings > Limits** (see [Change a limit](settings.md#change-a-limit)).
- **The ticket changed state**: for example it was already cancelled. The page shows its current state and the actions it allows.
- **The project is archived**: its tickets are read-only. Unarchive the project first (see [Archive a project](projects.md#archive-a-project)).
