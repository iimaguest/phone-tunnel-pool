// phone-tunnel-pool v2 auth proxy — Basic auth + session cookie + Host rewrite + Origin strip
// + public /iptunnel/* service paths (health, entry, sw.js, sw-config, watchdog.js,
// telemetry) + per-host usage accounting + watchdog HTML injection.
//
// v1 flow (unchanged): first request -> 401 -> browser prompts (Basic) -> proxy
// validates, sets dsh_auth cookie -> later requests (incl. WebSocket handshakes,
// which browsers don't carry Authorization on) pass via the cookie.
//
// v2 additions (pool feature; see PLAN.md):
//  - PUBLIC paths answered BEFORE auth so a service worker can register/fetch
//    them without credentials (browsers don't send Authorization on SW fetches).
//    They expose ONLY hostnames and liveness — no password, no harness data.
//  - /iptunnel/health   -> 200 + CORS *  (401-equivalent "gate alive" for probes)
//  - /iptunnel/entry    -> tiny page: registers the SW, then redirects to /
//  - /iptunnel/sw.js    -> the chase service worker (cache-busted script)
//  - /iptunnel/sw-config-> { primary, gen, list[], ts } + CORS * + no-store
//  - /iptunnel/watchdog.js -> injected open-tab watchdog (chases + telemetry)
//  - /iptunnel/telemetry   -> POST {host, tabId} from open tabs (anonymous)
//  - /iptunnel/__ctl/config + /iptunnel/__ctl/usage -> daemon->proxy control
//    (NOT public; still behind auth; daemon authenticates with the same creds)
//  - usage accounting: per original Host header (the proxy rewrites it, so it
//    sees it): lastSeen, reqCount, live WS sockets, distinct client IPs (XFF),
//    and per-tab telemetry registry.
//  - HTML injection: appends <script src=/iptunnel/watchdog.js> to 200
//    text/html responses with no content-encoding (buffered, <=4MB).
//
// Usage: DSH_PROXY_USER=<u> DSH_PROXY_PASS=<p> node cf-auth-proxy.mjs \
//          <listenHost> <listenPort> <targetHost> <targetPort>
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const [listenHost, listenPortStr, targetHost, targetPortStr] = process.argv.slice(2)
const USER = process.env.DSH_PROXY_USER || 'dsh'
const PASS = process.env.DSH_PROXY_PASS
const COOKIE_NAME = 'dsh_auth'
const TOKEN = crypto.createHash('sha256').update('dsh-tunnel::' + PASS).digest('hex')
const HERE = fileURLToPath(new URL('.', import.meta.url))

if (!PASS) { console.error('DSH_PROXY_PASS is required'); process.exit(1) }

// ---- static assets (self-contained; daemon self-heals the sibling files) ----
function swSrc() {
  try { return readFileSync(HERE + 'iptunnel-sw.js', 'utf8') } catch (e) { return '' }
}
// watchdog served per-request from disk: the daemon refreshes the temp copy
// every maintain() pass, so browser tabs always get the CURRENT watchdog
// without a proxy/daemon restart (9KB file, single-user app — trivial).
function wdSrc() {
  try { return readFileSync(HERE + 'iptunnel-watchdog.js', 'utf8') } catch (e) { return '' }
}
const ENTRY_HTML = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>tunnel entry</title></head><body><script>' +
  'window.__ptAuth=' + JSON.stringify(Buffer.from('dsh:' + PASS).toString('base64')) + ';' +
  'console.log("[iptunnel] entry on " + location.host + " — minting local auth cookie before landing");' +
  '(function(){' +
  'var o=location.origin;' + // origin never carries the QR userinfo -> no credential-URL fetches
  'var go=function(){location.replace(o+"/")};' +
  'fetch(o+"/iptunnel/preauth",{method:"GET",credentials:"include",headers:{authorization:"Basic "+window.__ptAuth}})' +
  '.then(function(r){console.log("[iptunnel] entry preauth self:", r.status); return r.ok})' +
  '.catch(function(e){console.warn("[iptunnel] entry preauth self failed:", e); return false})' +
  '.then(function(){' +
  'if(!("serviceWorker" in navigator)){go();return}' +
  'navigator.serviceWorker.register(o+"/iptunnel/sw.js",{scope:"/"}).then(go,go)' +
  '})})()' +
  '</script><script>var s=document.createElement("script");s.src=location.origin+"/iptunnel/watchdog.js";document.body.appendChild(s)</script></body></html>'

