// phone-tunnel-pool — permanent host half (dsh web profile bundle).
// One-click Cloudflare quick tunnel to the dsh web GUI for phone access.
//
// The tunnel chain (auth proxy + hardened cloudflared + caffeinate) is owned
// by a DETACHED daemon (lib/daemon.mjs), NOT by this plugin, so it survives
// dsh web restarts: same cloudflared process = same trycloudflare hostname =
// same password = same QR — no re-scan needed after a server restart.
// The daemon writes /tmp/iptunnel-state.json (0600) once the URL is known;
// this host adopts it on boot (or on Enable) and serves /iptunnel JSON routes.
//
// Routes are NOT under /api (no browser-trust fence involvement): the only
// external face is through the password-protected proxy, and loopback
// access is the local GUI.

import { rmSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn as cspawn } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'phone-tunnel-pool'

export const inject = ['subprocess', 'timer', 'webServer']

const PYTHON = process.env.DSH_PYTHON || 'python3'
const TMP = process.env.DSH_TMP || tmpdir() // per-OS temp dir (macOS/Linux/Windows)
const PROXY = TMP + '/cf-auth-proxy.mjs'
const PROXY_PORT = '3090' // MUST match the daemon's DSH_PROXY_PORT default (passed below)
const STORE = TMP + '/iptunnel-state.json'
const LOG = TMP + '/iptunnel-daemon.log'
const SETTINGS = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'iptunnel-settings.json')
const DAEMON = fileURLToPath(new URL('./daemon.mjs', import.meta.url))
const PY_QR = "import qrcode,sys\nfrom qrcode.image.svg import SvgPathImage\nqr=qrcode.QRCode(border=4,box_size=10)\nqr.add_data(sys.argv[1])\nqr.make(fit=True)\nqr.make_image(image_factory=SvgPathImage).save(sys.stdout.buffer)"

