<div align="center">

# 🔌 paseo-agy-acp

**Paseo × Antigravity — official ACP kernel, Paseo-ready product adapter**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0.0-blue?style=flat-square)](./package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](#)
[![ACP](https://img.shields.io/badge/ACP-NDJSON%20v1-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

</div>

<div align="center">

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

</div>

---

`paseo-agy-acp` is the Paseo-facing ACP product for Google Antigravity. From
**2.1.0.0** it runs Google's official Antigravity ACP kernel (`agy_acp_server` /
Registry id `antigravity-acp`) as a thin NDJSON proxy, then adds the Paseo
behavior that Generic ACP does not provide on its own: daemon context, session
mode mapping, MCP rewrite, product identity, and an account-wide Admission
queue so the Paseo main controller can delegate many Antigravity agents without
a startup stampede.

> **Not official Paseo support. Not official Google support.**
> Community-maintained product. Use at your own risk.

## About

This repository is a **product adapter**, not a second Antigravity. The kernel
does the model work; this repo makes that kernel **safe and complete for Paseo**.

| Highlight | Why it matters |
|---|---|
| **Official ACP kernel** | Native Agent Client Protocol over NDJSON: OAuth, session lifecycle, streaming, tools, MCP, and the signed-in model catalog — Google's protocol, not a reconstructed CLI. |
| **Paseo-ready out of the box** | Daemon `appendSystemPrompt`, mode ids Paseo already sends, and MCP `http` servers are rewritten so Generic ACP agents can talk to Antigravity without extra glue. |
| **Burst-safe delegation** | An account-wide durable Admission queue paces `session/prompt` so Paseo's main controller can dispatch many Antigravity agents without every turn hitting the kernel at once. |
| **Production-tested defaults** | Default **8 shared seats / 8 concurrent starts / 2s interval**, from live Paseo dispatch (including a 10-agent burst) plus isolated stress. Integers **≥ 1** can probe higher; this repo does **not** invent a product ceiling. |
| **Fail-closed operations** | Bad env, policy splits, and unprovable writes fail closed. Queue timeout, cancel, and kernel errors stay distinguishable. |
| **Empty-turn guard** | An official `end_turn` with no visible assistant/tool output becomes a JSON-RPC error, so Paseo does not record a silent success. |
| **Clean license split** | This repo stays **Apache-2.0**. The official kernel is proprietary: we **spawn** the binary you already installed; npm does **not** ship the ~1.5GiB `.par`. |

```text
Paseo Generic ACP (NDJSON)
  → paseo-agy-acp product proxy
      identity · daemon context · mode map · MCP rewrite · Admission fence
  → official agy_acp_server (NDJSON)
```

| Layer | License | What we do |
|---|---|---|
| **This repository** (proxy, Admission, Paseo context) | **Apache-2.0** | Keep Apache-2.0. We are **not** relicensing. |
| **Official ACP kernel** (`agy_acp_server.par` / `antigravity-acp`) | **Proprietary** | Spawn the kernel on the local machine. Do not redistribute it. |
| **ACP protocol / `@agentclientprotocol/sdk`** | Separate Apache-2.0 ecosystem | Not required at runtime for the official NDJSON proxy. |

---

## 1. Official `agy-acp` kernel capabilities

The product **does not reimplement** Antigravity. It starts Google's native ACP
server and forwards Agent Client Protocol NDJSON. The table below is the
**official kernel** surface, as seen through that protocol.

| Area | What the official kernel provides |
|---|---|
| Protocol | Native **ACP v1 over NDJSON** |
| Auth | `authenticate` with `methodId=oauth-personal` (OAuth inside the kernel) |
| Session lifecycle | `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/set_config_option` |
| Streaming | `session/update`: assistant text, thoughts, tool calls / tool updates |
| Live session modes | `default`, `auto_edit`, `yolo` (official has **no** plan mode) |
| Tools | File edits, shell/terminal, and other Antigravity tools as Google implements them |
| MCP | Official MCP client; servers are declared on `session/new` |
| Models | Google / Gemini / Claude / other catalog entries the signed-in Antigravity account can use |
| Turn completion | Official `end_turn` / stop reasons |

Tool quality, image generation, model catalog, and provider 503/quota text are
owned by the official kernel and Google's backend. This product **proxies**
that surface.

---

## 2. Paseo adaptations

These are the **Paseo-side** layers on top of the official kernel — the reason
this repository exists.

| # | Adaptation | What it does |
|---|---|---|
| 1 | Product identity | `initialize` `agentInfo` is overlaid as `agy-acp` / `paseo-agy-acp` so Paseo sees a stable product name. |
| 2 | Daemon context bridge | When `PASEO_AGENT_ID` is set, Paseo daemon `appendSystemPrompt` is injected into official `session/prompt`, so workspace/agent context reaches Antigravity. |
| 3 | Session mode mapping | Paseo / legacy ids map onto official live modes: `accept-edits` → `auto_edit`, `dangerously-skip-permissions` → `yolo`, `plan` → `default`. |
| 4 | MCP `http` → `sse` | Paseo often hands MCP servers as `type: "http"` plus a header map. The official kernel wants `sse` and `{name,value}` header arrays. The proxy rewrites that on `session/new`. |
| 5 | Admission fence | When Admission is enabled, each official `session/prompt` takes a durable account-wide seat **before** the kernel write; the seat is released when the turn finishes, fails, or is cancelled. |
| 6 | Blank-turn guard | Official `end_turn` with **no** visible assistant/tool output is returned as a JSON-RPC error (`-32000`) instead of an empty successful turn. |
| 7 | Isolated Admission ledger | Official-kernel queue state lives under `$AGY_ACP_STATE_DIR/official-kernel`, separate from any historical ledger. |
| 8 | Single kernel | `PASEO_AGY_ACP_KERNEL=legacy` and `--legacy-kernel` fail closed. Official is the only ACP execution path. |

`PASEO_HOME` is optional and falls back to `~/.paseo` when unset or empty.
Paseo typically provides `PASEO_AGENT_ID` (and `PASEO_AGENT_CWD`) to ACP
provider processes.

---

## 3. Why the Admission queue exists

### Background

Paseo is a **main controller**. It routinely **delegates many Antigravity
agents at once**. Under that burst, neighboring high concurrency used to
strand turns: empty assistant bubbles, hangs, or ACP **Internal Error
`-32603`**. The historical **3+1** fence (3 shared active seats, 1 concurrent
start, 2s start interval) was a bleed-stop for that failure mode — not a
measured official ACP maximum.

On the official kernel we production-tested **8 shared seats / 8 concurrent
starts / 2s interval**, including a 10-agent Antigravity dispatch that did not
reproduce the old hang. Isolated stress on `127.0.0.1:6768` (6 concurrent yolo
agents) also did not reproduce it. Official ACP is still **not** proven
unlimited. **8 is a tested default, not a published product ceiling.**

### Principle

```text
Paseo main controller
  delegates many Antigravity agents
            |
            v
  account-wide durable Admission queue
            |
     shared active seats (default 8)
     paced concurrent starts (default 8, ≥ 2s apart)
            |
     official session/prompt write
            |
     seat released on turn end / failure / cancel
```

Extra turns **wait in the queue** instead of all hitting `agy_acp_server` at
once. The queue is oldest-eligible with agent fairness, durable across
connector processes, and fail-closed on bad env (non-integers, values `< 1`,
start interval `< 2000ms`). Independent Paseo agents that share one state
directory share one account pool — they cannot multiply concurrency by
accident.

### Advantage

The point is **not** to permanently cap Paseo at 3 agents. The point is to
keep **Paseo → Antigravity delegation steadier**:

- The main controller can still dispatch a burst.
- Surplus work queues instead of stampeding the official kernel.
- Seats are account-wide across connector processes and restarts.
- Queue timeout, cancel, and kernel errors remain distinguishable from a crash.
- Operators can raise seat/start integers (**≥ 1**) to probe higher
  concurrency and report what they find.

That is why Admission stays in the product after the official-kernel switch.

---

## Admission Controller v2

Admission is the operational implementation of the queue above: durable seats,
paced starts, recovery, and typed terminals. It is **opt-in** via env
(`AGY_ACP_ADMISSION_ENABLED=true` plus an absolute `AGY_ACP_STATE_DIR` and a
valid `PASEO_AGENT_ID`). Recommended for any Paseo host that delegates more
than one Antigravity agent.

### Enabling Admission

Create one owner-only state directory per Antigravity account and run the
packaged preflight:

```bash
export AGY_ACP_STATE_DIR="$HOME/.local/state/paseo-agy-acp/account-name"
install -d -m 700 "$AGY_ACP_STATE_DIR"
agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
export AGY_ACP_ADMISSION_ENABLED=true
```

The preflight creates a missing directory with mode `0700` and verifies type,
owner, and exact mode. It **rejects** an existing permissive directory instead
of silently chmod-ing it. After you confirm path and ownership, run
`chmod 700 -- "$AGY_ACP_STATE_DIR"` and rerun the preflight. Admission key and
SQLite files are created with mode `0600`.

Official-kernel queue files are written under
`$AGY_ACP_STATE_DIR/official-kernel` so they cannot share a ledger with a
historical install.

### Default and conservative policy

| Rule | Default | Override |
|---|---:|---|
| Shared active seats | **8** (tested) | `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS` — integer **≥ 1** |
| Concurrent starts | **8** (tested) | `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS` — integer **≥ 1** |
| Minimum start interval | **2000 ms** | `AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS` — integer **≥ 2000** |
| Queue timeout | 30 minutes | `AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS` — integer `1`–`1800000` |
| Capacity cooldown | 30 seconds | `AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS` — integer **≥ 30000** |

Every local connector using the same state directory shares those account
seats across sessions and models. Requests are selected oldest-eligible with
agent fairness. A trusted provider-capacity failure pauses only the affected
provider/model. Queue timeout cancels the request and deletes its encrypted
prompt in the same transaction.

Overrides are fail-closed: non-integers, values `< 1`, and start intervals
below 2000 ms refuse to start. This repo does **not** publish a product
maximum; raise the integers to probe, and please report results.

Optional tighter fence (historical 3+1), **not** the recommended default:

```bash
AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS=3
AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS=1
```

Soft drain can reduce seats without killing in-flight work or dropping the
queue.

### Durability, dispatch, and recovery

The local implementation uses `shared-admission-queue` **schema v3**. Durable
policy (`policy_state` / `policy_fingerprint`), queued owner instances, leases
with suspect metadata for the runtime reaper, and `schema_migrations` live in
one SQLite ledger. Unexpected delivery-authority tables still fail closed.

Each enabled runtime opener claims or verifies that durable policy before
startup recovery. A second connector on the same directory with a **different**
policy fails closed rather than splitting policy per process.

Idle sessions consume no seat and keep no resident turn process. An admitted
turn uses a fenced one-shot `session/prompt` write; unprovable writes become
`dispatch_ambiguous` or `recovery_required` instead of a silent replay.
Heartbeat, owner identity, and the runtime reaper release capacity only when
an owner is proven dead. Closing a session cancels queued work; an already
running turn follows the connector cancel path (`session/cancel`).

Admission does **not** add a second live-output path, outbox, ACK protocol,
terminal replay, or manual requeue API. Official session history remains an
ACP Connector / kernel responsibility.

### Design authority and implementation boundary

Current authority is the confirmed Scheme plus accepted Stage 2 artifacts
(see [Authority documents](#authority-documents-v2000-closeout) below). The
legacy admission design file is historical input only.

The repository has exactly two source areas:

```text
paseo-agy-acp/
|-- ACP Connector/          ACP NDJSON proxy, official kernel spawn, Paseo context
`-- Admission Controller/   durable seats, queue, policy, paced starts, recovery
```

`ACP Connector/` owns protocol, identity, mode/MCP rewrites, kernel spawn, and
the Admission fence around `session/prompt`. `Admission Controller/` owns only
the shared seat pool, durable queue, policy ledger, leases, reaper, and
capacity cooldown. Package entrypoints stay inside `ACP Connector/`.

---

## Requirements

- **Node.js >= 22**
- **Official Antigravity ACP kernel** installed locally. Maintainer-host
  default pin:

  `~/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary`

  Override with `PASEO_AGY_ACP_OFFICIAL_BIN`. If the path is the `.par` itself,
  the process `cd`s into that directory and execs with `--uid=` (required on
  hosts without a usable group, e.g. `nogroup`).

- Completed official `authenticate` (`methodId=oauth-personal`). Tokens stay in
  the kernel's own state; this repo never prints them.

## Install

```bash
git clone https://github.com/tiezbro/paseo-agy-acp.git
cd paseo-agy-acp
npm ci
npm run build
npm test
```

```bash
# ACP initialize smoke (requires the official binary)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node 'dist/ACP Connector/main.js'
```

Login (official kernel OAuth):

```bash
node 'dist/ACP Connector/main.js' --login
```

The published bin names are `agy-acp` and `agy-acp-prepare-state`.

## Environment

| Variable | Purpose |
|---|---|
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Official kernel wrapper or `.par` path |
| `PASEO_AGENT_ID` | Enables daemon context + Admission agent binding |
| `PASEO_HOME` | Optional Paseo home; falls back to `~/.paseo` |
| `AGY_ACP_ADMISSION_ENABLED` | `true` / `1` to fence prompts through Admission |
| `AGY_ACP_STATE_DIR` | Admission state directory (official runtime uses `official-kernel/` under it) |
| `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS` | Shared active seats. Integer **≥ 1**. Default **8** (tested). |
| `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS` | Concurrent starts. Integer **≥ 1**. Default **8** (tested). |
| `AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS` | Minimum start spacing. Default **2000**; values below 2000 fail closed. |
| `AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS` | Queue wait budget. Default 30 minutes; max 1800000. |
| `AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS` | Provider/model cooldown after a trusted capacity failure. Default 30000; minimum 30000. |

`PASEO_AGY_ACP_KERNEL=legacy` and `--legacy-kernel` fail closed.

## Architecture

```text
Paseo / Generic ACP client
  └─ paseo-agy-acp (agy-acp)
       ├─ product proxy: identity, daemon context, mode map, MCP rewrite
       ├─ Admission fence on session/prompt (optional, recommended)
       └─ official agy_acp_server (NDJSON)
            └─ Antigravity account, tools, MCP, models
```

One official kernel child per connector process. Admission coordinates
**account-wide** seats across those processes through the durable ledger.

## Paseo provider config

```json
{
  "providers": {
    "antigravity": {
      "type": "acp",
      "command": "agy-acp",
      "env": {
        "PASEO_AGY_ACP_OFFICIAL_BIN": "/home/YOU/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary",
        "AGY_ACP_ADMISSION_ENABLED": "true",
        "AGY_ACP_STATE_DIR": "/home/YOU/.local/state/paseo-agy-acp/account-name"
      }
    }
  }
}
```

When `command` is `node`, pass
`["/path/to/paseo-agy-acp/dist/ACP Connector/main.js"]` as `args`.
Paseo supplies `PASEO_AGENT_ID` to the provider process.

Restart the Paseo daemon after changing the provider so idle Antigravity
agents pick up the new binary.

## Setup prompt

Paste into any Paseo agent to install or repair the Antigravity provider:

~~~
Configure the Paseo daemon to add an ACP provider for Google Antigravity.

1. Read Paseo config ($PASEO_HOME/config.json or ~/.paseo/config.json).
2. Add or update providers.antigravity:
   - type: "acp"
   - command: "agy-acp" (or node with the full path below)
   - args: when command is node, ["/path/to/paseo-agy-acp/dist/ACP Connector/main.js"]
   - env.PASEO_AGY_ACP_OFFICIAL_BIN: local official kernel wrapper (agy-acp-server-canary or agy_acp_server.par)
   - env.AGY_ACP_ADMISSION_ENABLED: "true"
   - env.AGY_ACP_STATE_DIR: absolute owner-only directory (mode 0700)
3. If agy-acp is not installed: cd paseo-agy-acp && npm ci && npm run build
4. Prepare Admission state: agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
5. Login once: node 'dist/ACP Connector/main.js' --login
6. Restart the Paseo daemon.
7. Verify: create a test agent with provider "antigravity", send a simple prompt.
~~~

## Verification

```bash
# Smoke test (needs the official binary)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node 'dist/ACP Connector/main.js'

# Full suite
npm test
```

Canary checklist: daemon context on a real Paseo agent, multi-turn, MCP server
declared as `http`, mode `dangerously-skip-permissions` → official `yolo`,
Admission queue under a small seat cap, blank-turn rejection.

`2.1.0.0` isolated canary on `127.0.0.1:6768` proved the product proxy +
official kernel + daemon context. Production `127.0.0.1:6767` was not switched
by that canary.

## Known issues

- The official kernel binary must already be installed; this package does not
  vendor it.
- Admission is off until `AGY_ACP_ADMISSION_ENABLED`, `AGY_ACP_STATE_DIR`, and
  `PASEO_AGENT_ID` are all valid. Discovery/`--login` without an agent id does
  not open the ledger.
- Official ACP has no plan mode; Paseo `plan` maps to `default`.
- Image generation and live provider 503 text are owned by the official kernel.
  This adapter does not claim those have been re-verified here.
- Raw-prompt tests can see prepended daemon context when `PASEO_AGENT_ID`
  points at a live Paseo agent:

```bash
env -u PASEO_AGENT_ID -u PASEO_HOME npm test
```

## Upgrade / Rollback

```bash
# Upgrade
git pull && npm ci && npm run build && npm test

# Rollback
git checkout <rev> && npm ci && npm run build && npm test
```

Point the daemon at the desired `agy-acp` binary or
`dist/ACP Connector/main.js` entrypoint and restart. After an Admission policy
change (for example 3+1 → 8/8), use a **fresh** `AGY_ACP_STATE_DIR` if the
durable fingerprint would fail-close the new policy.

## Authority documents (v2.0.0.0 closeout)

- [confirmed Scheme](/home/tiezbro/projects/MAACS/docs/maacs-paseo-agy-acp-confirmed-scheme.md)
- [Stage 2 handoff](docs/design/v2.0.0.0-stage2-handoff.md)
- [503 feasibility](docs/design/v2.0.0.0-stage2-503-feasibility.md)
- [ACP source map](docs/design/v2.0.0.0-stage2-acp-source-map.md)
- [Admission source map](docs/design/v2.0.0.0-stage2-admission-source-map.md)
- [Architecture](docs/design/v2.0.0.0-stage2-architecture.md)
- [Domain model](docs/design/v2.0.0.0-stage2-domain-model.md)
- [Test contracts](docs/design/v2.0.0.0-stage2-test-contracts.md)
- [Specification](docs/design/v2.0.0.0-stage2-spec.md)

→ [Local technical notes](./docs/PASEO_LOCAL_CHANGES.md)

## Disclaimer

The official kernel is governed by
[Google Antigravity Terms](https://antigravity.google/terms). This product
spawns that kernel; it does not reimplement or redistribute it.

Third-party tools for Antigravity may violate those terms and risk account
suspension. Prefer official API keys. Test/secondary accounts only.

**AS IS, NO WARRANTY. USE AT YOUR OWN RISK.**
