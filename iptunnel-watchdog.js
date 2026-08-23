// phone-tunnel-pool watchdog (v3) — injected into harness HTML by the proxy.
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
(function () {
  if (!('serviceWorker' in navigator)) return
  var here = location.origin
  var tabId = Math.random().toString(36).slice(2)
  var cred = (typeof window.__ptAuth === 'string' && window.__ptAuth) ? window.__ptAuth : null
  navigator.serviceWorker.register('/iptunnel/sw.js', { scope: '/' }).catch(function () {})
  function tele(type) {
    try {
      navigator.sendBeacon('/iptunnel/telemetry', new Blob([JSON.stringify({ host: location.host, tabId: tabId, type: type })], { type: 'application/json' }))
    } catch (e) { /* ignore */ }
  }
  // cross-origin handoff: mint the target's auth cookie before we land on it
  function preauth(target) {
    if (!cred) return Promise.resolve(false)
    return fetch(target + '/iptunnel/preauth', {
      method: 'GET', credentials: 'include',
      headers: { authorization: 'Basic ' + cred }
    }).then(function (r) { return r.ok }).catch(function () { return false })
  }
  tele('load')
  window.addEventListener('pagehide', function () { tele('hide') })
  setInterval(function () {
    tele('tick')
    fetch('/iptunnel/health', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) { location.replace('/iptunnel/entry'); return } // self dead -> re-home
      fetch('/iptunnel/sw-config', { cache: 'no-store' }).then(function (r2) { return r2.json() }).then(function (c) {
        try {
          caches.open('iptunnel-sw-v2').then(function (cache) {
            cache.put('/iptunnel/sw-config', new Response(JSON.stringify(c), { headers: { 'content-type': 'application/json' } }))
          })
        } catch (e) { /* cache unavailable */ }
        if (c && c.primary && c.primary !== here) {
          preauth(c.primary).then(function () { location.replace('/iptunnel/entry') })
          return
        }
      }).catch(function () {})
    }).catch(function () { location.replace('/iptunnel/entry') })
  }, 30000)
})()
