<div align="center">

# paseo-agy-acp

**Reliable Paseo adapter for Google's official Antigravity ACP kernel**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.3.1-blue?style=flat-square)](./package.json)
[![npm](https://img.shields.io/npm/v/paseo-agy-acp?style=flat-square)](https://www.npmjs.com/package/paseo-agy-acp)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](./package.json)
[![ACP](https://img.shields.io/badge/ACP-NDJSON%20v1-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

[English](./README.md) | [中文](./README.zh-CN.md) | [Changelog](./CHANGELOG.md)

</div>

<!-- readme:positioning -->
## What this product is

`paseo-agy-acp` is the product adapter between Paseo and Google's official
Antigravity ACP kernel. Authentication, models, tools, MCP, and inference stay
inside the official kernel. This adapter adds the context, compatibility,
concurrency control, skill discovery, and failure semantics required for
reliable Paseo multi-agent operation.

It is not a second Antigravity implementation and does not redistribute
Google's proprietary kernel. The npm package contains only this Apache-2.0
proxy; you install and authenticate the official kernel separately.

> Community maintained. Not official Paseo support and not official Google
> support.

<!-- readme:value -->
## Why paseo-agy-acp

ACP provides the protocol. A production Paseo provider still needs product
behavior around that protocol:

| Need | Direct generic ACP connection | `paseo-agy-acp` |
|---|---|---|
| Official execution chain | Can start an ACP server | Keeps OAuth, models, tools, MCP, and inference in Google's official kernel |
| Paseo context | No product-specific guarantee | Injects Paseo daemon and workspace/agent context into official prompts |
| Modes and MCP | Client and kernel shapes may differ | Maps Paseo modes and rewrites MCP `http` declarations to the official `sse` shape |
| Multi-agent bursts | Prompts can reach the kernel together | Uses one durable, account-wide Admission queue across connector processes |
| Slash command discovery | Official command updates omit local skills | Adds user-invocable Gemini, Agents, Codex, configured, and workspace skills |
| Empty turns | An output-free `end_turn` can look successful | Returns an explicit JSON-RPC error instead of recording silent success |
| Additional entitled models | Official ACP defaults to the Gemini-family path | Offers an explicit local compatibility runbook for entitled Claude 4.6 and GPT-OSS 120B |
| Product identity | Follows the underlying server | Exposes stable `agy-acp` / `paseo-agy-acp` identity to Paseo |

### Multi-agent stability

Paseo controllers can delegate several Antigravity agents at once. Admission
lets the controller dispatch that burst while excess turns wait instead of all
writing to `agy_acp_server` together. Seats are shared by every connector using
the same state directory and are released on turn completion, failure, or
cancel.

The tested default is **8 active turns / 8 concurrent starts / 2 seconds
minimum start spacing**. These are adjustable operating defaults, not a claimed
Google product limit. Invalid enabled configuration fails closed.

### Skill discovery

The adapter merges native ACP commands with `SKILL.md` metadata from configured
and default Gemini, Agents, Codex, and workspace roots. Native commands win on
name collisions, workspace skills take precedence over global skills, and
`user-invocable: false` entries stay out of slash command hints. Discovery is
scoped by session cwd so concurrent workspaces cannot leak command metadata to
each other.

### Model boundary

The unmodified official ACP path uses Gemini-family models as its default
working set. Accounts entitled to Claude 4.6 or GPT-OSS 120B can opt into the
local compatibility lifecycle documented in the
[official-kernel compatibility runbook](docs/operations/official-kernel-compat-runbook.md).
The same official kernel and Google backend remain responsible for inference;
this repository does not vendor or replace them.

<!-- readme:architecture -->
## Architecture and ownership

```text
Paseo / Generic ACP client
  -> paseo-agy-acp product adapter
       identity | daemon context | mode map | MCP rewrite
       skill hints | blank-turn guard | optional Admission fence
  -> official agy_acp_server (ACP v1 over NDJSON)
       OAuth | models | tools | MCP | inference
```

| Layer | Responsibility | License boundary |
|---|---|---|
| Paseo | Agent lifecycle, workspace, delegation, provider configuration | Paseo project |
| `paseo-agy-acp` | Paseo-specific ACP adaptation and Admission | Apache-2.0; published on npm |
| Official `agy_acp_server` | Authentication, model catalog, tools, MCP, and inference | Google proprietary software; local install only |

The adapter runs one official kernel child per connector process. Admission is
optional but recommended whenever one Antigravity account serves concurrent
Paseo agents.

<!-- readme:requirements -->
## Requirements

- **Paseo** with Generic ACP provider support
- **Node.js 22 or newer**
- A locally installed official Antigravity ACP kernel wrapper or `.par`
- An Antigravity account able to complete official `oauth-personal`
- Linux filesystem ownership and mode support when Admission is enabled

Set `PASEO_AGY_ACP_OFFICIAL_BIN` unless the kernel already exists at the
maintainer-host default pin. If this variable points directly at a `.par`, the
adapter starts it from its own directory and supplies the required uid.

<!-- readme:quickstart -->
## Quickstart

### 1. Point to the official kernel and authenticate

```bash
export PASEO_AGY_ACP_OFFICIAL_BIN="/absolute/path/to/agy-acp-server-wrapper-or.par"
npx -y paseo-agy-acp@2.3.1 --login
```

OAuth is completed by the official kernel. Its tokens remain in the kernel's
own state and are not printed by this adapter.

### 2. Prepare Admission state

Admission is optional for a single agent and recommended for multi-agent
delegation.

```bash
export AGY_ACP_STATE_DIR="$HOME/.local/state/paseo-agy-acp/account-name"
install -d -m 700 "$AGY_ACP_STATE_DIR"
npx -y --package=paseo-agy-acp@2.3.1 \
  agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
```

Use one owner-only state directory per Antigravity account. The preflight
creates or validates the directory and refuses an existing permissive path.

### 3. Configure the Paseo provider

Add or update the provider in `$PASEO_HOME/config.json` or
`~/.paseo/config.json`:

```json
{
  "providers": {
    "antigravity": {
      "type": "acp",
      "command": ["npx", "-y", "paseo-agy-acp@2.3.1"],
      "env": {
        "PASEO_AGY_ACP_OFFICIAL_BIN": "/absolute/path/to/agy-acp-server-wrapper-or.par",
        "AGY_ACP_ADMISSION_ENABLED": "true",
        "AGY_ACP_STATE_DIR": "/home/YOU/.local/state/paseo-agy-acp/account-name"
      }
    }
  }
}
```

Paseo supplies `PASEO_AGENT_ID` and `PASEO_AGENT_CWD` to the provider process.
Omit the two Admission variables only when you intentionally want unfenced
single-agent operation.

### 4. Restart and verify

Restart the Paseo daemon, create an agent with provider `antigravity`, select a
supported mode, and send a simple prompt. `npx` starts a stdio ACP server for
Paseo; it is not a standalone chat application.

<!-- readme:configuration -->
## Configuration

### Essential environment

| Variable | Purpose |
|---|---|
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Absolute official kernel wrapper or `.par` path |
| `PASEO_HOME` | Optional Paseo home; defaults to `~/.paseo` |
| `AGY_ACP_ADMISSION_ENABLED` | `true` / `1` enables the prompt fence |
| `AGY_ACP_STATE_DIR` | Absolute owner-only state directory shared by one account |

Advanced seat, start-rate, queue-timeout, cooldown, permission, recovery, and
policy-change procedures are in [Admission operations](docs/operations/admission.md).

### Mode mapping

| Paseo or legacy id | Official live mode |
|---|---|
| `default` | `default` |
| `accept-edits` | `auto_edit` |
| `dangerously-skip-permissions` | `yolo` |
| `plan` | `default` (the official kernel has no plan mode) |

`PASEO_AGY_ACP_KERNEL=legacy` and `--legacy-kernel` fail closed. The official
kernel is the only execution path.

### Skill roots

Discovery reads configured roots from workspace `.agents/skills.json` or
`skills.json`, and from global `~/.gemini/config/skills.json`. Default roots
cover workspace Agents/Codex directories and global Gemini/Agents/Codex
directories. Each skill directory must contain `SKILL.md` frontmatter with a
usable name and description.

<!-- readme:operations -->
## Operations and troubleshooting

- The official kernel must already be installed. `npx` installs only the proxy.
- The first npm run may compile `better-sqlite3` and require a local C++
  toolchain.
- Restart Paseo after changing provider command, environment, or kernel path.
- Enabled Admission with missing identity, unsafe state permissions, or invalid
  policy refuses to start instead of silently running unfenced.
- Tool quality, image generation, backend quota, and provider error text remain
  owned by the official kernel and Google backend.
- For reproducible upgrades or rollback, pin a three-part npm version in the
  provider command and restart Paseo.

Current operational references:

- [Admission operations](docs/operations/admission.md)
- [Claude / GPT-OSS local compatibility](docs/operations/official-kernel-compat-runbook.md)
- [npm Trusted Publishing](docs/operations/npm-publishing.md)
- [Changelog](CHANGELOG.md)
- [GitHub Releases](https://github.com/tiezbro/paseo-agy-acp/releases)
- [Issue tracker](https://github.com/tiezbro/paseo-agy-acp/issues)

Detailed implementation and research records remain under `docs/design/`,
`docs/evidence/`, and `docs/research/`; they are not release history or setup
instructions.

<!-- readme:development -->
## Development

```bash
git clone https://github.com/tiezbro/paseo-agy-acp.git
cd paseo-agy-acp
npm ci
npm run validate
```

An official-kernel smoke additionally requires
`PASEO_AGY_ACP_OFFICIAL_BIN`:

```bash
node scripts/official-kernel-smoke.mjs
```

<!-- readme:license -->
## License and disclaimer

The adapter source is [Apache-2.0](LICENSE). The official Antigravity kernel is
not included and remains governed by
[Google Antigravity Terms](https://antigravity.google/terms). This community
project spawns a kernel you installed locally; it does not reimplement,
relicense, or redistribute that software.

Third-party use may carry account or service risk. Prefer authorized accounts
and official credentials. The software is provided as-is, without warranty.
