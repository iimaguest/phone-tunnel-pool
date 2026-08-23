# phone-tunnel-pool v2 — self-healing generational tunnel pool (PLAN)

> Status: **IMPLEMENTED** 2026-08-23 (phases P0-P5 done; E2E receipts on
> record). Edit targets: `lib/daemon.mjs` (pool manager), `cf-auth-proxy.mjs`
> (proxy v2), `iptunnel-sw.js`, `iptunnel-watchdog.js`, `lib/index.js` +
> `lib/client.js` (host/widget), `verify.sh` (v2). Companion to NOTES.md.
>
> **Implementation deltas beyond this spec** (learned in E2E testing):
> 1. The chase-SW pre-warms the pool config at INSTALL time (the `install`
>    handler in `iptunnel-sw.js`): on the very first visit the SW is
>    registered by the entry page, so its origin may die before ever being
>    intercepted — without warm-up the dead origin's SW has an empty cache,
>    no sibling list, and the chase passes through to 1033.
> 2. The daemon keeps `state.url` in sync with `state.primary` (v1-compat:
>    the host's enable() waits for `url`).
> 3. Metrics ports start at 21000 (20241 is the v1 legacy port, in use by the
>    old chain).
> 4. The daemon self-heal ALWAYS copies the bundle files to /tmp (stale v1
>    copies would silently serve the old proxy/SW).
> 5. SW pass-through when self is alive is a same-origin redirect to `/`
>    (never a SW-side `fetch(req)` — avoids the SW/HTTP-Basic-auth conflict).
> 6. The proxy requests `accept-encoding: identity` from the dsh origin so
>    HTML is never compressed by it — watchdog injection would otherwise be
>    skipped on encoded responses (`isInjectable` refuses them), making SW
>    registration non-deterministic. CF edge re-compresses outward.
> 7. Cloudflare rate-limits quick-tunnel **minting** per IP (429 code 1015 —
>    observed mid-session; cloudflared exits code 1 instantly). The daemon
>    backs off exponentially on mint failure (30 s × 2^n, cap 8 min) instead
>    of hammering the API; the pool heals when the window opens (or the IP
>    changes). Also: one failed health probe right after registration is only
>    DNS-propagation lag — dead is declared after 2 consecutive failures.
> 8. **Chase on death only** — SUPERSEDED by §9 after the user's correct push-
>    back ("migration while alive is the intended part"): the auth problem is
>    solved at the credential layer instead of by freezing migrations.
> 9. **Credential handoff at redirect time (final)**: migration-while-alive is
>    restored and prompt-free. The proxy injects `window.__ptAuth`
>    (base64 user:pass) ONLY into HTML it has already authenticated (never in
>    public endpoints). Before every migration the watchdog fetches the target's
>    public `/iptunnel/preauth` with that Authorization header; the target
>    validates and mints its `dsh_auth` cookie (SameSite=Lax, HttpOnly; sent on
>    the subsequent top-level GET). The tab then lands authenticated — no 401,
>    no "Authentication required", on every rotation/migration. CORS: OPTIONS
>    preflight answered pre-auth (no Authorization possible); actual GET must
>    validate the header (401 otherwise; never sets a cookie for unauthenticated
>    callers — no auth downgrade). Residual prompt (rare, by design): a
>    cold-bookmark open of a DEAD origin has no page running the watchdog, so
>    no handoff — one prompt; the named-tunnel endgame removes even that.

## 0. Goal (user's exact ask)

- Quick tunnels keep working **without** the user re-scanning or re-booking:
  - a **pool** of tunnels refreshed on a schedule (every 12 h) so Cloudflare's
    unspecified long-session reaper never kills our only URL;
  - **browsers chase the pool automatically** (service-worker redirect chain),
    including open tabs (injected watchdog);
  - **usage-based retirement**: when every browser has moved away, a generation
    is dispensed with — measured with real signals (tabs, WebSockets, traffic),
    not blind timers;
  - the widget **shows the pool**: generations, versions (cloudflared version,
    gen numbers), health, and **who is connected** (distinct clients, tabs,
    live WS) per generation.

## 1. Architecture

```
                      ┌──────────────────────────────────────────────────┐
                      │  daemon.mjs  (pool manager, detached from dsh web)│
                      │  rotation every 12h → spawn gen (A,B)             │
                      │  probes every 30s; restarts dead tunnels          │
                      │  retirement rules (usage + caps)                  │
                      └──────┬──────────────┬──────────────┬─────────────┘
                             │              │              │
   gen N (current):    cloudflared A ─┐  cloudflared B ─┐   caffeinate
   gen N-1:            cloudflared A' ┤  cloudflared B' ┤   (keep-awake)
   gen N-2 (retiring)     ...         │   metrics 20241.. per proc
                                     ▼
                     proxy (127.0.0.1:3090)  ← ONE gate, ALL gens
                     · Basic-auth + cookie (unchanged)
                     · whitELISTED public paths (see §4)
                     · per-host usage/WS/client accounting
                     · serves entry page, sw.js, sw-config, watchdog.js
                     · injects watchdog into dsh HTML
                     └──────────────┬──────────────┘
                                    ▼
                     dsh web (127.0.0.1:3080)  ← Host rewritten, fence passes

Browsers: bookmark/QR = https://dsh:pw@<A_genN>/iptunnel/entry  (ONE entry)
  SW(entry) intercepts later navigations → chases current pool.
  Watchdog in pages keeps open tabs alive/chasing. Telemetry reports back.
```

## 2. Components & contracts

### 2.1 daemon.mjs — pool manager
- State: `gens[]` = `{ gen, spawnedAt, status: current|active|retiring|retired,
  tunnels: [ {id:A|B, url, metricsPort, healthy, lastAlive, lastDead, lastProbe, pid} ] }`
  + `primaryUrl`, `password`, `cloudflaredVersion`, `startedAt`.
- **Rotate**: when `now - currentGenStart >= ROTATE_INTERVAL` (12 h) →
  `spawnGen()`: spawn **two** cloudflareds (A,B) → same proxy origin
  `http://127.0.0.1:3090`, metrics on `20241 + 2*gen` … (free-port check),
  parse hostnames from logs, write atomic state (`write tmp + rename`).
- **Health probe** (30 s, node `fetch`, 8 s timeout): probe every tunnel's own
  public URL `https://<host>/iptunnel/health` → ANY status (401/200/404) =
  alive (proxy answered); CF error page (530/1033), timeout, network error =
  dead. Dead > `RESTART_AFTER` (2 min) → restart that cloudflared (new
  hostname, same gen; update state; the OTHER tunnel is untouched).
- **Retirement** (checked every 60 s). A non-current gen with `age >= MIN_LIFE`
  (4 h) retires when **idle**: `tabs == 0 && ws == 0 && lastSeen > IDLE_WINDOW`
  (60 min). Hard caps: `MAX_LIVE_GENS` = 4 (retire oldest beyond), `MAX_AGE`
  = 36 h (retire regardless — safe, see §5.8). Retiring → 5-min grace → kill
  cloudflareds → `retired` (meta kept for history).
- **Never retire the current gen. Never spawn while a gen is < 1 h old**
  (rotation guard). On any current-gen both-tunnels death → **emergency
  respawn** immediately (don't wait for the 12 h timer).
- Adoption: survives dsh web restarts exactly as v1 (state file + pid check).

### 2.2 proxy (cf-auth-proxy.mjs v2)
- Auth gate untouched for everything EXCEPT the whitelist (§4).
- **New loopback control API** (`/_ctl/…`, 127.0.0.1 only, daemon → proxy):
  - `POST /_ctl/config {primary, gen, list:[entry URLs newest→oldest]}` —
    pushed whenever pool changes;
  - `GET /_ctl/usage` → `{hosts:{<host>:{lastSeen,reqCount,ws,clients:SetSize}}}`.
- **Public paths** (pre-auth, all with `access-control-allow-origin: *` where
  cross-origin probing needs it):
  - `GET /iptunnel/health` → 401 (the gate itself is the liveness signal;
    401/200/404 all mean "alive" to any prober);
  - `GET /iptunnel/sw.js` — the chase-SW script (version-stamped comment);
  - `GET /iptunnel/sw-config` — `{primary, gen, list[], ts}` (hostnames only,
    NO password), CORS `*`, `cache-control: no-store`;
  - `GET /iptunnel/entry` — 1 KB HTML: registers SW then `location.replace('/')`;
  - `GET /iptunnel/watchdog.js` — injected page script (also served standalone);
  - `POST /iptunnel/telemetry` — `{host, tabId}` → per-host tab registry.
- **HTML injection**: for 200 `text/html` responses with NO content-encoding,
  append `<script src="/iptunnel/watchdog.js"></script>` before `</body>`
  (fallback: append at end). Skipped for gzip/JSON — documented limitation
  (open tabs there don't chase; reload still does).
- **Usage accounting** (every request, incl. WS upgrades): host from the
  original Host header (the proxy rewrites it — it already sees it); WS
  count = live upgraded sockets per host; clients = distinct
  `CF-Connecting-IP`/XFF values in the window.

### 2.3 chase-SW (served as /iptunnel/sw.js, registered per origin)
- `fetch` handler intercepts **only** `navigate` to `/iptunnel/entry`.
  Everything else: `return` (no respondWith) — harness untouched.
- Logic:
  1. `cfg = cachedConfig()` — Cache API `iptunnel-sw/1`; refreshed by fetching
     `/iptunnel/sw-config` (CORS, no-store) whenever the origin is alive;
  2. **primary chase**: if `cfg.primary.origin !== self.origin` **and**
     `probe(cfg.primary)` alive → `Response.redirect(cfg.primary)`;
  3. self alive (`fetch(self.origin + '/iptunnel/health')` readable) →
     `respondWith(fetch(event.request))` → normal browser load (auth flow
     untouched — the SW never touches Authorization headers);
  4. self dead → walk `cfg.list` (newest→oldest, skipping self origin),
     probe each (CORS), first alive → `Response.redirect(it)`;
  5. none alive → `fetch(event.request)` → 1033 (no loops: never redirect to
     self, never to an origin outside the known list).
- `probe(u)`: `fetch(u+'/iptunnel/health', {mode:'cors', cache:'no-store'})`
  → resolve with 401/200/404 = alive; TypeError/CF-5xx = dead.
- Registration is idempotent (`scope: '/'`, guard with try/catch since
  Basic-auth origins & iOS have quirks — verify early, §8 risk 1).

### 2.4 watchdog.js (injected)
```
on load:    fetch('/iptunnel/sw-config') → remember primary; sendBeacon telemetry
interval 30s:
  fetch('/iptunnel/health') → fail → location.replace('/iptunnel/entry')   // own gen died → chase
  fetch('/iptunnel/sw-config') → primary.origin !== self.origin
                             → location.replace('/iptunnel/entry')          // pool moved → chase
  sendBeacon('/iptunnel/telemetry', {host: location.host, tabId})
pagehide:   sendBeacon telemetry
```
- Chasing via `/iptunnel/entry` (not direct): the SW does the redirect, so the
  SW chain stays in charge and each visited gen registers its own SW.
- Trade-off chosen: open tabs are migrated eagerly at each rotation (one
  quick reload per tab per 12 h) in exchange for the pool being bounded —
  this matches the user's "keep refreshing … redirecting to the latest one in
  all active browsers". Alternative (death-only watchdog) noted in §7.

### 2.5 widget (client.js v2) — "showing versions & clients"
- Poll `/iptunnel/state` (now `{version:2, primary, username, password,
  gens:[…], cloudflaredVersion, startedAt}`; gated as before).
- Panel gains a **Pool** section (collapsible table):
  `gen ▸ A/B | hostname | status (current/active/retiring/retired) | healthy ✓ |
  age | lastSeen | clients | tabs | WS`. Primary row highlighted.
- Header shows `cloudflared <version>` + pool `gen N (current)`.
- QR = primary entry URL with userinfo (unchanged flow).
- Enable/Disable semantics unchanged; idle-disabled until enabled.

### 2.6 state file v2
`/tmp/iptunnel-state.json` (0600, atomic writes): `{version:2, primary,
username, password, startedAt, cloudflaredVersion, gens[]}`. Host plugin
adopts exactly like v1 (daemonPid alive → restore). Old v1 files (no `gens`)
adopt as a 1-tunnel pool.

## 3. Constants (proposed, single place in daemon)

| Name | Value | Why |
|---|---|---|
| ROTATE_INTERVAL | 12 h | before any plausible CF long-session reaper; user-chosen |
| MIN_GEN_AGE (rotate guard) | 1 h | no spawn storms |
| MIN_LIFE (before retireable) | 4 h | slow/clients onboarding safety |
| IDLE_WINDOW | 60 min | iOS suspends background tab timers; telemetry gaps expected |
| MAX_LIVE_GENS | 4 | ~8 cloudflareds — bounded resource + CF churn |
| MAX_AGE | 36 h | hard retire; safe because watchdog self-heals (§5.8) |
| PROBE_INTERVAL | 30 s | catches 1033 fast |
| RESTART_AFTER | 2 min | avoid restart loops on transient flaps |
| TELEMETRY/WATCHDOG | 30 s | open-tab chase latency ≤ 30 s |

## 4. Security model deltas (be explicit)

Whitelisted anonymous paths: `/iptunnel/{health,sw.js,sw-config,entry,
watchdog.js,telemetry}`. What an anonymous internet user gains:
- facts that the tunnel exists (health 401) — already visible by loading it;
- hostname lists (sw-config) — already in the QR/bookmark;
- an entry page that redirects to `'/'` (still 401-gated).
- **No password, no harness data, no state.** `state` is NOT whitelisted.
Telemetry accepts anonymous POSTs (small, validated, no storage beyond counts).
Everything else stays behind the Basic gate, unchanged.

## 5. Edge cases (deep analysis)

1. **SW registration on a Basic-auth origin** — browsers (esp. Safari) can
   reject SW on auth challenges. Mitigation: whitelist `sw.js` pre-auth (the
   SW registry fetch carries no Authorization), register with try/catch.
   **Verify first thing in P1 with Playwright on real iOS Safari or Edge.**
2. **SW fetch + cached Basic credentials** — never used: SW only probes
   health/config (whitelisted, no auth) and never re-fetches the harness.
   Real auth stays browser-level.
3. **Gzip/streamed HTML → injection skipped** — open tabs on those pages
   don't chase; navigation still does. Documented, acceptable (dsh serves
   plain HTML locally).
4. **Both tunnels of the current gen die simultaneously** — emergency
   respawn (immediate new gen). Clients on the dead gen: SW probes →
   `cfg.list` contains **older alive gens** (see 5.7) → fall back to the
   previous gen (still alive because usage-based retirement kept it).
   Stranded only if ALL gens are dead.
5. **Gen dies while tabs are open on it** — watchdog health-fails within 30 s
   → reload → chase. Short interruption, self-healing.
6. **A sub-hostname within a live gen dies and is restarted (new hostname)**
   — old SW's cached list is stale but includes siblings/older gens; probe
   skips dead entries. Fine.
7. **Pool never empty invariant** — `cfg.list` always contains, newest→oldest:
   current gen (A,B) → previous active gens, while they're alive. Since
   retirement is usage-based, a previous gen stays alive as long as ANY client
   is using it — so chasing down the list always finds a live target (unless
   all gens are dead).
8. **Forced retirement of an in-use gen (MAX_AGE)** — safe by construction:
   tabs on it get a dead `health` within 30 s → reload → chase. The 30 s
   reload latency is the cost; documented.
9. **iOS suspends background tab timers** — telemetry/`health` pause; the gen
   looks idle. Design says: idle ≠ retire if WS or traffic present; and
   surgical retirement is safe anyway (5.8). When the tab wakes: health fails
   → reload → chase. Zero harm.
10. **Rotation while user is mid-task** — open tab reloads once (eager chase,
    §2.4 trade-off), lands on the newest gen; same dsh web, same session;
    page-level state resets (localStorage keyed per origin — harness state
    lives server-side, only local UI state resets).
11. **Double-enable / adopt race** — enable is idempotent (daemon pid alive →
    adopt); spawn guarded by MIN_GEN_AGE + killPattern reaping on fresh start.
12. **Port exhaustion / metrics port clash** — daemon allocates per spawn,
    checks listeners, falls back to 21000-range on collision.
13. **State file corruption / daemon crash mid-write** — atomic rename; host
    falls back to `phase: disabled` + error (never a half-adopted pool).
14. **Cloudflare churn policy** — 2 registrations per 12 h + bursts on
    restarts; acceptable; log + retry with backoff; if CF throttles, probe
    deads will show; worst case manual scan (surface as `error` in widget).
15. **verify.sh must be pool-aware** — top-level `primary`/`password` kept for
    compat; audit checks: primary answers 401/200; pool size = 2; state
    version; then `disable` (which rotates the pool).
16. **`/tmp` wipe (OS reboot)** — everything dies + state gone → enable →
    gen 1. Unavoidable; the residual one-scan case (documented promise).

## 6. Implementation phases (each independently testable)

- **P0 (verify first, ~30 min):** iOS-Safari SW-on-basic-auth registration &
  SW-302-chase behavior in a Playwright harness with a stub proxy (two fake
  origins, stubbed configs). If SW registration fails on auth origins, the
  fallback design is: register the SW from the **whitelisted entry page only**
  (entry is anonymous, so its SW registration never sees auth).
- **P1 — proxy v2:** whitelist, health/entry/sw.js/sw-config/watchdog.js,
  telemetry, usage accounting, `/_ctl` API, HTML injection (plain HTML only).
- **P2 — daemon pool:** gens, rotation, probes, restart, retirement rules,
  atomic state v2, emergency respawn, adoption.
- **P3 — SW + watchdog:** chase logic, config caching, loop guards;
  watchdog injection + telemetry sender.
- **P4 — widget + verify.sh v2:** pool table, versions, clients/tabs/WS;
  updated audit script.
- **P5 — hardening:** abuse caps on telemetry, log hygiene (no creds),
  failure-history in NOTES, dry-run mode (`DRY=1` probes without spawning).

## 7. Decisions recorded & alternatives

- Eager chase (open tabs migrate at rotation) chosen over death-only chase —
  matches user intent ("redirecting to the latest one in all active
  browsers"); page-level cost: one reload/tab/12 h.
- Usage-based retirement + hard caps (not pure timing) — the "we can dispense
  with it when nobody is on it" requirement, bounded.
- Password policy: keep rotate-per-enable (v1 decision). A stable-password
  mode is a follow-up option (0600 file, rotate on demand) — not in v2 scope.
- Named tunnel / Tailscale remain the "zero-edge-cases" endgame; this plan is
  the quick-tunnel-only realization of the same promise.

## 8. Risks & open questions

1. SW registration on Basic-auth origins (iOS) → P0 goes first (§6).
2. Safari SW eviction on rarely-visited dead origins → rescan; documented,
   bounded by chase depth (each gen's SW is refreshed on every visit).
3. CF churn/rate-limit on 4+ concurrent quick tunnels → observed live;
   retire aggressively keeps count at 3-8.
4. gzip HTML (if dsh ever enables it) breaks injection → skip-safe.
5. Telemetry volume: 1 POST/30 s/tab — trivial; cap stored idents (LRU 1 h).

## 9. Success criteria

- Bookmark/QR remains valid across 3+ dsh web restarts and 2+ 12 h rotations
  with ZERO re-scans (verify via Playwright: navigate with an old-gen URL →
  expect chase landing on current gen).
- Killing one tunnel → clients move to the sibling within ≤ 60 s (watchdog/
  probe) without user action.
- After a rotation + watchdog chase, the old gen shows 0 tabs/0 WS and retires
  within IDLE_WINDOW; `retired` history visible in the widget.
- Audit (`verify.sh`) green; no credentials in any log; state 0600.
