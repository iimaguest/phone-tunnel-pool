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

    // i18n: follow the locale chosen in dsh Settings -> General -> Language
    // (the dsh locale service publishes active = 'en' | 'zh'; en is the
    // fallback for anything untranslated).
    var TRANSLATIONS = {
      en: {
        title: 'Cloudflare Tunnel — Phone access',
        refresh: '↻ refresh',
        refreshTitle: 'Refresh status (re-checks installed prerequisites)',
        moreTitle: 'More settings',
        more: 'more', less: 'less',
        status: 'Status: ', loading: 'loading…', working: ' (working…)',
        pEnabled: 'enabled', pDisabled: 'disabled', pStarting: 'starting', pStopping: 'stopping', pError: 'error',
        prereq: 'Prereq missing: ', copy: 'copy', copied: '✓ copied',
        err: 'Error: ',
        caf: 'Keep machine awake while enabled (next Enable)',
        aen: 'Start tunnel when dsh web starts (next start)',
        maxGens: 'Max generations (×2 tunnels, next Enable)',
        rotate: 'Rotate hostname every:',
        reset: function (d) { return 'Reset to default (' + d + ')' },
        info: function (port) { return 'Target 127.0.0.1:' + port + ' — env overrides: DSH_TARGET_PORT, DSH_CLOUDFLARED, DSH_IDLE_MS' },
        live: '⚠ Live on the internet — anyone with the QR can use dsh web. Disable when done.',
        urlLabel: 'URL — type on your phone, or scan the QR:',
        loginLabel: 'Login (username / password):',
        phone: 'Phone camera → scan → Safari opens the site and uses the login embedded in the QR. Anyone who photographs the card can open the tunnel, so disable it when you are done.',
        enable: 'Enable tunnel', disable: 'Disable tunnel',
        poolTitle: function (v, n, g) { return 'Pool — cloudflared ' + (v || '?') + ' · ' + n + ' gens live · current gen ' + g },
        poolHint: 'automatic pool chase: a dead hostname redirects to a live sibling; idle generations retire on their own.',
        pillEn: 'Tunnel pool (enabled)', pillDis: 'Tunnel pool (disabled)',
        tabs: ' tabs:', ws: ' ws:', clients: ' clients:'
      },
      zh: {
        title: 'Cloudflare 隧道 — 手机访问',
        refresh: '↻ 刷新',
        refreshTitle: '刷新状态（重新检查已安装的前置依赖）',
        moreTitle: '更多设置',
        more: '更多', less: '收起',
        status: '状态：', loading: '加载中…', working: '（工作中…）',
        pEnabled: '已启用', pDisabled: '已禁用', pStarting: '启动中', pStopping: '停止中', pError: '错误',
        prereq: '缺少前置依赖：', copy: '复制', copied: '✓ 已复制',
        err: '错误：',
        caf: '启用时保持机器唤醒（下次启用生效）',
        aen: 'dsh web 启动时自动开启隧道（下次启动生效）',
        maxGens: '最大代次数（每代 2 条隧道，下次启用生效）',
        rotate: '更换主机名周期：',
        reset: function (d) { return '恢复默认（' + d + '）' },
        info: function (port) { return '目标 127.0.0.1:' + port + ' — 环境变量覆盖：DSH_TARGET_PORT、DSH_CLOUDFLARED、DSH_IDLE_MS' },
        live: '⚠ 已公网开放 — 任何扫到二维码的人都能使用 dsh web，用完后请禁用。',
        urlLabel: 'URL — 在手机上输入，或扫描二维码：',
        loginLabel: '登录（用户名 / 密码）：',
        phone: '手机相机 → 扫码 → Safari 打开站点并使用二维码中嵌入的登录信息。任何拍到这张卡片的人都能打开隧道，所以用完后请禁用。',
        enable: '启用隧道', disable: '禁用隧道',
        poolTitle: function (v, n, g) { return '池 — cloudflared ' + (v || '?') + ' · 活跃 ' + n + ' 代 · 当前第 ' + g + ' 代' },
        poolHint: '自动池追踪：失效的主机名会重定向到存活的兄弟隧道；空闲代会自动退役。',
        pillEn: '隧道池（已启用）', pillDis: '隧道池（已禁用）',
        tabs: ' 标签:', ws: ' 连接:', clients: ' 客户端:'
      }
    }
    var t = function (lang, key, a, b, c) {
      var d = TRANSLATIONS[lang]
      if (!d) d = TRANSLATIONS.en
      var v = d[key]
      if (v === undefined) { v = TRANSLATIONS.en[key] }
      if (typeof v === 'function') return v(a, b, c)
      return typeof v === 'string' ? v : String(key)
    }
    var phaseLabel = function (lang, phase) {
      if (phase === 'enabled') return t(lang, 'pEnabled')
      if (phase === 'disabled') return t(lang, 'pDisabled')
      if (phase === 'starting') return t(lang, 'pStarting')
      if (phase === 'stopping') return t(lang, 'pStopping')
      if (phase === 'error') return t(lang, 'pError')
      return phase
    }
    // Guaranteed signal: the dsh locale plugin keeps <html lang> in sync with
    // the Settings choice ('zh-CN' | 'en'); used when the locale service is
    // not reachable from this plugin's context.
    var localeFromDom = function () {
      try {
        var l = document.documentElement.lang || ''
        return l.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (e) { return 'en' }
    }

    var TunnelWidget = function TunnelWidget(props) {
      // active locale from the dsh locale service ('en' | 'zh'); re-render when
      // the user changes Settings -> General -> Language.
      var localeService = props && props.localeService ? props.localeService : null
      var langSt = React.useState(function () {
        try {
          if (localeService !== null) {
            var snap = localeService.getLocale()
            if (snap && snap.active) return snap.active === 'zh' || snap.active === 'en' ? snap.active : localeFromDom()
          }
        } catch (e) {}
        return localeFromDom()
      })
      var lang = langSt[0]
      var setLang = langSt[1]
      React.useEffect(function () {
        if (localeService !== null && typeof localeService.subscribe === 'function') {
          return localeService.subscribe(function () {
            try {
              var snap = localeService.getLocale()
              setLang(snap && snap.active ? snap.active : localeFromDom())
            } catch (e) {}
          })
        }
        // fallback: watch <html lang> (kept in sync by the dsh locale plugin)
        try {
          var mo = new MutationObserver(function () { setLang(localeFromDom()) })
          mo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
          return function () { mo.disconnect() }
        } catch (e) { return undefined }
      }, [])
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
      // right edge; free anywhere vertically). topPos null = bottom-right default.
      // Restored positions are clamped so a smaller window can't hide the pill.
      var topSt = React.useState(function () {
        try {
          var v = Number(localStorage.getItem('pt-pill-top'))
          if (isNaN(v) || v === 0) return null
          return Math.max(2, Math.min(window.innerHeight - 36, v))
        } catch (e) { return null }
      })
      var topPos = topSt[0]
      var setTopPos = topSt[1]
      var copiedSt = React.useState('')
      var copiedKey = copiedSt[0]
      var setCopiedKey = copiedSt[1]
      var moreSt = React.useState(false)
      var more = moreSt[0]
      var setMore = moreSt[1]
      var refrSt = React.useState('')
      var refrTick = refrSt[0]
      var setRefrTick = refrSt[1]
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
      // a missing prereq is already explained by the yellow warning line; the
      // red error line is reserved for unexpected failures (daemon crash,
      // timeout, port conflict) so the two don't duplicate each other.
      var anyMissing = state !== null && state.prereqs ? Object.keys(state.prereqs).some(function (k) {
        var pp = state.prereqs[k]
        return pp !== null && pp !== undefined && pp.ok === false
      }) : false
      // follow the app's theme (light/dark) so the popup blends in; the dark
      // palette is exactly the previously finalized look.
      var appTheme = (function () {
        try {
          var cs = getComputedStyle(document.documentElement).colorScheme || 'light'
          if (cs.indexOf('dark') >= 0) return 'dark'
          var m = getComputedStyle(document.body).backgroundColor
          var mm = m.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
          if (mm) { var lum = 0.2126 * +mm[1] + 0.7152 * +mm[2] + 0.0722 * +mm[3]; if (lum < 100) return 'dark' }
          return 'light'
        } catch (e) { return 'dark' }
      })()
      var P = appTheme === 'light'
        ? {
          bg: 'rgba(252,252,253,0.97)', fg: '#1f2328',
          border: 'rgba(0,0,0,0.16)', btnBorder: 'rgba(0,0,0,0.18)', btnText: 'rgba(40,46,52,0.9)',
          rowDiv: 'rgba(0,0,0,0.10)', inputBg: '#ffffff', selectBg: '#ffffff',
          warn: '#9a6700', accent: '#9a6700', err: '#b91c1c', ok: '#1a7f37', dead: '#b31d28', cur: '#1a7f37',
          muted: 'rgba(87,96,106,0.9)', dim: 'rgba(87,96,106,0.95)', dim2: 'rgba(87,96,106,0.7)',
          shadow: 'rgba(0,0,0,0.15)', scroll: 'rgba(0,0,0,0.28)'
        }
        : {
          bg: 'rgba(24,26,30,0.96)', fg: '#e8e8e8',
          border: 'rgba(128,128,128,0.4)', btnBorder: 'rgba(170,170,170,0.4)', btnText: 'rgba(220,220,220,0.9)',
          rowDiv: 'rgba(128,128,128,0.25)', inputBg: '#111111', selectBg: '#1c1c1c',
          warn: '#d4a72c', accent: '#d4a72c', err: '#e08080', ok: '#2ea043', dead: '#d73a49', cur: '#7ee787',
          muted: 'rgba(155,155,155,0.9)', dim: 'rgba(170,170,170,0.95)', dim2: 'rgba(170,170,170,0.75)',
          shadow: 'rgba(0,0,0,0.4)', scroll: 'rgba(255,255,255,0.28)'
        }
      var pillStyle = { position: 'fixed', right: 16, top: topPos === null ? undefined : topPos, bottom: topPos === null ? 16 : undefined, zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'system-ui, sans-serif', fontSize: 20, touchAction: 'none', userSelect: 'none' }
      // subtle state from the icon itself: green glow when the tunnel is live,
      // desaturated/dim when disabled
      var iconStyle = enabled
        ? { textShadow: '0 0 7px rgba(46,160,67,0.65)' }
        : { filter: 'grayscale(1) opacity(0.6)', textShadow: '0 1px 3px rgba(0,0,0,0.35)' }
      var panelStyle = { position: 'fixed', right: 16, bottom: 64, zIndex: 9000, width: 340, maxWidth: 'calc(100vw - 32px)', maxHeight: 'min(72vh, 560px)', overflowY: 'auto', WebkitOverflowScrolling: 'touch', padding: 12, borderRadius: 12, border: '1px solid ' + P.border, background: P.bg, color: P.fg, fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.5, boxShadow: '0 8px 28px ' + P.shadow }
      var btnStyle = { padding: '8px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, color: '#fff', background: enabled ? '#b23b3b' : '#2f7d43' }
      var inputStyle = { width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 12, padding: 6, borderRadius: 6, border: '1px solid ' + P.border, marginTop: 2, background: P.inputBg, color: P.fg }
      // theme-matched scrollbar inside the popup (color-scheme default looks alien)
      React.useEffect(function () {
        var st = document.getElementById('pt-scroll-style')
        var css = '.pt-panel::-webkit-scrollbar{width:8px;height:8px}.pt-panel::-webkit-scrollbar-thumb{background:' + P.scroll + ';border-radius:8px}.pt-panel::-webkit-scrollbar-track{background:transparent}.pt-panel{scrollbar-width:thin;scrollbar-color:' + P.scroll + ' transparent}' +
          '.pt-pill .pt-dot{transition:opacity .15s ease}.pt-pill .pt-dot-dim{opacity:0}.pt-pill:hover .pt-dot-dim{opacity:1}'
        if (st === null) { st = document.createElement('style'); st.id = 'pt-scroll-style'; document.head.appendChild(st) }
        st.textContent = css
      }, [appTheme])

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
              rows.push(React.createElement('div', { key: g.gen + '/' + t.id, style: { padding: '4px 0', borderTop: '1px solid ' + P.rowDiv, fontSize: 12, fontFamily: 'monospace' } },
                React.createElement('span', { style: { color: g.status === 'current' ? P.cur : P.muted } }, 'gen' + g.gen + '/' + t.id),
                ' ' + (t.host || '?').replace(/\.trycloudflare\.com$/, '…'),
                g.status === 'current' ? ' ★' : (g.status === 'retired' ? ' ⏹' : ' ▶'),
                React.createElement('span', { style: { color: t.healthy ? P.ok : P.dead } }, ' ●'),
                u ? React.createElement('span', { style: { color: P.dim } },
                  t(lang, 'tabs') + ' ' + (u.tabs || 0) + t(lang, 'ws') + ' ' + (u.ws || 0) + t(lang, 'clients') + ' ' + (u.clients || 0) + ' ' + fmtAgo(u.lastSeen)) : null
              ))
            })
          })
          var liveCount = state.pool.gens.filter(function (g) { return g.status !== 'retired' }).length
          poolBlock = React.createElement('div', { style: { marginTop: 10 } },
            React.createElement('div', { style: { fontWeight: 700, marginBottom: 2 } },
              t(lang, 'poolTitle', state.pool.cloudflaredVersion || '?', liveCount, state.pool.gen)),
            React.createElement('div', { style: { fontSize: 11, color: P.dim, marginBottom: 4 } },
              t(lang, 'poolHint')),
            rows
          )
        }
        panel = React.createElement('div', { style: panelStyle, ref: panelRef, className: 'pt-panel' },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            React.createElement('div', { style: { fontWeight: 700, flex: 1 } }, t(lang, 'title')),
            React.createElement('button', {
              style: { background: 'transparent', border: '1px solid ' + P.btnBorder, color: P.btnText, borderRadius: 4, fontSize: 12, padding: '1px 8px', cursor: 'pointer', lineHeight: 1.4 },
              'aria-label': t(lang, 'refreshTitle'),
              title: t(lang, 'refreshTitle'),
              onClick: function () {
                fetch('/iptunnel/refresh', { method: 'POST', headers: { accept: 'application/json' } })
                  .then(function (r) { if (!r.ok) throw new Error('refresh ' + r.status); return r.json() })
                  .then(function (s2) { setState(s2); setRefrTick('✓'); setTimeout(function () { setRefrTick('') }, 1200) })
                  .catch(function (e2) { setErr(String(e2 && e2.message ? e2.message : e2)) })
              }
            }, refrTick || t(lang, 'refresh')),
            React.createElement('button', {
              style: { background: 'transparent', border: '1px solid ' + P.btnBorder, color: P.btnText, borderRadius: 4, fontSize: 12, padding: '1px 8px', cursor: 'pointer', lineHeight: 1.4 },
              'aria-label': 'More settings',
              title: t(lang, 'moreTitle'),
              onClick: function () { setMore(!more) }
            }, more ? t(lang, 'less') : t(lang, 'more'))),
          React.createElement('div', { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 } },
            React.createElement('button', { style: btnStyle, disabled: busy || state === null, onClick: onToggle }, enabled ? t(lang, 'disable') : t(lang, 'enable')),
            React.createElement('div', { style: { fontSize: 12, color: P.dim2 } }, t(lang, 'status') + (state === null ? t(lang, 'loading') : phaseLabel(lang, state.phase)) + (busy ? t(lang, 'working') : ''))),
          state !== null && state.prereqs ? Object.keys(state.prereqs).map(function (k) {
            var p = state.prereqs[k]
            if (p === null || p === undefined || p.ok) return null
            return React.createElement('div', { key: k, style: { color: P.warn, marginTop: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } },
              React.createElement('span', { style: { flex: 1 } }, t(lang, 'prereq') + (p.hint || k)),
              p.cmd ? React.createElement('button', {
                style: { background: 'transparent', border: '1px solid ' + P.accent, color: P.warn, borderRadius: 4, fontSize: 11, padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap' },
                'aria-label': 'Copy install command',
                onClick: function () {
                  try {
                    var done = function () { setCopiedKey(k === copiedKey ? '' : k); setTimeout(function () { setCopiedKey('') }, 1500) }
                    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(p.cmd).then(done, function () {})
                    else done()
                  } catch (e) {}
                }
              }, copiedKey === k ? t(lang, 'copied') : t(lang, 'copy')) : null)
          }) : null,
          state !== null && state.error && !anyMissing ? React.createElement('div', { style: { color: P.err, marginTop: 4 } }, t(lang, 'err') + state.error) : null,
          err !== null ? React.createElement('div', { style: { color: P.err, marginTop: 4 } }, t(lang, 'err') + err) : null,
          state !== null && state.settings && more ? (function () {
            var stg = state.settings
            var save = function (next) {
              fetch('/iptunnel/settings?c=' + (next.caffeinate ? 1 : 0) + '&ae=' + (next.autoEnable ? 1 : 0) + '&mg=' + Number(next.maxGens) + '&rot=' + Number(next.rotateH), { method: 'POST', headers: { accept: 'application/json' } })
                .then(function (r) { if (!r.ok) throw new Error('settings ' + r.status); return r.json() })
                .then(function (s) { setState(s) }).catch(function (err2) { setErr(String(err2 && err2.message ? err2.message : err2)) })
            }
            var L = function (style) { return style || {} }
            var slider = function (key, label, val, min, max, dflt, fmt) {
              return React.createElement('div', { key: key, style: L({ display: 'grid', gap: 2 }) },
                React.createElement('span', null, label),
                React.createElement('div', { style: L({ display: 'flex', alignItems: 'center', gap: 6 }) },
                  React.createElement('input', { type: 'range', min: min, max: max, step: 1, value: val, style: L({ flex: 1, cursor: 'pointer', accentColor: P.accent }),
                    onChange: function (e) { var n = {}; n[key] = Number(e.target.value); save(Object.assign({}, cur, n)) } }),
                  React.createElement('span', { style: L({ fontSize: 11, color: P.dim2, minWidth: 44, textAlign: 'right' }) }, fmt(val)),
                  React.createElement('button', {
                    style: L({ background: 'transparent', border: '1px solid ' + P.btnBorder, color: P.btnText, borderRadius: 4, fontSize: 11, padding: '1px 6px', cursor: 'pointer', opacity: val === dflt ? 0.35 : 1 }),
                    'aria-label': 'Reset ' + label + ' to default',
                    title: t(lang, 'reset', fmt(dflt)),
                    onClick: function () { var n = {}; n[key] = dflt; save(Object.assign({}, cur, n)) }
                  }, '↺')
                ))
            }
            var cur = { caffeinate: !!stg.caffeinate, autoEnable: !!stg.autoEnable, maxGens: Number(stg.maxGens), rotateH: Number(stg.rotateH) }
            var fmtH = function (h) { return h >= 24 ? (Math.floor(h / 24) + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '')) : (h + 'h') }
            var rows = []
            if (state.os === 'darwin') rows.push(React.createElement('label', { key: 'c', style: L({ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
              React.createElement('input', { type: 'checkbox', checked: !!stg.caffeinate, style: { cursor: 'pointer' }, onChange: function (e) { save(Object.assign({}, cur, { caffeinate: e.target.checked })) } }),
              React.createElement('span', null, t(lang, 'caf'))))
            rows.push(React.createElement('label', { key: 'ae', style: L({ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }) },
              React.createElement('input', { type: 'checkbox', checked: !!stg.autoEnable, style: { cursor: 'pointer' }, onChange: function (e) { save(Object.assign({}, cur, { autoEnable: e.target.checked })) } }),
              React.createElement('span', null, t(lang, 'aen'))))
            rows.push(slider('maxGens', t(lang, 'maxGens'), stg.maxGens, 2, 8, 4, function (v) { return String(v) }))
            rows.push(slider('rotateH', t(lang, 'rotate'), stg.rotateH, 4, 168, 12, fmtH))
            rows.push(React.createElement('div', { key: 'info', style: L({ fontSize: 11, color: P.dim2, marginTop: 4 }) },
              t(lang, 'info', state.targetPort || '3080')))
            return React.createElement('div', { style: { marginTop: 8, fontSize: 12, color: P.dim, display: 'grid', gap: 6 } }, rows)
          })() : null,
          enabled && state !== null && state.phase === 'enabled' ? React.createElement('div', { style: { color: P.warn, marginTop: 6, fontSize: 11, maxWidth: 300 } },
            t(lang, 'live')) : null,
          enabled && state !== null && state.url ? React.createElement('div', null,
            React.createElement('div', { style: { marginTop: 8 } }, t(lang, 'urlLabel')),
            React.createElement('input', { readOnly: true, value: state.url, style: inputStyle }),
            React.createElement('div', { style: { marginTop: 8 } }, t(lang, 'loginLabel')),
            React.createElement('input', { readOnly: true, value: state.username + ' / ' + state.password, style: inputStyle }),
            React.createElement('div', { style: { fontSize: 11, color: P.dim, marginTop: 4 } }, t(lang, 'phone')),
            state.qr !== null && state.qr !== undefined && state.qr !== '' ? React.createElement('div', { style: { marginTop: 8, background: '#fff', padding: 10, borderRadius: 8, display: 'inline-block' } },
              React.createElement('img', { src: state.qr, width: 240, height: 240, alt: 'QR code to scan with your phone', style: { display: 'block' } })) : null
          ) : null,
          poolBlock
        )
      }

      return React.createElement('div', null,
        panel,
        React.createElement('button', {
          style: pillStyle,
          ref: pillRef,
          className: 'pt-pill',
          title: enabled ? t(lang, 'pillEn') : t(lang, 'pillDis'),
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
            // persist ONLY when the user actually repositioned it (a plain
            // click/tap must not bake the default into storage). movedRef is
            // cleared by onClick — do NOT clear it here.
            if (movedRef.current) {
              try { localStorage.setItem('pt-pill-top', String(topPos === null ? Math.max(2, window.innerHeight - 16 - 34) : topPos)) } catch (e) {}
            }
          },
          onPointerCancel: function () { dragRef.current = null },
          onClick: function () {
            if (movedRef.current) { movedRef.current = false; return }
            setOpen(!open)
          }
        },
          React.createElement('span', { className: 'pt-dot' + (enabled ? '' : ' pt-dot-dim'), style: { position: 'absolute', top: 1, right: 1, width: 6, height: 6, borderRadius: 999, background: enabled ? '#2ea043' : '#d73a49', boxShadow: '0 0 0 1.5px rgba(255,255,255,0.85), 0 1px 2px rgba(0,0,0,0.3)' } }),
          React.createElement('span', { style: iconStyle }, '📱')
        )
      )
    }

    var apply = function (ctx) {
      var slotsComponent = ctx.get('slots')
      if (slotsComponent === undefined) return
      var localeService = null
      try {
        var ls = ctx.get('locale')
        if (ls !== undefined && typeof ls.getLocale === 'function') localeService = ls
      } catch (e) {}
      slotsComponent.inject('shell.overlay', function () {
        return slotsComponent.register({ name: 'shell.overlay', id: 'phone-tunnel-pool', order: 100, label: 'Tunnel pool' }, function () {
          return React.createElement(TunnelWidget, { localeService: localeService })
        })
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