const PUBLIC = new Set([
  '/iptunnel/health', '/iptunnel/sw.js', '/iptunnel/sw-config',
  '/iptunnel/entry', '/iptunnel/watchdog.js', '/iptunnel/telemetry',
  '/iptunnel/preauth'
])
const MAX_HTML = 4 * 1024 * 1024

// ---- pool config (pushed by the daemon via __ctl/config) ----
let poolConfig = { primary: null, gen: 0, list: [] }
// trycloudflare origins that were recently in the pool (rotation keeps 2 gens
// in the config for a short while, but a tab on a RETIRED host still needs to
// mint the sibling's cookie before re-homing: its Origin is no longer in
// poolConfig). Bounded — this is only a CORS-origin check, not auth.
const recentPoolHosts = []
const rememberPoolHost = (host) => {
  if (!host) return
  const h = String(host).toLowerCase()
  if (recentPoolHosts.includes(h)) return
  recentPoolHosts.push(h)
  if (recentPoolHosts.length > 16) recentPoolHosts.shift()
}

// ---- per-host usage accounting ----
// usage[host] = { lastSeen, req, ws, tabs:Map<tabId,ts>, clients:Map<ip,ts> }
// telemetry is unauthenticated, so cap the number of distinct hosts tracked
// (a hostile client must not grow the map without bound).
const usage = new Map()
const MAX_USAGE_HOSTS = 400
const usageGet = (host) => {
  let u = usage.get(host)
  if (!u) {
    if (usage.size >= MAX_USAGE_HOSTS) return null
    u = { lastSeen: 0, req: 0, ws: 0, tabs: new Map(), clients: new Map() }
    usage.set(host, u)
  }
  return u
}
const recordRequest = (req) => {
  const host = (req.headers.host || '').toLowerCase()
  if (!host) return
  const u = usageGet(host)
  if (u === null) return
  u.lastSeen = Date.now()
  u.req++
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['cf-connecting-ip'] || ''
  if (xff) { u.clients.set(xff, Date.now()) }
}
const usageSnapshot = () => {
  const now = Date.now()
  const out = {}
  for (const [host, u] of usage) {
    for (const [k, ts] of [...u.tabs]) if (now - ts > 60000) u.tabs.delete(k)
    for (const [k, ts] of [...u.clients]) if (now - ts > 600000) u.clients.delete(k)
    out[host] = { lastSeen: u.lastSeen, req: u.req, ws: u.ws, tabs: u.tabs.size, clients: u.clients.size }
  }
  return out
}

