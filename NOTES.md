# phone-tunnel-pool — complete engineering notes (for future sessions)

Captured 2026-08-23 after the full conversation: exposing the DeepSeek Harness
web GUI (127.0.0.1:3080) to a phone via Cloudflare, through a dynamic Cordis
plugin iteration, ending in a **permanent profile bundle** — plus all the
non-obvious harness, fence, QR, and cloudflared facts we learned the hard way.
READ THIS before touching anything in this directory or re-creating the tunnel.

> **v2 STATUS: IMPLEMENTED & TESTED 2026-08-23.** The self-healing
> **generational tunnel pool** is built (12 h rotation, dual tunnels per
> generation, chase service worker + watchdog injection, usage-based
> retirement, pool view with versions/clients/WS) — spec in
> [`PLAN.md`](./PLAN.md) (now "implemented"; §6 phases done incl. the
> install-time config warm-up fix discovered by the E2E chase test: a SW that
> never intercepts while its origin is alive must learn the pool at INSTALL
> time or it dies with an empty cache → PLAN.md §2.3 note). Proven end-to-end
> with a headed-browser E2E suite: SW registers (scope header fix), kill-A →
> respawn → primary promotion, stale-bookmark chase to sibling, chase to new
> primary, per-host usage accounting. Auth follows migrations now: the proxy
> injects window.__ptAuth only into authenticated HTML; the watchdog pre-auths
> every migration target via the public /iptunnel/preauth handoff (valid
> Authorization -> target mints its dsh_auth cookie), so the chase redirects
> land cookie-authenticated — no "Authentication required" prompt on any
> rotation. Cold opens of a DEAD origin (no page running) still prompt once.
> Watchdog also warms the SW config cache.
> Watchdog injection hardened with
> `accept-encoding: identity` — deterministic injection even when the origin
> would compress (PLAN.md §implementation 6). Caveat vs plan:
> the dynamic-plugin mirrors stay v1-shape (bundle is source of truth).

---

## 1. Current live state (as of writing)

- dsh web runs at http://127.0.0.1:3080 (`dsh web` from a terminal; PID changes).
- Permanent widget: **icon only** — floating 📱 emoji (20px, 34×34 invisible
  tap area) bottom-right of every page. **Draggable**: pointer-drag moves it
  vertically anywhere along the right edge (always snaps back flush to the
  right edge; clamped to the viewport; click still toggles the panel — a drag
  of >4px suppresses the click). Position resets to bottom on page reload.
  State readable from the icon itself:
  **enabled = green glow**, **disabled = grayscale/dimmed**; tooltip says
  "Tunnel pool (enabled|disabled)". A 7px status dot sits at the icon's
  top-right corner: **green** when enabled, **red** when disabled (white ring
  for contrast on any page background). Click → panel: one-click
  **Enable/Disable**, URL, login (`dsh / <password>`), QR (login embedded).
- Tunnel state (as of the persistence rewrite on 2026-08-23): the running
  `dsh web` (PID 12316, restarted 13:16) has the PRE-daemon code and a live
  tunnel started the old way (`stops-revolutionary-quilt-indianapolis…` /
  `oinxphhzlcaem7za6k1nxn0iyjzg`) — it dies with that server. After the next
  restart, the new daemon code loads: enable ONCE, scan the fresh QR, and that
  URL/password/QR then survives every subsequent `dsh web` restart.
- IMPORTANT: every fresh daemon session produces a NEW password + NEW hostname;
  the QR and inputs update automatically. Never hardcode either. (A daemon
  session does NOT rotate: it lives until Disable, OS reboot, or cloudflared
  death.) `/iptunnel/state` returns the password **only while enabled**;
  while disabled it is `null`.
- Processes (when enabled): `node <bundle>/lib/daemon.mjs` (detached parent)
  → `cloudflared tunnel --url http://127.0.0.1:3090 …` +
  `node /tmp/cf-auth-proxy.mjs 127.0.0.1 3090 127.0.0.1 3080` + `caffeinate -dims`.
- State endpoint (host routes, plain fetch): `curl http://127.0.0.1:3080/iptunnel/state`.
- Daemon store: `/tmp/iptunnel-state.json` (0600, url/user/password/daemonPid);
  daemon log: `/tmp/iptunnel-daemon.log`.

## 2. The chain (why each piece exists)