export async function apply(ctx) {
  const subprocess = ctx.subprocess
  const state = { phase: 'disabled', enabled: false, url: null, username: 'dsh', password: null, startedAt: null, error: null, qr: null, prereqs: null }
  // user preference (caffeinate OFF by default; persisted beside the profile)
  const cfg = { caffeinate: false, autoEnable: false, maxGens: 4, rotateH: 12 }
  try {
    const s = JSON.parse(readFileSync(SETTINGS, 'utf8'))
    if (typeof s.caffeinate === 'boolean') cfg.caffeinate = s.caffeinate
    if (typeof s.autoEnable === 'boolean') cfg.autoEnable = s.autoEnable
    if (Number.isFinite(s.maxGens)) cfg.maxGens = Math.max(2, Math.min(8, Math.floor(s.maxGens)))
    if (Number.isFinite(s.rotateH)) cfg.rotateH = Math.max(4, Math.min(168, Math.floor(s.rotateH)))
  } catch (e) {}
  const saveSettings = () => { try { writeFileSync(SETTINGS, JSON.stringify(cfg), { mode: 0o600 }) } catch (e) {} }

  const sleep = (ms) => ctx.timeout(ms)
  // one-shot external-command probe: true when exit code is 0 (missing binary
  // or timeout -> false); used for the prerequisite preflight.
  const okCmd = (argv) => new Promise((resolve) => {
    try {
      const c = cspawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'ignore'] })
      const t = setTimeout(() => { try { c.kill() } catch (e) {} resolve(false) }, 3000)
      c.on('error', () => { clearTimeout(t); resolve(false) })
      c.on('exit', (code) => { clearTimeout(t); resolve(code === 0) })
    } catch (e) { resolve(false) }
  })
  const checkPrereqs = async () => {
    const p = {}
    const cf = process.env.DSH_CLOUDFLARED || 'cloudflared'
    const cfCmd = process.platform === 'darwin' ? 'brew install cloudflared' : process.platform === 'win32' ? 'winget install Cloudflare.cloudflared' : 'sudo apt install cloudflared'
    p.cloudflared = { ok: await okCmd([cf, '--version']), hint: 'cloudflared not found on PATH — install it, or set DSH_CLOUDFLARED to an existing binary', cmd: cfCmd }
    p.qr = { ok: await okCmd([PYTHON, '-c', 'import qrcode']), hint: 'qrcode package missing — install it for a scannable QR (URL + login still usable without it)', cmd: 'pip install qrcode' }
    return p
  }
  const refreshPrereqs = () => { checkPrereqs().then((p) => { state.prereqs = p }).catch(() => {}) }
  const genPassword = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let out = ''
    for (let i = 0; i < 28; i++) out += chars[Math.floor(Math.random() * chars.length)]
    return out
  }
  const waitFor = async (fn, tries, delayMs, label) => {
    for (let i = 0; i < tries; i++) {
      const v = fn()
      if (v) return v
      await sleep(delayMs)
    }
    throw new Error('timeout waiting for ' + label)
  }
  const spawn = (argv, env) => subprocess.spawn({
    argv,
    cwd: TMP,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 524288 }, stderr: { maxBytes: 524288 } },
    graceMs: 2000,
    env
  })
  const killPattern = async (pattern) => {
    if (process.platform === 'win32') {
      // no pkill: match the command line via PowerShell CIM (patterns are
      // simple literals; strip regex-escape artifacts first)
      const needle = pattern.replace(/\\/g, '')
      try {
        const h = spawn(['powershell', '-NoProfile', '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + needle + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], undefined)
        await Promise.race([h.done, sleep(1200)])
        try { h.terminate() } catch (e) {}
      } catch (e) {}
      return
    }
    try {
      const h = spawn(['/usr/bin/pkill', '-f', pattern], undefined)
      await Promise.race([h.done, sleep(800)])
      try { h.terminate() } catch (e) {}
    } catch (e) {}
  }

  const readStore = () => {
    try { return JSON.parse(readFileSync(STORE, 'utf8')) } catch (e) { return null }
  }
  const daemonPidAlive = (pid) => {
    if (typeof pid !== 'number') return false
    try { process.kill(pid, 0); return true } catch (e) { return false }
  }
  const makeQr = async (credUrl) => {
    const h = await spawn([PYTHON, '-c', PY_QR, credUrl], undefined)
    const outcome = await Promise.race([h.done, sleep(20000)])
    if (outcome === undefined) { try { h.terminate() } catch (e) {}; throw new Error('QR generation timed out') }
    if (outcome.exitCode !== 0) throw new Error('QR generation failed (exit ' + String(outcome.exitCode) + '): ' + readAll(h, 'stderr').slice(0, 300))
    const svg = readAll(h, 'stdout')
    if (svg === '') throw new Error('QR generation produced no output')
    return 'data:image/svg+xml;base64,' + btoa(svg)
  }
  const readAll = (handle, stream) => {
    const reader = handle.collected[stream]
    return reader === undefined ? '' : reader.readFrom(0).text
  }
  const qrFor = (url, username, password) => makeQr('https://' + username + ':' + password + '@' + url.replace(/^https?:\/\//, ''))

  // Adopt a daemon that is still running (survived a dsh web restart).
  const adoptIfAny = async () => {
    const s = readStore()
    if (s === null || typeof s.url !== 'string' || s.url === '') return false
    if (!daemonPidAlive(s.daemonPid)) return false
    state.phase = 'enabled'
    state.enabled = true
    state.url = s.url
    state.username = s.username || 'dsh'
    state.password = s.password || ''
    state.startedAt = s.startedAt || Date.now()
    state.error = null
    try { state.qr = await qrFor(s.url, state.username, state.password) } catch (e) { state.qr = null }
    return true
  }

  const enable = async () => {
    if (state.phase === 'starting' || state.phase === 'stopping') return snapshot()
    if (state.phase === 'enabled') return snapshot()
    // mark synchronously BEFORE any await: two concurrent enable POSTs would
    // otherwise both pass the guard and spawn two daemons.
    state.phase = 'starting'
    state.error = null
    // A surviving daemon (e.g. from before a dsh web restart) wins: same
    // hostname + password + QR, no re-scan.
    if (await adoptIfAny()) return snapshot()
    refreshPrereqs() // user may have just installed something before enabling
    try {
      await killPattern('cf-auth-proxy.mjs 127.0.0.1 ' + PROXY_PORT)
      await killPattern('cloudflared tunnel --url http://127.0.0.1:' + PROXY_PORT)
      await killPattern(DAEMON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      rmSync(STORE, { force: true })
      const password = genPassword()
      const child = cspawn(process.execPath, [DAEMON], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, DSH_PROXY_USER: 'dsh', DSH_PROXY_PASS: password, DSH_PROXY_PORT: PROXY_PORT, DSH_CAFFEINATE: cfg.caffeinate ? '1' : '0', DSH_MAX_GENS: String(cfg.maxGens), DSH_ROTATE_MS: String(cfg.rotateH * 3600000) }
      })
      child.unref()
      let s = null
      const deadlineTs = Date.now() + 90 * 1000
      while (s === null) {
        const st = readStore()
        if (st !== null && typeof st.url === 'string' && st.url !== '') s = st
        else if (st !== null && st.phase === 'error') throw new Error(st.error || 'daemon reported an error (see ' + LOG + ')')
        else if (Date.now() > deadlineTs) throw new Error('daemon did not publish a tunnel URL within 90s — is cloudflared installed? see ' + LOG)
        else await sleep(500)
      }
      state.url = s.url
      state.username = s.username || 'dsh'
      state.password = s.password || password
      state.startedAt = s.startedAt || Date.now()
      state.enabled = true
      state.phase = 'enabled'
      state.error = null
      state.qr = await qrFor(s.url, state.username, state.password)
    } catch (err) {
      state.error = String(err !== null && err !== undefined ? (err.message || err) : err)
      await killPattern(DAEMON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      await killPattern('cf-auth-proxy.mjs 127.0.0.1 ' + PROXY_PORT)
      await killPattern('cloudflared tunnel --url http://127.0.0.1:' + PROXY_PORT)
      rmSync(STORE, { force: true })
      state.phase = 'disabled'
      state.enabled = false
      state.password = null
      state.startedAt = null
    }
    return snapshot()
  }

  const disable = async () => {
    if (state.phase === 'starting' || state.phase === 'stopping') return snapshot()
    state.phase = 'stopping'
    await killPattern(DAEMON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    await sleep(400)
    await killPattern('cf-auth-proxy.mjs 127.0.0.1 ' + PROXY_PORT)
    await killPattern('cloudflared tunnel --url http://127.0.0.1:' + PROXY_PORT)
    rmSync(STORE, { force: true })
    state.phase = 'disabled'
    state.enabled = false
    state.url = null
    state.error = null
    state.qr = null
    state.password = null
    state.startedAt = null
    return snapshot()
  }
  const snapshot = () => {
    const s = readStore()
    const pool = s !== null && s.version === 2 ? s : null
    return {
      phase: state.phase, enabled: state.enabled, url: state.url, username: state.username,
      password: state.password, startedAt: state.startedAt, error: state.error, qr: state.qr,
      prereqs: state.prereqs,
      settings: cfg, os: process.platform,
      targetPort: process.env.DSH_TARGET_PORT || '3080',
      ...(pool !== null ? {
        pool: {
          version: pool.version, gen: pool.gen, primary: pool.primary,
          cloudflaredVersion: pool.cloudflaredVersion, gens: pool.gens, usage: pool.usage
        }
      } : {})
    }
  }

  // heartbeat: if the daemon dies while we think we're enabled, fall back to
  // disabled instead of advertising a dead tunnel; also follow URL changes
  // (a respawned tunnel gets a NEW hostname — keep the widget truthful).
  ctx.effect(() => {
    let lastUrl = state.url
    const id = setInterval(async () => {
      try {
        if (state.phase !== 'enabled') return
        const s = readStore()
        if (s === null || !daemonPidAlive(s.daemonPid)) {
          state.phase = 'disabled'
          state.enabled = false
          state.error = 'tunnel daemon exited unexpectedly'
          state.password = null
          state.qr = null
          state.url = null
          // the daemon died WITHOUT cleaning up (SIGKILL/crash): its proxy and
          // cloudflareds were re-parented to init and keep the public tunnel
          // live — kill them so "disabled" really means off.
          await killPattern('cf-auth-proxy.mjs 127.0.0.1 ' + PROXY_PORT)
          await killPattern('cloudflared tunnel --url http://127.0.0.1:' + PROXY_PORT)
          await killPattern('/usr/bin/caffeinate -i')
          rmSync(STORE, { force: true })
          return
        }
        if (typeof s.url === 'string' && s.url !== '' && s.url !== lastUrl) {
          lastUrl = s.url
          state.url = s.url
          state.username = s.username || 'dsh'
          state.password = s.password || ''
          try { state.qr = await qrFor(s.url, state.username, state.password) } catch (e) { state.qr = null }
        }
      } catch (e) { /* never let a heartbeat probe take the host down */ }
    }, 30000)
    return () => clearInterval(id)
  }, 'phone-tunnel-pool: daemon heartbeat')

  // prerequisite preflight on boot: the widget warns before Enable is clicked
  refreshPrereqs()

  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  // these control routes expose live credentials; only serve them to the
  // loopback client (127.0.0.1 / localhost). Requests arriving via the pool
  // are forwarded by cf-auth-proxy with its Host rewritten to 127.0.0.1, so
  // loopback alone covers the phone path — and a `Host:` header is the one
  // thing an attacker can forge, so nothing else is accepted.
  const hostOf = (req) => {
    const h = String(req.headers.host || '')
    if (h.indexOf(']') !== -1) return h.slice(1, h.indexOf(']')).toLowerCase()
    return h.split(':')[0].toLowerCase()
  }
  const route = {
    kind: 'prefix',
    path: '/iptunnel',
    handler: async (req, res) => {
      let pathname = '/iptunnel'
      try {
        pathname = new URL(req.url, 'http://localhost').pathname
      } catch (e) {}
      const h = hostOf(req)
      if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') return json(res, 403, { error: 'forbidden' })
      // Host alone is forgeable; the socket must also be loopback (the pool's
      // proxy connects from 127.0.0.1, so this still permits the phone path).
      const remote = req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : ''
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return json(res, 403, { error: 'forbidden' })
      try {
        if (req.method === 'GET' && (pathname === '/iptunnel' || pathname === '/iptunnel/state')) return json(res, 200, snapshot())
        if (req.method === 'POST' && pathname === '/iptunnel/refresh') {
          // resync from the daemon store + re-run the prereq preflight
          try {
            const s2 = readStore()
            if (s2 !== null && state.phase === 'enabled' && typeof s2.url === 'string' && s2.url !== '') {
              state.url = s2.url
              state.username = s2.username || 'dsh'
              state.password = s2.password || ''
              try { state.qr = await qrFor(s2.url, state.username, state.password) } catch (e) { state.qr = null }
            }
          } catch (e) {}
          state.prereqs = await checkPrereqs()
          return json(res, 200, snapshot())
        }
        if (req.method === 'POST' && pathname === '/iptunnel/enable') return json(res, 200, await enable())
        if (req.method === 'POST' && pathname === '/iptunnel/disable') return json(res, 200, await disable())
        if (req.method === 'POST' && pathname === '/iptunnel/settings') {
          try {
            const q = new URL(req.url, 'http://localhost').searchParams
            cfg.caffeinate = q.get('c') === '1'
            cfg.autoEnable = q.get('ae') === '1'
            if (q.get('mg')) cfg.maxGens = Math.max(2, Math.min(8, Math.floor(Number(q.get('mg')) || 4)))
            if (q.get('rot')) cfg.rotateH = Math.max(4, Math.min(168, Math.floor(Number(q.get('rot')) || 12)))
          } catch (e) {}
          saveSettings()
          return json(res, 200, snapshot())
        }
        json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, 500, { error: String(err !== null && err !== undefined ? (err.message || err) : err) })
      }
    }
  }
  ctx.effect(() => ctx.webServer.register(route), 'phone-tunnel-pool: /iptunnel routes')

  // adopt a pre-existing daemon (from before this server started) async at boot
  adoptIfAny()
    .then(() => {
      // auto-enable option: dsh web start = tunnel start (no clicking)
      if (cfg.autoEnable && state.phase === 'disabled') enable().catch(() => {})
    })
    .catch(() => {})
}
