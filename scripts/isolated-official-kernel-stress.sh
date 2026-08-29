#!/usr/bin/env bash
# Isolated 6768 stress: product 2.1.0.0 proxy + official kernel + Admission.
# Never touches ~/.paseo or 127.0.0.1:6767.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/ACP Connector/main.js"
OFFICIAL_BIN="${PASEO_AGY_ACP_OFFICIAL_BIN:-$HOME/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary}"
HOST="127.0.0.1:6768"
MARKER="PASEO_STRESS_MARKER_2100"
MAX_ACTIVE_TURNS="${AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS:-}"
MAX_CONCURRENT_STARTS="${AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS:-}"
MIN_START_INTERVAL_MS="${AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS:-}"
CONCURRENCY=""
WAIT_TIMEOUT="${STRESS_WAIT_TIMEOUT:-10m}"
PRESERVE_FAILURE="${STRESS_PRESERVE_FAILURE:-0}"
TMP_PREFIX="paseo-agy-acp-stress"
TMPHOME="$(mktemp -d "/tmp/${TMP_PREFIX}-XXXXXX")"
chmod 700 "$TMPHOME"
WORKDIR="$TMPHOME/work"
ADMISSION_DIR="$TMPHOME/admission"
NODE_BIN="$(command -v node)"
PROD_BEFORE=""
CLEANED=0

require_positive_integer() {
  local value="$1"
  local label="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "$label must be a positive base-10 integer" >&2; exit 1; }
}

require_minimum_interval() {
  local value="$1"
  require_positive_integer "$value" "AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS"
  (( value >= 2000 )) || { echo "AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS must be at least 2000" >&2; exit 1; }
}

require_binary_flag() {
  local value="$1"
  local label="$2"
  [[ "$value" == "0" || "$value" == "1" ]] || {
    echo "$label must be 0 or 1" >&2
    exit 1
  }
}

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

byte_count() {
  local filename="$1"
  if [[ ! -f "$filename" ]]; then
    printf '0'
    return
  fi
  stat -c %s "$filename"
}

report_child_process_results() {
  local ordinal
  local index
  for ordinal in $(seq 1 "$CONCURRENCY"); do
    index="$((ordinal - 1))"
    printf 'isolated run ordinal=%s exit-success=%s stdout-bytes=%s stderr-bytes=%s\n' \
      "$ordinal" \
      "${run_success[$index]}" \
      "$(byte_count "$TMPHOME/run-$ordinal.json")" \
      "$(byte_count "$TMPHOME/run-$ordinal.err")" >&2
  done
}

cleanup() {
  local exit_status="$1"
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  run_isolated paseo daemon stop --home "$TMPHOME" --timeout 20 --json >/dev/null 2>&1 || true
  if curl -sS --max-time 1 "http://$HOST/api/health" >/dev/null 2>&1; then
    run_isolated paseo daemon stop --home "$TMPHOME" --timeout 5 --force --json >/dev/null 2>&1 || true
  fi
  if [[ "$exit_status" -ne 0 && "$PRESERVE_FAILURE" == "1" ]]; then
    chmod 700 "$TMPHOME" 2>/dev/null || true
    printf 'isolated stress failure directory retained at %s (mode 0700); warning: it may contain sensitive local diagnostics and the retention handler does not automatically read or print retained files\n' "$TMPHOME" >&2
  else
    rm -rf "$TMPHOME"
  fi
}

trap 'cleanup "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_binary_flag "$PRESERVE_FAILURE" "STRESS_PRESERVE_FAILURE"
require_positive_integer "$MAX_ACTIVE_TURNS" "AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS"
require_positive_integer "$MAX_CONCURRENT_STARTS" "AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS"
require_minimum_interval "$MIN_START_INTERVAL_MS"

# The caller may set STRESS_CONCURRENCY from the current Paseo parallel queue.
# Without it, create exactly one surplus request from the active-seat policy.
if [[ -n "${STRESS_CONCURRENCY:-}" ]]; then
  CONCURRENCY="$STRESS_CONCURRENCY"
else
  CONCURRENCY="$((MAX_ACTIVE_TURNS + 1))"
fi
require_positive_integer "$CONCURRENCY" "STRESS_CONCURRENCY"
(( CONCURRENCY > MAX_ACTIVE_TURNS )) || {
  echo "STRESS_CONCURRENCY must exceed AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS to prove queue progress" >&2
  exit 1
}

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
printf 'admission policy active=%s concurrent-starts=%s min-start-interval-ms=%s stress-concurrency=%s\n' \
  "$MAX_ACTIVE_TURNS" "$MAX_CONCURRENT_STARTS" "$MIN_START_INTERVAL_MS" "$CONCURRENCY"

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
          "AGY_ACP_STATE_DIR": "$ADMISSION_DIR",
          "AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS": "$MAX_ACTIVE_TURNS",
          "AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS": "$MAX_CONCURRENT_STARTS",
          "AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS": "$MIN_START_INTERVAL_MS"
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
run_success=()
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
for index in "${!pids[@]}"; do
  if wait "${pids[$index]}"; then
    run_success[$index]=true
  else
    run_success[$index]=false
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  report_child_process_results
  exit 1
fi

python3 -c 'import json,os,sys
concurrency=int(sys.argv[1]); home=sys.argv[2]
safe_statuses={"completed","idle","failed","cancelled","error","running","queued","waiting","stopped","timeout"}
completed=0
invalid=False
for i in range(1, concurrency+1):
    status="unknown"
    agent_id=""
    try:
        payload=json.loads(open(os.path.join(home,"run-%d.json"%i), encoding="utf8").read())
        raw_status=payload.get("status") if isinstance(payload,dict) else None
        status=raw_status if isinstance(raw_status,str) and raw_status in safe_statuses else "unknown"
        raw_agent_id=(payload.get("id") or payload.get("agentId") or payload.get("agent_id")) if isinstance(payload,dict) else None
        agent_id=raw_agent_id if isinstance(raw_agent_id,str) and raw_agent_id else ""
    except Exception:
        pass
    if status not in ("completed","idle") or not agent_id:
        print("isolated run ordinal=%d status=%s agent-id-present=%s"%(i,status,str(bool(agent_id)).lower()), file=sys.stderr)
        invalid=True
        continue
    open(os.path.join(home,"id-%d.txt"%i),"w",encoding="utf8").write(agent_id)
    completed += 1
if invalid:
    raise SystemExit(1)
print("all %d runs returned completed/idle"%concurrency)
' "$CONCURRENCY" "$TMPHOME"

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
    raise SystemExit("isolated final marker missing")
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

EVIDENCE_JSON="$("$NODE_BIN" "$ROOT/scripts/official-kernel-stress-evidence.mjs" \
  --database "$ADMISSION_DIR/official-kernel/runtime.sqlite" \
  --expected-runs "$CONCURRENCY" \
  --max-active-turns "$MAX_ACTIVE_TURNS" \
  --max-concurrent-starts "$MAX_CONCURRENT_STARTS" \
  --min-start-interval-ms "$MIN_START_INTERVAL_MS")"
printf '%s\n' "$EVIDENCE_JSON"

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
