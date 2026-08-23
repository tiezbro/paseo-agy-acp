#!/usr/bin/env bash
# Isolated 6768 stress: product 2.1.0.0 proxy + official kernel + Admission.
# Never touches ~/.paseo or 127.0.0.1:6767.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/ACP Connector/main.js"
OFFICIAL_BIN="${PASEO_AGY_ACP_OFFICIAL_BIN:-$HOME/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary}"
HOST="127.0.0.1:6768"
MARKER="PASEO_STRESS_MARKER_2100"
CONCURRENCY="${STRESS_CONCURRENCY:-6}"
WAIT_TIMEOUT="${STRESS_WAIT_TIMEOUT:-10m}"
TMP_PREFIX="paseo-agy-acp-stress"
TMPHOME="$(mktemp -d "/tmp/${TMP_PREFIX}-XXXXXX")"
WORKDIR="$TMPHOME/work"
ADMISSION_DIR="$TMPHOME/admission"
NODE_BIN="$(command -v node)"
PROD_BEFORE=""
CLEANED=0

run_isolated() {
  local unset_args=()
  local name
  while IFS= read -r name; do
    unset_args+=(-u "$name")
  done < <(env | awk -F= '/^PASEO_/ {print $1}')
  if [[ "${#unset_args[@]}" -eq 0 ]]; then
    "$@"
  else
    env "${unset_args[@]}" "$@"
  fi
}

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  run_isolated paseo daemon stop --home "$TMPHOME" --timeout 20 --json >/dev/null 2>&1 || true
  if curl -sS --max-time 1 "http://$HOST/api/health" >/dev/null 2>&1; then
    run_isolated paseo daemon stop --home "$TMPHOME" --timeout 5 --force --json >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPHOME"
}

trap cleanup EXIT INT TERM

fingerprint_prod() {
  run_isolated paseo daemon status --home "$HOME/.paseo" --json
}

require_prod_unchanged() {
  local after
  after="$(fingerprint_prod)"
  python3 -c 'import json,sys
before=json.loads(sys.argv[1]); after=json.loads(sys.argv[2])
for key in ("pid","listen","home","startedAt","serverId"):
    if before.get(key)!=after.get(key):
        raise SystemExit("production daemon changed: %s %r -> %r"%(key, before.get(key), after.get(key)))
print("production daemon fingerprint unchanged")' "$PROD_BEFORE" "$after"
}

[[ -f "$CLI" ]] || { echo "missing built CLI: $CLI" >&2; exit 1; }
[[ -x "$OFFICIAL_BIN" ]] || { echo "missing official wrapper: $OFFICIAL_BIN" >&2; exit 1; }
[[ -x "$NODE_BIN" ]] || { echo "node not found" >&2; exit 1; }

if curl -sS --max-time 1 "http://$HOST/api/health" >/dev/null 2>&1; then
  echo "refusing to run: $HOST is already listening" >&2
  exit 1
fi

PROD_BEFORE="$(fingerprint_prod)"
python3 -c 'import json,sys
before=json.loads(sys.argv[1])
if before.get("listen")!="127.0.0.1:6767":
    raise SystemExit("refusing to run: production listen is %r"%before.get("listen"))
print("production guard: pid=%s listen=%s"%(before.get("pid"), before.get("listen")))' "$PROD_BEFORE"

mkdir -p "$WORKDIR"
mkdir -m 0700 "$ADMISSION_DIR"
cat > "$TMPHOME/config.json" <<EOF
{
  "version": 1,
  "daemon": {
    "listen": "$HOST",
    "mcp": { "injectIntoAgents": false },
    "browserTools": { "enabled": false },
    "appendSystemPrompt": "Isolated stress daemon context. Token: $MARKER. Do not mention secrets."
  },
  "agents": {
    "providers": {
      "antigravity-official-product": {
        "extends": "acp",
        "label": "Antigravity Official Product",
        "command": ["$NODE_BIN", "$CLI"],
        "env": {
          "PASEO_AGY_ACP_KERNEL": "official",
          "PASEO_AGY_ACP_OFFICIAL_BIN": "$OFFICIAL_BIN",
          "AGY_ACP_ADMISSION_ENABLED": "true",
          "AGY_ACP_STATE_DIR": "$ADMISSION_DIR"
        },
        "enabled": true
      }
    }
  }
}
EOF

BEFORE_TMP="$(find /tmp -maxdepth 1 -name "${TMP_PREFIX}-*" -printf '%p\n' 2>/dev/null | sort)"

run_isolated paseo start --home "$TMPHOME" --listen "$HOST" --no-relay --no-web-ui
for _ in $(seq 1 40); do
  if curl -sS --max-time 1 "http://$HOST/api/health" | grep -q '"status":"ok"'; then
    break
  fi
  sleep 0.25
done
curl -sS --max-time 2 "http://$HOST/api/health" | grep -q '"status":"ok"'
echo "isolated daemon ready on $HOST"

