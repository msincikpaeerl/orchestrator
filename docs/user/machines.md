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

An agent may still read public GitHub pages in its web browsing tool. The checks on shell commands are **best effort**: a command could still read a file of your user that it does not name directly, while text that only looks like a path, such as a web route in `grep "/api/users"`, is not refused: something counts as a path only when its first folder exists on the computer (`/home`, `/mnt`, `/usr`, …). Keep secrets you care about off this machine, or use a computer dedicated to the Orchestrator. A guide for running the daemon under its own user comes in a later version.

Claude Code itself tells every agent the e-mail address of the Claude account it runs with and your Git user name and e-mail address (from your global Git settings), as it does in your own sessions. They are not secrets, but an agent sees them.

For the same reason, an agent could pretend to be its own session and send the Orchestrator false news about its run (for example that it finished a step). The Orchestrator limits the harm: each run's key only allows actions on that run's own ticket, so an agent can never touch another ticket or another project.

Your GitHub token is never stored on the machine. The daemon receives it from the Orchestrator for one Git command at a time, keeps it only in memory during that command, and never shows it to the agents.

## Add a machine

1. Open **Machines** and click **Add machine**.
2. Give the machine a **Name** (for example "Desktop") and choose its **Claude account**, then click **Show the commands**.
3. On the machine, type the commands the page shows, in order:
   1. `npm install -g …`: installs the daemon of the same version as the Orchestrator, downloaded from the Orchestrator itself.
   2. `orchestrator-daemon enroll …`: connects the machine to the Orchestrator with a one-time code. The code works once, and only for a limited time: 15 minutes by default (the **Enrollment code lifetime** setting, see [Settings](settings.md#machines)). If it expires, open the machine and click **New enrollment code**.
   3. `orchestrator-daemon login`: opens Claude Code once, in a configuration kept only for the Orchestrator (your own Claude Code settings are not used). Log in with the Claude account you chose, then quit Claude Code (type `/exit`).
   4. `orchestrator-daemon install-service`: starts the daemon as a background service, which also starts again after a restart of the computer. The service uses the tools this terminal finds (Node.js, Git, tmux, Claude Code): the command prints the list of folders it looks in (the `PATH`). Type it in a terminal where `node --version` and `claude --version` work.
4. Come back to the Orchestrator page. It checks again each time you come back to it and shows **Connected** once the daemon has connected. If it says the machine cannot receive runs yet, see [When a machine has a problem](#when-a-machine-has-a-problem).

On Windows, also do [Keep WSL running](#keep-wsl-running).

If the Orchestrator runs on another computer, read [Orchestrator on another computer](#orchestrator-on-another-computer) first.

### Orchestrator on another computer

The machine's key, and your GitHub token for each Git command, travel between the daemon and the Orchestrator. So the daemon accepts a plain `http://` address only when the Orchestrator runs on the same computer (`http://localhost:8080`). Otherwise it refuses the address and asks for `https://`.

To use machines with an Orchestrator on another computer (a home server such as Unraid, or a VPS):

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

## The machine page

Click a machine's name to open its page. It shows:

- its **status**: **Online** (connected), **Offline** (not connected; the daemon or the computer is stopped, or WSL was shut down), **Waiting for enrollment**, **Disabled** or **Revoked**;
- its Claude account, system, daemon and Claude Code versions, and when it was last heard from;
- the **Checks on the machine**, done by the daemon each time it connects: **OK**, **Warning**, **Error** or **Check this yourself**. An error keeps the machine from receiving runs;
- its **capabilities** and its actions.

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

If you run the daemon yourself in a terminal (`orchestrator-daemon start`) instead of as a service, stop it with Ctrl+C and start it again.

"Needs you" lists these problems, each with a link to the machine:

| Item | Why it appears | What to do |
|---|---|---|
| No Claude account yet | No Claude account exists. | Add one: see [Add a Claude account](#add-a-claude-account). |
| No machine enrolled yet | No machine has enrolled (revoked machines do not count). | See [Add a machine](#add-a-machine). |
| Update the daemon on … | The machine's daemon does not match this version of the Orchestrator, so it cannot connect. This happens after updating the Orchestrator. | On the machine, type the `npm install -g …` command shown, then restart the daemon. |
| Claude Code not supported on … | Claude Code is missing, or older than 2.1.280. The machine gets no runs. | Install or update Claude Code (see [Before you start](#before-you-start)), then restart the daemon. |
| Problem on … | A check on the machine found an error, for example tmux missing or too old. The machine gets no runs. | Fix what the item names, then restart the daemon. |

An item disappears once the daemon connects again without the problem.

### After changing the Node.js version

The service starts the daemon with the Node.js it was installed with. If you install another Node.js version (for example with `nvm install`), install the daemon again with the same `npm install -g …` command you typed when adding the machine, then type `orchestrator-daemon install-service` again. The checks show an error until you do.

### After installing a tool

The service looks for tools in the folders it was given by `install-service`. After installing a tool (for example Docker, or Claude Code in another folder), type `orchestrator-daemon install-service` again from a terminal where the tool works.

### When the daemon stopped by itself

The daemon stops, instead of trying again, when trying again cannot help:

- the machine was revoked, or got a new enrollment code: enroll it again with the command shown on its page, then restart the daemon;
- the daemon's version does not match the Orchestrator's: install it again with the `npm install -g …` command shown, then restart it;
- another daemon connected with this machine's key (a second terminal, or a copy of the `~/.orchestrator` folder on another computer): stop the other one, or add that computer as its own machine.

`orchestrator-daemon status` and `orchestrator-daemon doctor` show why it last stopped. Only one daemon runs per user: `orchestrator-daemon start` refuses when the service already runs.

## Troubleshooting

Type these commands on the machine, in its Ubuntu terminal:

| To | Type |
|---|---|
| See whether the daemon's service is running, and its last messages | `systemctl --user status orchestrator-daemon` |
| Read the daemon's last 100 messages | `journalctl --user -u orchestrator-daemon -n 100` |
| Follow its messages as they come (stop with Ctrl+C) | `journalctl --user -u orchestrator-daemon -f` |
| Check the machine: tools and versions, Claude Code login, systemd, the service, WSL settings, the Orchestrator's certificate | `orchestrator-daemon doctor` |
| See whether the daemon runs (as the service or in a terminal), its connection to the Orchestrator, versions, capabilities and runs on this machine, or why it last stopped | `orchestrator-daemon status` |
| Restart the daemon, for example after fixing a problem | `systemctl --user restart orchestrator-daemon` |

If `systemctl --user` answers "Failed to connect to bus", systemd is not running: see [Turn on systemd on WSL](#turn-on-systemd-on-wsl). If the machine shows **Offline** while the service runs, read the daemon's last messages: they say why it cannot reach the Orchestrator.