```
Phone camera QR → Safari → https://dsh:pw@host.trycloudflare.com
   → Cloudflare edge (TLS; post-quantum hybrid X25519MLKEM768)
   → cloudflared connector (QUIC, hardened flags)
   → /tmp/cf-auth-proxy.mjs on 127.0.0.1:3090   ← password gate (Basic + cookie)
   → dsh web on 127.0.0.1:3080

   └─ all three (proxy/cloudflared/caffeinate) are children of the DETACHED
      lib/daemon.mjs, spawned by the plugin with child_process.spawn
      (detached + unref) — NOT ctx.subprocess — so they survive dsh web
      restarts. The plugin adopts the daemon via /tmp/iptunnel-state.json.
```

- **dsh web has NO authentication layer.** Its /api **browser-trust fence**
  (dsh-client-connection `api-request-trust`) rejects ANY Host that isn't a
  loopback authority or an explicitly trusted `trustedHosts` entry
  (DNS-rebinding defense). It is "a reachability policy, not authentication".
- Because a quick-tunnel hostname can't be added to `trustedHosts` without
  restarting the server (and stays dynamic), the **proxy rewrites Host →
  127.0.0.1:3080** (fence sees loopback → allowed) and **strips
  Origin/Referer** so the page's real origin never mismatches.
- **WebSocket**: browsers do NOT send Basic-Auth credentials on WS handshakes
  → the proxy sets `dsh_auth` HttpOnly cookie on every authorized response;
  the cookie rides the WS upgrade (both `/api/events.mux`, `/api/events.host`).
- **QR**: hand-rolled encoder was WRONG (see §10) — the host now shells to
  Python `qrcode` and ships `data:image/svg+xml;base64,…` to the client.
  QR payload = `https://dsh:<password>@<host>` (basic-auth deep link; Safari
  pre-fills/uses it; anyone who photographs the card can open the tunnel).

## 3. Files

Permanent bundle at `~/.dsh/plugins/phone-tunnel-pool/` (symlinked into
`~/.dsh/profiles/web/node_modules/phone-tunnel-pool`):

| File | Role |
|---|---|
| `package.json` | bundle manifest: `dsh.bundle.patch` + `dsh.client` (platform web) |
| `cordis.patch.yml` | **`insert:` row** (must be insert, NOT a plain id row — see §10) |
| `lib/index.js` | host: daemon lifecycle (spawn detached/adopt/stop), QR via python3, `/iptunnel` routes, 30s heartbeat |
| `lib/daemon.mjs` | **detached supervisor** — owns proxy+cloudflared+caffeinate, parses URL, writes `/tmp/iptunnel-state.json`, SIGTERM cleanup |
| `lib/client.js` | module-loader bundle; `exports.inject = ['slots']`; overlay widget |
| `cf-auth-proxy.mjs` | the auth proxy SOURCE (bundled; host self-heals it to /tmp at enable) |
| `host.js` / `client.js` | dynamic-plugin variants (same logic, harness.handle RPC) — usable for `cordis_define` recipe |
| `verify.sh` | one-command chain audit: enable → 401/200/fence/TLS probes → disable → clean-shutdown check (exit 0 = green; tunnel left OFF) |
| `README.md` | user-facing usage |
| `NOTES.md` | this file |

Profile wiring: `~/.dsh/profiles/web/package.json` →
`"phone-tunnel-pool": "link:../../plugins/phone-tunnel-pool"` in dependencies and
`"phone-tunnel-pool"` in `dsh.profile.bundles` (after dsh-plugin-subscriptions).
The profile user patch `cordis.patch.yml` is NOT touched.

## 4. Operations

- **Enable from Mac GUI or phone**: click 📱 pill → Enable. Takes ~10-20 s
  (daemon: proxy → cloudflared → URL → state file → QR). The host spawns
  `lib/daemon.mjs` DETACHED (`child_process.spawn`, `unref` — deliberately NOT
  ctx.subprocess so it survives server restarts). Disable pkills the daemon
  (it SIGTERMs its children: proxy, cloudflared, caffeinate) + backup
  pkill of proxy/cloudflared + removes the state file.
- **Persistence semantics (user decision 2026-08-23)**: the tunnel now survives
  `dsh web` restarts — the plugin adopts a live daemon at boot (`adoptIfAny()`)
  and on Enable (`state.phase==='enabled'` short-circuits). Hostname + password
  + QR are unchanged → **no re-scan after a server restart**. The tunnel STILL
  ends on: Disable, OS reboot (`/tmp` wiped), cloudflared death (quick-tunnel
  hostname is per-process; daemon exits rather than restarting with a new one).
- **Restart checklist**:
  1. `dsh web` restart → widget always present. If a daemon is running, the
     widget shows it as enabled (adopted) — same URL/QR, nothing to do.
  2. Run `bash verify.sh` after code changes (one command; enables, audits,
     disables). NOTE: verify.sh Disables at the end — it rotates the session.
  3. If nothing is running: click Enable, scan fresh QR (one-time per daemon
     session).
