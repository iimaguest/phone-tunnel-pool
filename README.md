# phone-tunnel-pool — Cloudflare quick-tunnel pool for the dsh web GUI

Enable/disable a **self-healing Cloudflare quick-tunnel pool** for
`http://127.0.0.1:3080` (the DeepSeek Harness web GUI) from a floating widget
with a scannable QR code. One scan from your phone, and the pool keeps
itself alive:

- **Generational rotation** (12 h): a new pair of tunnels spawns on schedule;
  older generations stay alive while anything is still on them.
- **Chase service worker**: every origin your browser touches registers a
  service worker. Dead or rotated hostnames redirect to a live sibling or the
  newest primary — the same open tab survives generation changes as long as
  it stays connected.
- **Prompt-free migrations**: the proxy injects credentials only into pages it
  has already authenticated; before any redirect the watchdog pre-authenticates
  the target hostname (minting its auth cookie), so migrations land
  authenticated — no "Authentication required" popups.
- **Usage-based retirement**: generations retire only when idle
  (no tabs / websockets / recent traffic) or at a hard age cap.
- **Respawn with backoff**: dead tunnels are replaced with new hostnames;
  quick-tunnel mint quota (Cloudflare 429) is respected via exponential
  backoff + a 2-probe dead-grace (DNS propagation).

Extra: the daemon runs detached and **adopts** across `dsh web` restarts, so
the same URL, password and QR stay valid until you click Disable — no
re-scan (an OS reboot still costs one fresh scan; a named tunnel removes even
that — see [`PLAN.md`](./PLAN.md) §7).

## Install / Uninstall

```bash
# install (from this public repo)
dsh plugin --profile web add github:iimaguest/phone-tunnel-pool
dsh web        # the GUI shows a floating 📱 widget (bottom-right)

# uninstall (one command — removes the dependency AND the dsh.profile.bundles layer)
dsh plugin --profile web remove phone-tunnel-pool
dsh web
```

After install: open the widget → **Enable** → scan the QR with your phone
camera. Install/remove reconcile `dsh.profile.bundles` against the installed
state automatically — **never edit `~/.dsh/profiles/web/package.json` by hand**;
a stray bundle entry with no matching dependency is exactly the kind of state
that fails profile boot ("cannot resolve profile bundle").

## Screenshots

![dsh web on a phone, reached through the tunnel pool](docs/phone-on-tunnel.jpg)

![Tunnel pool widget: a phone tunnel enabled with a live pool of generations](docs/screenshot-widget.png)

*Live hostnames, credentials and the QR are blurred out in these shots.*

Requirements on the host: `cloudflared` (`brew install cloudflared`), `node`,
`python3` with the `qrcode` package (`pip install qrcode`).

## How it's wired

```
dsh web GUI  <--  /iptunnel routes  --  auth proxy (127.0.0.1:3090)
                                              │  Basic + session cookie,
                                              │  Host rewrite to 127.0.0.1:3080
                                              │  (the GUI's browser-trust fence)
                                              ▼
cloudflared A ─ to ─ auth proxy ───────────────────────────────────┐
cloudflared B ─ to ─ auth proxy ───────────────────────────────────┤ (tunnel daemon
    ... new generations ...  ──────────────────────────────────   │   manages all)
```

Files: `lib/index.js` (host API: enable/disable/adopt, state + QR SVG routes),
`lib/daemon.mjs` (detached pool brain: spawn, probe, rotate, retire, respawn),
`cf-auth-proxy.mjs` (public `/iptunnel/*` service paths + Basic auth +
watchdog injection + credential handoff), `iptunnel-sw.js` (chase service
worker), `iptunnel-watchdog.js` (open-tab watchdog), `lib/client.js`
(widget), `verify.sh` (end-to-end audit). `PLAN.md` = full spec + edge cases;
`NOTES.md` = engineering history.

## Security model

- The password is **generated per Enable**, held in memory, shown in the
  widget and embedded in the QR; nothing is committed or persisted.
- `/iptunnel/*` service paths (health, sw-config, sw.js, entry, watchdog.js,
  telemetry, preauth) are **public by necessity** — browsers fetch service
  workers without credentials; they carry hostnames and pool liveness only.
  The credential handoff (`/iptunnel/preauth`) mints a cookie only for a
  caller presenting the valid password; it never echoes anything.
- `window.__ptAuth` is injected **only into HTML the proxy has authenticated**.
- The proxy listens on 127.0.0.1; public network exposure happens only
  through the tunnel hostnames — **the QR/hostname is a bearer secret**
  (anyone who gets it can open the tunnel while enabled): disable when done.
- Quick tunnels are testing-grade (no uptime SLA, per-IP mint quota).
  [The repo-agnostic sibling package](https://github.com/iimaguest/port-tunnel-pool)
  carries the same pattern for any local port; a named tunnel is the
  lifetime endgame (one stable hostname → no re-scans, no prompts, no quota).

## License note

Third-party code: [cloudflared](https://github.com/cloudflare/cloudflared)
(distributed by Cloudflare), the Python `qrcode` library — used at runtime,
not vendored.
