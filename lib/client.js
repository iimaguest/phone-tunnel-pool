// phone-tunnel-pool — permanent client half (module-loader bundle).
// Floating shell.overlay widget: enable/disable button, URL, login, QR.
// Talks to the host half via plain fetch on /iptunnel (same origin; any
// external face passes the password-protected proxy first).
window.__ModuleLoader__.load({
  id: 'phone-tunnel-pool',
  factory: function (require) {
    var React = require('react')
    var module = { exports: {} }
    var exports = module.exports

    var stateJson = function () {
      return fetch('/iptunnel/state', { headers: { accept: 'application/json' } }).then(function (r) {
        if (!r.ok) throw new Error('state ' + r.status)
        return r.json()
      })
    }
    var postAction = function (action) {
      return fetch('/iptunnel/' + action, { method: 'POST', headers: { accept: 'application/json' } }).then(function (r) {
        if (!r.ok) throw new Error(action + ' ' + r.status)
        return r.json()
      })
    }
    var fmtAgo = function (ms) {
      if (!ms) return '–'
      var d = Date.now() - ms
      if (d < 60000) return Math.round(d / 1000) + 's'
      if (d < 3600000) return Math.round(d / 60000) + 'm'
      return Math.round(d / 3600000) + 'h'
    }

    var TunnelWidget = function TunnelWidget() {
      var st = React.useState(null)
      var state = st[0]
      var setState = st[1]
      var busySt = React.useState(false)
      var busy = busySt[0]
      var setBusy = busySt[1]
      var errSt = React.useState(null)
      var err = errSt[0]
      var setErr = errSt[1]
      var openSt = React.useState(false)
      var open = openSt[0]
      var setOpen = openSt[1]
      // draggable icon: vertical position along the right edge (snaps to the
      // right edge; free anywhere vertically). topPos null = initial bottom spot.
      var topSt = React.useState(function () {
        try { var v = Number(localStorage.getItem('pt-pill-top')); return isNaN(v) ? null : v } catch (e) { return null }
      })
      var topPos = topSt[0]
      var setTopPos = topSt[1]
      var copiedSt = React.useState('')
      var copiedKey = copiedSt[0]
      var setCopiedKey = copiedSt[1]
      var dragRef = React.useRef(null)
      var movedRef = React.useRef(false)
      var panelRef = React.useRef(null)
      var pillRef = React.useRef(null)

      React.useEffect(function () {
        var alive = true
        stateJson().then(function (s) { if (alive) setState(s) }).catch(function (e) { if (alive) setErr(String(e && e.message ? e.message : e)) })
        return function () { alive = false }
      }, [])

      React.useEffect(function () {
        if (state === null || (state.phase !== 'starting' && state.phase !== 'stopping')) return undefined
        var id = setInterval(function () {
          stateJson().then(function (s) { setState(s) }).catch(function () {})
        }, 900)
        return function () { clearInterval(id) }
      }, [state === null ? null : state.phase])

      // no background polling while open: fetch once when the panel opens,
      // and let the user refresh by hand (the button in the header).
      React.useEffect(function () {
        if (!open) return undefined
        var alive = true
        stateJson().then(function (s) { if (alive) setState(s) }).catch(function () {})
        return function () { alive = false }
      }, [open])

      // close on outside click: pointerdown anywhere that is neither the
      // panel nor the pill dismisses the popup (standard overlay behavior).
      React.useEffect(function () {
        if (!open) return undefined
        function onDocPointerDown(e) {
          var t = e.target
          if (panelRef.current && panelRef.current.contains(t)) return
          if (pillRef.current && pillRef.current.contains(t)) return
          setOpen(false)
        }
        document.addEventListener('pointerdown', onDocPointerDown)
        return function () { document.removeEventListener('pointerdown', onDocPointerDown) }
      }, [open])

      var onToggle = function () {
        setBusy(true)
        setErr(null)
        var action = state !== null && state.phase === 'enabled' ? 'disable' : 'enable'
        postAction(action).then(function () {
          return stateJson()
        }).then(function (s) {
          setState(s)
        }).catch(function (e) {
          setErr(String(e && e.message ? e.message : e))
        }).finally(function () { setBusy(false) })
      }

      var enabled = state !== null && state.phase === 'enabled'
      var pillStyle = { position: 'fixed', right: 16, top: topPos === null ? undefined : topPos, bottom: topPos === null ? 16 : undefined, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'system-ui, sans-serif', fontSize: 20, touchAction: 'none', userSelect: 'none' }
      // subtle state from the icon itself: green glow when the tunnel is live,
      // desaturated/dim when disabled
      var iconStyle = enabled
        ? { textShadow: '0 0 7px rgba(46,160,67,0.65)' }
        : { filter: 'grayscale(1) opacity(0.6)', textShadow: '0 1px 3px rgba(0,0,0,0.35)' }
      var panelStyle = { position: 'fixed', right: 16, bottom: 64, zIndex: 9000, width: 340, padding: 12, borderRadius: 12, border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(24,26,30,0.96)', color: '#e8e8e8', fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.5, boxShadow: '0 8px 28px rgba(0,0,0,0.4)' }
      var btnStyle = { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, color: '#fff', background: enabled ? '#b23b3b' : '#2f7d43' }
      var inputStyle = { width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12, padding: 6, borderRadius: 6, border: '1px solid rgba(128,128,128,0.4)', marginTop: 2, background: '#111', color: '#e8e8e8' }

      var panel = null
      if (open) {
        // pool table: generations, tunnel health, live clients/tabs/WS
        var poolBlock = null
        if (enabled && state !== null && state.pool && state.pool.gens && state.pool.gens.length > 0) {
          var usage = state.pool.usage || {}
          var rows = []
          state.pool.gens.forEach(function (g) {
            g.tunnels.forEach(function (t) {
              var u = usage[t.host || '']
              rows.push(React.createElement('div', { key: g.gen + '/' + t.id, style: { padding: '4px 0', borderTop: '1px solid rgba(128,128,128,0.25)', fontSize: 12, fontFamily: 'monospace' } },
                React.createElement('span', { style: { color: g.status === 'current' ? '#7ee787' : 'rgba(155,155,155,0.9)' } }, 'gen' + g.gen + '/' + t.id),
                ' ' + (t.host || '?').replace(/\.trycloudflare\.com$/, '…'),
                g.status === 'current' ? ' ★' : (g.status === 'retired' ? ' ⏹' : ' ▶'),
                React.createElement('span', { style: { color: t.healthy ? '#2ea043' : '#d73a49' } }, ' ●'),
                u ? React.createElement('span', { style: { color: 'rgba(170,170,170,0.9)' } },
                  ' tabs:' + (u.tabs || 0) + ' ws:' + (u.ws || 0) + ' clients:' + (u.clients || 0) + ' ' + fmtAgo(u.lastSeen)) : null
              ))
            })
          })
          var liveCount = state.pool.gens.filter(function (g) { return g.status !== 'retired' }).length
          poolBlock = React.createElement('div', { style: { marginTop: 10 } },
            React.createElement('div', { style: { fontWeight: 700, marginBottom: 2 } },
              'Pool — cloudflared ' + (state.pool.cloudflaredVersion || '?') + ' · ' + liveCount + ' gens live · current gen ' + state.pool.gen),
            React.createElement('div', { style: { fontSize: 11, color: 'rgba(170,170,170,0.95)', marginBottom: 4 } },
              'automatic pool chase: a dead hostname redirects to a live sibling; idle generations retire on their own.'),
            rows
          )
        }
        panel = React.createElement('div', { style: panelStyle, ref: panelRef },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            React.createElement('div', { style: { fontWeight: 700, flex: 1 } }, 'Cloudflare Tunnel — Phone access'),
            React.createElement('button', {
              style: { background: 'transparent', border: '1px solid rgba(170,170,170,0.4)', color: 'rgba(220,220,220,0.9)', borderRadius: 4, fontSize: 12, padding: '1px 8px', cursor: 'pointer', lineHeight: 1.4 },
              'aria-label': 'Refresh status',
              title: 'Refresh status',
              onClick: function () { stateJson().then(function (s) { setState(s) }).catch(function (e) { setErr(String(e && e.message ? e.message : e)) }) }
            }, '↻ refresh')),
          React.createElement('div', null, 'Status: ', state === null ? 'loading…' : state.phase, busy ? ' (working…)' : ''),
          state !== null && state.prereqs ? Object.keys(state.prereqs).map(function (k) {
            var p = state.prereqs[k]
            if (p === null || p === undefined || p.ok) return null
            return React.createElement('div', { key: k, style: { color: '#d4a72c', marginTop: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } },
              React.createElement('span', { style: { flex: 1 } }, 'Prereq missing: ' + (p.hint || k)),
              p.cmd ? React.createElement('button', {
                style: { background: 'transparent', border: '1px solid rgba(212,167,44,0.5)', color: '#d4a72c', borderRadius: 4, fontSize: 11, padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap' },
                'aria-label': 'Copy install command',
                onClick: function () {
                  try {
                    var done = function () { setCopiedKey(k === copiedKey ? '' : k); setTimeout(function () { setCopiedKey('') }, 1500) }
                    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(p.cmd).then(done, function () {})
                    else done()
                  } catch (e) {}
                }
              }, copiedKey === k ? '✓ copied' : 'copy') : null)
          }) : null,
          state !== null && state.error ? React.createElement('div', { style: { color: '#e08080', marginTop: 4 } }, 'Error: ' + state.error) : null,
          err !== null ? React.createElement('div', { style: { color: '#e08080', marginTop: 4 } }, 'Error: ' + err) : null,
          state !== null && state.settings ? (function () {
            var stg = state.settings
            var save = function (next) {
              fetch('/iptunnel/settings?c=' + (next.caffeinate ? 1 : 0) + '&ae=' + (next.autoEnable ? 1 : 0) + '&mg=' + Number(next.maxGens) + '&ad=' + Number(next.autoDisableH), { method: 'POST', headers: { accept: 'application/json' } })
                .then(function (r) { return r.json() })
                .then(function (s) { setState(s) }).catch(function (err2) { setErr(String(err2 && err2.message ? err2.message : err2)) })
            }
            var L = function (style) { return style || {} }
            var rows = []
            if (state.os === 'darwin') rows.push(React.createElement('label', { key: 'c', style: L({ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
              React.createElement('input', { type: 'checkbox', checked: !!stg.caffeinate, style: { cursor: 'pointer' }, onChange: function (e) { save({ caffeinate: e.target.checked, autoEnable: stg.autoEnable, maxGens: stg.maxGens, autoDisableH: stg.autoDisableH }) } }),
              React.createElement('span', null, 'Keep machine awake while enabled (next Enable)')))
            rows.push(React.createElement('label', { key: 'ae', style: L({ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
              React.createElement('input', { type: 'checkbox', checked: !!stg.autoEnable, style: { cursor: 'pointer' }, onChange: function (e) { save({ caffeinate: stg.caffeinate, autoEnable: e.target.checked, maxGens: stg.maxGens, autoDisableH: stg.autoDisableH }) } }),
              React.createElement('span', null, 'Start tunnel when dsh web starts (next start)')))
            rows.push(React.createElement('div', { key: 'mg', style: L({ display: 'flex', alignItems: 'center', gap: 6 }) },
              React.createElement('span', null, 'Pool size (gens × 2 tunnels, next Enable):'),
              React.createElement('select', { value: Number(stg.maxGens), style: { background: '#1c1c1c', color: 'inherit', border: '1px solid rgba(170,170,170,0.4)', borderRadius: 4, fontSize: 12 }, onChange: function (e) { save({ caffeinate: stg.caffeinate, autoEnable: stg.autoEnable, maxGens: Number(e.target.value), autoDisableH: stg.autoDisableH }) } },
                [2, 3, 4, 5, 6].map(function (n) { return React.createElement('option', { key: n, value: n }, String(n)) })))))
            rows.push(React.createElement('div', { key: 'ad', style: L({ display: 'flex', alignItems: 'center', gap: 6 }) },
              React.createElement('span', null, 'Auto-disable after:'),
              React.createElement('select', { value: Number(stg.autoDisableH), style: { background: '#1c1c1c', color: 'inherit', border: '1px solid rgba(170,170,170,0.4)', borderRadius: 4, fontSize: 12 }, onChange: function (e) { save({ caffeinate: stg.caffeinate, autoEnable: stg.autoEnable, maxGens: stg.maxGens, autoDisableH: Number(e.target.value) }) } },
                [[0, 'never'], [2, '2 h'], [8, '8 h'], [12, '12 h'], [24, '24 h']].map(function (p) { return React.createElement('option', { key: p[0], value: p[0] }, p[1]) })))))
            rows.push(React.createElement('div', { key: 'info', style: L({ fontSize: 11, color: 'rgba(170,170,170,0.75)', marginTop: 4 }) },
              'Target 127.0.0.1:' + (state.targetPort || '3080') + ' · rotation every ' + (state.rotateH || 12) + 'h — env: DSH_TARGET_PORT, DSH_ROTATE_MS'))
            return React.createElement('div', { style: { marginTop: 8, fontSize: 12, color: 'rgba(200,200,200,0.9)', display: 'grid', gap: 4 } }, React.createElement('div', { style: { fontWeight: 700, fontSize: 11, color: 'rgba(170,170,170,0.8)' } }, 'Settings'), rows)
          })() : null,
          enabled && state !== null && state.phase === 'enabled' ? React.createElement('div', { style: { color: '#d4a72c', marginTop: 6, fontSize: 11, maxWidth: 300 } },
            '⚠ Live on the internet — anyone with the QR can use dsh web. Disable when done.') : null,
          enabled && state !== null && state.url ? React.createElement('div', null,
            React.createElement('div', { style: { marginTop: 8 } }, 'URL — type on your phone, or scan the QR:'),
            React.createElement('input', { readOnly: true, value: state.url, style: inputStyle }),
            React.createElement('div', { style: { marginTop: 8 } }, 'Login (username / password):'),
            React.createElement('input', { readOnly: true, value: state.username + ' / ' + state.password, style: inputStyle }),
            React.createElement('div', { style: { fontSize: 11, color: 'rgba(170,170,170,0.95)', marginTop: 4 } }, 'Phone camera → scan → Safari opens the site and uses the login embedded in the QR. Anyone who photographs the card can open the tunnel, so disable it when you are done.'),
            state.qr !== null && state.qr !== undefined && state.qr !== '' ? React.createElement('div', { style: { marginTop: 8, background: '#fff', padding: 10, borderRadius: 8, display: 'inline-block' } },
              React.createElement('img', { src: state.qr, width: 240, height: 240, alt: 'QR code to scan with your phone', style: { display: 'block' } })) : null
          ) : null,
          poolBlock,
          React.createElement('div', { style: { marginTop: 8 } },
            React.createElement('button', { style: btnStyle, disabled: busy || state === null, onClick: onToggle }, enabled ? 'Disable tunnel' : 'Enable tunnel'))
        )
      }

      return React.createElement('div', null,
        panel,
        React.createElement('button', {
          style: pillStyle,
          ref: pillRef,
          title: enabled ? 'Tunnel pool (enabled)' : 'Tunnel pool (disabled)',
          onPointerDown: function (e) {
            dragRef.current = { startY: e.clientY, startTop: topPos === null ? Math.max(2, window.innerHeight - 16 - 34) : topPos }
            try { if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId) } catch (err) {}
          },
          onPointerMove: function (e) {
            if (dragRef.current === null) return
            var dy = e.clientY - dragRef.current.startY
            if (Math.abs(dy) > 4) movedRef.current = true
            setTopPos(Math.max(2, Math.min(window.innerHeight - 36, dragRef.current.startTop + dy)))
          },
          onPointerUp: function () {
            dragRef.current = null
            try { localStorage.setItem('pt-pill-top', String(topPos === null ? Math.max(2, window.innerHeight - 16 - 34) : topPos)) } catch (e) {}
          },
          onPointerCancel: function () { dragRef.current = null },
          onClick: function () {
            if (movedRef.current) { movedRef.current = false; return }
            setOpen(!open)
          }
        },
          React.createElement('span', { style: { position: 'absolute', top: 1, right: 1, width: 7, height: 7, borderRadius: 999, background: enabled ? '#2ea043' : '#d73a49', boxShadow: '0 0 0 1.5px rgba(255,255,255,0.85), 0 1px 2px rgba(0,0,0,0.3)' } }),
          React.createElement('span', { style: iconStyle }, '📱')
        )
      )
    }

    var apply = function (ctx) {
      var slotsComponent = ctx.get('slots')
      if (slotsComponent === undefined) return
      slotsComponent.inject('shell.overlay', function () {
        return slotsComponent.register({ name: 'shell.overlay', id: 'phone-tunnel-pool', order: 100, label: 'Tunnel pool' }, function () {
          return React.createElement(TunnelWidget, null)
        })
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
