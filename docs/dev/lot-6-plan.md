# Lot 6 — Implementation plan

> Status: step A (2026-11-07): this plan, the owner's answers and the spec changes, waiting for the owner's approval
> Scope: "Lot 6 — Isolated agent workspace" in [10 — Delivery Plan](../specs/10-delivery-plan.md), lot 5's open points "No Docker or database for agents" and "Agents on the owner's user" ([lot 5 plan](lot-5-plan.md#open-points)), and the access to an Orchestrator running in WSL from the local network, carried from lot 2's check to Hardening and brought into this lot by the owner (answer 11).
> **Lot 6 is done when** the owner, on the dedicated agent machine with the real Claude Code, submits a request for a `web_app` with PostgreSQL and, after approving the plan and merging pull requests, gets it working with CI, tests and documentation, its integration and browser tests run in the run container on the machine as well as in CI; a run can read neither the Claude login nor the machine token, reach no local-network address, and its agent's `docker` refuses `--privileged` and a host folder; a run's containers, networks and volumes are gone after it; **Reset agent workspace** works; and Desktop WSL still runs a project that does not require isolation (step L).

Every session follows the [working rules](working-rules.md). Branches: `lot6/<step letter>-<short-name>`. Steps are done one after the other, in the order below, each in its own session once the previous one is merged (rule 18). No session acts on the real GitHub (rule 9) or starts a real Claude Code session (rule 10). No session installs anything outside the repository (rule 8): no second Linux user, no rootless Docker and no firewall rule on the owner's computer; the owner prepares the agent machine with Help's commands, and runs the probe (step B) and the check (step L). Lot 6 is released as version 0.7.0.

