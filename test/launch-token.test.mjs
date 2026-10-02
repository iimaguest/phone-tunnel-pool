// Integration test: the proxy must carry the dsh 0.2 web launch token.
//
// dsh 0.2 answers 401 to every request that carries neither the per-process
// ?token= nor the session cookie that token mints. The proxy is given the
// token, exchanges it once against the origin, and stamps the resulting cookie
// onto everything it forwards — so a client that only has the proxy's Basic
// auth gets through. These tests stand in a mock origin for dsh and exercise
// the real proxy over real HTTP:
//
//   1. mint + stamp: a Basic-authed client gets 200 from an origin that 401s
//      every tokenless request.
//   2. outer gate intact: no Basic auth still gets the proxy's own 401.
//   3. token rotation: after a dsh web restart the process token changes; the
//      plugin pushes the fresh one to /iptunnel/__ctl/launch-token, the proxy
//      re-mints, and clients keep working. A proxy still holding the stale
//      token stays locked out.
//   4. pre-0.2 shape: with no DSH_LAUNCH_TOKEN at all, an origin with no gate
//      is proxied untouched.
//
// Run: node --test test/

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cf-auth-proxy.mjs')

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// The mock dsh origin: exactly the 0.2 shape the proxy must survive — a token
// exchange on GET /, 401 for everything unauthenticated. `state` is mutable so
// a test can rotate the token the way a real dsh restart does.
function mockOrigin(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/' && state.token !== null && url.searchParams.get('token') === state.token) {
      res.writeHead(303, { 'set-cookie': `${state.cookieName}=${state.cookieValue}; Path=/`, location: './' })
      return res.end()
    }
    const got = String(req.headers.cookie || '').split(';').map((p) => p.trim())
    if (state.token !== null && got.includes(`${state.cookieName}=${state.cookieValue}`)) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('OK')
    }
    if (state.token === null) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('OK')
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('denied')
  })
}

function startProxy(targetPort, env) {
  const child = spawn(process.execPath, [PROXY, '127.0.0.1', '0', '127.0.0.1', String(targetPort)], {
    env: { ...process.env, DSH_PROXY_USER: 'dsh', DSH_PROXY_PASS: 'testpass', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not announce its port')), 5000)
    child.stdout.on('data', (d) => {
      const m = String(d).match(/auth proxy listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }) }
    })
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('proxy exited ' + code)) })
  })
}

const request = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let out = ''
    res.on('data', (d) => { out += d })
    res.on('end', () => resolve({ status: res.statusCode, body: out }))
  })
  req.on('error', reject)
  if (body !== undefined) req.write(body)
  req.end()
})

const AUTH = { authorization: 'Basic ' + Buffer.from('dsh:testpass').toString('base64') }

// Close everything the test opened: an unclosed server handle or child stdio
// pipe keeps the runner's event loop alive and hangs the whole suite.
async function teardown(origin, proxies) {
  origin.close()
  await Promise.all(proxies.map(({ child }) => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve()
    child.on('exit', resolve)
    child.kill()
  })))
}

test('launch token is exchanged once and stamped onto forwarded requests', async (t) => {
  const state = { token: 'SECRET1', cookieName: 'dsh_web', cookieValue: 'good' }
  const origin = mockOrigin(state)
  const originPort = await listen(origin)
  const { child, port } = await startProxy(originPort, { DSH_LAUNCH_TOKEN: 'SECRET1' })
  t.after(() => teardown(origin, [{ child }]))

  // the origin 401s every tokenless request, so a 200 here can only come
  // from the proxy's minted cookie riding along
  let res = await request(port, 'GET', '/', AUTH)
  assert.equal(res.status, 200, 'Basic-authed client should reach the origin through the minted cookie')
  assert.equal(res.body, 'OK')
  // the outer gate still stands: no Basic auth, no tunnel
  res = await request(port, 'GET', '/', {})
  assert.equal(res.status, 401, 'proxy must still reject unauthenticated clients')
})

test('a pushed token re-mints after a dsh web restart; a stale token stays locked out', async (t) => {
  const state = { token: 'SECRET1', cookieName: 'dsh_web', cookieValue: 'good' }
  const origin = mockOrigin(state)
  const originPort = await listen(origin)
  const stale = await startProxy(originPort, { DSH_LAUNCH_TOKEN: 'STALE' })
  const fresh = await startProxy(originPort, { DSH_LAUNCH_TOKEN: 'SECRET1' })
  t.after(() => teardown(origin, [stale, fresh]))

  // the fresh proxy mints and gets through; the stale one cannot
  let res = await request(fresh.port, 'GET', '/', AUTH)
  assert.equal(res.status, 200, 'proxy holding the current token gets through')
  res = await request(stale.port, 'GET', '/', AUTH)
  assert.equal(res.status, 401, 'proxy holding a stale token stays locked out')

  // dsh web restarts: the process token and its cookie both rotate
  state.token = 'SECRET2'
  state.cookieValue = 'good2'

  // the old cookie is now worthless on BOTH proxies
  res = await request(fresh.port, 'GET', '/', AUTH)
  assert.equal(res.status, 401, 'rotated origin rejects the old session cookie')

  // the plugin pushes the fresh token to the surviving proxy over ctl
  res = await request(fresh.port, 'POST', '/iptunnel/__ctl/launch-token', {
    ...AUTH, 'content-type': 'application/json',
  }, JSON.stringify({ token: 'SECRET2' }))
  assert.equal(res.status, 200, 'ctl push should be accepted')

  // ...and clients work again through the SAME proxy, no restart
  res = await request(fresh.port, 'GET', '/', AUTH)
  assert.equal(res.status, 200, 're-minted cookie restores the tunnel')
  // the stale proxy was never pushed a working token and stays out
  res = await request(stale.port, 'GET', '/', AUTH)
  assert.equal(res.status, 401, 'stale proxy without a push stays locked out')
})

test('no DSH_LAUNCH_TOKEN: an ungated origin is proxied untouched', async (t) => {
  const state = { token: null, cookieName: 'dsh_web', cookieValue: 'good' }
  const origin = mockOrigin(state)
  const originPort = await listen(origin)
  const { child, port } = await startProxy(originPort, {})
  t.after(() => teardown(origin, [{ child }]))

  const res = await request(port, 'GET', '/', AUTH)
  assert.equal(res.status, 200, 'pre-0.2 dsh (no gate) must proxy exactly as before')
  assert.equal(res.body, 'OK')
})
