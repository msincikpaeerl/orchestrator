# Open the Orchestrator from another device

By default the Orchestrator is opened on the computer where it runs, at `http://localhost:8080`. You can also open it from another device on your home network or through a VPN.

## Use HTTPS outside this computer

Your password and your login travel between the browser and the Orchestrator. On `localhost` they never leave the computer. From another device they cross your network, and with plain `http://` anyone able to watch that network could read them.

**Outside `localhost`, use HTTPS**, for example through a reverse proxy (such as Nginx Proxy Manager or Caddy) or a VPN that encrypts the traffic (such as Tailscale). Never expose the Orchestrator directly on the internet.

## Tell the Orchestrator its address

In the `.env` file, set `PUBLIC_URL` to the address you type in the browser, then restart the Orchestrator (`docker compose -f docker/compose.yml up -d`):

```sh
PUBLIC_URL=https://orchestrator.example.net
```

or, on your home network without HTTPS:

```sh
PUBLIC_URL=http://192.168.1.20:8080
```

Machines on other computers need the `https://` form: their daemon refuses plain `http://` outside `localhost` (see [Orchestrator on another computer](machines.md#orchestrator-on-another-computer)).

The address must match what you type in the browser. With an `https://` address, the Orchestrator marks its login cookie as secure, so the browser sends it only over HTTPS: logging in from an `http://` address would then fail.