**The gate** (owner's answer 1): **nothing after step B is built until the owner's probe with the real Claude Code has passed** on the agent machine. If `CLAUDE_CODE_SHELL_PREFIX` does not hold (an agent command runs outside the container, or a hook, the status line or the MCP relay runs inside it), or the worktree cannot be shared as described below, step B ends by reporting what failed, and the owner and the session revise this plan together. There is no automatic switch to another option (Claude Code inside the container, answer 1's option B, is not taken by default).

## Decisions taken for this lot (2026-11-07)

### Already decided

From the specs and earlier lots; nothing here waits for an answer.

- **The scope** (10, lot 6; lot 5 step A, the owner's change): sessions run on a machine or an environment dedicated to agents, the main target a dedicated Linux machine the owner has, a dedicated WSL distribution the fallback on a Windows host; no access there to the owner's personal files or credentials; Docker, packages, servers and web research allowed there.
- **What stays as it is** (05, sections 4.3 to 4.11; 06): Claude Code in interactive mode in tmux, state from hooks, transcripts and MCP calls only; `--permission-mode dontAsk`, never `--dangerously-skip-permissions`; the daemon alone pushes, only ticket branches, with the credential given for one command (05, section 7.1); agents never hold GitHub credentials.
- **Lot 5's rule for an older daemon** (09, section 6): a daemon of the previous protocol stays connected and takes no run at all, with "Update the daemon to <version>".
- **Lot 8 keeps** the separate system user for machines shared with the owner (05, section 7.2); lot 6 is the answer for machines dedicated to agents (10).
- **Every new item kind and event** is covered by `merges.test.ts`'s every-kind guard and `every-event.ts`; every new setting is in 04 section 8 and Settings > Limits.

### Documentation checked (2026-11-07)

Read in the official documentation, not from memory. A later step that relies on a point checks the page again and notes any change.

**Claude Code** (`code.claude.com`):

- [Sandboxing](https://code.claude.com/docs/en/sandboxing): the built-in Bash sandbox (off by default) uses bubblewrap and socat on Linux and WSL2, not WSL1. It confines Bash commands and their children; hooks, MCP servers, the status line and the file tools run outside it. By default its commands can **read** most of the machine, credential files included ("There is no built-in credential deny list"); only writes to Claude Code's configuration folder and `.credentials.json` are protected. "`docker` is incompatible with the sandbox"; most database drivers ignore its proxy and fail; on Linux "a sandboxed command's `localhost` is private to that command"; Chromium needs `--no-sandbox` (Playwright's own default for its headless shell). In `dontAsk` mode a host outside the allowed domains is refused. So the built-in sandbox cannot give agents Docker or a database: rejected as the barrier (answer 1, option C).
- [Development containers](https://code.claude.com/docs/en/devcontainer) and [Choose a sandbox environment](https://code.claude.com/docs/en/sandbox-environments): with Claude Code inside the container, "dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container, including the Claude Code credentials". The reference container's firewall is a default-deny `iptables` script with `NET_ADMIN` and `NET_RAW`. A dedicated virtual machine is the strongest separation. Rejected as the default (answer 1, option B).
- [Environment variables](https://code.claude.com/docs/en/env-vars): `CLAUDE_CODE_SHELL_PREFIX` is a "Command prefix that wraps shell commands Claude Code spawns: Bash tool calls, hook commands, status line commands, and stdio MCP server startup commands" (not exec-form hooks); the wrapper gets the command line as one shell-quoted argument (`$1`) and must run it with a shell; for Bash tool calls `$1` holds "the full shell invocation Claude Code assembles, including environment setup". Documented as "useful for logging or auditing", **not as a way to run commands elsewhere**: the probe of step B settles it. `CLAUDE_CODE_TMPDIR` moves Claude Code's own temporary files (`<dir>/claude-<uid>/`). `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips credentials from the environment of the processes Claude Code starts. `DISABLE_AUTOUPDATER=1` stops background updates.
- [Authentication](https://code.claude.com/docs/en/authentication): on Linux the login is `$CLAUDE_CONFIG_DIR/.credentials.json`, mode `0600`. `claude setup-token` makes a one-year token, `CLAUDE_CODE_OAUTH_TOKEN`, that "can only make model requests". Not used: the dedicated configuration's login stays as it is (05, section 2).

**Docker**:

- [Rootless mode](https://docs.docker.com/engine/security/rootless/): the daemon and its containers run as a non-root user in a user namespace; needs `newuidmap`/`newgidmap` (`uidmap`) and at least 65,536 subordinate ids in `/etc/subuid` and `/etc/subgid`; installed with `dockerd-rootless-setuptool.sh install` (package `docker-ce-rootless-extras`); a user service `~/.config/systemd/user/docker.service`, started at boot with `loginctl enable-linger`; the socket at `/run/user/<uid>/docker.sock`. The page does not mention WSL.
- [Rootless tips](https://docs.docker.com/engine/security/rootless/tips/) and [troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/): `--cpus`, `--memory` and `--pids-limit` work "only when running with cgroup v2 and systemd"; "only `memory` and `pids` controllers are delegated to non-root users by default", all of them with `/etc/systemd/system/user@.service.d/delegate.conf` (`Delegate=cpu cpuset io memory pids`; `cpuset` needs systemd 244); `dbus-user-session` is needed on cgroup v2 hosts; ports below 1024 need a capability or a sysctl.
- [Resource constraints](https://docs.docker.com/engine/containers/resource_constraints/): `--memory`, `--memory-swap` (equal to `--memory`: no swap), `--cpus`.
- [Linux post-installation](https://docs.docker.com/engine/install/linux-postinstall/): "The `docker` group grants root-level privileges to the user." So no user of the agent machine is put in the `docker` group, and the system-wide (rootful) Docker, when installed, is not used for agents.
- [Docker Desktop on WSL 2](https://docs.docker.com/desktop/features/wsl.md): WSL 2 runs every distribution on one shared kernel; Docker Desktop's WSL integration shares one Docker daemon with the distributions it is enabled for. So the WSL fallback uses Docker Engine installed inside the dedicated distribution, never Docker Desktop's integration.

**WSL** ([Advanced settings configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config), updated 2026-10-16): `wsl.conf` is per distribution: `[boot] systemd=true`; `[interop] enabled=false` and `appendWindowsPath=false` stop Windows programs and Windows paths; `[automount] enabled=false` stops the `/mnt/c` mounts; `[user] default`. `.wslconfig` is global to the one VM of every WSL 2 distribution: `memory` (50 % of Windows' by default), `processors`, `swap`, `networkingMode` (`nat` by default, `mirrored` on Windows 11 22H2 and later), `[general] instanceIdleTimeout` (`-1`: never shut down; 05 section 2). `isolateDistroCgroup` (default `true`) gives each distribution its own cgroup. A community page ([wsl.dev, Security](https://wsl.dev/security/), not Microsoft's) says distributions of the same Windows user share one VM and are "not a security boundary" against the host or each other: Help says so plainly for the fallback.

**systemd** ([systemd.resource-control](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), version 262): `MemoryMax=` (the out-of-memory killer acts inside the unit), `CPUQuota=` (a percentage of one CPU, above 100 % for several), `TasksMax=`; delegating controllers to less privileged code "is only safe on the unified control group hierarchy" (cgroup v2).

### The owner's answers (2026-11-07)

Step A's questions, answered by the owner: A to all, with the owner's additions to answers 1, 2, 3, 4, 8, 11 and 16 (below, in the answers they change). The specs named carry them (this step).

1. **Where Claude Code runs: A, gated** (05, new section 4.12; 00, section 4). Claude Code stays on the agent machine, with the daemon, its login, its hooks, its status line and the MCP relay. Each run has its own **run container**, and every Bash command of the agent runs in it: the daemon sets `CLAUDE_CODE_SHELL_PREFIX` to a wrapper of its own, which runs Claude Code's hook, status line and MCP commands (the daemon's own `orchestrator-daemon hook`, `status-line` and `mcp` commands, recognised exactly) on the machine, and every other command in the run container. The worktree is mounted at the same path, so Claude Code's file tools (on the machine) and the commands (in the container) see the same files. Nothing else of the machine is mounted. **The owner's addition**: the gate above; step B reports a failure and the plan is revised together, never switched by itself.
2. **Secrets out of the agents' Docker: A** (05, sections 2, 4.2, 4.12 and 7.2). Two Linux users on the agent machine, created once by the owner:
   - `orchestrator` runs the daemon and Claude Code and holds everything secret: `~/.orchestrator/config.json` (machine token), `claude-config/` (the Claude login), `runs/` (run sockets, run tokens in `mcp.json`, settings). Its home is mode `700`. It is in no `docker` group.
   - `orchestrator-agent` holds no secret and no login shell; it owns a **rootless Docker for agents** (its user service, lingering on). The run containers and every container an agent starts run there, under its mapped ids, which cannot read `orchestrator`'s home.
   - **The socket filter**: the daemon (as `orchestrator`) reaches the agent Docker through its socket, opened to it by a group (`orchestrator-docker`, the socket's group, set by the agent user's service; checked by `doctor`). Each run container gets **only a per-run filtered socket**, served by the daemon, mounted as `/run/docker.sock` with `DOCKER_HOST` set to it; **the agent never sees the real socket** (owner's addition to 2; a `doctor` check). The filter allows a listed set of Docker API calls (containers, images, networks, volumes, exec, logs, build with a context from the worktree), adds the run's label (`orchestrator.run=<run id>`) and its cgroup parent and limits (answer 8) to everything created, binds every published port to `127.0.0.1`, and refuses `--privileged`, added capabilities, devices, the host's network, PID, IPC or user namespace, security options that turn off a confinement, volume driver options (a `local` volume with `o=bind`), and any bind mount outside the run's worktree. Refusals are in plain words the agent reads (Docker's own error answer).
   - **Where worktrees live and how both users share them** (owner's addition to 2): the daemon's shared folder `/srv/orchestrator/` (created once by the owner: owner `orchestrator`, group `orchestrator-work`, mode `2770`, the set-group-id bit, and a default ACL giving the group read, write and search), holding `repos/<owner>/<name>.git` (the bare clones) and `worktrees/<run-id>/`. Both users are in `orchestrator-work`; nobody else is. Everything else of `orchestrator` stays in its mode `700` home (`~/.orchestrator/`: `config.json`, `claude-config/`, `runs/`, `browsers/` and the rest). The run container runs as its root, which rootless Docker maps to `orchestrator-agent` itself, so a file it writes is owned by `orchestrator-agent`, group `orchestrator-work` (set-group-id), group-writable (default ACL); a file Claude Code writes as `orchestrator` is the same for the container. The bare clones use `core.sharedRepository=group` (a setting of the daemon's own, kept by the configuration's restore, 05 section 7.1), so objects written by the agent's `git commit` in the container are readable and writable by the daemon's commands. Git's ownership check is answered for these folders only: the daemon's commands with `-c safe.directory=<path>`, the image's system configuration with `safe.directory=/srv/orchestrator/*`. The run container mounts the run's worktree and its bare clone only (Git needs the bare clone's objects and refs), at the same paths. Rootless id mapping alone (option kept aside) would need idmapped mounts, which the spike may test as a comparison only. **Step B's spike and the owner's probe test it**: a file created in the container is editable by Claude Code's file tools and committed and pushed by the daemon's commands; a file written by Claude Code is usable in the container; nothing of `orchestrator`'s home is visible in the container.
3. **What an agent can do in an isolated run: A** (03, sections 2.2 to 2.5; 05, section 4.6; 08, sections 3.2 and 3.3). It installs the project's dependencies, runs its unit, integration and browser tests, starts servers in the background (stopped with the container) and uses `docker` and `docker compose` through the filtered socket (PostgreSQL for a `web_app`, for example). The hook keeps refusing remote Git commands (the daemon pushes), changes to the repository's `.claude/`, `tmux`, and the daemon's and Claude's folders through the file tools (which run on the machine). In the container, the Bash path checks and the container-tool refusals no longer apply: the container is the barrier. The run's deny rules for `docker` and the other container tools are left out of an isolated run's settings.
4. **Network: A, with the owner's additions** (05, section 4.12; Help > Agent machine). The internet is open to the run container and to every container the agent starts; the local network, the machine itself and the Orchestrator's address are blocked. How:
   - **Where the block is**: every packet of the agent Docker leaves the machine from processes of `orchestrator-agent` (rootless Docker's user-mode network, `pasta` or `slirp4netns`, runs as that user), so one rule set the owner installs once (`nftables`, Help's command, checked by a committed script in pinned Ubuntu images) drops, for the socket owner `orchestrator-agent` (`meta skuid`), every destination in the IPv4 ranges `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (the cloud metadata address included), `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4` and `240.0.0.0/4`, and the IPv6 ranges `::1/128`, `fc00::/7` (unique local), `fe80::/10` (link-local) and `ff00::/8` (multicast), and the machine's own and the Orchestrator's addresses, whatever range they are in.
   - **DNS** (owner's addition): name resolution must keep working although a home router, usually the resolver, is a private address. Run containers and the agent's containers ask Docker's own DNS (on a user-defined network, `127.0.0.11`, inside each container; on the default network, the resolver rootless Docker's network gives), which forwards to the machine's resolvers as `orchestrator-agent`. So the rule set has one exception before the drops: **port 53 (UDP and TCP) to the resolvers of the machine's `/etc/resolv.conf`** (and to `127.0.0.53` when systemd-resolved is the stub, whose own upstream queries are made as `systemd-resolve`, not the agent user), nothing else on those addresses. The daemon reads the resolvers once at `doctor` and the check names them; Help says to run the command again when they change. A container cannot reach the router's web page or any other port of it.
   - **Published ports** are bound to `127.0.0.1` by the filter, so no service an agent starts is reachable from the local network.
   - **The run container reaches the agent's services** at `localhost:<port>` (the usual project configuration): the run container shares the network namespace of rootless Docker itself (its `--network host`, which is rootless Docker's namespace, not the machine's), where published ports listen; the agent's own containers never get that network (the filter refuses it). To be confirmed by the spike (step B), with the user-defined network as the fallback (`docker compose` services reached by name).
   - **Builders keep `WebFetch` and `WebSearch`** (they run in Claude Code on the machine, outside the rule set, as today); the Project Manager stays without web search (owner's answer 3, lot 5 step E1).
   - **Help > Agent machine** also suggests, as optional, putting the agent machine on a network segment of its own (a VLAN or a guest network of the router), so that even a gap in the rules reaches nothing of the owner's (owner's addition).
5. **The run container's image: A** (05, section 4.12). One image the Orchestrator provides, `orchestrator-workspace:<daemon version>`, built on the agent machine by `orchestrator-daemon workspace build` (typed by the owner, on the agent Docker) from a Dockerfile shipped in the daemon package: a pinned Ubuntu base (by digest), Node.js 24 LTS, npm, pnpm and yarn through Corepack, Git, Playwright's system libraries for the Playwright version the daemon pins (lot 5), the Docker CLI and its Compose plugin, and nothing else. No registry. Projects cannot change it in 0.7.0 (a project's own `.devcontainer` is for later). Browser tests on an isolated machine need no system library on the machine itself; the browsers are downloaded into the project's cache (answer 6) through `PLAYWRIGHT_BROWSERS_PATH`, set by the daemon in the container.
6. **What persists: A** (05, section 4.12). Thrown away at each run's end, and when a waiting or paused run's session is closed: the run container, and every container, network and anonymous volume with the run's label (the services' data with them); a resumed run starts its services again. Kept **per project**, on each machine: a cache volume mounted in the run container (npm's, pnpm's and yarn's caches, Playwright's browsers, tools an agent installs under the cache folder), never shared between projects. Kept **per machine**: the images agents pulled or built, and the workspace image. The worktree and the bare clones as today (05, section 4.11).
7. **Reset from the UI: A** (02, the machine page; 05, section 8). The machine page gets **Reset agent workspace** (every project cache, every image an agent pulled or built, any container, network or volume left on the agent Docker; the workspace image is built again by the daemon) and, in a list of the projects with a cache on the machine, **Clear caches** for one project. Both are refused while a run of the machine (for **Clear caches**, of the project) is active, waiting or paused, saying which; both are daemon commands (protocol 4) answered once done, with an event each, and a Help section.
8. **Limits: A, global with a per-project override, with the owner's additions** (04, section 8; 05, section 4.12).
   - **A run as a whole** (owner's addition): the limits apply to the run container plus every container it starts, together. How: the filter gives everything a run creates one cgroup parent, a systemd slice of the agent user's manager, `orchestrator-run-<run id>.slice`, which the daemon creates with the limits before the run container starts (`MemoryMax`, `MemorySwapMax=0`, `CPUQuota`, `TasksMax`), through the agent user's systemd (a command the agent user's service allows the daemon, set up once by Help's commands). This needs cgroup v2 and the `cpu`, `memory` and `pids` controllers delegated to the agent user (`delegate.conf`, Help's command; a `doctor` check).
   - **If rootless Docker cannot hold a total** (the spike of step B tries it): the closest option is per-container limits plus **Most containers per run** (a setting, default 5 with the run container), the worst case total being each limit times that number; Help then says so. The step that builds limits says which one holds, with the spike's evidence.
   - **The settings**: **Run CPUs** (`runCpus`), **Run memory** (`runMemoryMegabytes`), **Run processes** (`runMaxProcesses`), **Agent workspace disk** (`agentWorkspaceDiskGigabytes`: the agent Docker's measured use, images, volumes and caches together, above which the daemon clears the oldest caches before the next run, and the machine page warns), global with a per-project override except the disk (per machine, global only). Run time stays **Longest run**. **Defaults** are set from the owner's machine (below, "The owner's machine"); they are written into 04 section 8 by the step that adds them, never guessed.
   - **Simultaneous runs on one machine** (owner's addition): a machine can hold several runs of its account at once (a working one, and others waiting for the owner or for CI with their session open; an account's maximum concurrent runs, 01 section 3.9). Each run has its own slice with its own limits, so they add up. A machine-wide ceiling sits above them: the agent user's own slice (`user-<uid>.slice` of `orchestrator-agent`) gets `MemoryMax` and `CPUQuota` once, from Help's command, sized to leave the machine's daemon, Claude Code and system enough room; a run whose memory would pass it is stopped by the kernel inside its own slice first. Help gives the arithmetic: runs × **Run memory** should stay under the agent user's ceiling, and the account's concurrent runs should be set accordingly.
9. **Which machines are isolated: A** (01, sections 3.1 and 3.8; 07, section 4). `doctor` detects the capability **`isolated-workspace`** when every workspace check passes (answer 12). A machine without it keeps today's rules exactly (the owner's Desktop WSL, protocol 4, takes runs as today). Projects created from 0.7.0 require `isolated-workspace` by default (as `browser-tests` in lot 5), and the owner may remove it in Project settings; existing projects are unchanged, and when they run on an isolated machine they run in a run container with no change to their repository. The run's rules (03, section 3) say what the machine allows.
10. **The machines: A** (05, section 2; 09, section 7.2; Help > Agent machine). The main target is the owner's dedicated Linux machine; the fallback a dedicated WSL distribution (a second Ubuntu installed with `wsl --install`), with `[interop] enabled=false`, `appendWindowsPath=false` and `[automount] enabled=false` in its `wsl.conf`, its own Docker Engine (never Docker Desktop's WSL integration), and Help saying that WSL distributions share one kernel and are not a security boundary. **The owner's machine's facts** were asked in answer 5 and are not given yet: see "The owner's machine" below.
11. **The server during lot 6: A, with the owner's addition** (09, sections 5 and 7.2; 10, lots 6 and 8). The Orchestrator stays on Desktop WSL (the future server is not built yet). The agent machine's daemon reaches it over HTTPS through a reverse proxy, as Help > "Orchestrator on another computer" describes, with `--ca-file` for an internal certificate authority. **Brought into this lot**: how to reach an Orchestrator running in WSL from the local network (carried from lot 2's check, then in Hardening's scope): Help > "Open the Orchestrator from another device" is rewritten for it (WSL's networking mode or a port proxy on Windows, the Windows firewall rule, the reverse proxy and its certificate, `PUBLIC_URL` with `https://`, never `http://<lan address>` for a machine), and removed from lot 8's scope in 10.
12. **What the owner installs once, and `doctor`: A** (05, sections 2 and 8). Help > Machines > "Agent machine" gives the owner's one-time `sudo` commands, checked by a committed script in pinned Ubuntu images (as `browser-deps-check.sh`, lot 5): Docker Engine and its rootless extras from Docker's repository (the system-wide daemon disabled), `uidmap`, `dbus-user-session`, `nftables`, the two users, the groups `orchestrator-work` and `orchestrator-docker`, `/etc/subuid` and `/etc/subgid` for `orchestrator-agent`, `delegate.conf`, the agent user's ceiling, lingering for both users, `/srv/orchestrator/` with its group, mode and ACL, the network rule set; then, as `orchestrator`: Git, tmux, Node.js 24 (nvm), Claude Code, the daemon (as today). New `doctor` checks, each with its Help link; an error makes the machine **not isolated** (no `isolated-workspace`), never unusable:
    - **Agent Docker**: reachable through its socket, rootless (`docker info`'s security options), cgroup v2 with the systemd driver;
    - **Real socket closed** (owner's addition to 2): a test container started through a per-run filtered socket sees no Docker socket but the filtered one (`/run/docker.sock` only, no `/run/user/*/docker.sock`, `DOCKER_HOST` the filtered one), and a container it asks for with the real socket's path as a bind mount is refused;
    - **Controllers**: `cpu`, `memory` and `pids` delegated to the agent user, and its ceiling set;
    - **Workspace image**: built for this daemon's version;
    - **Container start**: a test container starts and stops within the command timeout;
    - **Secrets out of reach**: a test container cannot read `~orchestrator/.orchestrator/` (it is not mounted, and the filter refuses mounting it), and the shared folder's mode, group and ACL are as Help says;
    - **Network**: from a test container, a name resolves, a public address answers, and the router's address (the default gateway) and the Orchestrator's address on any other port than DNS are refused;
    - **Disk**: the agent Docker's use against **Agent workspace disk**, and the free disk.
13. **The upgrade: A** (09, section 6; 05, section 4). `PROTOCOL_VERSION` 4: `run.start` carries the workspace (whether the run is isolated, its limits, the project's cache name); new daemon commands for **Reset agent workspace** and **Clear caches**; `hello` reports the workspace checks. A protocol 3 daemon stays connected and takes no run, with "Update the daemon to 0.7.0" (lot 5's rule). After the update, existing projects keep running on Desktop WSL as today.
14. **Tests: A** (`docs/dev/testing.md`). In CI: a fake `docker` (like the fake `claude`) for the daemon's logic; the socket filter and the clean-up tested against a real Docker where CI has one (the rootful Docker of the runner: the filter's rules do not depend on rootless mode), each refusal with its test; no real Claude Code. An opt-in real-rootless test (`ORCHESTRATOR_TEST_AGENT_DOCKER=1`, like the systemd tests) on a host prepared like the agent machine. The owner's probe (step B) and smoke test on the agent machine.
15. **Room for later: A** (00, section 9; 05, section 4.12). Nothing built for operations agents. The specs call the place where a run's commands execute its **workspace**, of a kind (`host` today on non-isolated machines, `container` on isolated ones), so that a later "deployment target" can be another kind, still driven by the daemon only, with its credentials held by the daemon.
16. **The owner's check: A, with the owner's additions** (step L): on the dedicated machine with the real Claude Code, a `web_app` with PostgreSQL whose integration and Playwright tests run in the run container and in CI; a run cannot read the Claude login or the machine token; a local-network address is refused; **Reset agent workspace**; Desktop WSL still runs a project that does not require isolation; **added**: after a run, its containers, networks and volumes are gone; the agent's `docker` refuses `--privileged` and a host folder mount.
17. **Lot size: A**: the steps below, each split under rule 15 when too large.

### The owner's machine

Answer 5 asked for the dedicated machine's OS and version, CPU, RAM, disk, `sudo`, and whether it reaches the Desktop over the local network. **Not given yet** (the answer's placeholders were left as they were). Needed before step B (the probe's commands depend on the OS version) and before step F (the limits' defaults and the agent user's ceiling). Until then: the probe's commands are written for Ubuntu 24.04 and 26.04 LTS (the versions `browser-deps-check.sh` already covers), and no default limit is written anywhere.

### New protocol version

Protocol 4 holds everything lot 6 changes on the daemon (answer 13). A step that finds another daemon change keeps it in protocol 4, unreleased until 0.7.0, and says so; a change of something released stops and asks the owner.

### Lessons of lots 2 to 5, applied in every step

- **Time**: no test waits for a real delay; the server's clock is moved and the loops run by the test.
- **One code path**: an isolated run starts through the same path as any run (the scheduler's start, **Run now**'s checks); the queue and the screens give the same reasons in the same words.
- **The owner's processes, step size, rules 9, 10 and 15**: as in lot 5 (test homes under `/tmp/od-test-*`, rule 15 splits proposed before any code).
- **Real commands the owner types** (Help's `sudo` commands, the network rule set) are checked by a committed script in pinned images before Help gives them (lot 5 step C1's lesson).

### CI time

As lot 5: new integration tests use scripted daemons where only the server changes; real-daemon tests with the fake `claude` and the fake `docker` where the daemon's side changes; lot 6's end-to-end scenarios in `apps/server/test/acceptance-lot6.test.ts`. Every step adding a test file checks the four shards' placement and gives the shard times; a shard near 7 minutes gets a fifth (ADR 0032). Real-Docker tests of the filter go in their own CI job only if they would push a shard over its margin (decided by the step that adds them, with an ADR if a job is added).

### What the fakes need

- **Fake `docker`**: records its arguments; `run` and `exec` run the given command locally in the worktree with the container's environment (enough for the daemon's ordering, clean-up and messages); `info`, `ps`, `inspect`, `system df` and `image inspect` from a scenario file; each failure the daemon names (daemon unreachable, image missing, container refused).
- **Fake `claude`**: honours `CLAUDE_CODE_SHELL_PREFIX` the way the probe of step B finds the real Claude Code does (the wrapper given one argument, run for Bash commands, hooks, the status line and MCP startup), so the daemon's wrapper is tested against what Claude Code really does, recorded in the probe's fixtures.
- **Fake `systemctl` and `systemd-run`**: the run slice's creation with its properties (as lot 5's fake `systemd-run`).

## Steps

### [ ] A. Plan and spec decisions (branch `lot6/a-plan`, 2026-11-07)

- This plan; the owner's answers written into the specs they change: 00 (sections 4, 6 and 9), 01 (sections 3.1 and 3.8), 03 (sections 2.1 to 2.5), 04 (section 8, the new limits named, their defaults left to step F), 05 (sections 2, 4, 4.6, 7.2 and the new 4.12), 06 (section 6), 07 (section 4), 08 (sections 3.2 and 3.3), 09 (sections 5, 6 and 7.2) and 10 (lot 6 written, lot 8 without the WSL access point); CLAUDE.md's "Current state".
- No ADR in this step: the run container through `CLAUDE_CODE_SHELL_PREFIX`, the two users and the shared folder depend on step B's probe; their ADRs come with step B's result (or the revised plan).

**Done when** the owner has approved this plan and the spec changes.

### [ ] B. Spike and the owner's probe (branch `lot6/b-workspace-probe`) — the gate

What only the real Claude Code and a real agent machine can tell, before any code is built on it.

- `tools/spike/workspace-wrapper.sh` (or the daemon's wrapper in `apps/daemon`, behind no feature switch, used only by the probe): the prefix wrapper of answer 1.
- `tools/smoke/workspace-probe.sh` (`--help`; refuses CI and runs without a terminal, asks the owner to type `yes`, like every script that starts the real Claude Code), run by the owner **as `orchestrator`** on the agent machine prepared with the draft one-time commands (Help's draft in this step, `docs/dev/agent-machine-draft.md`, not yet in Help). It starts one throw-away session on `haiku` (the probe's model) in a worktree under `/srv/orchestrator/worktrees/`, with the daemon's settings generation, the recorder hooks and `CLAUDE_CODE_SHELL_PREFIX`, and checks, each `PASS`, `FAIL` or `INFO`:
  1. the wrapper's argument for a Bash tool call, a hook, the status line and the MCP startup (recorded, sanitised, as fixtures for the fake `claude`);
  2. a Bash command runs in the run container (its hostname, `/proc/1/cgroup`, the user `orchestrator-agent` on the machine's side);
  3. every hook, the status line and the MCP relay run on the machine, as `orchestrator`, and the hook's answer still reaches Claude Code (a `PreToolUse` deny is honoured);
  4. no command of the agent runs on the machine: a command chained after a hook-looking text, a background command, a command with `CLAUDE_CODE_SHELL_PREFIX` itself in it;
  5. a file created in the container is read and edited by Claude Code's file tools; a file written by `Write` is read, changed and run in the container; `git commit` in the container, then the daemon-like `git` (as `orchestrator`, with `-c safe.directory`) reads the commit and makes another, and a push to a local `file://` remote works (no real GitHub);
  6. nothing of `~orchestrator/` is visible in the container (`ls`, a file read, the real Docker socket's path);
  7. the shell's working folder and environment persist between two Bash calls as Claude Code expects (its shell snapshot under `CLAUDE_CODE_TMPDIR`, mounted read-only when the spike shows it must be);
  8. the run's slice holds the run container and a container started through the filtered socket's draft (a plain proxy in the spike), with `MemoryMax`, `CPUQuota` and `TasksMax` applied to their total (answer 8; else the fallback, recorded);
  9. the run container reaches a PostgreSQL container the agent started at `localhost:5432` (answer 4; else by name on a user-defined network, recorded);
  10. from the run container, a name resolves and a public address answers, while the default gateway, a `192.168.x.x` address, `169.254.169.254` and an IPv6 link-local address are refused (the draft rule set installed).
- The script's dry run with the fake `claude` and the fake `docker` in CI (as the other probes), so its logic is tested without the real Claude Code.

**Done when** the owner's probe passes checks 1 to 7 and 10, and 8 and 9 pass or their fallback is recorded; its fixtures are committed after review (no secret, as lot 5's probe fixtures); the result is recorded here; the ADRs of the run container (`CLAUDE_CODE_SHELL_PREFIX`), the two users with the shared folder, and the rootless agent Docker are written. **If any of checks 2 to 6 fails**, this step ends by reporting what failed, and the plan is revised with the owner before step C (owner's answer 1).

### [ ] C. Protocol 4 and the workspace on the server (branch `lot6/c-protocol-4`)

- `PROTOCOL_VERSION` 4; `run.start`'s `workspace` (`host` or `container`, the limits resolved at the start, the project's cache name); `hello`'s workspace checks; a protocol 3 daemon unusable with "Update the daemon to 0.7.0" (as lot 5 step B1).
- The capability `isolated-workspace` (detected, 01 section 3.8); projects created from 0.7.0 require it (migration-free default for new projects, as `browser-tests`; the form says so); the queue's and **Run now**'s reasons.
- The settings of answer 8 with their ranges, without their defaults' final figures if step F changes them (Settings > Limits marks "Used from version 0.7.0").

**Done when** server tests cover the new fields and refusals, a protocol 3 daemon is given no run of any kind with the words on the machine page, in Needs you and in the queue, a new project requires the capability and an existing one does not, and lot 5's scenarios pass unchanged on protocol 4.

### [ ] D. The agent Docker, the socket filter and the network (branch `lot6/d-socket-filter`)

- The daemon's per-run filtered socket (answer 2): the allowed calls, the run's label, the cgroup parent and limits, ports bound to `127.0.0.1`, every refusal of answer 2 in plain words.
- `doctor`'s workspace checks of answer 12, the capability `isolated-workspace` in `hello`.
- `tools/smoke/agent-machine-check.sh`: Help's one-time commands (users, groups, folder, Docker, `delegate.conf`, ceiling, the `nftables` rule set with its DNS exception) run in pinned Ubuntu 24.04 and 26.04 images with systemd, then `doctor`'s checks.

**Done when** each allowed call and each refusal has its test against a real Docker (CI's), the labels and limits are added to everything created, `doctor`'s checks are covered in each grade with the fake `docker`, and the script passes in both images.

### [ ] E. The run container in a run (branch `lot6/e-run-container`)

- On an isolated machine: worktrees and bare clones in `/srv/orchestrator/`, the run slice, the run container started from the workspace image with the worktree, its bare clone, the project's cache and the filtered socket, `CLAUDE_CODE_SHELL_PREFIX` set to the daemon's wrapper; the session as today.
- The end (05, section 4.11): the session closed, the run container and everything with the run's label removed, the slice stopped, then the existing order (transcript, branch, worktree, restore, end push); the same when a waiting or paused run's session is closed; a daemon restart finds and cleans what a stopped daemon left.
- The rules of answer 3 in the hook and the run's settings for an isolated run; a non-isolated run unchanged.

**Done when** daemon tests with the fake `claude` (honouring the prefix as the probe recorded) and the fake `docker` cover a run's start, commands in the container, hooks on the machine, the end and its clean-up in order, a waiting run's session closed, a restart's clean-up, and an unchanged non-isolated run; the opt-in real-rootless test covers a run on a prepared host.

### [ ] F. Caches, limits and reset (branch `lot6/f-caches-limits-reset`)

- The project caches (answer 6), the limits' defaults from the owner's machine (answer 8, written into 04 section 8 and Settings), the disk measure and the clearing of the oldest caches, **Most containers per run** if step B's check 8 found no total.
- **Reset agent workspace** and **Clear caches** (answer 7): daemon commands, refusals while runs are active, events, the machine page.

**Done when** tests cover a cache kept between two runs of a project and never seen by another, each limit reaching the run's slice (or the fallback), the disk measure and clearing, both resets with their refusals and events, and Playwright on both viewports shows the machine page's buttons.

### [ ] G. Agents' rules and the projects (branch `lot6/g-agent-rules`)

- The builders', Quality's and the Project Manager's texts for an isolated run (answer 3; 03 sections 2.1 to 2.5): Docker and services allowed there, local integration tests for a `web_app` with PostgreSQL, the bootstrap's criteria (08 section 3.2: integration tests run locally on an isolated machine and in CI); a non-isolated run's texts unchanged.
- The Project Manager may steer to a `web_app` with PostgreSQL when the request needs it, now that it is tested locally on an isolated machine.

**Done when** `files.test.ts` and the run message snapshots cover both kinds of runs, and the bootstrap template's parts for a `web_app` say where integration tests run.

### [ ] H. Help, the agent machine and the local network (branch `lot6/h-help`)

- Help > Machines > "Agent machine": the one-time commands (checked by step D's script), the optional VLAN, the WSL fallback with its limits, `doctor`'s checks, the resets; "Agents on your own user" updated.
- Help > "Open the Orchestrator from another device" rewritten for an Orchestrator in WSL reached from the local network (answer 11), with the reverse proxy and `--ca-file`.
- CHANGELOG.

**Done when** `pnpm docs:links` passes, every command in Help is the script's, and the owner has read both pages.

### [ ] J. End-to-end lot 6 test (branch `lot6/j-acceptance`)

- `apps/server/test/acceptance-lot6.test.ts`: a request for a `web_app` planned, approved and run on an isolated machine (real daemon, fake `claude`, fake `docker`), its tickets' commands in the run container, the clean-up after each run, the reset; a non-isolated machine taking a project without the requirement; a protocol 3 daemon given nothing.

**Done when** the scenarios pass and the shard placement is checked.

### [ ] K. Version 0.7.0 (branch `lot6/k-release-0.7.0`)

- Rule 14; step L's checklist completed with the screens' words and the budget figures.

**Done when** `pnpm verify` and `pnpm test:e2e` pass with 0.7.0 everywhere and step L's checklist is final.

### [ ] L. Lot 6 check by the owner (branch `lot6/l-owner-check`)

On `main` once K is merged, from `docs/user/` alone, on the dedicated agent machine with the real Claude Code (the checklist is completed in step K):

1. The agent machine prepared with Help > "Agent machine" alone; the Orchestrator on Desktop WSL reached over HTTPS from the agent machine (Help > "Open the Orchestrator from another device"); the machine enrolled, **Online**, its daemon 0.7.0, every workspace check **OK**, `isolated-workspace` detected.
2. The probe again if Claude Code changed since step B; the allowlist smoke tests.
3. A request for a `web_app` with PostgreSQL (the text fixed in step K), planned, approved and built; its integration tests and Playwright tests run in the run container on the machine (the run log) and in CI, green on `main`; the app runs from its documentation alone.
4. From a run on the agent machine: reading the Claude login and the machine token refused; a local-network address refused; the agent's `docker run --privileged` and a host folder mount refused.
5. After a run: its containers, networks and volumes gone (`docker ps -a`, `docker network ls`, `docker volume ls` on the agent Docker, as Help shows).
6. **Clear caches** for the project, then **Reset agent workspace**; the next run works.
7. Desktop WSL (non-isolated, daemon 0.7.0) runs a ticket of a project that does not require isolation.
8. The usage-limit capture if the limit is reached (lot 5's rule).

**Done when** the owner has run the scenario from the user documentation alone and confirmed it, and lot 6 is closed as version 0.7.0.

## Open points

- **The owner's machine's facts** (answer 5, above): needed before step B.
- **The probe's result decides** the run container's mechanism, the worktrees' sharing, the run's total limits and how the run container reaches services (step B, checks 2 to 9).
- **A project's own image** (`.devcontainer` or Dockerfile): later, not in lot 6 (answer 5).
- **The WSL fallback** is not a security boundary between distributions (documentation checked above): kept as a fallback, said in Help, never the recommended setup.
- Lot 5's open points not about lot 6 stay where lot 5 put them (the launch without command-line texts in lot 8; the automatic merge of a branch behind; the failed implement runs on ART; the usage-limit capture).

## Carried into lot 6, where each item went

| Item | Where |
|---|---|
| No Docker or database for agents (lot 5, Open points) | Answers 2 and 3; steps D, E, G |
| Agents on the owner's user (lot 5, Open points; 05 section 7.2) | Answers 1 and 2: removed on isolated machines; lot 8 keeps the separate user for shared machines |
| Reaching an Orchestrator in WSL from the local network (lot 2's check, then Hardening) | Answer 11; step H |