- Dead sessions are reaped on every fresh enable via
  `pkill -f 'iptunnel.*daemon.mjs'` (escaped), `pkill -f 'cf-auth-proxy.mjs'`
  and `pkill -f 'cloudflared tunnel --url http://127.0.0.1:3090'`.
- **After OS reboot**: python3 `qrcode` module must exist
  (`pip install qrcode`; opencv-python-headless only for verification).
  `/tmp/cf-auth-proxy.env` is a LEFTOVER from the early manual sessions — the
  plugin never reads or writes it (creds flow through spawn env vars); the
  daemon deletes it on start. `/tmp/cf-auth-proxy.mjs` self-healed by the
  daemon from the bundle.

## 5. Cloudflared flags (all validated 2026.8.2, brew)

`cloudflared tunnel --url http://127.0.0.1:3090 --no-autoupdate --no-prechecks
--metrics 127.0.0.1:20241 --loglevel info --transport-loglevel error
--grace-period 5s --edge-ip-version 4 --post-quantum
--management-diagnostics=false`

(Defined in ONE place now: `lib/daemon.mjs` — the plugin no longer duplicates
the argv; edit there first, then restart dsh web.)

- `--no-autoupdate` (no update pings), `--no-prechecks` (no startup probes),
  `--metrics <loopback>` (never public; default localhost:0 also fine),
  `--post-quantum` (X25519MLKEM768 hybrid), `--transport-loglevel error`.
- **`--management-diagnostics=false` correction (verified 2026-08-23):** in
  v2026.8.2 it gates `/debug/pprof/cmdline` (returns `forbidden`) but NOT the
  pprof handlers on the METRICS port — `/debug/pprof/goroutine`, `/heap`,
  `/trace`, `/symbol` all answer **200** on 127.0.0.1:20241. Impact is LOW:
  loopback-only (lsof: 127.0.0.1:20241), never reachable through the tunnel
  (cloudflared only proxies the origin URL) — same-user processes only. Accept
  it, or later run cloudflared in a container with tightened loopback.
- AVOID `debug` loglevel (logs URLs/methods/headers). No `--protocol` flag in
  this version (auto QUIC). `--metrics 0` does NOT disable; bind loopback.
