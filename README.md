# paseo-agy-acp

A lightweight Paseo adapter for the official Google Antigravity ACP kernel.

[English](./README.md) | [中文](./README.zh-CN.md) | [Changelog](./CHANGELOG.md)

This branch is an unreleased lightweight iteration. This branch pins the managed kernel to 1.5.0; the installed production runtime has not been switched.

The target is to make every official-kernel capability usable in Paseo. Coverage is not complete: protocol forwarding, client entry points and UI acceptance are tracked separately in the [capability and decision inventory](docs/research/2026-11-17-paseo-capability-parity.md).

<!-- readme:positioning -->
## Purpose

`paseo-agy-acp` connects Paseo to the official `agy_acp_server` through ACP NDJSON. The official kernel owns authentication, model execution, tools, inference, retries and conversation persistence. The adapter supplies Paseo context, skills and protocol compatibility.

The independent provider id is `paseo-agy-acp`, with display name `Antigravity Pro`. It can coexist with Paseo’s built-in `antigravity`. Official ACP login state lives under `~/.gemini/antigravity-acp`. Google’s kernel is downloaded separately and is not redistributed in this Apache-2.0 package. This is a community project.

The companion Paseo branch preserves official mode and thinking labels, uses session config model families, and refreshes thinking choices from confirmed kernel responses. Its provider settings also expose `additionalDirectories` and native `_meta` session parameters, preserved during restoration. This requires the companion client changes; updating this adapter alone does not update the UI.

<!-- readme:value -->
## Capabilities

| Capability | Adapter behavior |
| --- | --- |
| Models and thinking | Forward official names, grouped model/config choices and native thoughts; retain local third-party model compatibility patches |
| Tools and permissions | Preserve tool events, approval requests and client replies |
| Session lifecycle | Support new/load/resume, cancellation and process cleanup; session/close is capability-gated |
| Paseo context | Inject daemon context; negotiate native context when explicitly enabled |
| Skills | Merge slash command metadata and expose session-scoped skill resources through MCP |
| MCP | Preserve HTTP/SSE endpoints and apply required protocol compatibility |
| Errors | Preserve JSON-RPC failures and reject successful turns with no visible output |

Independent sessions dispatch without adapter queueing, seat limits, start spacing or cooldowns. A second prompt for the same active session is rejected. This does not establish an unlimited backend concurrency entitlement. Thought summaries are visible only when the kernel emits them; the adapter does not synthesize reasoning. System envelopes remain text with a system marker. The companion Paseo branch displays them as notifications; older clients display the text. They are never converted into thought summaries.

<!-- readme:architecture -->
## Architecture

```text
Paseo / ACP client
  -> paseo-agy-acp
       identity | daemon context | modes | MCP | skills
       session cancellation | output compatibility | diagnostics
  -> official agy_acp_server
       OAuth | models | tools | inference | conversation history
```

One kernel child runs per connector process. There is no adapter scheduling database and no runtime npm dependency. The kernel’s own session database remains intact. A short per-connection `session/new` sequencing boundary remains because early command updates contain no request id; it does not serialize prompts across sessions.

<!-- readme:requirements -->
## Requirements

- Node.js 22+
- Paseo with custom ACP provider support
- An account authorized to use the official Antigravity service
- A non-root Linux user for the managed Linux x86_64 compatibility wrapper

<!-- readme:quickstart -->
## Try this branch

Build locally. The published npm version does not contain this iteration.

```bash
npm ci
npm run build
node "dist/ACP Connector/main.js" --doctor
node "dist/ACP Connector/main.js" --prepare-kernel
node "dist/ACP Connector/main.js" --login
```

`--doctor` only checks local installation. Preparation downloads the pinned official kernel when needed; login uses official OAuth. On a headless host, complete OAuth in your browser and paste the localhost callback into that host’s terminal.

For an isolated Paseo test configuration, replace the example absolute path:

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "enabled": true,
        "extends": "acp",
        "label": "Antigravity Pro",
        "command": ["node", "/absolute/path/paseo-agy-acp/dist/ACP Connector/main.js"]
      }
    }
  }
}
```

Apply provider configuration to future agent launches. Production rollout and a versioned npm command follow branch acceptance; see the migration guide below.

<!-- readme:configuration -->
## Configuration

| Variable | Purpose |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Existing absolute kernel/wrapper path; unset for managed installation |
| `PASEO_HOME` | Paseo home; default `~/.paseo` |
| `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT` | `1`: use native context only if advertised by the kernel |
| `AGY_ACP_DIAGNOSTICS` | `1`: fixed-field stderr timings, no prompt or credentials |
| `AGY_ACP_CANCEL_TIMEOUT_MS` | Positive cancellation acknowledgement timeout; default 30000 ms |

| Paseo mode | Official mode |
| --- | --- |
| `default` | `default` |
| `accept-edits` | `auto_edit` |
| `dangerously-skip-permissions` | `yolo` |

The misleading `plan` alias has been removed. Use the official `/plan` command; it is not a read-only permission mode. Unknown modes are passed to the kernel for validation.

With the companion Paseo adapter, `yolo` is unattended: tool approvals, trust and single-choice questions are automatic. It prefers persistent permission, then the first one-time allow option. `default` and `auto_edit` retain their official approval behavior, regardless of a stale Auto Accept toggle. This client behavior requires the companion MAACS changes; released Paseo clients do not yet consume the mode metadata.

Permission requests remain active until answered or cancelled. Native `yolo` and Paseo Auto Accept are distinct settings. For network proxies, configure HTTP/HTTPS proxy variables on the provider and include local MCP endpoints in `NO_PROXY`.

Skill discovery honors configured, workspace and global Gemini/Agents/Codex roots, plus Paseo compatibility roots. Native commands win on collisions; workspace skills override global skills. `user-invocable: false` hides slash hints. Skill reads stay within the discovered directory and are limited to 1 MiB per file.

<!-- readme:operations -->
## Operations and verification

Remove obsolete `AGY_ACP_ADMISSION_*` and `AGY_ACP_STATE_DIR` settings when deploying. Old ledgers are not read or deleted. `agy-acp-prepare-state` no longer exists. Explicit kernel errors pass through; an upstream failure encoded as ordinary assistant text plus `end_turn` still needs separate upstream/adapter investigation. Removing scheduling does not fix provider 429/502/503 responses or slow model generation.

- [Admission retirement / 迁移](docs/operations/admission.md)
- [Lightweight architecture / 轻量化验收](docs/operations/lightweight-adapter.md)
- [Kernel compatibility / 内核兼容](docs/operations/official-kernel-compat-runbook.md)
- [Paseo verification / Paseo 验收](docs/operations/paseo-adapter-verification.md)
- [Cross-host / 跨主机](docs/operations/paseo-cross-host-e2e.md)
- [npm publishing / npm 发布](docs/operations/npm-publishing.md)

<!-- readme:development -->
## Development

```bash
npm run validate
npm run test:paseo-provider
npm run test:paseo-client
```

Client tests need the locked fixtures described in the verification guide. They use real Paseo clients and a simulated kernel. For an explicitly requested real-account comparison:

```bash
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --concurrency 4 --groups native,adapter
```

The probe shares the existing account quota, refuses tool permissions, pins the model between groups, stops on unexpected results and cleans up its processes. Reports contain timing and status fields, not model text or raw provider errors. Historical evidence remains under `docs/research/` and `docs/design/`.

<!-- readme:license -->
## License

[Apache-2.0](./LICENSE)