// ---- helpers ----
const pathOf = (req) => req.url.split('?')[0]
const cookieValue = (req) => {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    if (part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim()
  }
  return ''
}
// constant-time compare (no early exit on prefix match)
const safeEq = (a, b) => {
  const A = Buffer.from(String(a))
  const B = Buffer.from(String(b))
  if (A.length !== B.length) return false
  try { return crypto.timingSafeEqual(A, B) } catch { return false }
}
const authorized = (req) => {
  if (safeEq(cookieValue(req), TOKEN)) return true
  const h = req.headers.authorization || ''
  if (!h.startsWith('Basic ')) return false
  const decoded = Buffer.from(h.slice(6), 'base64').toString()
  const i = decoded.indexOf(':')
  if (i === -1) return false
  return safeEq(decoded.slice(0, i), USER) && safeEq(decoded.slice(i + 1), PASS)
}
// per-IP auth-failure throttle: 20 failures/60s -> 429 for 30s (a legit phone
// authenticates a handful of times; this only trips on brute-force attempts)
// cloudflared always connects from 127.0.0.1, so the ONLY trustworthy per-IP
// key for tunnel traffic is CF-Connecting-IP, forwarded by the Cloudflare
// edge; when the header is absent (direct/local callers) we fall back to the
// socket address rather than exempting them altogether.
const failStats = new Map()
const clientIp = (req) => {
  const ip = req.headers['cf-connecting-ip']
  if (typeof ip === 'string' && ip !== '') return ip
  // tunnel traffic always carries CF-Connecting-IP; the fallback covers
  // callers that reach the proxy directly (local use) — they still get
  // throttled instead of being exempt.
  return String((req.socket && req.socket.remoteAddress) || '?')
}
const authLocked = (req) => {
  const key = clientIp(req)
  const f = failStats.get(key)
  return f !== undefined && f.lockedUntil > Date.now()
}
const rememberFail = (req) => {
  const key = clientIp(req)
  const now = Date.now()
  const f = failStats.get(key)
  if (f === undefined || f.windowUntil < now) {
    failStats.set(key, { n: 1, windowUntil: now + 60000, lockedUntil: 0 })
  } else {
    f.n++
    if (f.n >= 20) { f.lockedUntil = now + 30000; f.n = 0 }
  }
  if (failStats.size > 500) for (const [k, v] of [...failStats]) if (v.windowUntil + 600000 < now) failStats.delete(k)
}
const COOKIE_ATTRS = 'Path=/; SameSite=Lax; HttpOnly; Secure' // tunnel is always HTTPS
const withCookie = (headers) => {
  // append the tunnel cookie WITHOUT dropping any cookie the origin sets
  // (dsh web's own session/CSRF cookie must survive the proxy)
  const out = { ...headers }
  const ours = `${COOKIE_NAME}=${TOKEN}; ${COOKIE_ATTRS}`
  const prev = out['set-cookie']
  if (Array.isArray(prev)) out['set-cookie'] = [...prev, ours]
  else if (typeof prev === 'string' && prev !== '') out['set-cookie'] = [prev, ours]
  else out['set-cookie'] = ours
  return out
}
const rewriteHeaders = (headers) => {
  const out = { ...headers }
  out.host = `${targetHost}:${targetPortStr}`
  delete out.origin
  delete out.referer
  delete out['referrer']
  delete out['proxy-connection']
  // never ask the origin to compress HTML: the watchdog needs the raw body to
  // inject into it (isInjectable skips encoded responses -> inconsistent SW
  // registration; CF edge re-compresses on the way out anyway)
  out['accept-encoding'] = 'identity'
  return out
}
const send = (res, status, headers, body) => {
  res.writeHead(status, headers)
  res.end(body)
}
const deny = (res) => send(res, 401, {
  'WWW-Authenticate': 'Basic realm="dsh tunnel", charset="UTF-8"',
  'content-type': 'text/plain; charset=utf-8'
}, 'authentication required')
const rejectAuth = (req, res) => {
  if (authLocked(req)) return send(res, 429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '30' }, 'too many failed attempts — try again shortly')
  rememberFail(req)
  return deny(res)
}
const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
const isInjectable = (pres) => {
  // only plain (uncompressed) html, and only when we can buffer it fully
  if (!(pres.headers['content-type'] || '').startsWith('text/html')) return false
  if (pres.headers['content-encoding']) return false
  const cl = Number(pres.headers['content-length'] || 0)
  return cl === 0 || cl <= MAX_HTML
}

