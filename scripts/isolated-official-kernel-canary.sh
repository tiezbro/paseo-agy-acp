#!/usr/bin/env bash
# Isolated Paseo canary: product 2.1.0.0 proxy + real official agy_acp_server.
# Never touches ~/.paseo or 127.0.0.1:6767.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/dist/ACP Connector/main.js"
OFFICIAL_BIN="${PASEO_AGY_ACP_OFFICIAL_BIN:-$HOME/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary}"
HOST="127.0.0.1:6768"
MARKER="PASEO_CONTEXT_MARKER_2100"
TOKEN="CANARY_OK_2100"
TMPHOME="$(mktemp -d /tmp/paseo-agy-acp-canary-XXXXXX)"
WORKDIR="$TMPHOME/work"
NODE_BIN="$(command -v node)"
PROD_BEFORE=""
CLEANED=0

cleanup() {
  if [[ "$CLEANED" -eq 1 ]]; then
    return
  fi
  CLEANED=1
  paseo daemon stop --home "$TMPHOME" --timeout 20 --json >/dev/null 2>&1 || true
  if curl -sS --max-time 1 "http://$HOST/api/health" >/dev/null 2>&1; then
    paseo daemon stop --home "$TMPHOME" --timeout 5 --force --json >/dev/null 2>&1 || true
  fi
  rm -rf "$TMPHOME"
}

trap cleanup EXIT INT TERM

fingerprint_prod() {
  paseo daemon status --home "$HOME/.paseo" --json
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

PROD_BEFORE="$(fingerprint_prod)"
python3 -c 'import json,sys
before=json.loads(sys.argv[1])
if before.get("listen")!="127.0.0.1:6767":
    raise SystemExit("refusing to run: production listen is %r"%before.get("listen"))
print("production guard: pid=%s listen=%s"%(before.get("pid"), before.get("listen")))' "$PROD_BEFORE"

mkdir -p "$WORKDIR"
cat > "$TMPHOME/config.json" <<EOF
{
  "version": 1,
  "daemon": {
    "listen": "$HOST",
    "mcp": { "injectIntoAgents": false },
    "browserTools": { "enabled": false },
    "appendSystemPrompt": "Isolated canary daemon context. Token: $MARKER. Do not mention secrets."
  },
  "agents": {
    "providers": {
      "antigravity-official-product": {
        "extends": "acp",
        "label": "Antigravity Official Product",
        "command": ["$NODE_BIN", "$CLI"],
        "env": {
          "PASEO_AGY_ACP_KERNEL": "official",
          "PASEO_AGY_ACP_OFFICIAL_BIN": "$OFFICIAL_BIN"
        },
        "enabled": true
      }
    }
  }
}
EOF

paseo start --home "$TMPHOME" --listen "$HOST" --no-relay --no-web-ui
for _ in $(seq 1 40); do
  if curl -sS --max-time 1 "http://$HOST/api/health" | grep -q '"status":"ok"'; then
    break
  fi
  sleep 0.25
done
curl -sS --max-time 2 "http://$HOST/api/health" | grep -q '"status":"ok"'

RUN_JSON="$(
  env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_HOME \
    paseo run --host "$HOST" \
      --provider antigravity-official-product \
      --mode yolo \
      --cwd "$WORKDIR" \
      --label canary=official-kernel-2.1.0.0 \
      --wait-timeout 8m \
      --json \
      "Reply with exactly $TOKEN. If you can see a daemon system context containing $MARKER, also print CONTEXT_SEEN on the next line. No other text."
)"
printf '%s\n' "$RUN_JSON" > "$TMPHOME/run.json"
echo "$RUN_JSON"

AGENT_ID="$(python3 -c 'import json,sys
payload=json.loads(sys.argv[1])
for key in ("id","agentId","agent_id"):
    value=payload.get(key)
    if isinstance(value,str) and value:
        print(value); raise SystemExit
raise SystemExit("could not parse agent id: %s"%payload)' "$RUN_JSON")"

LOGS="$(env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_HOME paseo logs "$AGENT_ID" --host "$HOST")"
python3 -c 'import json,os,re,sys
token, marker, logs, home = sys.argv[1:5]
lines = logs.splitlines()
last_meta = -1
for index, line in enumerate(lines):
    if re.match(r"^\[(Thought|Shell|Read|Tool|Error|Warning)\b", line):
        last_meta = index
final = "\n".join(lines[last_meta + 1 :]).strip()
if token not in final:
    raise SystemExit("canary token missing from final message:\n"+final[:800])
print("canary token present in final message")
if marker in final or "CONTEXT_SEEN" in final:
    print("daemon context marker observed by the model")
else:
    print("warning: model did not echo daemon context marker; checking agent state")
matches = []
for root, _, files in os.walk(os.path.join(home, "agents")):
    for name in files:
        if name.endswith(".json"):
            matches.append(os.path.join(root, name))
if not matches:
    raise SystemExit("no isolated agent state files")
state = json.loads(open(matches[0], encoding="utf8").read())
prompt = ((state.get("persistence") or {}).get("metadata") or {}).get("daemonAppendSystemPrompt") or ""
if marker not in str(prompt):
    raise SystemExit("daemonAppendSystemPrompt missing isolated marker")
print("agent state has daemonAppendSystemPrompt marker")
print("isolated canary assertions passed")' "$TOKEN" "$MARKER" "$LOGS" "$TMPHOME"

require_prod_unchanged
echo "ISOLATED_OFFICIAL_KERNEL_CANARY_OK"
