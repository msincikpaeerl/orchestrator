# Needs you

**Needs you** is the home page of the Orchestrator. It lists everything waiting for you; when it is empty, nothing needs you. The number next to "Needs you" in the menu counts the items.

In this version, it shows:

- what agents' work leaves for you: questions, tickets they propose, work ready for review, reviews that did not finish, tickets stopped after too many review rounds or after repeated failures, finished work to check, work that could not reach GitHub (a push refused, a project that could not be downloaded, a pull request not opened or not updated) and runs paused by a usage limit (see [Agents' work](#agents-work));
- pull requests to merge, and pull requests closed on GitHub without merging (see [Pull requests to merge](#pull-requests-to-merge) and [Closed pull requests](#closed-pull-requests));
- runs that stopped at **CI wait at submission** (see [CI items](#ci-items));
- problems with the GitHub connection, projects whose setup failed, the setup still to do (a Claude account and a machine), machines that cannot work and machines offline while agents were working on them.

Plans to approve come with a later version.

The setup still to do comes first. Every other item is listed oldest first, by the time its reason began: when the question was asked, the ticket proposed, the work submitted, the ticket moved to **Awaiting merge**, the pull request closed, or the run paused.

## Claude accounts

Above the items, one line per Claude account says whether agents can use it:

- **Available**: runs can start on it.
- **Limited until 3:45 PM**: the account reached its Claude usage limit; no run starts on it before that time. "(estimated)" after the time means Claude gave no reset time, so the Orchestrator waits the **Quota wait when the reset time is unknown** (see [Settings](settings.md#settings-reference)). Once the time has passed, the line shows **Available** again by itself.
- **Paused**: you clicked **Stop new runs** on it. Runs already started finish; **Run now** is refused until you click **Resume**, on the line or on the account.

The line also says **next window at** a time when the account is outside its windows, **in its window until** a time when it is inside one, and **daily budget used until** midnight when today's runs reached its daily budget. Each line has **Stop new runs** or **Resume**. See [Keep Claude usage for yourself](machines.md#keep-claude-usage-for-yourself).

A limited account is not an item of its own: the runs it paused are listed below, and **Run now** says why it cannot start a run, with the time.

## Agents' work

Each item links to its ticket; its buttons are the same as on the ticket page.

| Item | Why it appears | What to do |
|---|---|---|
| Question from agent … | An agent needs a decision only you can make; the ticket is **Waiting for you**. | Write your answer in **Your answer** and click **Send answer**, as on the ticket page (see [Questions](runs.md#questions)). |
| Ticket proposed by agent … | While working, an agent found more work and proposed a ticket. | **Accept** it (it moves to **To do**) or **Reject** it (see [Tickets proposed by agents](tickets.md#tickets-proposed-by-agents)). |
| Ready for review: … | An agent's work was accepted and CI passed, or found nothing to run: the ticket is **In review**. The item shows the pull request, the CI line ("CI passed on GitHub for commit …", "(checked again by you at …)" after **Check CI again**, or "No CI found for commit …"), a line when the work changed workflow files, and what each choice costs. | **Start review** (Quality reviews it, one Claude Code session) or **Skip review** (none; you check the pull request yourself). From version 0.5.0 the scheduler starts the review by itself if you do neither. See [Review by Quality](tickets.md#review-by-quality). |
| Review did not finish for … | Quality's review run ended without a decision, or with a decision that was not applied: the item says why, or which decision and why. It never counts as a failed attempt. | **Start review** again, or **Skip review**. See [When the review did not finish](tickets.md#when-the-review-did-not-finish). |
| Stopped after too many review rounds | From version 0.4.0: Quality asked for changes on the ticket more times than **Most review rounds per ticket** allows. Its latest request was applied, and **Run now** is refused until you decide. The item says how many times and the setting's value. | **Try again** (no session; the review rounds and failed attempts count from 0 again, and a dialog offers **Run now** at once), **Cancel the ticket**, or **Mark as done manually**. See [Too many review rounds](tickets.md#too-many-review-rounds). |
| Stopped after repeated failures | From version 0.4.0: the ticket's failed attempts reached **Failed attempts before asking you**, and **Run now** is refused until you decide. The item says how many attempts failed and the setting's value. | **Try again** (no session; the failed attempts and review rounds count from 0 again, and a dialog offers **Run now** at once), **Cancel the ticket**, or **Mark as done manually**. See [When a ticket keeps failing](runs.md#when-a-ticket-keeps-failing). |
| … could not start on … | From version 0.5.0: the ticket's last runs on that machine failed because of the machine, not because of the ticket's work, as many times in a row as **Machine failures before asking you** (2 by default). The item lists each failure. The scheduler no longer starts the ticket by itself. | Check the machine on its page, then **Run now**: it starts on any machine that can take the run. See [When a machine keeps failing a ticket](runs.md#when-a-machine-keeps-failing-a-ticket). |
| Work finished: check it | A ticket left **In review** by version 0.3.0, without a pull request. The item shows the agent's summary; **Open the run** shows its log. | If the work is right, **Mark as done manually**. If not, **Request changes** (see [Check finished work](runs.md#check-finished-work)). |
| GitHub refused the push of … / The branch of … changed on GitHub / GitHub could not be reached to push … | From version 0.4.0: the agent's work is committed on its machine, but could not be pushed to GitHub. The item names the token permission to give when GitHub said which, in the words of GitHub's token page, with **Open your tokens on GitHub**. | Fix what the item says, then open the ticket and click **Run now**. See [When the work cannot be pushed to GitHub](tickets.md#when-the-work-cannot-be-pushed-to-github). |
| … could not be downloaded from GitHub on … | From version 0.4.0: when a run started, its machine could not download the project from GitHub, so the agent never started. The item says why: GitHub could not be reached, GitHub refused the token (naming the permission to give, in the words of GitHub's token page, with **Open your tokens on GitHub**), or the download took longer than **Longest push**. It does not count as a failed attempt. It goes when a new run starts, or the ticket is done or cancelled, or the machine is revoked. | Fix what the item says, then click **Run now**. See [When the project cannot be downloaded from GitHub](machines.md#when-the-project-cannot-be-downloaded-from-github). |
| Pull request not opened for … / Pull request not updated for … | From version 0.4.0: the agent's work was accepted and is on GitHub, but the Orchestrator could not open its pull request, or update the one that is open. See [Pull request not opened](#pull-request-not-opened). | Fix what the item says, then click **Try again**. |
| Run paused: Claude usage limit reached | The run stopped at the usage limit of its Claude account. The item says when you can resume it, "(estimated)" when Claude gave no reset time. | Wait for that time, then click **Resume**: the button becomes available by itself. Or **Stop run**. |
| Run paused: possible Claude usage limit | The run stopped on an error that may be the usage limit, or Claude being overloaded, or a network problem. | Click **Resume** at once: the run may pause again if it was the limit. Or **Stop run**. |

In this version nothing resumes by itself: a paused run waits for your **Resume**. An item disappears once it is handled: answered, accepted or rejected, marked as done or sent back, reviewed or skipped, tried again or cancelled, resumed or stopped, the branch pushed to GitHub, the pull request opened, updated, merged or reopened.

## Pull requests to merge

From version 0.4.0, each ticket on **Awaiting merge** whose pull request is open on GitHub is an item **Pull request to merge: …**. You merge it on GitHub yourself: the Orchestrator never merges. The item shows:

- **Pull request #…**, a link to it on GitHub;
- the review: "Quality approved commit …", with Quality's summary below it, or "Review skipped" when you used **Skip review** (then check the pull request yourself before merging);
- the CI line, as on "Ready for review": "CI passed on GitHub for commit …", "(checked again by you at …)" after **Check CI again**, or "No CI found for commit …";
- a line when the work changed workflow files, which decide what CI checks: look at them on the pull request before merging;
- **Conflicts with main: GitHub cannot merge it as it is.** when GitHub says the pull request conflicts with its base branch;
- a line when the pull request's head changed on GitHub after Quality's approval or your skip (someone pushed to the branch, or used **Update branch**): "Pull request #12's head on GitHub is now def5678, not abc1234, which Quality approved", with the titles of the commits added since (the five newest, then "and N more"), or a line saying the approved commit is no longer part of the pull request when its history was rewritten. Quality did not review those commits: look at them before merging, or use **Request changes**;
- a line when GitHub could not be checked for this pull request (for example the token lost a permission): while it lasts, a merge is not found, and the ticket stays on **Awaiting merge** after you merged. The Orchestrator asks again at each **GitHub check interval** (see [Settings](settings.md#settings-reference)).

| You want to | Do |
|---|---|
| Merge it | Merge the pull request on GitHub, with any merge method. At its next GitHub check the Orchestrator finds the merge: the ticket moves to **Done** and the item disappears by itself, without reloading the page. See [Merging the pull request](tickets.md#merging-the-pull-request). |
| Send it back | **Request changes**, with a comment saying what to change: the ticket goes back to **To do** and its pull request stays open; a dialog offers **Run now**. When the item shows a conflict, the comment is already filled in, asking the agent to merge the base branch and resolve the conflicts; you can change it. The agent is told to merge the base branch whatever the comment says, since GitHub reported the conflict. |

## Closed pull requests

From version 0.4.0, when a ticket's pull request is closed on GitHub without merging while the ticket is neither done nor cancelled, the item **Pull request closed without merging for …** says when, and that the ticket is unchanged.

| You want to | Do |
|---|---|
| Go on with the work | **Reopen pull request**: the Orchestrator reopens it on GitHub, and the item disappears. If GitHub refuses, the item shows GitHub's reason; when the branch is gone from GitHub, the next accepted submission opens a new pull request. |
| Stop the work | **Cancel the ticket**. The pull request stays closed. |

Reopening the pull request on GitHub yourself works too: the item disappears at the next GitHub check.

A pull request merged into another branch than the project's default branch (its base changed on GitHub) is the same item, **Pull request merged into … for …**: the work did not reach the default branch, so the ticket is unchanged. GitHub never reopens a merged pull request, so the item offers **Cancel the ticket** and **Mark as done manually** (when the work is done this way); otherwise the next accepted submission opens a new pull request into the default branch.

## Pull request not opened

From version 0.4.0, when the Orchestrator accepts an agent's work, it opens the ticket's pull request on GitHub, or updates it when the ticket already has one. The agent does not wait for GitHub: the pull request is opened just after. When GitHub cannot do it, the work itself is safe on GitHub and the ticket goes on as usual; only the pull request is missing, and this item says why.

When the ticket's pull request is already open, the item says **Pull request not updated** instead: the pull request is there, but its description still shows the report of the earlier submission. The new commits are on GitHub, in the pull request. A pull request closed without merging, or merged, is reopened or replaced by a new one, so the item says **Pull request not opened**.


| The item says | Why | What to do |
|---|---|---|
| … the token needs Pull requests (Read and write) | The GitHub token is not allowed to open pull requests. | Click **Open your tokens on GitHub**, open the Orchestrator's token, set **Pull requests** to **Read and write**, and save it. Do not regenerate the token. Then **Try again**. |
| … GitHub could not be reached | The Orchestrator could not connect to GitHub, or GitHub had a problem. | Check that the computer running the Orchestrator is connected to the internet and that GitHub works, then **Try again**. |
| … the GitHub token cannot be used | No token is saved, GitHub refused it, or it cannot be read since the secret key changed. | Click **Open GitHub connection** and enter a working token (see [Connect GitHub](github-token.md)), then **Try again**. |
| … GitHub's request limit was reached | GitHub limits how many requests a token makes per hour. | Wait a few minutes, then **Try again**. |
| … GitHub's answer could not be read | GitHub answered in a form this version of the Orchestrator does not read. The item lists what differed (field names and kinds of value, never their content). | **Try again**. If it keeps failing, report the listed fields. |
| GitHub refused to open (or update) the pull request of … | Any other refusal, for example a repository that was deleted or renamed. The item shows GitHub's own words, with any secret hidden. | Fix the cause on GitHub, then **Try again**. |

**Try again** makes one new attempt and the item disappears when it succeeds. The Orchestrator also tries again by itself each time it starts, and every **GitHub check interval** while the run waits for CI. The item's **Since** is the first attempt that failed, whatever the tries since; Activity shows "Pull request not opened or updated" when attempts start failing or fail for another reason, not at each try. A try never opens a second pull request: it first looks for the ticket's pull request on GitHub by its branch, even when GitHub did the work but its answer was lost. The item also disappears when the ticket is cancelled or marked as done.

## CI items

From version 0.4.0, a run that reaches **CI wait at submission** stops without counting as a failed attempt, and leaves one of these items, so nothing starts again by itself. Each says what was found, with **Open the run** and **Open the ticket**.

| Item | Why | What to do |
|---|---|---|
| CI did not finish for … | CI on GitHub had not finished when the wait ended. | When CI has finished on GitHub, click **Check CI again**: if it passed, the work is accepted without starting a session, the ticket moves to **In review** and the item disappears; otherwise it says what it found. If the pull request was never opened, use **Try again** in "Pull request not opened" first. |
| CI failed for …, and the agent did not get the result | CI failed, but the result did not reach the agent before the wait ended: its machine did not confirm it, could not take it, or the result came too late. | **Run now**: the next run's agent reads the failure first. If you re-ran the failed jobs on GitHub, **Check CI again** on the ticket page. |
| … conflicts with main | The pull request conflicts with the default branch, and the agent could not merge it before the wait ended (for example its machine could not download the default branch). | **Run now**: the agent merges the default branch and resolves the conflict. |
| CI cancelled for … | From version 0.5.0 as an item: CI was cancelled on GitHub because the branch changed there, so the run ended. It does not count as a failed attempt, and the scheduler does not start the ticket by itself. | **Run now**: the next run takes the branch as it is on GitHub. |

The item disappears when the work is accepted, when a new run of the ticket starts, or when the ticket is cancelled or marked as done. See [Tickets > Check CI again](tickets.md#check-ci-again).

## GitHub items

Each item has a link to **Settings > GitHub connection**, where you fix it by entering a new token (see [Connect GitHub](github-token.md)).

| Item | Why it appears | What to do |
|---|---|---|
| Your GitHub token expires soon | The expiry date you entered is less than 14 days away (the **GitHub token expiry warning** setting, see [Settings](settings.md#settings-reference)). | Create a new token and enter it with **Replace the token**. |
| Your GitHub token has expired | The expiry date you entered has passed. | Create a new token and enter it. |
| GitHub no longer accepts your token | GitHub refused the token: it was deleted, revoked or has expired. | Create a new token and enter it. |
| The GitHub token is missing a permission | The permissions check found it missing. | Create a new token with the **Create the token on GitHub** button, which fills in every permission, and enter it. |
| GitHub refused a request | The Orchestrator needed a permission the token does not have. | Same as above. |
| Enter your GitHub token again | The secret key in `.env` changed, so the saved token cannot be read. | Enter the token again; see [Back up your secret key](secret-key.md). |

An item disappears once the problem is fixed: after entering a new token, or after **Check again** succeeds.

## Project items

| Item | Why it appears | What to do |
|---|---|---|
| Project setup failed | The Orchestrator could not finish creating or reading the project's GitHub repository. The item names the step that failed and why. | Click **Open the project**, fix the cause if needed, then click **Try again**. See [If the setup fails](projects.md#if-the-setup-fails). |

The item disappears once the setup is ready. An archived project is not listed, even if its setup failed: unarchive it first.

## Setup and machine items

| Item | Why it appears | What to do |
|---|---|---|
| No Claude account yet | No Claude account exists yet. | Click **Open Machines**, then **Add a Claude account**. See [Add a Claude account](machines.md#add-a-claude-account). |
| No machine enrolled yet | No machine has enrolled yet, or every machine is revoked. | Click **Add machine**. See [Add a machine](machines.md#add-a-machine). |
| Update the daemon on … | The machine's daemon is too old (or too new) for this version of the Orchestrator: either it cannot connect, or it connects but gets no runs. | On the machine, type the commands the item shows, one after the other. See [Update the daemon](machines.md#update-the-daemon). |
| The daemon on … is not the one this Orchestrator provides | The daemon works with this Orchestrator, but it is another build than the one this Orchestrator provides, older or newer. The machine still gets runs. | When no agent works on the machine, type the commands the item shows. See [Update the daemon](machines.md#update-the-daemon). |
| Claude Code not supported on … | Claude Code is missing on the machine, or too old: found when the daemon connects, or when a run starts (Claude Code updates itself, so its version can change while the daemon runs). A run that could not start for this reason does not count as a failed attempt. | Install or update Claude Code, then type the restart command the item shows. |
| Problem on … | A check on the machine found an error; the item lists it. | Fix it on the machine, then type the restart command. |
| … is offline with work on it | The machine is offline while agents' runs are on it; the item names their tickets. The runs wait: their Claude Code sessions keep running on the machine if it is still on. | Start the machine, or its daemon, so it connects again. |

Each machine item opens the machine's page. Details: [When a machine has a problem](machines.md#when-a-machine-has-a-problem). The item disappears once the daemon connects again without the problem.