// ---- public handlers ----
const handlePublic = (req, res) => {
  const path = pathOf(req)
  if (path === '/iptunnel/health') return send(res, 200, { ...cors, 'content-type': 'text/plain' }, 'ok')
  if (path === '/iptunnel/sw-config') return send(res, 200, { ...cors, 'content-type': 'application/json' }, JSON.stringify(poolConfig))
  if (path === '/iptunnel/sw.js') return send(res, 200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache', 'service-worker-allowed': '/' }, swSrc())
  if (path === '/iptunnel/watchdog.js') return send(res, 200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }, wdSrc())
  if (path === '/iptunnel/entry') return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, ENTRY_HTML)
  if (path === '/iptunnel/telemetry') {
    let body = ''
    req.on('data', (d) => { body += d.slice(0, 4096) })
    req.on('end', () => {
      try {
        const j = JSON.parse(body)
        const host = String(j.host || '').toLowerCase()
        // ignore hosts that are not part of the live pool (unauthenticated
        // endpoint: random hosts must not pollute the usage map)
        const known = host !== '' && (String(poolConfig.primary || '').toLowerCase() === host || (poolConfig.list || []).some(function (x) { return String(x).toLowerCase() === host }))
        if (known) {
          const u = usageGet(host)
          if (u !== null) {
            const now = Date.now()
            if (u.tabs.size > 200) for (const [k, ts] of [...u.tabs]) if (now - ts > 60000) u.tabs.delete(k)
            u.tabs.set(String(j.tabId || 'x'), now)
            u.lastSeen = now
          }
        }
      } catch { /* ignore junk */ }
      send(res, 204, { ...cors }, '')
    })
    return
  }
  // Cross-origin credential handoff: the watchdog on an authenticated page
  // fetches this WITHOUT a cookie (fresh origin has none) but WITH the
  // Authorization header the proxy injected into that page; a valid header
  // mints the dsh_auth cookie for the TARGET origin before the tab navigates
  // there, so migrations-by-redirect never trigger Safari's auth prompt.
  // OPTIONS carries no Authorization and must not 401 (CORS preflight).
  if (path === '/iptunnel/preauth') {
    // only the pool's own origins may participate (a random web page cannot
    // use the user's tunnel as a CORS oracle); no Origin = non-browser caller.
    const allowOrigin = req.headers.origin || '*'
    if (req.headers.origin) {
      const hostOf = (o) => o.replace(/^https?:\/\//, '').replace(/:\d+$/, '').toLowerCase()
      const poolHosts = new Set([...(poolConfig.list || []), poolConfig.primary].filter(Boolean).map(hostOf))
      const self = hostOf(req.headers.host || '')
      const o = hostOf(req.headers.origin)
      if (!poolHosts.has(o) && o !== self && !recentPoolHosts.includes(o)) {
        return send(res, 403, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': 'null' }, 'origin not allowed')
      }
    }
    const pc = {
      'access-control-allow-origin': allowOrigin,
      // credentials are only meaningful when reflecting a specific origin;
      // with a wildcard allow-origin a browser would reject it anyway
      ...(allowOrigin === '*' ? {} : { 'access-control-allow-credentials': 'true' }),
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      'cache-control': 'no-store'
    }
    if (req.method === 'OPTIONS') return send(res, 204, pc, '')
    if (!authorized(req)) return rejectAuth(req, res)
    return send(res, 200, { ...pc, 'set-cookie': `${COOKIE_NAME}=${TOKEN}; ${COOKIE_ATTRS}` }, 'ok')
  }
  return deny(res)
}

// ---- _ctl (daemon control; auth required like everything else) ----
const handleCtl = (req, res) => {
  const path = pathOf(req)
  if (path === '/iptunnel/__ctl/config' && req.method === 'POST') {
    let body = ''
    req.on('data', (d) => { body += d.slice(0, 65536) })
    req.on('end', () => {
      try {
        const j = JSON.parse(body)
        if (typeof j.primary === 'string' && Array.isArray(j.list)) {
          poolConfig = { primary: j.primary, gen: Number(j.gen) || 0, list: j.list.map(String), ts: Date.now() }
          rememberPoolHost(poolConfig.primary)
          poolConfig.list.forEach(rememberPoolHost)
          send(res, 200, { 'content-type': 'application/json' }, '{"ok":true}')
          console.log(`[iptunnel] config: gen=${poolConfig.gen} primary=${poolConfig.primary} list=${poolConfig.list.length}`)
          return
        }
      } catch { /* fall through */ }
      send(res, 400, { 'content-type': 'application/json' }, '{"ok":false}')
    })
    return
  }
  if (path === '/iptunnel/__ctl/usage') {
    return send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(usageSnapshot()))
  }
  return send(res, 404, { 'content-type': 'text/plain' }, 'not found')
}

