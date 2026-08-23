// phone-tunnel-pool v2 daemon — DETACHED pool manager for the tunnel chain.
//
// Owns ONE auth proxy (all generations share it) + 2 cloudflareds per
// generation + caffeinate. Survives dsh web restarts (spawned detached,
// unref'd by lib/index.js; the plugin adopts via /tmp/iptunnel-state.json).
//
// See PLAN.md for the full design. Highlights:
//  - generations rotated every DSH_ROTATE_MS (default 12h): a fresh gen
//    (A,B) is spawned; older gens stay alive while in use and are retired
//    when idle (tabs==0 && ws==0 && lastSeen older than DSH_IDLE_MS) or at
//    hard caps (DSH_MAX_AGE_MS / DSH_MAX_GENS) — retirement is always safe
//    because open tabs chase away within 30s (watchdog reload).
//  - every tunnel is health-probed through its OWN public URL every
//    DSH_PROBE_MS; dead ones are respawned after DSH_RESTART_AFTER_MS (new
//    hostname — quick-tunnel hostnames are per-process).
//  - the proxy receives a fresh pool config (primary + origins list, newest
//    first) on every change, which is what the chase service worker reads.
//  - usage accounting (tabs/WS/clients per hostname) is pulled from the proxy
//    and merged into the state file so the widget can show the pool.
//
// State: /tmp/iptunnel-state.json (0600, atomic). Log: /tmp/iptunnel-daemon.log.
// Password arrives ONLY via DSH_PROXY_PASS env (never argv).
// env overrides (for tests): DSH_ROTATE_MS DSH_MIN_LIFE_MS DSH_IDLE_MS
//   DSH_MAX_AGE_MS DSH_MAX_GENS DSH_PROBE_MS DSH_RESTART_AFTER_MS

import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, writeFileSync, chmodSync, rmSync, appendFileSync, renameSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('..', import.meta.url)) // bundle root (daemon lives in lib/)
const TMP = process.env.DSH_TMP || tmpdir() // per-OS temp dir (macOS/Linux/Windows)
const PROXY = TMP + '/cf-auth-proxy.mjs'
const CLOUDFLARED = process.env.DSH_CLOUDFLARED || 'cloudflared'
// cloudflared never needs the tunnel credentials — keep them out of its
// environment (visible to same-user processes via /proc/<pid>/environ).
const CLOUDFLARED_ENV = { ...process.env }
delete CLOUDFLARED_ENV.DSH_PROXY_PASS
delete CLOUDFLARED_ENV.DSH_PROXY_USER
const USER = process.env.DSH_PROXY_USER || 'dsh'
const PASS = process.env.DSH_PROXY_PASS || ''
const PROXY_PORT = process.env.DSH_PROXY_PORT || '3090'
const TARGET_PORT = process.env.DSH_TARGET_PORT || '3080'
const STORE = process.env.DSH_STORE || TMP + '/iptunnel-state.json'
const LOG = process.env.DSH_LOG || TMP + '/iptunnel-daemon.log'
const MS = { h: 3600000, m: 60000, s: 1000 }
const CF = {
  PROBE: Number(process.env.DSH_PROBE_MS || 30 * MS.s),
  ROTATE: Number(process.env.DSH_ROTATE_MS || 12 * MS.h),
  MIN_LIFE: Number(process.env.DSH_MIN_LIFE_MS || 4 * MS.h),
  IDLE: Number(process.env.DSH_IDLE_MS || 60 * MS.m),
  MAX_AGE: Number(process.env.DSH_MAX_AGE_MS || 36 * MS.h),
  MAX_GENS: Number(process.env.DSH_MAX_GENS || 4),
  RESTART_AFTER: Number(process.env.DSH_RESTART_AFTER_MS || 2 * MS.m),
  GRACE: 5 * MS.s,
  EMERGENCY_GAP: 60 * MS.s,
}

const now = () => Date.now()
const log = (msg) => {
  try {
    appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n')
    // keep the log bounded: if it grows past 512KB, keep the last 128KB
    try {
      const st = statSync(LOG)
      if (st.size > 512 * 1024) writeFileSync(LOG, readFileSync(LOG, 'utf8').slice(-128 * 1024))
    } catch (e) {}
  } catch (e) {}
}
if (PASS === '') { log('DSH_PROXY_PASS missing — refusing to start'); process.exit(1) }

