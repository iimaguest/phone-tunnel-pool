// phone-tunnel-pool chase service worker (v2)
// Registered on EVERY tunnel origin it visits. Its only job: intercept
// navigations to /iptunnel/entry and point the browser at the current pool
// primary (or, if that's gone, the first live origin from the known list).
// Everything else passes through untouched, and it never touches credentials:
// it only fetches /iptunnel/health (public, no auth) and /iptunnel/sw-config
// (public JSON). Configuration is cached in the Cache API so the chase keeps
// working from a DEAD origin (that's what makes a stale bookmark survive).
//
// Behavior (see PLAN.md §2.3):
//   0. primary != self and primary alive      -> redirect to primary
//      (migration while alive IS intended — chase the newest; the watchdog
//      pre-authenticated the target, so the landing carries the auth cookie)
//   1. self alive                             -> redirect to "/" (normal load, browser auth)
//   2. self dead                              -> redirect to first alive in list
//   3. nothing alive                          -> fetch(event.request) (1033; no loops)

const CONFIG_PATH = '/iptunnel/sw-config'
const CACHE = 'iptunnel-sw-v2'
const HEALTH = '/iptunnel/health'
// CRITICAL: all own-origin URLs are built from location.origin, never
// relative. The QR opens the tunnel as https://user:pass@host/ and the SW's
// own script URL could carry that userinfo; a relative fetch would resolve
// against it and Chromium rejects "a URL that includes credentials".
const ownOrigin = location.origin
const CFG_KEY = ownOrigin + CONFIG_PATH

async function fetchConfig() {
  try {
    const r = await fetch(ownOrigin + CONFIG_PATH, { cache: 'no-store' })
    if (r.ok) {
      const c = await r.json()
      try {
        const cache = await caches.open(CACHE)
        await cache.put(CFG_KEY, new Response(JSON.stringify(c), { headers: { 'content-type': 'application/json' } }))
      } catch (e) { /* cache full / disallowed: still usable */ }
      return c
    }
  } catch (e) { /* origin dead */ }
  try {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(CFG_KEY)
    if (hit) return await hit.json()
  } catch (e) { /* no cache */ }
  return null
}

async function probe(origin) {
  try {
    const r = await fetch(origin + HEALTH, { mode: 'cors', cache: 'no-store' })
    return r.status > 0 && r.status < 500
  } catch (e) { return false }
}

// Pre-warm the pool config at INSTALL: registration happens while the origin
// is alive (entry page / watchdog), and this snapshot is what lets a DEAD
// origin keep chasing afterwards (the 1033 failure mode without it).
async function warmConfig() {
  try {
    const r = await fetch(ownOrigin + CONFIG_PATH, { cache: 'no-store' })
    if (!r.ok) return
    const c = await r.json()
    const cache = await caches.open(CACHE)
    await cache.put(CFG_KEY, new Response(JSON.stringify(c), { headers: { 'content-type': 'application/json' } }))
  } catch (e) { /* origin already dead; nothing to warm */ }
}

self.addEventListener('install', (ev) => { ev.waitUntil(warmConfig()); self.skipWaiting() })

self.addEventListener('fetch', (ev) => {
  const req = ev.request
  const u = new URL(req.url)
  if (req.mode !== 'navigate' || u.pathname !== '/iptunnel/entry') return
  ev.respondWith((async () => {
    const me = u.origin
    const cfg = await fetchConfig()
    // 0. migration while alive is INTENTIONAL (chase the newest): the watchdog
    //    pre-authenticated the target via /iptunnel/preauth, so we land with
    //    the dsh_auth cookie — no 401, no "Authentication required" prompt
    if (cfg && cfg.primary && cfg.primary !== me && (await probe(cfg.primary))) {
      return Response.redirect(cfg.primary + '/iptunnel/entry')
    }
    // 1. self is the current origin -> same-origin "/" (browser auth flow)
    if (await probe(me)) return Response.redirect(me + '/')
    // 2. self dead -> first live sibling
    if (cfg) {
      for (const o of cfg.list || []) {
        if (o === me) continue
        if (await probe(o)) return Response.redirect(o + '/iptunnel/entry')
      }
    }
    // 3. nothing alive -> pass through (1033; no loops)
    return fetch(req)
  })())
})

self.addEventListener('activate', (ev) => { ev.waitUntil(self.clients.claim()) })
