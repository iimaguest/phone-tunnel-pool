// phone-tunnel-pool watchdog (v5) — injected into harness HTML by the proxy.
// Keeps OPEN tabs chasing the newest live pool AND avoids auth prompts:
//  - registers the chase SW if this page's origin doesn't have it yet
//  - every 30s: health-probes own origin; fetches pool config; when the
//    primary moved (migration while alive is INTENTIONAL: chase the newest),
//    PRE-AUTHENTICATES the target via /iptunnel/preauth with window.__ptAuth
//    (injected only into authenticated pages by the proxy) and only then
//    navigates to /iptunnel/entry — the target mints its dsh_auth cookie,
//    the navigation arrives authenticated, no 401, no "Authentication
//    required" prompt.
//  - keeps the SW's pool-config cache warm (same-origin CacheStorage)
//  - pagehide -> telemetry so the daemon sees tabs leave promptly
// Chasing ALWAYS goes through /iptunnel/entry so the SW stays in charge and
// intermediates register themselves on the way (see PLAN.md §2.4).
//
// CRITICAL: all URLs are built from location.origin, never relative paths.
// The QR opens the tunnel as https://user:pass@host/ — a relative fetch
// resolves against that credential-bearing URL and Chromium rejects it
// ("Request cannot be constructed from a URL that includes credentials").
// That single rejection made the health check fail on EVERY phone tick —
// spurious re-home, reload loop, and the credential-less SW redirect that
// finally surfaced as the :443 username/password prompt.
(function () {
  if (!('serviceWorker' in navigator)) return
  var here = location.origin
  var tabId = Math.random().toString(36).slice(2)
  var cred = (typeof window.__ptAuth === 'string' && window.__ptAuth) ? window.__ptAuth : null
  var healthUrl = here + '/iptunnel/health'
  var cfgUrl = here + '/iptunnel/sw-config'
  var entryUrl = here + '/iptunnel/entry'
  console.log('[iptunnel] watchdog v5 on ' + location.host + ' cred=' + (cred ? 'yes' : 'NO'))
  navigator.serviceWorker.register(here + '/iptunnel/sw.js', { scope: '/' }).catch(function (e) { console.warn('[iptunnel] sw register failed:', e) })
  function tele(type) {
    try {
      navigator.sendBeacon(here + '/iptunnel/telemetry', new Blob([JSON.stringify({ host: location.host, tabId: tabId, type: type })], { type: 'application/json' }))
    } catch (e) { /* ignore */ }
  }
  // cross-origin handoff: mint the target's auth cookie before we land on it
  function preauth(target) {
    if (!cred) return Promise.resolve(false)
    return fetch(target + '/iptunnel/preauth', {
      method: 'GET', credentials: 'include',
      headers: { authorization: 'Basic ' + cred }
    }).then(function (r) {
      console.log('[iptunnel] preauth ' + target + ' ->', r.status)
      return r.ok
    }).catch(function (e) {
      console.warn('[iptunnel] preauth ' + target + ' failed:', e)
      return false
    })
  }
  // mint the cookie on EVERY pool hostname (dsh_auth is host-only — each
  // trycloudflare origin stores its own copy). Keeping the whole pool warm
  // means any redirect chosen by the chase SW (moved primary OR dead-self
  // sibling) lands authenticated: no 401, no "Authentication required".
  // Returns a promise; navigations MUST await it (a navigation aborts
  // in-flight fetches — racing it is exactly how the :443 prompt returned).
  var lastCfg = null
  function preauthAll(cfg) {
    if (!cred || !cfg) return Promise.resolve()
    var jobs = []
    var seen = {}
    ;[cfg.primary].concat(cfg.list || []).forEach(function (h) {
      if (!h || typeof h !== 'string') return
      var target = h.indexOf('http') === 0 ? h : 'https://' + h
      target = target.replace(/\/$/, '')
      if (seen[target] || target === here) return
      seen[target] = 1
      jobs.push(preauth(target))
    })
    console.log('[iptunnel] preauthAll: minting ' + jobs.length + ' host(s), primary=' + cfg.primary)
    return Promise.all(jobs.map(function (p) { return p.catch(function () {}) }))
  }
  // never let a slow preauth strand the tab: cap the wait at 8s
  function settle(p) {
    return Promise.race([p, new Promise(function (res) { setTimeout(res, 8000) })])
  }
  tele('load')
  window.addEventListener('pagehide', function () { tele('hide') })
  // battery back-off: while nothing changes, stretch the tick 30s -> 45s ->
  // 60s -> 90s -> 150s -> 225s -> 300s (radio wake-ups cost on a phone; reset on any event)
  var tickMs = 30000
  var timer = null
  function schedule() {
    clearInterval(timer)
    timer = setInterval(tick, tickMs)
  }
  function backOff() {
    tickMs = Math.min(300000, Math.round((tickMs || 30000) * 1.5))
    schedule()
  }
  // 2-strike health grace: a single transient 530 must NOT re-home the tab
  // (the re-home on a still-alive host is a full page reload — users see a
  // self-refresh out of nowhere; only a genuinely dead host moves us).
  var healthFails = 0
  function rehome(why) {
    console.warn('[iptunnel] ' + why + ' on ' + location.host + ' (' + healthFails + '/2)')
    tickMs = 30000
    if (healthFails < 2) return
    healthFails = 0
    settle(preauthAll(lastCfg)).then(function () { location.replace(entryUrl) })
  }
  function tick() {
    tele('tick')
    console.log('[iptunnel] tick on ' + location.host + ' tickMs=' + tickMs)
    fetch(healthUrl, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) { // self dead -> re-home (mint first, then navigate)
        healthFails += 1
        rehome('health ' + r.status)
        return
      }
      healthFails = 0
      fetch(cfgUrl, { cache: 'no-store' }).then(function (r2) { return r2.json() }).then(function (c) {
        lastCfg = c
        try {
          caches.open('iptunnel-sw-v2').then(function (cache) {
            cache.put(here + '/iptunnel/sw-config', new Response(JSON.stringify(c), { headers: { 'content-type': 'application/json' } }))
          })
        } catch (e) { /* cache unavailable */ }
        if (c && c.primary && c.primary !== here) {
          console.log('[iptunnel] primary moved ' + here + ' -> ' + c.primary + ' — minting then chasing')
          tickMs = 30000
          settle(preauthAll(c)).then(function () { location.replace(entryUrl) })
          return
        }
        settle(preauthAll(c))
        backOff()
      }).catch(function () { backOff() })
    }).catch(function () {
      healthFails += 1
      rehome('health fetch failed')
    })
  }
  schedule()
})()
