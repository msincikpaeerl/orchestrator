# Machines

Agents work on your own computers, called **machines**. On each machine, a small program, the **Orchestrator daemon**, receives the work, starts Claude Code for it and reports back. Each machine uses one of your **Claude accounts**: the Claude subscription it is logged into.

Everything here is in **Machines**, in the menu. Add a Claude account first, then a machine.

## Add a Claude account

1. Open **Machines** and click **Add a Claude account**.
2. Fill in:
   - **Label**: a name you recognise, for example "Personal". Two accounts cannot have the same label.
   - **Plan**: your Claude subscription (Pro, Max 5x or Max 20x). In this version it is for your information only.
   - **Runs at the same time**: how many agents may work at once with this account, on all its machines together (1 to 10, 1 by default). A higher number uses your Claude usage faster.
3. Click **Add the account**.

Click **Edit** to change its label, plan or runs at the same time.

Each account also shows its **State**: **Available**, **Paused** (you stopped new runs, below), or **Limited until** a time when it reached its Claude usage limit ("(estimated)" when Claude gave no reset time), with the time left. No run starts on a limited account before that time; it shows **Available** again by itself once the time has passed. See [Usage limits](runs.md#usage-limits).

## Keep Claude usage for yourself

Agents use the same Claude subscription as you. Each account has three ways to keep some of it for your own work: **windows**, a **daily budget** and **Stop new runs**. Click **Windows, budget and history** under an account to set them.

The scheduler, which starts runs by itself (see [What starts by itself](runs.md#what-starts-by-itself)), follows all three. **Run now** always ignores windows and the budget, since you choose to start that run; it is refused only while the account is paused, limited or already running its maximum.

**Time zone first.** Windows and the day of the budget are read in the Orchestrator's time zone, set in **Settings** > **Time zone**. Until you save one, the Orchestrator uses UTC; the field is filled in with your browser's time zone, so you usually only click **Save the time zone**. Summer and winter time are followed by themselves.

**Windows.** Runs start only inside the account's windows; with no window, at any time. Click **Add a window**, tick its days, and set **from** and **until**. A window ending at 00:00 ends at midnight; one ending before its start ends the next day (for example Monday to Friday, 22:00 to 06:00: Monday night to Tuesday morning, and so on). 00:00 to 00:00 is the whole day. Click **Save windows**. When a window ends, a run already started finishes; it is not paused. On the night the clocks go forward, a window starting at an hour that does not exist (02:00 in much of Europe) opens when the clocks jump (03:00).

**Daily budget.** Choose **Working time** (minutes a day) or **Estimated usage** (US dollars a day), then **Save the budget**. Once the runs started today reach it, no new run starts on the account until midnight; a run already started finishes. What counts:

- each run counts whole on the day it started, also while it is still running: its working time so far, and the latest estimate its machine sent. A run started at 23:50 counts for that day, even if it works past midnight;
- working time is the time agents work, not the time they wait for you, for CI or for a usage limit;
- estimated usage is what Claude Code estimates the run would cost in US dollars. Your subscription does not charge it, but it follows how much of your usage a run takes better than time. A run Claude Code gave no estimate for yet counts as $0.00, and the account says how many there are.

The budget is per calendar day and starts again at midnight. So a window crossing midnight (22:00 to 06:00) can use up to two days' budget in one night: the evening's runs count for the first day, the ones started after midnight for the next. To cap a night with one budget, start the window at 00:00.

**Stop new runs.** Click **Stop new runs** on the account, its page or its line in **Needs you**: the account shows **Paused**. Runs already started go on and finish; **Run now**, and **Resume** of a paused run, are refused until you click **Resume**. To free your usage at once, also stop the running agent with **Stop run** on its ticket or run (see [Stop a run](runs.md#stop-a-run)). If the account reaches its usage limit while paused, **Resume** brings it back as limited until that time.

The account's page also shows today against the budget, the estimated usage and runs of the last 14 days (each run on the day it started), and the usage limits it reached. The ticket page shows the estimated usage of the ticket's runs together.

## Before you start

The machine is a Linux computer, or a Windows computer with WSL 2 (Ubuntu). Type every command below in its Ubuntu terminal. It needs:

| Tool | Check with | Needed |
|---|---|---|
| Node.js | `node --version` | 24.x |
| Git | `git --version` | 2.40 or later |
| tmux | `tmux -V` | 3.2 or later |
| Claude Code | `claude --version` | 2.1.280 or later |
| systemd (WSL only) | `systemctl --user is-system-running` | `running`: see [Turn on systemd on WSL](#turn-on-systemd-on-wsl) |
| WSL kept running (WSL only) | — | Done after adding the machine: see [Keep WSL running](#keep-wsl-running) |

To install what is missing:

- **Node.js**: install **nvm** by following the [official nvm instructions](https://github.com/nvm-sh/nvm#installing-and-updating), open a new terminal, then type `nvm install 24`. With nvm, installing the daemon needs no `sudo`.
- **Git and tmux**: `sudo apt update && sudo apt install git tmux`.
- **Claude Code**: follow [Anthropic's installation guide](https://code.claude.com/docs/en/setup). Claude Code updates itself; you do not need to update it by hand.
- **systemd on WSL**: see [Turn on systemd on WSL](#turn-on-systemd-on-wsl) below.

### Turn on systemd on WSL

On Windows, the daemon runs inside WSL as a service, which needs systemd (the service manager of Ubuntu). Do this once per computer, before adding the machine:

1. In Ubuntu, type `sudo nano /etc/wsl.conf` and make sure the file contains:

   ```ini
   [boot]
   systemd=true
   ```

2. Save, then in a Windows terminal (PowerShell) type `wsl.exe --shutdown` and open Ubuntu again.
3. Check: `systemctl --user is-system-running` should answer `running`.

Details: [Microsoft's systemd guide](https://learn.microsoft.com/windows/wsl/systemd).

### Agents on your own user

In this version, the daemon runs under your own Linux user, so agents work with your user's rights. The Orchestrator refuses, and tells the agent why:

- its own `~/.orchestrator` folder, which holds the machine's key and the other runs' work, and the Claude configuration folders (`~/.claude`, `~/.claude.json`, and the Orchestrator's own Claude login);
- any file outside the project's folder for the file tools (reading, writing, searching);
- in shell commands: your home folder (`~`), paths outside the project's folder other than `/tmp`, `/dev/null` and system folders such as `/usr` and `/etc`, the Windows drives under `/mnt`, and changes to the project's `.claude` folder;
- every Git command that reaches another computer (`push`, `fetch`, `pull`, `clone`, …), `gh` and `hub`, and any command naming GitHub: on WSL, Git often remembers your own GitHub login (Git Credential Manager), and an agent must never use it. The Orchestrator itself fetches the project and, later, pushes the agent's branch;
- `tmux`, so an agent cannot reach its own session or another one.
- the container tools `docker`, `docker-compose`, `podman`, `nerdctl` and `kubectl`: your user can use them, and the Orchestrator itself may run in Docker on the same computer, so a container's configuration could show the Orchestrator's secret key.

An agent may still read public GitHub pages in its web browsing tool. The checks on shell commands are **best effort**: a command could still read a file of your user that it does not name directly, while text that only looks like a path, such as a web route in `grep "/api/users"`, is not refused: something counts as a path only when its first folder exists on the computer (`/home`, `/mnt`, `/usr`, …). Keep secrets you care about off this machine, or use a computer dedicated to the Orchestrator. A guide for running the daemon under its own user comes in a later version: it protects your personal files, not the daemon's own key or your GitHub token (see "What stays possible" below).

The list of commands an agent may run (see [Agents](agents.md)) saves time, since a command outside it is refused at once, but it does not protect your computer: the tools it allows, such as `node`, `npx` and `pnpm`, can run any program. The protection comes from the refusals above.

Agents may also search the web and read web pages, to look up how a library works. A web page can hide instructions meant for an agent, hoping it follows them. The refusals above limit what such instructions could make it do: no access to your files outside the project, to the Orchestrator's folder or to GitHub.

Claude Code itself tells every agent the e-mail address of the Claude account it runs with and your Git user name and e-mail address (from your global Git settings), as it does in your own sessions. They are not secrets, but an agent sees them.

For the same reason, an agent could pretend to be its own session and send the Orchestrator false news about its run (for example that it finished a step). The Orchestrator limits the harm: each run's key only allows actions on that run's own ticket, so an agent can never change another ticket or touch another project. It can only propose new tickets in its project, which wait for you to accept or reject them.

When the last run of a project on a machine ends, the daemon also puts back the Git settings and hooks of its copy of the project, which every run of that project on this machine shares, as it wrote them: an agent may have changed them, on purpose or through a tool (husky, for example, sets where Git finds its hooks). While another run of the project still has its copy there (working, waiting for your answer or paused), nothing is put back, so what that run set up keeps working. When something had changed, [Activity](activity.md) shows "Git configuration restored" on the run that ended, naming the settings and hook files, never their values; the change may come from that run or from an earlier run of the project on the machine. This is information only: nothing is refused, and nothing needs you. It changes nothing for your GitHub token, since the daemon never reads these settings when it fetches or pushes.

When a run's session closes (the run ends, or a run waiting for your answer is paused), the Orchestrator stops every program the agent left running, even one started to keep running on its own (with `nohup` or `setsid`), so nothing goes on working in a folder that is then removed.

Your GitHub token is never stored on the machine. The daemon receives it from the Orchestrator for one Git command at a time, keeps it only in memory during that command, and never shows it to the agents. From version 0.4.0 the daemon fetches and pushes in a separate place it prepares itself: it never reads the Git settings of the project, of your user or of your computer, which an agent can change, so a setting an agent added cannot send the token to another computer or to another program.

**What stays possible in this version.** Because agents run under the same Linux user as the daemon, a determined agent, or instructions hidden in a web page it read, could still take the token:

- by reading the daemon's own key in `~/.orchestrator` (the refusals above stop the usual ways, but not every program an allowed tool like `node` can run) and asking the Orchestrator for the token as if it were the daemon, while one of its runs is active;
- by leaving a program running that watches the daemon's Git commands while they run.

A stolen token allows **writing to and administering every repository of your GitHub account**: the token covers "All repositories" with Administration, because the Orchestrator creates repositories ([Connect GitHub](github-token.md)). Running the daemon under a separate Linux user does not change this, since the agents run under the daemon's user; it only keeps them away from your personal files. A later version runs the agents under a user of their own, apart from the daemon. Until then, give agents tickets on projects you trust, and if you suspect a token was taken, delete it on GitHub at once (Settings > Developer settings > Personal access tokens > Fine-grained tokens), then create a new one with **Replace the token**.

## Add a machine

1. Open **Machines** and click **Add machine**.
2. Give the machine a **Name** (for example "Desktop") and choose its **Claude account**, then click **Show the commands**.
3. On the machine, type the commands the page shows, in order:
   1. `npm install -g …`: installs the daemon of the same version as the Orchestrator, downloaded from the Orchestrator itself.
   2. `orchestrator-daemon enroll …`: connects the machine to the Orchestrator with a one-time code. The code works once, and only for a limited time: 15 minutes by default (the **Enrollment code lifetime** setting, see [Settings](settings.md#machines)). If it expires, open the machine and click **New enrollment code**.
   3. `orchestrator-daemon login`: opens Claude Code once, in a configuration kept only for the Orchestrator (your own Claude Code settings are not used). Type it in any folder: Claude Code always opens in an empty folder of the Orchestrator's own, so it does not ask whether you trust a folder. The first time, Claude Code may ask a few setup questions (colours, account type) and show notices: keep the defaults, choose your Claude subscription if asked, log in with the link it shows (on WSL, open it in a browser in Windows) using the Claude account you chose for this machine, then type `/exit`.
   4. `orchestrator-daemon install-service`: starts the daemon as a background service, which also starts again after a restart of the computer. The service uses the tools this terminal finds (Node.js, Git, tmux, Claude Code): the command prints the list of folders it looks in (the `PATH`). Type it in a terminal where `node --version` and `claude --version` work. It also turns on [lingering](#lingering), so the service keeps running when you close the terminal.
4. Come back to the Orchestrator page. It checks again each time you come back to it and shows **Connected** once the daemon has connected. If it says the machine cannot receive runs yet, see [When a machine has a problem](#when-a-machine-has-a-problem).

On Windows, also do [Keep WSL running](#keep-wsl-running).

Then try the machine with the small ticket of [Try it with a small ticket](runs.md#try-it-with-a-small-ticket): it shows the whole work of an agent, a question and a proposed ticket included, with little of your Claude usage.

If the Orchestrator runs on another computer, read [Orchestrator on another computer](#orchestrator-on-another-computer) first. When its address starts with `http://` and is not this computer, **Add machine** warns you at the top of the page: the daemon would refuse that address.

### Orchestrator on another computer

The machine's key, and your GitHub token for each Git command, travel between the daemon and the Orchestrator. So the daemon accepts a plain `http://` address only when the Orchestrator runs on the same computer (`http://localhost:8080`). Otherwise it refuses the address and asks for `https://`.

To use machines with an Orchestrator on another computer (a dedicated server, or a VPS):

1. Put the Orchestrator behind a reverse proxy with HTTPS (such as Nginx Proxy Manager or Caddy), and set its `PUBLIC_URL` to the `https://` address: see [Open the Orchestrator from another device](network-access.md).
2. Add the machine: the commands then use the `https://` address.
3. If the reverse proxy uses a certificate from your own certificate authority (a self-signed or internal certificate), copy that authority's certificate (a PEM file, starting with `-----BEGIN CERTIFICATE-----`) to the machine and add `--ca-file` to the enroll command:

   ```sh
   orchestrator-daemon enroll https://orchestrator.home.lan ABCD-... --ca-file ~/orchestrator-ca.pem
   ```

   The daemon keeps a copy of it and uses it for every connection. Certificates are always checked: there is no way to turn the check off.

`orchestrator-daemon doctor` shows the address and whether its certificate is valid, with a warning when it expires within 14 days.

### Keep WSL running

On Windows, the daemon runs inside WSL, and Windows stops WSL a few seconds after its last Ubuntu window closes, even while the daemon runs. Do this once per computer:

1. In Windows, open the file `.wslconfig` in your user folder (type `notepad %UserProfile%\.wslconfig` in PowerShell; create it if it does not exist) and add:

   ```ini
   [general]
   instanceIdleTimeout=-1
   ```

2. Save, then type `wsl.exe --shutdown` in PowerShell and open Ubuntu again. The daemon's service starts with it.

Instead, you can keep an Ubuntu window open. Details: [Microsoft's WSL settings guide](https://learn.microsoft.com/windows/wsl/wsl-config).

**Check that it works**: close every Ubuntu window, wait two minutes, then open the machine in the Orchestrator: it is still **Online**. (A machine whose WSL stopped shows **Offline** after about a minute: the **Machine offline after** setting, 60 seconds by default. Waiting two minutes leaves time for it.)

The daemon cannot read this Windows file: its checks show "Check this yourself" for it, with a link to this section.

**Keep the computer awake.** Runs go on only while the computer is awake: when Windows sleeps or hibernates, WSL stops with it, and so do the daemon and its agents; the machine shows **Offline** (see [When a machine goes offline during a run](#when-a-machine-goes-offline-during-a-run)). Before leaving runs to go on overnight, open Windows **Settings** > **System** > **Power & battery** (**Power** on a desktop computer) and set the times after which it sleeps and hibernates to **Never** when plugged in; keep a laptop plugged in, with its lid open.

### Lingering

Linux normally stops your services when you close your last terminal or log out. **Lingering** tells it to keep them running, and to start them when the computer starts, even before you log in. The daemon's service needs it. `orchestrator-daemon install-service` turns it on for you.

`orchestrator-daemon doctor` shows **Lingering**: **OK** when it is on. When it is off (a warning, and `install-service` said "Lingering could not be turned on" with the reason), type the command the check shows, with your Linux user name, for example:

```sh
loginctl enable-linger alice
```

`$USER` gives your user name: `loginctl enable-linger "$USER"` works too. Type the name: without it, on WSL, loginctl answers "Could not enable linger: No such device or address". If it answers that you are not allowed, type it again with `sudo` in front. Check with `loginctl show-user "$USER" --property=Linger`: it answers `Linger=yes`. Then restart the daemon (see [When a machine has a problem](#when-a-machine-has-a-problem)).

## The machine page

Click a machine's name to open its page. It shows:

- its **status**: **Online** (connected), **Offline** (not connected; the daemon or the computer is stopped, or WSL was shut down), **Waiting for enrollment**, **Disabled** or **Revoked**;
- its Claude account, system, daemon and Claude Code versions, and when it was last heard from;
- its **daemon build** and the build this Orchestrator provides (see [Update the daemon](#update-the-daemon));
- the **Checks on the machine**, done by the daemon each time it connects: **OK**, **Warning**, **Error** or **Check this yourself**. An error keeps the machine from receiving runs;
- its **Active runs**: each run in progress on it, as [Live runs](activity.md#live-runs) shows them, with **Stop run** and the command to watch it in a terminal;
- its **capabilities** and its actions.

The machine list also shows each machine's active runs, each linking to its run page.

A Claude Code newer than the latest version checked with this version of the Orchestrator shows a warning. Runs are still allowed. If runs fail to start after a Claude Code update, update the Orchestrator when a new version is out.

### Capabilities

Capabilities are the tools a machine has, such as `git`, `node`, `docker` or `android-sdk`. The daemon detects `git`, `node` and `docker` each time it connects. Each tag says where it comes from:

- **detected**: found by the daemon;
- **added by you**: you added it (with "not detected" when the daemon does not find it);
- **removed by you**: you removed it, and it stays removed even when the daemon detects it (with "detected" when it does). Click **Add back** to use it again.

To add one, type it in **Add a capability** (lowercase letters and digits, with `-` between words, for example `android-sdk`) and click **Add**. Click **Remove** to take one away.

### Disable, revoke, enroll again

- **Disable**: the machine stays connected but gets no new runs; runs already on it finish. **Enable** gives it runs again.
- **Revoke**: for a lost computer, or one you stop using. The daemon is disconnected at once and its key never works again; runs still active on it fail. You are asked to confirm. The machine stays in the list.
- **New enrollment code**: on a revoked machine, or one that has not enrolled yet. It shows the commands again with a new code; type the `enroll` command again on the machine, then restart the daemon.

## When a machine has a problem

The daemon checks the machine each time it connects. So after fixing a problem, **restart the daemon** so it checks again:

```sh
systemctl --user restart orchestrator-daemon
```

Restarting the service does not interrupt the agents at work: their sessions keep running in [process scopes](#process-scopes) and the daemon finds them again when it is back.

If you run the daemon yourself in a terminal (`orchestrator-daemon start`) instead of as a service, stop it with Ctrl+C and start it again.

"Needs you" lists these problems, each with a link to the machine:

| Item | Why it appears | What to do |
|---|---|---|
| No Claude account yet | No Claude account exists. | Add one: see [Add a Claude account](#add-a-claude-account). |
| No machine enrolled yet | No machine has enrolled (revoked machines do not count). | See [Add a machine](#add-a-machine). |
| Update the daemon on … | The machine's daemon is too old (or too new) for this version of the Orchestrator. Either it cannot connect, or it connects but gets no runs. This happens after updating the Orchestrator. | [Update the daemon](#update-the-daemon) with the commands the item shows. |
| The daemon on … is not the one this Orchestrator provides | The daemon works with this Orchestrator, but it is not the daemon this Orchestrator provides: an older or a newer build of it (see [Update the daemon](#update-the-daemon)). The machine still gets runs. | [Update the daemon](#update-the-daemon) with the commands the item shows, so the machine runs the daemon this Orchestrator was tested with. |
| Claude Code not supported on … | Claude Code is missing, or older than 2.1.280. The machine gets no runs. | Install or update Claude Code (see [Before you start](#before-you-start)), then restart the daemon. |
| Problem on … | A check on the machine found an error, for example tmux missing or too old, or [process scopes](#process-scopes) that cannot be created. The machine gets no runs. | Fix what the item names, then restart the daemon. |

An item disappears once the daemon connects again without the problem.

### After changing the Node.js version

The service starts the daemon with the Node.js it was installed with. If you install another Node.js version (for example with `nvm install`), install the daemon again with the same `npm install -g …` command you typed when adding the machine, then type `orchestrator-daemon install-service` again. The checks show an error until you do.

### After installing a tool

The service looks for tools in the folders it was given by `install-service`. After installing a tool (for example Docker, or Claude Code in another folder), type `orchestrator-daemon install-service` again from a terminal where the tool works.

### Process scopes

When the daemon runs as a service, it starts the agents' sessions in **process scopes**: groups of processes that systemd keeps apart from the service. That is why restarting the service does not stop the agents at work, and why everything an agent started stops with its run.

If the daemon cannot create a process scope, a restart of the service would stop every agent's session. So the daemon still connects, but the machine takes no runs: "Needs you" shows **Problem on …** with "Process scopes" and the reason, and `orchestrator-daemon status` and `orchestrator-daemon doctor` show it too. This is checked when the daemon starts. If a run's scope cannot be created later, that run fails without counting as a failed attempt, its ticket goes back to To do, and the machine takes no runs either until the daemon is restarted.

To fix it, on the machine:

1. Type `systemctl --user is-system-running`. It should answer `running` (`degraded` also works). If it answers "Failed to connect to bus", systemd does not run for your user: on WSL, see [Turn on systemd on WSL](#turn-on-systemd-on-wsl).
2. Type `systemd-run --user --scope true`. It should end at once without a message. If it prints an error, that error is what to fix: it is also the reason shown in "Needs you".
3. Restart the service: `systemctl --user restart orchestrator-daemon`. The item disappears once the daemon connects without the problem.

A daemon you run yourself in a terminal (`orchestrator-daemon start`) does not need process scopes: where systemd does not run, it starts sessions without them.

### When the daemon stopped by itself

The daemon stops, instead of trying again, when trying again cannot help:

- the machine was revoked, or got a new enrollment code: enroll it again with the command shown on its page, then restart the daemon;
- the daemon's version does not match the Orchestrator's: [update the daemon](#update-the-daemon);
- another daemon connected with this machine's key (a second terminal, or a copy of the `~/.orchestrator` folder on another computer): stop the other one, or add that computer as its own machine.

`orchestrator-daemon status` and `orchestrator-daemon doctor` show why it last stopped. Only one daemon runs per user: `orchestrator-daemon start` refuses when the service already runs.

## Update the daemon

The daemon on each machine must match the Orchestrator. After updating the Orchestrator, update the daemon on every machine. "Needs you" and the machine's page tell you when a machine needs it:

- **Update the daemon on …**: the daemon is too old (or too new) for this Orchestrator. Either it cannot connect, or it connects but gets no runs until you update it. For example, a daemon of version 0.3.0 cannot push work to GitHub, which this Orchestrator needs.
- **The daemon on … is not the one this Orchestrator provides**: the daemon works with this Orchestrator and still gets runs, but it is another **build** than the one this Orchestrator provides. A build is a short code, such as `3f9a0c1d2e4b5a69`, that changes whenever the daemon's program changes. Two daemons with the same version number can be different builds, and the one on the machine can be older or newer than the one provided. Updating gives the machine the daemon this Orchestrator was tested with.

Update when no agent is working on the machine (its page shows no active run), so no work is interrupted. Then, on the machine, in its Ubuntu terminal, type these commands one after the other. The item in "Needs you" and the machine's page show them with your Orchestrator's address and version filled in in place of `<server URL>` and `<version>`: copy them from there.

```sh
systemctl --user stop orchestrator-daemon
npm uninstall -g orchestrator-daemon
npm install -g --prefer-online <server URL>/downloads/orchestrator-daemon-<version>.tgz
orchestrator-daemon install-service
orchestrator-daemon doctor
```

They:

1. stop the daemon's service;
2. remove the installed daemon;
3. install the daemon this Orchestrator provides, downloaded from it again (`--prefer-online`: npm would otherwise reuse a copy of the same version number it keeps, which can be another build);
4. install the service again and start it;
5. check the machine.

Then open the machine's page: it should be **Online**, receive runs, and show the same **Daemon build** as **Build this Orchestrator provides**. `orchestrator-daemon --version` shows the version and build of the daemon installed on the machine.

If you run the daemon yourself in a terminal instead of as a service, stop it with Ctrl+C instead of the first command, skip `install-service`, and start it again with `orchestrator-daemon start`.

## Troubleshooting

Type these commands on the machine, in its Ubuntu terminal:

| To | Type |
|---|---|
| See whether the daemon's service is running, and its last messages | `systemctl --user status orchestrator-daemon` |
| Read the daemon's last 100 messages | `journalctl --user -u orchestrator-daemon -n 100` |
| Follow its messages as they come (stop with Ctrl+C) | `journalctl --user -u orchestrator-daemon -f` |
| Check the machine: tools and versions, Claude Code login, systemd, the service and its process scopes, WSL settings, the Orchestrator's certificate | `orchestrator-daemon doctor` |
| See whether the daemon runs (as the service or in a terminal), its version and build, its connection to the Orchestrator, versions, capabilities, process scopes and runs on this machine, or why it last stopped; and the ticket branches kept on this machine with their commits not on GitHub yet (listed even when the daemon is stopped) | `orchestrator-daemon status` |
| Restart the daemon, for example after fixing a problem | `systemctl --user restart orchestrator-daemon` |
| Stop the daemon: the machine shows **Offline** and gets no run until you start it again (a run it was doing fails after **Runs of an offline machine fail after**) | `systemctl --user stop orchestrator-daemon` |
| Start it again | `systemctl --user start orchestrator-daemon` |

If a run fails at its start with "The ticket branch … is checked out by another run on this machine": a run of the same ticket on that machine still waits for your answer or is paused, holding the branch (this happens only when that run was stopped while the machine was offline). Its branch is left as it is. Wait until the machine is online again: the old run is stopped when it reconnects, and **Run now** works again.

If the machine can reach GitHub only through a proxy: from version 0.4.0 the daemon ignores Git's own settings (`~/.gitconfig` and the computer's Git settings), so a proxy set there with `git config --global http.proxy` is not used when it fetches or pushes. Set the proxy in the daemon's environment instead (`https_proxy`, and `no_proxy` for the addresses to reach directly) and restart the daemon.

If `systemctl --user` answers "Failed to connect to bus", systemd is not running: see [Turn on systemd on WSL](#turn-on-systemd-on-wsl). If the machine shows **Offline** while the service runs, read the daemon's last messages: they say why it cannot reach the Orchestrator.

### When a machine goes offline during a run

A machine goes **Offline** when its daemon stops, the computer sleeps or shuts down, WSL stops, or the network drops. Its agents' sessions keep running on the computer as long as it is on, and the run page says "(machine offline)".

- **Back within Runs of an offline machine fail after** (from version 0.5.0; 10 minutes by default, in [Settings](settings.md#settings-reference)): nothing is lost. The run goes on where it was; while the machine was offline the agent's calls to the Orchestrator were answered "try again in a few minutes", so it waits and tries again.
- **Offline longer than that**: a run that was starting or working (waiting for CI included) **fails** as "machine offline", and the ticket's timeline says so: "The run failed as "machine offline": machine Laptop was offline for 10 minutes (Runs of an offline machine fail after: 10 minutes). It does not count as a failed attempt. …". The ticket goes back to **To do** (a review run's ticket stays **In review**, and Needs you shows "Review did not finish", with **Start review**).
- **What then starts by itself**: the scheduler can start the ticket again, but not on that machine until it is back (see [When a machine keeps failing a ticket](runs.md#when-a-machine-keeps-failing-a-ticket)). When the ticket's commits are only on that machine (not on GitHub yet), no other machine takes it either, and **Run now** says why: "The ticket's branch has 2 commits not on GitHub, only on machine Laptop, and it is offline since 3:12 PM. The run can only continue there." Once the machine is back, the ticket starts there again. If the same machine loses the ticket's run twice in a row, Needs you shows "WEB-12 could not start on Laptop" and the scheduler waits for your **Run now**.
- **When the machine comes back**, a session that was still running is stopped, and the work it had done is kept: its commits are pushed to GitHub as at the end of any run, and the run page lists them. If that push fails, they stay on the machine, as after any failed push.
- **Runs waiting for you or paused at a usage limit keep waiting**, however long the machine is offline. Your answer, or **Resume**, needs the machine online: offline, the run then fails as "machine offline", not counted.
- **A machine that restarted without a run** (its daemon no longer has it when it connects again): that run fails at once as "machine offline", not counted, and the ticket can start again on that machine.

None of these failures counts as a failed attempt. To keep a run going while you are away, keep the machine on and connected (see [Keep WSL running](#keep-wsl-running)); to give runs more time to come back, raise **Runs of an offline machine fail after**.

### When the project cannot be downloaded from GitHub

At the start of every run, the machine downloads the project from GitHub. When it cannot, the agent never starts, and the run ends with "the project could not be downloaded from GitHub". Such a run does **not** count as a failed attempt, so it never stops the ticket. "Needs you" shows "<ticket> could not be downloaded from GitHub on <machine>", with **Run now**, and says which of three things happened:

- **GitHub could not be reached** from the machine: check that it is connected to the internet and that GitHub works, then press **Run now**.
- **GitHub refused the token**: when GitHub says the repository is not found, the token cannot see the project's repository. On GitHub's list of your tokens (the item links to it), open the Orchestrator's token, make sure it includes the repository with **Contents (Read and write)**, and save it; do not regenerate it. When the Orchestrator itself did not give the token, or GitHub gave other words, the item shows them: check Settings > GitHub. Then press **Run now**.
- **The download took longer than Longest push**: the first download of a project on a new machine is the longest, since it brings the project's whole history; later runs download only what changed. Press **Run now** again, or raise **Longest push** in Settings > Limits (the MCP call timeout plus Longest push must stay below the Claude Code MCP tool timeout, so raise that one first if the Orchestrator refuses).

The item goes when a new run of the ticket starts, when the ticket is done or cancelled, or when the machine is revoked. A review run that fails this way shows "Review did not finish" instead, with the same words and **Start review**. Any other failure while the machine prepares the run (a full disk, for example) still counts as a failed attempt.
