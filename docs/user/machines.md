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

The account shows its state: **Available**, or **Usage limit reached** until the time Claude gave. Click **Edit** to change its label, plan or runs at the same time.

## Before you start

The machine is a Linux computer, or a Windows computer with WSL 2 (Ubuntu). Type every command below in its Ubuntu terminal. It needs:

| Tool | Check with | Needed |
|---|---|---|
| Node.js | `node --version` | 24.x |
| Git | `git --version` | 2.40 or later |
| tmux | `tmux -V` | 3.2 or later |
| Claude Code | `claude --version` | 2.1.280 or later |
| systemd (WSL only) | `systemctl --user is-system-running` | `running` |

To install what is missing:

- **Node.js**: install **nvm** by following the [official nvm instructions](https://github.com/nvm-sh/nvm#installing-and-updating), open a new terminal, then type `nvm install 24`. With nvm, installing the daemon needs no `sudo`.
- **Git and tmux**: `sudo apt update && sudo apt install git tmux`.
- **Claude Code**: follow [Anthropic's installation guide](https://code.claude.com/docs/en/setup). Claude Code updates itself; you do not need to update it by hand.
- **systemd on WSL**: see [Keep WSL running](#keep-wsl-running).

### Agents on your own user

In this version, the daemon runs under your own Linux user, so agents work with your user's rights. The Orchestrator blocks the folders it knows are sensitive (its own `~/.orchestrator` folder, which holds the machine's key, and the Claude configuration folders), and it limits file tools to the project's folder. Its checks on shell commands are **best effort**: a command could still read a file of your user that it does not name directly. Keep secrets you care about off this machine, or use a computer dedicated to the Orchestrator. A guide for running the daemon under its own user comes in a later version.

## Add a machine

1. Open **Machines** and click **Add machine**.
2. Give the machine a **Name** (for example "Desktop") and choose its **Claude account**, then click **Show the commands**.
3. On the machine, type the commands the page shows, in order:
   1. `npm install -g …`: installs the daemon of the same version as the Orchestrator, downloaded from the Orchestrator itself.
   2. `orchestrator-daemon enroll …`: connects the machine to the Orchestrator with a one-time code. The code works once, and only for 15 minutes (the **Enrollment code lifetime** setting). If it expires, open the machine and click **New enrollment code**.
   3. `orchestrator-daemon login`: opens Claude Code once, in a configuration kept only for the Orchestrator (your own Claude Code settings are not used). Log in with the Claude account you chose, then quit Claude Code (type `/exit`).
   4. `orchestrator-daemon install-service`: starts the daemon as a background service, which also starts again after a restart of the computer.
4. Come back to the Orchestrator page. It checks again each time you come back to it and shows **Connected** once the daemon has connected. If it says the machine cannot receive runs yet, see [When a machine has a problem](#when-a-machine-has-a-problem).

On Windows, also do [Keep WSL running](#keep-wsl-running).

### Keep WSL running

On Windows, the daemon runs inside WSL. Two settings are needed, once per computer:

1. **Turn on systemd** (the service manager the daemon uses). In Ubuntu, type `sudo nano /etc/wsl.conf` and make sure the file contains:

   ```ini
   [boot]
   systemd=true
   ```

   Save, then in a Windows terminal (PowerShell) type `wsl.exe --shutdown` and open Ubuntu again. `systemctl --user is-system-running` should now answer `running`. Details: [Microsoft's systemd guide](https://learn.microsoft.com/windows/wsl/systemd).

2. **Stop Windows from shutting WSL down.** Windows stops WSL a few seconds after its last window closes, even while the daemon runs. In Windows, open the file `.wslconfig` in your user folder (type `notepad %UserProfile%\.wslconfig` in PowerShell; create it if it does not exist) and add:

   ```ini
   [general]
   instanceIdleTimeout=-1
   ```

   Save, then type `wsl.exe --shutdown` and open Ubuntu again. Instead, you can keep an Ubuntu window open. Details: [Microsoft's WSL settings guide](https://learn.microsoft.com/windows/wsl/wsl-config).

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
| No machine connected yet | No machine has enrolled (revoked machines do not count). | See [Add a machine](#add-a-machine). |
| Update the daemon on … | The machine's daemon does not match this version of the Orchestrator, so it cannot connect. This happens after updating the Orchestrator. | On the machine, type the `npm install -g …` command shown, then restart the daemon. |
| Claude Code not supported on … | Claude Code is missing, or older than 2.1.280. The machine gets no runs. | Install or update Claude Code (see [Before you start](#before-you-start)), then restart the daemon. |
| Problem on … | A check on the machine found an error, for example tmux missing or too old. The machine gets no runs. | Fix what the item names, then restart the daemon. |

An item disappears once the daemon connects again without the problem.

### After changing the Node.js version

The service starts the daemon with the Node.js it was installed with. If you install another Node.js version (for example with `nvm install`), install the daemon again with the same `npm install -g …` command you typed when adding the machine, then type `orchestrator-daemon install-service` again.
