# paseo-agy-acp

Coexist with Paseo's built-in Antigravity and sign in two Antigravity Pro accounts

[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.7.1-blue?style=flat-square)](./package.json)
[![npm](https://img.shields.io/npm/v/paseo-agy-acp?style=flat-square)](https://www.npmjs.com/package/paseo-agy-acp)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](./package.json)
[![ACP](https://img.shields.io/badge/ACP-NDJSON%20v1-8A2BE2?style=flat-square)](https://agentclientprotocol.com)

[English](./README.md) | [中文](./README.zh-CN.md) | [Changelog](./CHANGELOG.md)

Since v0.11.0, Paseo includes a built-in Antigravity provider. `paseo-agy-acp`
coexists with it as an independent provider, so Paseo can sign in two
Antigravity Pro accounts and dispatch everyday work to different accounts.

**Upstream runtime: Registry `antigravity-acp` 1.4.3.** Version 2.7.1 fixes
Admission transaction contention and adds real Paseo 0.13.2 client contracts
and author-local cross-host verification notes, retaining protocol lifecycle hardening, read-only
skill resources, model tracking, diagnostics and the workspace-integrity fix.

![Antigravity and Antigravity Pro both available in Paseo](./docs/images/antigravity-and-antigravity-pro.png)

The settings list shows the display name. Use the provider id in `config.json`
and when creating an agent.

| | **Antigravity Pro** (this adapter) | **Antigravity** (built into Paseo) |
| --- | --- | --- |
| Display name | Antigravity Pro | Antigravity |
| Provider id | `paseo-agy-acp` | `antigravity` |
| Process | official ACP kernel `agy_acp_server` | host `agy`, resolved from `PATH` |
| Login | `~/.gemini/antigravity-acp` | `~/.gemini/antigravity-cli` |

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
| --- | --- | --- |
| Official execution chain | Can start an ACP server | Keeps OAuth, models, tools, MCP, and inference in Google's official kernel |
| Paseo context | No product-specific guarantee | Injects Paseo daemon and workspace/agent context into official prompts |
| Modes and MCP | Client and kernel shapes may differ | Maps Paseo modes, preserves native MCP `http`/`sse`, and applies necessary protocol compatibility |
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
| --- | --- | --- |
| Paseo | Agent lifecycle, workspace, delegation, provider configuration | Paseo project |
| `paseo-agy-acp` | Paseo-specific ACP adaptation and Admission | Apache-2.0; published on npm |
| Official `agy_acp_server` | Authentication, model catalog, tools, MCP, and inference | Google proprietary software; local install only |

The adapter runs one official kernel child per connector process. Admission is
optional but recommended whenever one Antigravity account serves concurrent
Paseo agents.

CI verifies the adapter with the real Paseo 0.13.2 ACP client, an isolated
kernel, and a local HTTP MCP server. It does not run a Google account, a real
Paseo daemon, or a cross-host deployment.

The author reports local cross-VM Gemini/Claude delegation and follow-up turns,
plus Gemini cancellation and host reconnection, using the Admission patch
source. Those runs are **author-local acceptance, outside CI**. Raw environment
evidence is not public and has not been independently reproduced by the
maintainer; these observations are not a product guarantee. UI, account
isolation, Paseo 0.12.0 and other operating systems were not retested. See the
[verification scope](docs/operations/paseo-adapter-verification.md) and
[cross-host runbook](docs/operations/paseo-cross-host-e2e.md).

<!-- readme:requirements -->
## Requirements

- **Paseo** v0.12.0 or newer with custom ACP provider support
- **Node.js 22 or newer**
- A non-root Linux user for the managed Linux x86_64 compatibility lifecycle
- An Antigravity account able to complete official `oauth-personal`
- Linux filesystem ownership and mode support when Admission is enabled

On first start the adapter downloads the official Antigravity ACP 1.4.3 archive
for the current operating system from Google. The npm package does not contain
those archives. Linux x86_64 also installs the local compatibility wrapper.
Leave `PASEO_AGY_ACP_OFFICIAL_BIN` unset, or keep it pointed at the managed
wrapper. A different existing path is used as-is.

<!-- readme:quickstart -->
## Quickstart

### 1. Authenticate

```bash
npx -y paseo-agy-acp@2.7.1 --login
```

The first run downloads and configures official kernel 1.4.3. That download is
about 320 MiB and stays under `~/.local/opt/`.

OAuth is completed by the official kernel. Its tokens remain in the kernel's
own state and are not printed by this adapter.

On a headless VM, open the authorization link on your computer, then paste the
complete localhost callback URL into the same VM terminal. Run login and the
provider as the same Linux user. If your network requires a proxy, configure it
for both login and the provider as described below.

### 2. Prepare Admission state

Admission is optional for a single agent and recommended for multi-agent
delegation.

```bash
export AGY_ACP_STATE_DIR="$HOME/.local/state/paseo-agy-acp/account-name"
install -d -m 700 "$AGY_ACP_STATE_DIR"
npx -y --package=paseo-agy-acp@2.7.1 \
  agy-acp-prepare-state "$AGY_ACP_STATE_DIR"
```

Use one owner-only state directory per Antigravity account. The preflight
creates or validates the directory and refuses an existing permissive path.

### 3. Configure the Paseo provider

Add or update the provider in `$PASEO_HOME/config.json` or
`~/.paseo/config.json`. The provider id is the key under `agents.providers`:

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "extends": "acp",
        "label": "Antigravity Pro",
        "command": ["npx", "-y", "paseo-agy-acp@2.7.1"],
        "env": {
          "AGY_ACP_ADMISSION_ENABLED": "true",
          "AGY_ACP_STATE_DIR": "/home/YOU/.local/state/paseo-agy-acp/account-name"
        }
      }
    }
  }
}
```

A custom ACP provider needs `extends: "acp"` and a `label`. Provider ids must
match `^[a-z][a-z0-9-]*$`; `paseo-agy-acp` does.

Paseo supplies `PASEO_AGENT_ID` and `PASEO_AGENT_CWD` to the provider process.
Omit the two Admission variables only when you intentionally want unfenced
single-agent operation.

#### Coexistence with Paseo's built-in Antigravity

Display names, provider ids, login directories, and the screenshot are at the
top of this README. In the JSON above, the key is `paseo-agy-acp` and `label`
is `Antigravity Pro`.

If an existing config still uses the key `antigravity` for this adapter, rename
it to `paseo-agy-acp`. While the old key remains, Paseo hides the built-in
Antigravity provider and routes the id `antigravity` to this adapter.

### 4. Reload and verify

Run `paseo reload`, then create an agent with provider `paseo-agy-acp`,
select a supported mode, and send a simple prompt. `npx` starts a stdio ACP
server for Paseo; it is not a standalone chat application.

<!-- readme:configuration -->
## Configuration

### Essential environment

| Variable | Purpose |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Absolute official kernel wrapper or `.par` path |
| `PASEO_HOME` | Optional Paseo home; defaults to `~/.paseo` |
| `AGY_ACP_ADMISSION_ENABLED` | `true` / `1` enables the prompt fence |
| `AGY_ACP_STATE_DIR` | Absolute owner-only state directory shared by one account |

Advanced seat, start-rate, queue-timeout, cooldown, permission, recovery, and
policy-change procedures are in [Admission operations](docs/operations/admission.md).

### Network proxy

When required, set `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy` and `https_proxy`
in the provider's `env`. Set `NO_PROXY` and `no_proxy` to
`localhost,127.0.0.1,::1`, adding any directly connected host addresses.
Use a proxy address reachable from each machine; `127.0.0.1` always refers to
that machine. Terminal exports used for login do not configure an already
running Paseo daemon. See the cross-host runbook for complete examples.

### Mode mapping

| Paseo or legacy id | Official live mode |
| --- | --- |
| `default` | `default` |
| `accept-edits` | `auto_edit` |
| `dangerously-skip-permissions` | `yolo` |
| `plan` | `default` (the official kernel has no plan mode) |

Official `yolo` and Paseo's Auto Accept (`features.auto_accept`) are
separate switches. An unanswered `session/request_permission` keeps
`session/prompt` open, so the agent can stay `running` after assistant
text is already visible. For unattended work, enable Auto Accept or
approve with `paseo permit ls` / `paseo permit allow`, and use `yolo`
when you also want the kernel to skip tool confirmation. This adapter
does not treat displayed text as `end_turn`. See
[#11](https://github.com/tiezbro/paseo-agy-acp/issues/11).

`PASEO_AGY_ACP_KERNEL=legacy` and `--legacy-kernel` fail closed. The official
kernel is the only execution path.

### Skill roots

Discovery combines configured roots with workspace and global Gemini, Agents,
Codex and Paseo compatibility directories, respecting `GEMINI_HOME` and
`PASEO_HOME`. Paseo documents `.agents/skills`, `.claude/skills`, and
`.codex/skills` as installation locations; `.paseo/skills` is an additional
compatibility location. Each skill needs `SKILL.md` name and description
frontmatter. The session-scoped `paseo_skills` MCP server exposes
`list_skills` and `read_skill`, so the kernel can read discovered skill text
and relative resource files without copying them into the workspace. Reads
are limited to the discovered skill directory and 1 MiB per file.

See [adapter verification](docs/operations/paseo-adapter-verification.md) for
queue notices, optional stderr diagnostics, native context opt-in and the
remaining real Paseo acceptance steps.

<!-- readme:operations -->
## Operations and troubleshooting

Run `paseo-agy-acp --doctor` for a read-only JSON check of the local kernel
executable and managed receipt. It exits with status 1 when `ready` is false;
authentication and daemon state remain `not_checked`. Run
`paseo-agy-acp --prepare-kernel` explicitly to install or verify the managed
kernel before launching an agent.

- `npx` installs the proxy package; `--prepare-kernel`, `--login` or the first
  protocol launch downloads the managed official kernel separately.
- The first npm run may compile `better-sqlite3` and require a local C++
  toolchain.
- After changing provider command, environment, or kernel path, run `paseo reload`.
  Changes apply to future launches; existing agent processes keep their configuration.
  See [Paseo custom providers](https://paseo.sh/docs/custom-providers).
- Enabled Admission with missing identity, unsafe state permissions, or invalid
  policy refuses to start instead of silently running unfenced.
- A turn that stays `running` after visible assistant output is often a
  pending permission card, not a missing kernel completion. Check Auto Accept
  and `paseo permit ls`. Paseo's `Worked for …` duration is wall-clock and
  includes those waits.
- Tool quality, image generation, backend quota, and provider error text remain
  owned by the official kernel and Google backend.
- For reproducible upgrades or rollback, pin a three-part npm version in the
  provider command, run `paseo reload`, and launch a new agent.

Current operational references:

- [Admission operations](docs/operations/admission.md)
- [Claude / GPT-OSS local compatibility](docs/operations/official-kernel-compat-runbook.md)
- [Cross-host deployment, proxy and E2E verification](docs/operations/paseo-cross-host-e2e.md)
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