// ---- forward (authed) with optional watchdog injection ----
const forward = (req, res) => {
  recordRequest(req)
  const headers = rewriteHeaders(req.headers)
  const preq = http.request({
    host: targetHost, port: Number(targetPortStr), method: req.method, path: req.url, headers
  }, (pres) => {
    const doInject = pres.statusCode === 200 && isInjectable(pres)
    const outHeaders = withCookie(pres.headers)
    if (!doInject) {
      res.writeHead(pres.statusCode ?? 502, outHeaders)
      pres.pipe(res)
      return
    }
    const chunks = []
    let total = 0
    pres.on('data', (d) => {
      chunks.push(d)
      total += d.length
      if (total > MAX_HTML) { // overflow: bail to passthrough
        res.writeHead(pres.statusCode ?? 502, outHeaders)
        for (const c of chunks) res.write(c)
        pres.pipe(res)
      }
    })
    pres.on('end', () => {
      let html = Buffer.concat(chunks).toString('utf8')
      // authenticated HTML only: hand the injected watchdog its credentials so
      // it can pre-authenticate migration targets (see /iptunnel/preauth)
      const creds = '<script>window.__ptAuth="' + Buffer.from(USER + ':' + PASS).toString('base64') + '"</script>'
      const tag = '<script src="/iptunnel/watchdog.js"></script>'
      html = html.includes('</body>') ? html.replace('</body>', creds + tag + '</body>') : html + creds + tag
      const buf = Buffer.from(html)
      const h = { ...outHeaders }
      delete h['content-length']
      delete h['transfer-encoding']
      res.writeHead(200, h)
      res.end(buf)
    })
    pres.on('error', () => { try { res.destroy() } catch { /* */ } })
  })
  preq.on('error', (err) => {
    try { send(res, 502, { 'content-type': 'text/plain; charset=utf-8' }, 'proxy error: ' + err.message) } catch { /* */ }
  })
  req.pipe(preq)
}

const server = http.createServer((req, res) => {
  const path = pathOf(req)
  // public service paths answered pre-auth; probe/tooling traffic is NOT
  // counted as client usage (the daemon probes the same paths every 30s)
  if (PUBLIC.has(path)) return handlePublic(req, res)
  if (path.startsWith('/iptunnel/__ctl')) {
    if (!authorized(req)) return rejectAuth(req, res)
    return handleCtl(req, res)
  }
  if (!authorized(req)) return rejectAuth(req, res)
  forward(req, res)
})

server.on('upgrade', (req, socket, head) => {
  const host = (req.headers.host || '').toLowerCase()
  if (!authorized(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="dsh tunnel", charset="UTF-8"\r\ncontent-length: 0\r\n\r\n')
    socket.destroy()
    return
  }
  recordRequest(req)
  const headers = rewriteHeaders(req.headers)
  const upstream = net.connect(Number(targetPortStr), targetHost)
  upstream.on('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) lines.push(`${k}: ${v}`)
    lines.push('', '')
    upstream.write(lines.join('\r\n'))
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
    const u = usageGet(host)
    if (u !== null) {
      u.ws++
      socket.on('close', () => { if (u.ws > 0) u.ws-- })
    }
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(Number(listenPortStr), listenHost, () => {
  console.log(`auth proxy listening on http://${listenHost}:${listenPortStr} -> http://${targetHost}:${targetPortStr}`)
})
