# Projects

A project is one product the Orchestrator builds for you: a web app, a website or an Android app. Every project has its own GitHub repository, on your personal GitHub account, where its code and documentation live.

You find your projects under **Projects** in the menu. The list shows, for each project, how many tickets it has in each state (see [Tickets](tickets.md)) and its last activity: the time of its most recent event, which opens the project's [event log](activity.md#event-log).

## Create a project with a new repository

Use this to start something new. The Orchestrator creates the repository on GitHub for you.

1. Open **Projects** and click **New project**.
2. Keep **Create a new repository** selected.
3. Fill in the form:
   - **Name**: the name of the project, for example "Family recipes".
   - **Key**: 2 to 6 capital letters, suggested from the name (for example `FR`). Every ticket number of the project starts with it (`FR-12`). It cannot be changed later, and two projects can never have the same key, even when one of them is archived.
   - **Kind**: web app, website or Android app. From version 0.6.0, a website or a web app requires the capability `browser-tests`, so its agents can run its tests in a browser: its runs go only to a machine set up for browser tests (see [Browser tests](machines.md#browser-tests) and [Required capabilities](#required-capabilities)). The form says so under **Kind**. An Android app requires nothing yet.
   - **Description**: optional, one or two sentences.
   - **Repository name**: the name of the new repository on GitHub, made from the project name. You can change it. The form tells you if a repository with this name already exists on your account.
   - **Visibility**: **Private** (only you can see it, the default) or **Public** (anyone on the internet can see it).
4. Click **Create the project**.

The project page opens and shows the setup while it runs. The page updates by itself until the setup is finished. The steps are:

1. **Create the GitHub repository.**
2. **Add the starting files**: a README, a CLAUDE.md with the instructions for the agents, folders for the documentation and the decisions, and a CI workflow on GitHub that checks the documentation links. On GitHub, the repository then has two commits: GitHub's own first README, then the starting files.
3. **Protect the default branch** (see [Branch protection](#branch-protection)).

When all the steps are done, the setup says **Ready**, and you can create the project's tickets on its page (see [Tickets](tickets.md)).

## Link an existing repository

Use this for a repository you already have on your personal GitHub account. The Orchestrator leaves it exactly as it is: it adds no files and changes no settings.

1. Open **Projects** and click **New project**.
2. Choose **Link an existing repository**.
3. Choose the **Repository**. The list shows your repositories that are not archived on GitHub and not already linked to a project. The project name is filled in with the repository's name; change it if you like.
4. Fill in the key, kind and description as for a new repository, then click **Create the project**.

The Orchestrator then looks in the repository for the elements that help agents work well, and lists the missing ones on the project page (see [Missing harness elements](#missing-harness-elements)).

## Branch protection

Branch protection is a GitHub setting that stops anyone from changing the repository's default branch (usually `main`) directly: every change must go through a pull request whose checks pass. The Orchestrator turns it on for the repositories it creates, when GitHub allows it.

The project page shows one of:

| Branch protection | Meaning |
|---|---|
| **Applied** | GitHub protects the default branch. |
| **Not available on your GitHub plan** | GitHub's free plan offers branch protection only on **public** repositories. Your private repository works normally without it. |
| **Not applied: a linked repository is never changed** | For a linked repository, the Orchestrator does not change its settings. You can set up branch protection yourself on GitHub. |
| **Failed** | GitHub refused the request for another reason than your plan, for example because the GitHub token is missing the Administration permission. The whole setup then stops at this step and is not Ready: see [If the setup fails](#if-the-setup-fails). |

**"Not available on your GitHub plan" is not a problem.** Agents never write to the default branch anyway: only the Orchestrator sends their work to GitHub, always on a separate branch, and you merge it with a pull request. Branch protection is an extra safety net. If you want it on a private repository, GitHub asks for a paid plan (GitHub Pro).

## Missing harness elements

The "harness" is a set of files that tell agents how the project works and check their work. The Orchestrator puts them in every repository it creates. In a linked repository, it lists the ones it did not find, under **Harness elements** on the project page. Missing elements do not stop you from creating tickets, but agents work better with them.

After adding files on GitHub, click **Check again** on the project page to update the list.

### CLAUDE.md

A file named `CLAUDE.md` at the root of the repository. It gives agents the essentials: what the project is, the commands to build and test it, and the project's rules.

### User documentation

At least one file in the `docs/user/` folder: the guide for the people who use the product, written without technical words.

### Developer documentation

At least one file in the `docs/dev/` folder: how to set up, build and test the project.

### Architecture decisions

At least one file in the `docs/adr/` folder. Each file records one technical decision (for example the choice of a framework) and why it was made, so agents do not reopen it.

### CI workflow

At least one `.yml` or `.yaml` file in the `.github/workflows/` folder: the checks GitHub runs on every pull request (tests, formatting, links). Agents rely on them to know their work is correct.

## If the setup fails

If GitHub refuses a request or cannot be reached, the setup stops and the project page shows the step that failed and why, with a **Try again** button. This includes branch protection refused for another reason than your GitHub plan: the project is not Ready until that step succeeds. "Needs you" lists the project until its setup is ready.

1. Read the reason and fix its cause if needed. For example, if the GitHub token is missing a permission (Administration, for branch protection), replace it in **Settings > GitHub connection** (see [Connect GitHub](github-token.md)). If GitHub could not be reached, just wait a moment.
2. Click **Try again**. The setup continues from the failed step: the steps already done are not done twice.

If the Orchestrator restarted during a setup, the reason is "The setup was interrupted by a restart of the server": click **Try again**.

### "Repository name already taken"

This reason means that when the setup came to create the repository, a repository with the project's name already existed on your GitHub account, and the Orchestrator could not be sure it had created it itself. It never takes over a repository it did not create, so it wrote nothing to it and stopped.

It can happen on the first attempt: someone created a repository with this name on GitHub between the moment you filled in the form and the moment the setup started. It can also happen when you click **Try again**: most often because a repository with this name was created on GitHub since the first attempt. Rarely, the Orchestrator did create it, but GitHub's answer was lost (for example in a restart) and the clock of the computer running the Orchestrator server (not the one of your browser, if you open the Orchestrator from another device) differs from GitHub's clock by more than the allowed difference (2 minutes by default), so the Orchestrator cannot prove the repository is its own.

What you can do:

- Open the repository on GitHub. Delete it only if both are true: it contains only GitHub's README (or only the starting files listed in [Create a project with a new repository](#create-a-project-with-a-new-repository)), and you did not create it yourself. **Deleting a repository on GitHub is permanent**: it cannot be undone. If in doubt, do not delete it. To delete it: the repository's **Settings**, then **Delete this repository** at the bottom. Then click **Try again**: the Orchestrator creates it again.
- If the Orchestrator created it and the clock difference is the cause, raise the **GitHub clock tolerance** setting (**Settings > Limits**, see [Change a limit](settings.md#change-a-limit)), then click **Try again**. Check also that the computer running the Orchestrator server sets its clock automatically.
- If you want to keep that repository and use it, archive this project and create a new project that links the repository instead (with another key, since keys are never reused). A linked repository gets no starting files and no branch protection. So for a repository the Orchestrator created (only a README or the starting files), deleting it and trying again is the better choice.

## Change a project's name or description

On the project page, click **Project settings**, change the **Name** or **Description**, then click **Save**. The key, the repository and the kind cannot be changed. The same page has the project's [Required capabilities](#required-capabilities).

## Reviews by themselves

From version 0.5.0, once a ticket's work is ready for review, the scheduler starts Quality's review by itself (see [Review by Quality](tickets.md#review-by-quality)). Each review uses one Claude Code session from your Claude plan. To decide each time yourself, turn it off for the project:

1. On the project page, click **Project settings**.
2. Under **Reviews by Quality**, uncheck **Start reviews by themselves**. It is saved at once: "Saved: reviews wait for Start review. A review already running goes on."

While it is off, a ticket ready for review waits for you: "Ready for review" in [Needs you](needs-you.md#agents-work) says "Start reviews by themselves is off in this project's settings: the review waits for you to use Start review.", and you choose **Start review** or **Skip review**, as in version 0.4.0. A review already running is not stopped. Fixes after a request for changes still start by themselves: the switch is only about reviews.

Check the box again to let the scheduler start reviews: a ticket already waiting for its review is then started in its turn. Every project starts with the box checked, also the projects created before version 0.5.0. Each change is in the [event log](activity.md).

## Required capabilities

A project's **required capabilities** are what every run of the project needs on the machine, as tags such as `browser-tests`. A run of the project goes only to a machine that has all of them (a machine shows its capabilities on its page, see [Capabilities](machines.md#capabilities)), and Quality's reviews too.

From version 0.6.0, a new website or web app, with a new repository or a linked one, requires `browser-tests`. Projects created before require nothing, and nothing changes for them unless you add a capability.

To see or change them:

1. On the project page, click **Project settings**.
2. Under **Required capabilities**:
   - click **Remove** next to a capability you no longer want to require, for example `browser-tests` if no machine of yours is set up for browser tests yet and the project's agents can do without them;
   - or type one in **Add a capability** (lowercase letters and digits, with "-" between words, for example `android-sdk`) and click **Add**.

Each change is saved at once ("Saved. A run already started goes on where it is.") and written in the [event log](activity.md). From then on, a ticket of the project waits in Activity > [Queue](activity.md#queue) while no machine has them all, which says "Laptop: it lacks browser-tests"; **Run now** and **Start review** give the same reason. Add the capability to a machine (Help > [Browser tests](machines.md#browser-tests) for `browser-tests`), or remove it from the project. A paused run resumes on its own machine, even when you added a capability since. An archived project's list cannot be changed.

## Archive a project

Projects are never deleted: you archive the ones you no longer work on.

1. Open the project, click **Project settings**, then **Archive**. (You can also click **Archive** next to the project in the list.)
2. Confirm. The project and its tickets are kept but become read-only, and no new work starts on it.

**Archiving never changes the GitHub repository**: it stays on GitHub as it is. Delete or archive it on GitHub yourself if you want to.

Archived projects are hidden from the list. To see them, tick **Show archived** on the Projects page. To use one again, click **Unarchive** (in the list or on the project page) and confirm; the repository is not changed either. An archived project keeps its key: a new project cannot use it.

A project cannot be archived while its setup is running: wait until it is ready or has failed.