// ------------------------------------------------ mutable pool state
const state = {
  version: 2, phase: 'enabled', url: null, username: USER, password: PASS,
  startedAt: now(), daemonPid: process.pid,
  cloudflaredVersion: 'unknown', gen: 0, nextGen: 1,
  gens: [], usage: {}, primary: null,
}
let stopping = false
let lastEmergency = 0
let nextMetricsPort = Number(process.env.DSH_METRICS_BASE || 21000) // high base: v1 used 20241
let awake = null
let proxy = null

// ------------------------------------------------ persistence
const save = (why) => {
  try {
    // project a slim copy: never serialize ChildProcess handles (tunnels'
    // `proc` carries spawn internals; only pid/metrics belong on disk)
    const slim = {
      ...state,
      gens: state.gens.map((g) => ({
        ...g,
        tunnels: g.tunnels.map((t) => { const o = { ...t }; delete o.proc; return o })
      }))
    }
    const tmp = STORE + '.tmp'
    writeFileSync(tmp, JSON.stringify(slim), { mode: 0o600 })
    renameSync(tmp, STORE)
    chmodSync(STORE, 0o600)
    log('state saved (' + why + ') primary=' + (state.primary || '-'))
  } catch (e) { log('state save FAILED: ' + e.message) }
}
const tunnelHosts = (genObj) => genObj.tunnels.map((t) => t.host).filter(Boolean)
const anyLive = (genObj) => genObj.tunnels.some((t) => t.url && t.deadSince === null)
const liveGens = () => state.gens.filter((g) => g.status !== 'retired')

// Hard-fatal path: persist a readable error INTO the state store (instead of
// deleting it) so the widget shows why the pool could not come up, then exit.
const fatal = (msg) => {
  log('FATAL: ' + msg)
  try { for (const h of allProc()) { if (h.exitCode === null) { try { h.kill('SIGTERM') } catch (e) {} } } } catch (e) {}
  try {
    state.phase = 'error'
    state.error = msg
    state.url = null
    save('fatal')
  } catch (e) { log('could not persist error state: ' + e.message) }
  process.exit(1)
}

// pick a genuinely free loopback port (a just-killed cloudflared can still
// hold its metrics listener for a few seconds -> avoid boot respawn churn)
const freePort = async (start) => {
  for (let p = start; p < start + 500; p++) {
    const ok = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (ok) return p
  }
  return start
}

