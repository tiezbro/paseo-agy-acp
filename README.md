<div align="center">

# 🔌 paseo-agy-acp

**Paseo × Antigravity — official ACP kernel product adapter**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0.0-blue?style=flat-square)](./package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](#)
[![ACP](https://img.shields.io/badge/ACP-NDJSON%20v1-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

</div>

<div align="center">

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

</div>

---

`paseo-agy-acp` is the Paseo-facing ACP product. **ACP protocol execution now
runs on Google's official Antigravity ACP kernel** (`agy_acp_server` /
Registry id `antigravity-acp`). This repository is a thin NDJSON proxy plus
Paseo product behavior (Admission, daemon context, identity, mode/MCP
rewrites). It is **not** a PTY/SQLite scraper of the `agy` CLI, and it is no
longer a kernel fork of `shindgew/agy-acp`.

> **Not official Paseo support. Not official Google support.**
> Community-maintained product. Use at your own risk.

## About

| | |
|---|---|
| **Maintainer** | [tiezbro](https://github.com/tiezbro) |
| **Repository** | [github.com/tiezbro/paseo-agy-acp](https://github.com/tiezbro/paseo-agy-acp) |
| **ACP kernel** | Official Google Antigravity ACP server (spawned locally; not vendored) |
| **Product license** | [Apache 2.0](./LICENSE) |

## License (read this)

| Layer | License | What we do |
|---|---|---|
| **This repository** (`paseo-agy-acp` source, Admission, proxy) | **Apache-2.0** | Keep Apache-2.0. We are **not** relicensing. |
| **Official ACP kernel** (`agy_acp_server.par` / `antigravity-acp`) | **Proprietary** (not open source; Antigravity Terms of Service) | We **spawn** the kernel you already installed. The npm package **does not** ship the ~1.5GiB binary. |
| **ACP protocol / `@agentclientprotocol/sdk`** | Separate Apache-2.0 ecosystem | Not required at runtime for the official NDJSON proxy. |

**Do not change this project's SPDX license to match the official kernel.** The
kernel is not open source, and leftover Apache-2.0 product code (Admission,
Paseo context, proxy) cannot be relicensed away from Apache-2.0 without
removing that code or obtaining permission.

Third-party PTY wrappers of `agy -p` are a different ToS risk. This product's
kernel is Google's **native ACP server**, not a PTY scrape of the CLI.

## What 2.1.0.0 is

```
Paseo Generic ACP (NDJSON)
  → paseo-agy-acp product proxy
      → official agy_acp_server (NDJSON)
```

The product proxy:

1. Overlays product identity (`agy-acp` / `paseo-agy-acp`).
2. Injects Paseo daemon `appendSystemPrompt` into `session/prompt`.
3. Maps session modes: `accept-edits` → `auto_edit`, `dangerously-skip-permissions` → `yolo`, `plan` → `default`.
4. Rewrites MCP `http` servers to `sse` with `{name,value}` headers.
5. Fences Admission around the official prompt write (when enabled).
6. Rejects blank official `end_turn` results with no visible assistant output.

The PTY/SQLite scraper kernel has been **deleted**. There is no
`--legacy-kernel` / `PASEO_AGY_ACP_KERNEL=legacy` escape hatch.

## Requirements

- Node.js >= 22
- Official Antigravity ACP kernel installed locally. Default pin on this host:

  `~/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary`

  Override with `PASEO_AGY_ACP_OFFICIAL_BIN`. The wrapper must `cd` to the pin
  directory and `exec ./agy_acp_server.par --uid=` (`--uid=` is required on
  hosts without a usable group, e.g. `nogroup`).

- Completed official `authenticate` with `methodId=oauth-personal` (tokens live
  under the kernel's own state; this repo never prints them).

## Quick start

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

Login (official kernel OAuth, not `agy` TUI):

```bash
node 'dist/ACP Connector/main.js' --login
```

## Environment

| Variable | Purpose |
|---|---|
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Official kernel wrapper or `.par` path |
| `PASEO_AGENT_ID` | Enables daemon context + Admission agent binding |
| `PASEO_HOME` | Optional Paseo home; falls back to `~/.paseo` |
| `AGY_ACP_ADMISSION_ENABLED` | `true` / `1` to fence prompts through Admission (queue stays on) |
| `AGY_ACP_STATE_DIR` | Admission state directory (official runtime uses `official-kernel/` under it) |
| `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS` | Shared active seats. Integer **≥ 1**. Default **8** (tested in production). Raise this to probe higher concurrency; this repo does **not** publish a product max. |
| `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS` | Concurrent starts. Integer **≥ 1**. Default **8** (tested in production). |
| `AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS` | Minimum start spacing. Default **2000**; values below 2000 fail closed. |

`PASEO_AGY_ACP_KERNEL=legacy` and `--legacy-kernel` now fail closed. Official
is the only kernel.

## Paseo provider config

```json
{
  "providers": {
    "antigravity": {
      "type": "acp",
      "command": "agy-acp",
      "env": {
        "PASEO_AGY_ACP_OFFICIAL_BIN": "/home/YOU/.local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary"
      }
    }
  }
}
```

When `command` is `node`, pass
`["/path/to/paseo-agy-acp/dist/ACP Connector/main.js"]` as `args`.

## Admission Controller v2

Account-wide durable queue stays **enabled**. The queue is what keeps
**Paseo → Antigravity delegation steadier**: extra turns wait instead of all
hitting the official ACP kernel at once.

**Default (from real testing, not a claimed official maximum):** **8 shared
active seats**, **8 concurrent starts**, and a **2s** minimum start interval.
A production dispatch of 10 Antigravity agents against this default did not
reproduce the old scraper hang.

That 8 is **not** a published product ceiling. Set the env integers to any
integer **≥ 1** if you want to test higher (or lower) concurrency, and please
report what you find. Official ACP is **not** proven unlimited.

**Background:** the old 3+1 fence existed because the deleted PTY/SQLite
scraper hung under neighboring `agy -p` load. Isolated official-kernel stress
on `127.0.0.1:6768` (6 concurrent yolo agents) did not reproduce that hang.
3+1 remains a valid *tighter* override, not the recommended default:

```bash
AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS=3
AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS=1
```

Official-kernel Admission state is isolated under
`$AGY_ACP_STATE_DIR/official-kernel` so it cannot share a ledger with a
historical scraper install.

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

**AS IS, NO WARRANTY. USE AT YOUR OWN RISK.**