- Quick tunnels: no account, random hostname, NO uptime guarantee, new URL per
  restart, Cloudflare sees metadata by design (can't be turned off locally).
- Probes: `curl -H 'Connection: Upgrade' …` over the tunnel returns edge 400
  (`server: cloudflare`) — HTTP/1.1 upgrade probes are NOT representative;
  real browsers use RFC 8441 extended CONNECT and work (verified with Edge).

## 6. Harness security model (facts verified, do not "fix")

- **No auth layer**; fence = reachability. Loopback hostnames pass; privileged
  methods ALSO pass an empty trust list → pinned to loopback. `trustedHosts`
  config lives in `dsh-web-app/cordis.patch.yml` via `ctx.webRuntime.trustedHosts`
  and the CLI `--trusted-host` — restart required to change.
- `PRIVILEGED_METHODS` (settings/credentials/agentPreset/host.pickDirectory/
  llm.discoverModels) — settings+credentials are **loopback-only by design**
  (reconnaissance-grade reads). Through the proxy the SERVER-side fence passes
  (Host loopback) but the CLIENT decides by page origin: the Settings **Models**
  tab needs `settings.describe` + `credentials.describe` → on the tunnel page it
  shows "settings are unavailable in this browser" → **by design**; provider
  admin stays Mac-side. Model picker/chat/sessions all work remotely.
- Dynamic plugins: process-local, die on server restart; fresh pages show
  "Client ready to activate" → click Start; `cordis_define` needs re-approval.
- `dsh web --host 0.0.0.0` intentionally unsupported without an auth layer.

## 7. Permanent bundle gotchas (learned the hard way)

- Bundle patch rows must be `- insert:\n    - id: …\n      name: …` — a plain
  `- id: … name: …` is an OVERRIDE patch → "entry not found" + silent skip.
- pnpm `file:` deps are COPIED+content-cached → source edits don't propagate;
  use `link:` (symlink) for live dev. `pnpm install` after package.json changes.
- The client bundle is served LIVE from disk (`/plugins/phone-tunnel-pool/client.js`);
  page reloads pick up edits without a server restart (rev is a cache-buster).
- Permanent client slots API ≠ dynamic: `slots.register({ name: 'shell.overlay',
  id: …, order, label }, render)` — `name` is REQUIRED; without it →
  `slot "undefined" is not declared`. And the row mounts EARLY
  (`immediately: true`) before `shell.overlay` is declared → wrap in
  `slots.inject('shell.overlay', () => slots.register({name: 'shell.overlay', …}))`.
  Client plugin `exports.inject = ['slots']` so the loader waits for the service.
- Client bundle wrapper shape:
  `window.__ModuleLoader__.load({id: '<pkg-name>', factory: require => { … exports.inject/apply … }})`
  — `require('react')` is baseline. No imports/JSX.
- Host module shape (ESM): `export const name/inject`, `export function apply(ctx, config)`
  — `Config` optional (validate via throwaway boot `dsh --profile web --port 3999 --no-open`).
- `/plugins/<id>/client.js` URL and route registration work only when the row
  is in the composed tree — verify with `dsh --profile web --dump-config | grep <id>`.

## 8. Verification toolkit (recreate from scratch if /tmp wiped)

- **One-command audit: `bash verify.sh`** (in this dir) — enables the tunnel,
  waits for the public URL, checks anonymous → 401, creds → 200, fence-pass
  codes (426/404), prints TLS/HTTP version, disables, and verifies phase +
  cleared password. Exit 0 = chain green; tunnel left OFF. Run it after any
  change, after OS reboot, and after `brew upgrade cloudflared`.
- QR decode proof: Playwright screenshot of the QR `<img>` → python cv2
  `QRCodeDetector().detectAndDecode()` → must equal `https://dsh:pw@host`.
  pip: `opencv-python-headless`, `qrcode`.
- GUI E2E (permanent): fresh Chromium/Edge → wait → pill `button[title="Tunnel pool"]`
  → click → `button:text-is("Enable tunnel")` → wait for input containing
  `.trycloudflare.com` (no `@`) → screenshot `img[alt="QR code to scan with your phone"]`.
- Host/endpoint smoke: `/iptunnel/state` 200 JSON; `/plugins/phone-tunnel-pool/client.js` 200.
- Fence probes: `curl /api/anyPing` → 403 (fence) vs 404 (passed) — 404 = passed.
- **Live audit set (verified 2026-08-23, tunnel enabled → probed → disabled):**
  - Anonymous `GET /` through the tunnel → **401** + `WWW-Authenticate: Basic
    realm="dsh tunnel"` (gate before anything).
  - With creds → 200, HTTP/2; TLS to edge = **TLSv1.3 / CHACHA20 / h2**, cert
    CN=trycloudflare.com (Google Trust Services).
  - `/iptunnel/state` through the tunnel with creds → 200 JSON (see §1: it
    includes the password only while enabled — fine behind the gate; the
    2026-08-23 fix nulls it on disable; never share the response).
  - Fence-pass proof with creds: `/api/events.mux` → **426** (WS upgrade
    required — reached dsh), `/api/session` → 404 (reached dsh, not 403).
  - Local surface: metrics+pprof on 127.0.0.1:20241 only (see §5 correction);
    proxy 127.0.0.1:3090 only; dsh web 127.0.0.1:3080 only.
  - Log hygiene: `grep -icE 'authorization:|<password>|dsh:'` in
    /tmp/cloudflared-dsh.log → **0** lines at `transport-loglevel error`.
  - NOTE: cloudflared log showed the old hostname still being polled by the
    phone tab (`stream canceled by remote`) after a previous disable — old
    URLs die; close old tabs, re-scan the fresh QR.
- Playwright pitfalls: `get_by_role(button, name=…)` can hit disclosure rows
  (strict-mode) → prefer `locator("button:text-is('Enable tunnel')")`; fresh
  pages land on the Home view — open the session first for run-card content.

## 9. Failure history (what NOT to repeat)

- Hand-rolled QR encoder (byte mode, ECC L, mask 0): looked right, **cv2
  rejected it** — the finder separator ring wasn't marked as function modules,
  so data leaked into the separators (user saw "corners not dense / triangles").
  Never ship a from-memory QR encoder; use Python `qrcode` (or kazuhikoarase).
- `qr === null ? qr.size : …` null-deref crashed the whole card render.
- `slots.register` without `name` → `slot "undefined"`.
- Update-flow UX: after `cordis_run` update, each page must re-activate the
  client ("Client ready to activate") — not an error, it's the design.
- python3 qrcode 8.x kwarg is `image_factory=` (not `factory=`) and the SVG
  factory needs binary stream (`sys.stdout.buffer` / BytesIO) — lxml writes bytes.
- `head -40` in a bash pipe swallowed the boot log (block buffering) — log to a file.
- `disable()` didn't clear `state.password` → `/iptunnel/state` kept showing the
  stale secret while OFF, and re-enable REUSED it (rotation happened only
  across server restarts). Fixed: null password+startedAt on disable,
  unexpected-exit, and enable-failure paths (2026-08-23; restart to load).

## 10. Handoff / future TODOs

1. ~~**Self-heal the proxy file**~~ DONE (2026-08-23; now lives in
   `lib/daemon.mjs`): copies `../cf-auth-proxy.mjs` (bundle) to `/tmp` when
   missing and deletes any stale `/tmp/cf-auth-proxy.env`. Needs a `dsh web`
   restart to load.
2. ~~**Persistence across dsh web restarts**~~ DONE (2026-08-23, user changed
   mind): the tunnel chain moved into a DETACHED daemon (`lib/daemon.mjs`,
   `child_process.spawn` + `unref`, NOT ctx.subprocess) + state file
   `/tmp/iptunnel-state.json` (0600); the host adopts it at boot/Enable.
   Same hostname/password/QR across server restarts — no re-scan.
   + `caffeinate -dims` moved INTO the daemon (keep-alive while the tunnel
   exists, even between two dsh web processes).
3. **Named tunnel + Cloudflare Access** (production/permanent auth): stable
   hostname, email-OTP policy — the "right" upgrade path; quick tunnel +
   password is personal-use grade. Add `--region`/residency only for named.
4. **Tailscale Serve** (privacy endgame): `tailscale serve` → HTTPS inside
   your tailnet; no Cloudflare, no rotation, no /tmp proxy, forever-fresh URL.
   The widget stays as the public-access accessory. Requires Tailscale account
   + phone app.
5. **launchd for `dsh web`** (optional): a user LaunchAgent restarts the GUI
   after reboot; tunnel still starts OFF by default. `~/Library/LaunchAgents/
   com.iimaguest.dsh-web.plist` with `dsh web` + KeepAlive.
6. **git in the plugin dir**: version the bundle + NOTES.md so history and
   fixes survive (single-user repo, no remote).
7. Consider `dsh.webRuntime` LAN IP display parity later — not needed.
8. If the loopback settings pin ever needs remote admin, it's a harness
   feature (real auth layer), not a tunnel option — do not bypass.

## 12. Good practices (tension-free + long-lasting)

- **Rotate per session, persist per session (user-approved)**: a password is
  generated when a daemon session starts and stored ONLY in the 0600 state
  file /tmp/iptunnel-state.json (wiped by reboot; removed on Disable; passed
  to the proxy via spawn env, never argv). A session never rotates its
  password — that's what makes the QR reusable; Disable/fresh-enable = new
  secret. Never hardcode a password in the GUI/docs.
- **Verify after every change**: `bash verify.sh` (one command, leaves tunnel
  OFF). Also after OS reboot and `brew upgrade cloudflared`.
- **Re-validate flags after brew upgrades** — this exact pitfall bit us:
  v2026.8.2 changed what `--management-diagnostics=false` gates (see §5).
  `brew pin cloudflared` if you want stability.
- **Treat /tmp as disposable**: the daemon/state/log files there are all
  re-created by the daemon; everything durable is in the bundle dir. A reboot
  wipes /tmp (new session → one re-scan — the only remaining one).
- **No time cap + survives restarts (user decisions 2026-08-23)**: the tunnel
  has NO auto-expiry and now SURVIVES `dsh web` restarts (detached daemon +
  adoption). It ends only on: Disable, OS reboot, cloudflared death. Enable →
  use → Disable remains the model.
- **Long sessions**: the daemon holds `caffeinate -dims` (released on Disable)
  so Mac sleep can't drop the QUIC connection — one QR stays usable for hours
  or days. Wi-Fi change → reconnect, same hostname; caffeinate keeps the Mac
  awake so even that is rare.
- **Old phone tabs die silently** — close tabs pointing at a previous
  hostname; only the fresh QR counts.
- **Never paste `https://user:pass@host` into chat/email**; the QR screenshot
  is the secret — treat the photo as a password.
- **Host changes need a restart; client changes are live** (bundle served from
  disk; reload the page). Batch host edits into one restart.
- **Quick tunnel = convenience tool, not infrastructure**: if this becomes a
  daily habit, move to Tailscale (#4) or named tunnel + Access (#3).

## 11. Ask-the-agent recipe (if the bundle is ever removed)

> Re-create phone-tunnel-pool: read `~/.dsh/plugins/phone-tunnel-pool/host.js`
> as `code.host` and `client.js` as `code.client`, then `cordis_define`
> (new plugin, prefix `qru`, name `phone-tunnel-pool`) and `cordis_run`; approve
> the Client half. Then re-mount permanently per `README.md`.