// ------------------------------------------------ cloudflared subprocesses
// flags are built against the ACTUAL cloudflared version: old builds
// (apt/dnf packages, legacy Docker images) reject newer flags and exit,
// and unknown means conservative = max compatibility.
const tunnelArgs = (metricsPort) => {
  const a = ['tunnel', '--url', 'http://127.0.0.1:' + PROXY_PORT]
  if (cfGte(2022, 5)) a.push('--no-autoupdate', '--no-prechecks')
  if (cfGte(2022, 6)) a.push('--edge-ip-version', '4')
  if (cfGte(2022, 7)) a.push('--grace-period', '5s')
  // post-quantum handshake costs CPU per connection — opt-in (DSH_PQ=1)
  if (process.env.DSH_PQ === '1' && cfGte(2024, 6)) a.push('--post-quantum')
  if (cfGte(2024, 8)) a.push('--management-diagnostics=false')
  a.push('--metrics', '127.0.0.1:' + metricsPort, '--loglevel', 'info', '--transport-loglevel', 'error')
  return a
}
const spawnTunnel = async (genObj, id, replace) => {
  const port = await freePort(nextMetricsPort++)
  const t = replace || { proc: null }
  for (const k of ['url', 'host', 'pid', 'healthy', 'lastAlive', 'lastProbe', 'deadSince', 'fails']) t[k] = k === 'healthy' ? false : null
  t.id = id
  t.metricsPort = port
  if (!replace) genObj.tunnels.push(t)
  let proc
  try {
    proc = spawn(CLOUDFLARED, tunnelArgs(port), { stdio: ['ignore', 'pipe', 'pipe'], env: CLOUDFLARED_ENV })
  } catch (e) {
    if (e.code === 'ENOENT') fatal('cloudflared binary not found — install it (brew install cloudflared) or set DSH_CLOUDFLARED')
    log('gen' + genObj.gen + '/' + id + ' spawn FAILED: ' + e.message); return t
  }
  t.proc = proc
  t.proc.on('error', (e) => {
    const msg = e.code === 'ENOENT'
      ? 'cloudflared binary not found — install it (brew install cloudflared) or set DSH_CLOUDFLARED'
      : 'cloudflared spawn error: ' + e.message
    log(msg)
    if (!stopping) fatal(msg)
  })
  t.pid = proc.pid
  let buf = ''
  const onData = (d) => {
    buf = (buf + d).slice(-262144)
    if (!t.url) {
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (m) {
        t.url = m[0].replace(/\/+$/, '')
        t.host = t.url.replace('https://', '')
        t.healthy = true
        t.deadSince = null
        t.lastAlive = now()
        t.mintFails = 0
        t.nextTry = null
        log('gen' + genObj.gen + '/' + id + ' registered: ' + t.url)
        save('url')
        pushConfig()
      }
    }
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  proc.on('exit', (code) => {
    if (stopping) return
    t.healthy = false
    if (t.deadSince === null) t.deadSince = now()
    t.pid = null
    if (!t.url) {
      // mint failure (typ. Cloudflare quick-tunnel 429/1015 quota): back off
      // exponentially before the next attempt instead of hammering the API
      t.mintFails = (t.mintFails || 0) + 1
      t.nextTry = now() + Math.min(30000 * Math.pow(2, Math.min(t.mintFails, 4)), 480000)
      if (t.mintFails >= 2) log('gen' + genObj.gen + '/' + id + ' mint failed x' + t.mintFails + ' (quota?) next-try in ' + Math.round((t.nextTry - now()) / 1000) + 's')
    }
    log('gen' + genObj.gen + '/' + id + ' exited code=' + String(code) + ' url=' + (t.url || '-'))
    save('exit')
    pushConfig() // drop the dead tunnel from the pool config NOW (chase + primary)
  })
  log('gen' + genObj.gen + '/' + id + ' spawned pid=' + String(proc.pid) + ' metrics=' + port)
  return t
}

const spawnGen = async (why) => {
  const genObj = { gen: state.nextGen++, spawnedAt: now(), status: 'current', tunnels: [] }
  state.gens.push(genObj)
  state.gen = genObj.gen
  for (const g of state.gens) if (g.gen !== genObj.gen && g.status === 'current') g.status = 'active'
  log('spawnGen(' + why + ') -> gen ' + genObj.gen)
  await Promise.all([spawnTunnel(genObj, 'A'), spawnTunnel(genObj, 'B')])
  save('spawn')
  pushConfig()
}

// ------------------------------------------------ proxy control + usage
const ctl = (path, method, body) => {
  return fetch('http://127.0.0.1:' + PROXY_PORT + path, {
    method: method || 'GET',
    headers: { 'authorization': 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64'), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null)
}
const liveOrigins = () => {
  const out = []
  for (const g of [...state.gens].sort((a, b) => b.gen - a.gen))
    for (const t of g.tunnels)
      if (t.url && t.deadSince === null) out.push(t.url)
  return out
}
const pushConfig = () => {
  const list = liveOrigins()
  const primary = list[0] || state.primary
  state.primary = primary
  state.url = primary || state.url // v1-compat: host enable() waits for url
  ctl('/iptunnel/__ctl/config', 'POST', { primary: primary || '', gen: state.gen, list })
}
const refreshUsage = () => {
  ctl('/iptunnel/__ctl/usage').then(async (r) => {
    if (!r) return
    const j = await r.json().catch(() => null)
    if (j) { state.usage = j; save('usage') }
  })
}

// ------------------------------------------------ health probes
const probeOne = async (g, t) => {
  if (!t.url) return // still registering
  t.lastProbe = now()
  let ok = false
  try {
    const r = await fetch(t.url + '/iptunnel/health', { signal: AbortSignal.timeout(8000) })
    ok = r.status > 0 && r.status < 500
  } catch (e) { ok = false }
  t.healthy = ok
  t.lastProbe = now()
  // grace: one failed probe (fresh registration / DNS propagation) is NOT
  // death — declare dead only after 2 consecutive failures, recover anytime
  let changed = false
  if (ok) {
    t.lastAlive = now()
    t.fails = 0
    if (t.deadSince !== null) { t.deadSince = null; changed = true; log('gen' + g.gen + '/' + t.id + ' recovered') }
  } else {
    t.fails = (t.fails || 0) + 1
    if (t.fails >= 2 && t.deadSince === null) {
      t.deadSince = now(); changed = true; log('gen' + g.gen + '/' + t.id + ' UNREACHABLE')
    }
  }
  return changed
}
const probeAll = async () => {
  const results = await Promise.all(state.gens.flatMap((g) => g.tunnels.map((t) => probeOne(g, t))))
  if (results.some(Boolean)) pushConfig() // dead/recovered -> refresh the chase list NOW
  save('probe')
}

// ------------------------------------------------ maintenance loop
const idleGen = (g) => {
  const u = tunnelHosts(g).map((h) => state.usage[h]).filter(Boolean)
  return u.length > 0
    ? u.every((x) => x.tabs === 0 && x.ws === 0 && x.lastSeen < now() - CF.IDLE)
    : true // no observed traffic at all = idle (browsers moved or never came)
}
const killGenTunnels = (g, why) => {
  for (const t of g.tunnels) {
    if (t.pid !== null) { try { process.kill(t.pid, 'SIGTERM') } catch (e) {} }
    t.pid = null
  }
  g.status = 'retired'
  log('gen ' + g.gen + ' retired (' + why + ')')
  save('retire')
  pushConfig()
}
const maintain = async () => {
  const nowMs = now()
  const cur = state.gens.find((g) => g.status === 'current')
  // emergency: current gen lost every tunnel -> new gen right away
  if (cur && !anyLive(cur) && nowMs - lastEmergency > CF.EMERGENCY_GAP) {
    lastEmergency = nowMs
    log('EMERGENCY: current gen ' + cur.gen + ' has no live tunnels')
    await spawnGen('emergency')
  }
  // scheduled rotation (never below MIN_LIFE and while a live tunnel exists)
  if (cur && anyLive(cur) && nowMs - cur.spawnedAt >= CF.ROTATE && liveGens().length < CF.MAX_GENS) {
    await spawnGen('rotation')
  }
  // never exceed MAX_GENS live generations
  if (liveGens().length > CF.MAX_GENS) {
    const oldest = liveGens().filter((g) => g.status !== 'current').sort((a, b) => a.gen - b.gen)[0]
    if (oldest) killGenTunnels(oldest, 'maxgens')
  }
  // retirement: idle by usage, or hard age cap (force-safe: tabs chase away)
  for (const g of state.gens) {
    if (g.status === 'current' || g.status === 'retired') continue
    const age = nowMs - g.spawnedAt
    if (age < CF.MIN_LIFE && age < CF.MAX_AGE) continue
    if (age >= CF.MAX_AGE || idleGen(g)) killGenTunnels(g, age >= CF.MAX_AGE ? 'maxage' : 'idle')
  }
  // respawn dead tunnels after RESTART_AFTER (new hostname — same gen record);
  // respect mint-backoff (t.nextTry) so a Cloudflare 429 window heals slowly
  for (const g of liveGens()) {
    for (const t of g.tunnels) {
      if (t.deadSince !== null && t.pid === null && nowMs - t.deadSince >= CF.RESTART_AFTER && (t.nextTry === null || nowMs >= t.nextTry)) await spawnTunnel(g, t.id, t)
    }
  }
}
const existsLive = () => (state.gens.find((g) => g.status === 'current')?.tunnels || []).some((t) => t.url)

// ------------------------------------------------ lifecycle
const allProc = () => [proxy, awake, ...state.gens.flatMap((g) => g.tunnels.map((t) => t.proc).filter(Boolean))].filter(Boolean)
const stop = (code, why) => {
  if (stopping) return
  stopping = true
  log('stopping (' + why + ') code=' + code)
  clearInterval(probeTimer)
  clearInterval(usageTimer)
  clearInterval(maintTimer)
  try { rmSync(STORE) } catch (e) {}
  const kids = allProc()
  for (const h of kids) { if (h.exitCode === null) { try { h.kill('SIGTERM') } catch (e) {} } }
  setTimeout(() => {
    for (const h of kids) { if (h.exitCode === null) { try { h.kill('SIGKILL') } catch (e) {} } }
    process.exit(code)
  }, 2000)
}

process.on('SIGTERM', () => stop(0, 'SIGTERM'))
process.on('SIGINT', () => stop(0, 'SIGINT'))

// self-heal the three files the runtime needs (macOS wipes /tmp on reboot).
// ALWAYS copy: the temp dir may hold stale v1 copies, source is the truth.
for (const [name, target] of [['cf-auth-proxy.mjs', PROXY], ['iptunnel-sw.js', TMP + '/iptunnel-sw.js'], ['iptunnel-watchdog.js', TMP + '/iptunnel-watchdog.js']]) {
  try { copyFileSync(HERE + name, target) } catch (e) { log(name + ' self-heal failed: ' + e.message) }
}
// a fresh daemon session owns the state file; clear any stale one first
try { rmSync(STORE) } catch (e) {}
// version receipt
try {
  const v = execFileSync(CLOUDFLARED, ['--version'], { encoding: 'utf8' })
  const m = v.match(/version (\S+)/)
  state.cloudflaredVersion = m ? m[1] : v.trim()
} catch (e) { log('cloudflared --version failed: ' + e.message) }
const cfGte = (y, mo) => {
  const m = String(state.cloudflaredVersion).match(/^(\d+)\.(\d+)/)
  if (!m) return false // unknown version → omit newer flags
  const a = +m[1], b = +m[2]
  return a > y || (a === y && b >= mo)
}

// keep the machine awake while the daemon exists — OFF by default, opt-in via
// the widget toggle (host passes DSH_CAFFEINATE=1) or the env directly.
// macOS-only utility; on Linux/Windows there is no caffeinate — skip.
const spawnAwake = () => {
  if (process.env.DSH_CAFFEINATE !== '1') { log('caffeinate: off (opt-in)'); return }
  if (process.platform !== 'darwin') { log('caffeinate: unavailable on ' + process.platform); return }
  try {
    awake = spawn('/usr/bin/caffeinate', ['-i'], { stdio: 'ignore' })
    awake.on('error', (e) => { log('caffeinate unavailable: ' + e.message); awake = null })
    awake.on('exit', () => { if (!stopping) { log('caffeinate exited; respawning'); spawnAwake() } })
  } catch (e) { log('caffeinate unavailable') }
}
spawnAwake()

// auth proxy (the security gate) — its death is fatal (no gate, no tunnels)
const startProxy = () => {
  proxy = spawn(process.execPath, [PROXY, '127.0.0.1', PROXY_PORT, '127.0.0.1', TARGET_PORT], {
    env: { ...process.env, DSH_PROXY_USER: USER, DSH_PROXY_PASS: PASS },
    // pipes are never drained here — 'pipe' would let the proxy block once the
    // OS buffer fills; its own logs go nowhere useful, drop them instead.
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  proxy.on('error', (e) => { if (!stopping) { log('proxy spawn error: ' + e.message); stop(1, 'proxy spawn failed') } })
  proxy.on('exit', (code) => { if (!stopping) stop(1, 'proxy exited ' + String(code)) })
}
startProxy()

// boot: first generation immediately
spawnGen('boot').catch((e) => log('boot spawn error: ' + e.message))

const probeTimer = setInterval(() => { probeAll().catch((e) => log('probe error: ' + e.message)) }, CF.PROBE)
const usageTimer = setInterval(() => refreshUsage(), CF.PROBE)
const maintTimer = setInterval(() => { maintain().catch((e) => log('maintain error: ' + e.message)) }, Math.max(15000, CF.PROBE))
// 90s boot watchdog: never end silently with nothing registered
setTimeout(() => { if (!existsLive()) log('WARN: no tunnel registered after 90s') }, 90000)

log('daemon v2 started pid=' + process.pid + ' cloudflared=' + state.cloudflaredVersion + ' rotate=' + CF.ROTATE / MS.h + 'h')
