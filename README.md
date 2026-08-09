<div align="center">

# 🔌 paseo-agy-acp

**Paseo × Antigravity — ACP Adapter**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0.4-blue?style=flat-square)](./package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](#)
[![ACP](https://img.shields.io/badge/ACP-v1%20%2B%20draft%20v2-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

</div>

<div align="center">

[🇺🇸 English](./README.md) | [🇨🇳 中文](./README.zh-CN.md)

</div>

---

ACP adapter for [Google Antigravity CLI](https://antigravity.google/product/antigravity-cli).
A community derivative of [`shindgew/agy-acp`](https://github.com/shindgew/agy-acp), hardened
for reliable daily use with [Paseo](https://github.com/getpaseo/paseo).

> **Not official Paseo support. Not official Google support.**
> Community-maintained fork. Use at your own risk.

## About

| | |
|---|---|
| **Maintainer** | [tiezbro](https://github.com/tiezbro) |
| **Repository** | [github.com/tiezbro/paseo-agy-acp](https://github.com/tiezbro/paseo-agy-acp) |
| **Upstream** | [shindgew/agy-acp](https://github.com/shindgew/agy-acp) (Apache 2.0) |
| **License** | [Apache 2.0](./LICENSE) |

Built on the excellent work of [Shindge Wong](https://github.com/shindgew) and upstream
contributors. All credit for the original ACP adapter architecture belongs to them.

## ✨ Features

### 🧬 Inherited from upstream

| Feature | Description |
|---|---|
| ACP v1 + draft v2 | Full Agent Client Protocol support with fallback negotiation |
| PTY session management | One PTY per session via `agy --print --conversation <id> --sandbox` |
| Protobuf streaming | Structured step decoding from SQLite protobuf (never parsing stdout) |
| Session modes | `default`, `accept-edits`, `plan` passed through `agy --mode` |
| Slash commands | ACP slash command dispatch (`/mode`, etc.) |
| Tool calls | `run_command`, `write_to_file`, and other Antigravity tools |

### 🔧 Paseo additions

| # | Feature | Description |
|---|---------|-------------|
| 1 | Daemon context bridge | Prepends `daemon.appendSystemPrompt` to backend prompts so Paseo context reaches Antigravity |
| 2 | Authoritative permissions | ACP "deny" suppresses late provider success rows; denied tools tracked and blocked |
| 3 | Completion gating | Turn only completes after final assistant output is visible (ignores progress/system rows) |
| 4 | Foreground task fix | Commands with explicit `exitCode` + `task_details` no longer stuck as "active" |
| 5 | Revert tolerance | Whole-file revert handles trailing `\n` / `\r\n` from provider |
| 6 | Permission bypass | Exposes `--dangerously-skip-permissions` as ACP mode id `dangerously-skip-permissions` |
| 7 | Test coverage | Extended test suite for all Paseo-specific paths |

→ [Full technical detail](./docs/PASEO_LOCAL_CHANGES.md)

## v2 Admission Controller Development

The v2.0.0.0 Admission Controller is under source development. It will add
local cross-connector admission, conservative crash recovery, and typed
capacity errors without changing official Paseo or Antigravity endpoints.
The current release does not enable this controller for live prompts.

The design contract and release gates are in
[`docs/design/v2.0.0.0-admission-controller.md`](docs/design/v2.0.0.0-admission-controller.md).

## What This Fixes

Upstream `agy-acp` is a general-purpose adapter. This fork solves 5 Paseo-specific
reliability problems:

| # | Problem | Solution |
|---|---------|----------|
| 1 | Paseo daemon context invisible to Antigravity | Bridge prepends `daemon.appendSystemPrompt` to backend prompts; `PASEO_HOME` is optional and falls back to `~/.paseo` |
| 2 | Permission "deny" overridden by late provider success | Authoritative deny tracking, success rows suppressed post-denial |
| 3 | Turn closed before final assistant message | `turnCompleteCandidate` requires visible terminal output |
| 4 | Explicit-exit foreground commands stuck as "active" | `task_details` + `exitCode` rows not treated as background tasks |
| 5 | Whole-file revert broken by provider-added newlines | `\n` / `\r\n` tolerance for whole-file writes |
| 6 | Paseo cannot select Antigravity's unattended permission bypass | Exposes the native `--dangerously-skip-permissions` parameter as ACP mode id `dangerously-skip-permissions` |

→ [Full technical detail](./docs/PASEO_LOCAL_CHANGES.md)

## Quick Start

```bash
git clone https://github.com/tiezbro/paseo-agy-acp.git
cd paseo-agy-acp
npm ci
npm run build
npm test
```

**Requirements:** Node.js >= 22, `agy` CLI (auto-installed on first run if missing).

## Environment

| Variable | Purpose |
|---|---|
| `PATH` | Must include `agy` and `node` |
| `AGY_BIN` | Override `agy` binary path |
| `PASEO_AGENT_ID` | Agent ID; enables daemon context bridge |
| `PASEO_HOME` | Optional Paseo home override; falls back to `~/.paseo` when unset or empty |

## Architecture

```
Paseo / ACP Client
  └─ paseo-agy-acp (ACP v1 or draft v2)
       └─ agy --print --conversation <id> --sandbox
            └─ ~/.gemini/antigravity-cli/conversations/<id>.db  ← structured protobuf
       └─ StreamPoller + Translator → ACP notifications
```

One PTY per session. Steps decoded from SQLite protobuf, never from stdout.
`--sandbox` on by default. Config: `mode`, `model`, `reasoningEffort`.
The `dangerously-skip-permissions` mode maps directly to Antigravity CLI's
native `--dangerously-skip-permissions` flag; it is not translated through a
custom "full access" name.
When that bypass is active, `paseo-agy-acp` also suppresses its own posthoc
completed-edit review bridge so unattended Paseo runs do not surface an extra
ACP approval panel after Antigravity has already applied an edit.

Paseo daemon context is prepended to the backend prompt sent to `agy`. The
Antigravity CLI does not currently expose a per-call system/developer prompt
flag, so this is a model-visible prompt bridge rather than a native system-role
message.

`agy models` output is parsed using the provider-native model id when the CLI
prints `modelId<TAB>display name` rows. This keeps Paseo selections such as
`gemini-3.1-pro` + `high` mapped to Antigravity's exact variant id, instead of
folding the display label into the model name or adding an unsupported
`--effort` flag.

## Paseo Provider Config

```json
{
  "providers": {
    "antigravity": {
      "type": "acp",
      "command": "node",
      "args": ["/path/to/paseo-agy-acp/dist/main.js"]
    }
  }
}
```

The `bin` name is `agy-acp` for backward compatibility.

## Setup Prompt

Paste into any Paseo agent to install or repair the Antigravity provider:

~~~
Configure the Paseo daemon to add an ACP provider for Google Antigravity.

1. Read Paseo config ($PASEO_HOME/config.json or ~/.paseo/config.json).
2. Add or update providers.antigravity:
   - type: "acp"
   - command: path to agy-acp binary (e.g. "agy-acp" or full path to dist/main.js)
   - args: []
3. If agy-acp is not installed: cd paseo-agy-acp && npm ci && npm run build
4. Ensure agy CLI is installed: curl -fsSL https://antigravity.google/cli/install.sh | bash
   Then: agy auth login
5. Restart the Paseo daemon.
6. Verify: create a test agent with provider "antigravity", send a simple prompt.
~~~

## Verification

```bash
# Smoke test
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node dist/main.js

# Full suite
npm test
```

Canary checklist: permission deny, multi-turn, long prompt + daemon context, foreground
commands, whole-file edits.

## Known Issues

Raw-prompt tests can see prepended daemon context when `PASEO_AGENT_ID` points to
a live Paseo agent state.

```bash
env -u PASEO_AGENT_ID -u PASEO_HOME npm test
```

This disables the bridge only for the test process.

## Upgrade / Rollback

```bash
# Upgrade
git pull && npm ci && npm run build && npm test

# Rollback
git checkout <rev> && npm ci && npm run build && npm test
```

Point daemon at the desired `dist/main.js` and restart.

## Disclaimer

Third-party tools for Antigravity may violate [Google's ToS](https://antigravity.google/terms)
and risk account suspension. Prefer official API keys. Test/secondary accounts only.

**AS IS, NO WARRANTY. USE AT YOUR OWN RISK.**