pids=()
for i in $(seq 1 "$CONCURRENCY"); do
  agent_dir="$WORKDIR/agent-$i"
  mkdir -p "$agent_dir"
  token="STRESS_OK_$i"
  run_isolated paseo run --host "$HOST" \
    --provider antigravity-official-product \
    --mode yolo \
    --cwd "$agent_dir" \
    --label "stress=official-kernel-2.1.0.0" \
    --label "n=$i" \
    --wait-timeout "$WAIT_TIMEOUT" \
    --json \
    "Reply with exactly $token on the first line. If you can see a daemon system context containing $MARKER, print CONTEXT_SEEN on the second line. No other text." \
    >"$TMPHOME/run-$i.json" 2>"$TMPHOME/run-$i.err" &
  pids+=("$!")
done

fail=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "one or more paseo run processes failed" >&2
  for i in $(seq 1 "$CONCURRENCY"); do
    echo "--- run-$i.err ---" >&2
    cat "$TMPHOME/run-$i.err" >&2 || true
    echo "--- run-$i.json ---" >&2
    cat "$TMPHOME/run-$i.json" >&2 || true
  done
  exit 1
fi

python3 -c 'import json,os,re,sys
concurrency=int(sys.argv[1]); marker=sys.argv[2]; home=sys.argv[3]
ids=[]
for i in range(1, concurrency+1):
    token="STRESS_OK_%d"%i
    payload=json.loads(open(os.path.join(home,"run-%d.json"%i), encoding="utf8").read())
    status=payload.get("status")
    agent_id=payload.get("id") or payload.get("agentId") or payload.get("agent_id")
    if status not in ("completed","idle"):
        raise SystemExit("agent %s status %r payload=%s"%(i, status, payload))
    if not isinstance(agent_id,str) or not agent_id:
        raise SystemExit("agent %s missing id: %s"%(i, payload))
    ids.append(agent_id)
    open(os.path.join(home,"id-%d.txt"%i),"w",encoding="utf8").write(agent_id)
print("all %d runs returned completed/idle"%concurrency)
print("AGENT_IDS %s"%(" ".join(ids)))
' "$CONCURRENCY" "$MARKER" "$TMPHOME"

for i in $(seq 1 "$CONCURRENCY"); do
  agent_id="$(cat "$TMPHOME/id-$i.txt")"
  token="STRESS_OK_$i"
  logs="$(run_isolated paseo logs "$agent_id" --host "$HOST")"
  printf '%s\n' "$logs" >"$TMPHOME/logs-$i.txt"
  python3 -c 'import json,os,re,sys
token, marker, log_path, home = sys.argv[1:5]
logs=open(log_path, encoding="utf8").read()
lines=logs.splitlines()
last_meta=-1
for index, line in enumerate(lines):
    if re.match(r"^\[(Thought|Shell|Read|Tool|Error|Warning)\b", line):
        last_meta=index
final="\n".join(lines[last_meta+1:]).strip()
if token not in final:
    raise SystemExit("token %s missing from final message:\n%s"%(token, final[:800]))
print("token %s present in final message"%token)
matches=[]
for root, _, files in os.walk(os.path.join(home,"agents")):
    for name in files:
        if name.endswith(".json"):
            matches.append(os.path.join(root,name))
if not matches:
    raise SystemExit("no isolated agent state files")
found=False
for path in matches:
    state=json.loads(open(path, encoding="utf8").read())
    prompt=((state.get("persistence") or {}).get("metadata") or {}).get("daemonAppendSystemPrompt") or ""
    if marker in str(prompt):
        found=True
        break
if not found:
    raise SystemExit("daemonAppendSystemPrompt missing isolated marker")
print("agent state has daemonAppendSystemPrompt marker")
' "$token" "$MARKER" "$TMPHOME/logs-$i.txt" "$TMPHOME"
done

LS_JSON="$(run_isolated paseo ls --global --json --host "$HOST")"
printf '%s\n' "$LS_JSON" >"$TMPHOME/ls.json"
python3 -c 'import json,sys
payload=json.loads(sys.argv[1])
agents=payload if isinstance(payload,list) else payload.get("agents") or []
print("isolated global agent count %d"%len(agents))
if len(agents)<int(sys.argv[2]):
    raise SystemExit("expected at least %s isolated agents"%sys.argv[2])
' "$LS_JSON" "$CONCURRENCY"

require_prod_unchanged

AFTER_TMP="$(find /tmp -maxdepth 1 -name "${TMP_PREFIX}-*" -printf '%p\n' 2>/dev/null | sort)"
python3 -c 'import sys
before=set(sys.argv[1].splitlines()); after=set(sys.argv[2].splitlines()); home=sys.argv[3]
new=sorted(path for path in after-before if path!=home)
if new:
    raise SystemExit("new /tmp leftovers: %s"%new)
print("no extra /tmp leftovers besides current home")
' "$BEFORE_TMP" "$AFTER_TMP" "$TMPHOME"

echo "ISOLATED_OFFICIAL_KERNEL_STRESS_OK concurrency=$CONCURRENCY"
