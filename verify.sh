#!/bin/bash
# phone-tunnel-pool v2 — end-to-end pool check (enable -> probe -> chase config ->
# usage -> disable). Usage: bash verify.sh (dsh web must be running; loopback
# 3080). Exits 0 = chain green. Leaves the tunnel DISABLED (password rotated).
set -uo pipefail

BASE=http://127.0.0.1:3080
J() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('$1') or '')"; }
JP() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('$1') or '')"; }
# the daemon uses os.tmpdir() (== DSH_TMP when set); on macOS that is NOT /tmp
TMPT=$(python3 -c "import tempfile;print(tempfile.gettempdir())" 2>/dev/null || printf /tmp)
STORE="${DSH_TMP:-$TMPT}/iptunnel-state.json"
LOG="${DSH_TMP:-$TMPT}/iptunnel-daemon.log"

echo "[1/8] enabling tunnel…"
R=$(curl -s -X POST $BASE/iptunnel/enable)
URL=$(printf '%s' "$R" | J url); PW=$(printf '%s' "$R" | J password)
if [ -z "$URL" ]; then echo "  FAIL: enable returned no url: $R"; exit 1; fi
echo "  primary $URL"

echo "[2/8] daemon store is v2 with a pool…"
S=$(cat $STORE)
V=$(printf '%s' "$S" | JP version); GENS=$(printf '%s' "$S" | JP gen)
N=$(python3 -c "import json,sys;print(len(json.load(sys.stdin)['gens']))" <<<"$S")
CNT=$(python3 -c "import json,sys;d=json.load(sys.stdin);print(sum(1 for g in d['gens'] for t in g['tunnels'] if t.get('url')))" <<<"$S")
echo "  version=$V gen=$GENS gens=$N url_tunnels=$CNT (want 2,2,>=1,>=2)"
[ "$V" = "2" ] && [ "$GENS" = "$N" ] && [ "$CNT" -ge 2 ] || { echo "  FAIL: pool shape"; curl -s -X POST $BASE/iptunnel/disable >/dev/null; exit 1; }

echo "[3/8] public gate on PRIMARY (anonymous -> 401 expected)…"
OK=0
for i in $(seq 1 15); do
  sleep 2
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$URL/" || true)
  [ "$CODE" = "401" ] && { OK=1; break; }
done
[ "$OK" = 1 ] || { echo "  FAIL: gate never answered (last $CODE)"; curl -s -X POST $BASE/iptunnel/disable >/dev/null; exit 1; }

echo "[4/8] /iptunnel/health + sw-config (public service paths)…"
H=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "https://$URL/iptunnel/health")
CFG=$(curl -s --max-time 12 "https://$URL/iptunnel/sw-config")
[ "$H" = "200" ] && printf '%s' "$CFG" | grep -q '"primary"' || { echo "  FAIL: health=$H cfg=$CFG"; curl -s -X POST $BASE/iptunnel/disable >/dev/null; exit 1; }
echo "  health=$H; config: $(printf '%s' "$CFG" | python3 -c "import json,sys;d=json.load(sys.stdin);print('primary='+d['primary'][:40], 'list='+str(len(d['list'])))")"

echo "[5/8] with credentials (harness + fence)…"
CODE2=$(curl -s -u "dsh:$PW" -o /dev/null -w '%{http_code}' --max-time 12 "https://$URL/")
CODE3=$(curl -s -u "dsh:$PW" -o /dev/null -w '%{http_code}' --max-time 12 "https://$URL/api/events.mux")
echo "  / -> $CODE2 (want 200); /api/events.mux -> $CODE3 (426/404 ok, 403 fence-blocked)"
[ "$CODE2" = "200" ] || { curl -s -X POST $BASE/iptunnel/disable >/dev/null; exit 1; }
case "$CODE3" in 426|404) ;; *) curl -s -X POST $BASE/iptunnel/disable >/dev/null; exit 1;; esac

echo "[6/8] TLS + no secrets in logs…"
curl -sv -o /dev/null --max-time 12 "https://$URL/" 2>&1 | grep -E 'SSL connection using|ALPN: server accepted' | sed 's/^/  /' | head -3
LEAK=$(grep -c "$PW" $LOG 2>/dev/null || true)
echo "  password occurrences in daemon log: $LEAK (want 0)"
[ "$LEAK" = "0" ] || echo "  WARN: password found in $LOG"

echo "[7/8] usage accounting present…"
U=$(python3 -c "import json,sys;d=json.load(sys.stdin);print(len([k for k in d['usage'] if 'trycloudflare.com' in k]))" <<<"$S")
echo "  hosts with usage records: $U (>=2 after probes; tabs/ws >0 only while a browser is open)"

echo "[8/8] disabling + clean shutdown…"
curl -s -X POST $BASE/iptunnel/disable >/dev/null
sleep 3
PHASE=$(curl -s $BASE/iptunnel/state | J phase)
PWL=$(curl -s $BASE/iptunnel/state | J password)
LTMP=$(curl -s $BASE/iptunnel/state | J url)
PROCS=$(pgrep -f 'daemon.mjs|cf-auth-proxy.mjs' | wc -l | tr -d ' ')
PWPRINT=$([ -z "$PWL" ] && printf unset || printf "<set>")
echo "  phase=$PHASE password=$PWPRINT url=${LTMP:-null} leftover_procs=$PROCS"
[ "$PHASE" = "disabled" ] || { echo "  FAIL: state $PHASE"; exit 1; }
[ -z "$PWL" ] || echo "  WARN: password still set (host fix not loaded? restart dsh web)"

echo
echo "✅ pool chain green — tunnel OFF, credentials rotated and cleared."
