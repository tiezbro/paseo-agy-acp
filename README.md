# paseo-agy-acp

[English](./README.md) | [中文](./README.zh-CN.md) | [Türkçe](./README.tr.md) | [Changelog](./CHANGELOG.md)

`paseo-agy-acp` connects Paseo to Google's standalone Antigravity ACP kernel. The [latest stable release (`2.11.1`)](https://github.com/tiezbro/paseo-agy-acp/releases/tag/v2.11.1) pins [Google's `agy_acp_server` `1.5.2`](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/ensure-managed-kernel.ts#L18). Managed Linux x86_64 installs add a compatibility layer. No changes to Paseo are required.

<!-- readme:positioning -->
## Purpose

Select **Antigravity Pro** in Paseo to run `paseo-agy-acp`. It coexists with the built-in **Antigravity** provider (`antigravity`). Antigravity Pro runs on the official ACP 1.5.2 kernel (with compatibility patches in the managed Linux x86_64 runtime), whereas the built-in provider drives `agy` on the host.

![Antigravity Pro and built-in Antigravity side by side in Paseo](./docs/images/antigravity-and-antigravity-pro.png)

Google's kernel handles authentication, models, tools, retries, and conversation history. The adapter passes Paseo's working directory, background instructions, and skills to the kernel, and relays replies, permission requests, and errors back to Paseo. This is a community project; the Google kernel is downloaded separately.

<!-- readme:value -->
## Why use paseo-agy-acp?

The adapter uses official 1.5.2 modes, retries and cancellation. Rule files, path policy, enterprise quota display and license locations that the kernel already provides stay with the kernel. The managed Linux x86_64 compatibility layer still restores supported account models, presents skills through tools and observes kernel events. Install this package and configure Paseo; the connection keeps the actual client identity.

What the new architecture delivers:

- It connects to the standalone official ACP kernel independently of the installed `agy` CLI.
- The managed Linux x86_64 runtime can show a kernel-scheduled retry or observed HTTP 503 while the turn continues.
- `max_tokens`, `max_turn_requests` and `refusal` appear as failures instead of looking like success.
- Concrete model choices remain available; the managed compatibility layer exposes built-in skills through tools without automatically writing skill files into the workspace.

### Capability comparison

#### Comparison baseline

- **Built-in Antigravity:** [Paseo `0.18.1`](https://github.com/getpaseo/paseo/releases/tag/v0.18.1) + [Google Antigravity CLI (`agy`) `1.5.18`](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.18), launched as `agy acp`.
- **Antigravity Pro:** the same Paseo `0.18.1` + [`paseo-agy-acp` `2.11.1`](https://github.com/tiezbro/paseo-agy-acp/releases/tag/v2.11.1) and its `2.11.1` companion plugin + Google's standalone ACP kernel `1.5.2` (`agy_acp_server`).

`agy` and `agy_acp_server` are separate Google distributions with independent version numbers. Linux x86_64 managed compatibility features are marked separately. The comparison is based on the released code, documentation and linked checks; it is not a full live comparison on the same account.

| Capability | Paseo built-in Antigravity | Antigravity Pro (paseo-agy-acp) |
| --- | --- | --- |
| Startup and installation | The provider ships with Paseo and starts the separately installed official `agy acp`; Paseo 0.18.1 requires CLI 1.5.1 or later. | Paseo starts the adapter, which starts the standalone `agy_acp_server`. The adapter supports `--doctor`, managed preparation, and an explicit kernel path. The adapter, plugin and kernel have separate lifecycles. |
| Google sign-in and storage | Uses the CLI's sign-in; SSH and non-SSH runs may read different credentials. | `--login` handles personal OAuth for the standalone kernel. It has a separate credential and session store, normally under `~/.gemini/antigravity-acp`. |
| Unattended authentication | Paseo documents API-key or Agent Platform authentication for unattended or scheduled runs. | The bundled `--login` handles personal OAuth only. An equivalent API-key or Agent Platform setup is not verified here. Permission settings do not change Google's account rules. |
| Model catalog | Uses the models that `agy` advertises over ACP for the signed-in account. | Uses the standalone kernel's catalog. On managed Linux x86_64, the compatibility layer restores supported Claude/GPT entries the account offers and keeps upstream disabled-model checks. The two catalogs were not compared on the same account. |
| Model cache and refresh | On 0.18.1, Paseo caches the catalog across restarts and refreshes on demand instead of polling in the background. | The bundled plugin uses the same on-demand ACP SDK catalog policy on 0.18.1. |
| Thinking levels | Discovers each model's own advertised levels; it does not apply the default model's levels to every model. | Forwards native levels, including Extra High where offered. The bundled plugin does not opt into the built-in provider's per-model catalog probing. |
| Grouped model display and fixed effort | Uses the SDK's model and thinking controls. A model with no advertised thinking levels need not offer a selector. | Preserves grouped `configOptions` on the wire, but the 0.18.1 plugin SDK flattens its select options. The fixed-effort display shim checks for `Paseo`; the 0.18.1 plugin host sends `paseo`, so the shim does not activate on this path. It never changes native effort. |
| Permission modes | Exposes CLI modes including Default, Accept edits and Plan, plus Paseo's default Full access, which can auto-select Allow once on eligible requests. CLI policy still applies. | The kernel supplies Default, Auto Edit and YOLO. YOLO is a kernel mode; `/plan` is a command. Neither is the built-in provider's Full access mode. |
| Approval and cancellation of questions | Relays tool approvals to Paseo. Stopping a turn cleans up outstanding approvals. | Relays the kernel's permission options. The 1.5.2 kernel handles cancellation of unanswered requests; YOLO does not by itself answer a choice that still reaches the client. Native question-form parity is not verified. |
| Workspace trust and hooks | Has a general ACP permission interface; the workspace-trust and hook flows were not verified separately. | Kernel trust prompts can travel through the regular permission channel. Equivalent presentation in Paseo 0.18.1 was not verified separately. |
| Session list and import | Lists and imports saved CLI conversations; the upstream migration tested import using the real CLI. | Forwards `session/list`; the plugin SDK can list and import when the kernel advertises it. CLI and standalone histories are separate; cross-provider import was not verified. |
| Cold reopen and history | Loads saved sessions with `session/load`; includes compatibility for saved conversation IDs from the old provider and a 200 ms quiet window for late replay events. | The plugin SDK uses `session/load`, without the built-in provider's extra replay window. The adapter can relay a client's resume request, but that is not a separate restore path in this SDK. |
| Stop and recovery | Sends ACP cancellation, with special handling for tools that keep running after the CLI's response. | Sends ACP cancellation, normalizes a locally cancelled `end_turn` to `cancelled`, and closes the connection after 30 seconds by default if an already dispatched prompt does not acknowledge cancellation. |
| Follow-ups and concurrency | Has a dedicated follow-up path around deferred turns with running tools and recurring schedules. | The adapter rejects overlapping prompts within one session and does not impose a global queue between sessions. The plugin does not opt into the built-in provider's deferred-turn handling. |
| Working directory and extra roots | The SDK sends `cwd`; its standard session request does not send `additionalDirectories`. | Falls back to `PASEO_AGENT_CWD` when no working directory is supplied. Can relay `additionalDirectories` received over ACP; the bundled plugin still uses the same SDK. |
| Background instructions | Uses a native session-open append when the CLI advertises that capability. | Defaults to prepending the daemon note to each prompt. With `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` and kernel support, it appends at session open instead. |
| Slash commands and skills | Shows CLI-advertised commands and skills, classifies them for the menu, and waits for the initial list. | Keeps kernel-advertised commands and adds discoverable local skills, including configured Paseo, Agents, Codex, Claude and Gemini roots. Kernel names win on collision. Provides session tools to list and read skills; managed Linux x86_64 also exposes built-in skills through tools without automatically writing their files into the workspace. |
| Pictures and other attachments | The SDK sends images as ACP image blocks. Other input block types are converted to text by this SDK. | Same Paseo SDK limit. A direct ACP client can send native resource blocks for the adapter to relay; an uploaded file is not proof of native PDF or audio support in Paseo. |
| MCP | Passes the agent's configured MCP servers to `agy`; upstream tested a real stdio tool and its approval. | Accepts configured MCP servers, preserves stdio, normalizes headers and routes HTTP/SSE URLs through a local protocol bridge. Remote-server parity was not verified. |
| Streaming and tool cards | Separates replies and reported thoughts, and has CLI-specific mappings for shell output, exit codes, files, search and MCP. | Relays replies, reported thoughts and tool events. The bundled plugin uses generic ACP tool cards rather than the built-in provider's CLI-specific mappings. |
| Context and token counts | The shared SDK reads reported token counts and context-window usage when supplied. | The same SDK consumes the kernel's usage fields. These are per-session metrics, separate from remaining account quota. |
| Paseo Usage quota card | Removed in Paseo 0.17.6; absent in the 0.18.1 baseline. | Removed from the bundled plugin in 2.11.1. Upgrading only the CLI does not remove a previously installed 2.11.0 plugin's background source. |
| Manual account commands | The official `agy` terminal has its own `/usage` and sign-in controls. The ACP menu only shows commands advertised by `agy`. | The standalone kernel's `/usage` and `/logout` are separate from the removed card; a prepended daemon note can keep them from being recognized as standalone commands. The adapter's `--usage` remains for compatibility; consumer OAuth users should use Google's official quota interface. |
| Incomplete turn reasons | In the shared SDK's ordinary prompt path, a successful response with `max_tokens`, `max_turn_requests` or `refusal` is marked complete; an ACP error is marked failed. | Turns those reasons into ACP errors and keeps the original value in `error.data.stopReason`. |
| Empty completion | No equivalent blank-success check was found in the built-in provider or its ordinary prompt path. | Rejects a successful end when no visible reply or tool activity was observed. |
| Retries, HTTP 503 and terminal failures | Uses the status and errors `agy` sends through ACP; no equivalent kernel-event observer is configured. | Managed Linux x86_64 can show a kernel-scheduled retry or an observed HTTP error such as 503 without ending the turn. An HTTP error alone is not a retry. The observer can also correct some failures reported as `end_turn`. |
| System envelopes and carousel text | No equivalent envelope or carousel conversion was found in the built-in adapter. | Converts `SYSTEM_MESSAGE` envelopes and carousel formatting into readable ACP text. A dedicated system card is not verified in the bundled plugin's Paseo path. |
| Rules and path policy | The provider does not implement Google rule or path policy itself; equivalent behavior for `GEMINI.md`, `AGENTS.md`, `.aiexclude` and administrator rules was not verified. | The standalone 1.5.2 kernel owns rule discovery and path enforcement; the adapter forwards resulting tool errors. |
| Enterprise policy and license locations | Provider documentation describes Agent Platform authentication; license-region fallback and full enterprise policy behavior were not verified. | The standalone kernel owns enterprise policy and license locations where available; the bundled sign-in command is still personal OAuth only. |

Sources: [Paseo provider documentation](https://github.com/getpaseo/paseo/blob/v0.18.1/public-docs/supported-providers/antigravity.md), [built-in ACP migration and live checks](https://github.com/getpaseo/paseo/pull/10193), [Paseo ACP SDK](https://github.com/getpaseo/paseo/blob/v0.18.1/packages/plugin/src/server/acp-internal/connection.ts), [Paseo plugin client identity](https://github.com/getpaseo/paseo/blob/v0.18.1/packages/server/src/server/agent/plugin-provider.ts#L94-L104), [Pro plugin registration](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/plugins/paseo-agy-acp/index.server.ts), [Pro fixed-effort implementation](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/fixed-model-effort.ts), [Pro ACP relay and turn outcomes](https://github.com/tiezbro/paseo-agy-acp/blob/v2.11.1/ACP%20Connector/official-kernel/proxy.ts), and [quota removal and upgrade notes](docs/operations/paseo-quota.md). The [official 1.5.0 capability catalog](docs/research/2026-11-19-official-capability-catalog.md) is historical evidence for the older standalone kernel.

<!-- readme:architecture -->
## Architecture

```text
Paseo → ACP / NDJSON → paseo-agy-acp → agy_acp_server 1.5.2 → Google
```

Each adapter process spawns one kernel child process. Managed installation verifies Google's original download and, on Linux x86_64, attaches a kernel event observer in a separate compatibility runtime. You can also connect directly to an unmodified official executable, in which case retry, HTTP, and terminal-failure notices depend on the signals that executable supplies.

Session history is stored by the kernel; the adapter has no scheduling database or runtime npm dependencies. New sessions on a connection open sequentially so early command menus bind to the right workspace, while prompts across different sessions run concurrently.

<!-- readme:requirements -->
## Requirements

- Node.js 22 or later, and Paseo with custom ACP provider support.
- A Google account authorized for the official Antigravity service.
- A non-root user to run the managed Linux x86_64 wrapper.

<!-- readme:quickstart -->
## Try it

Install the published package on the host running the Paseo daemon. To build the same tarball from source, check out the matching release tag first, then follow the Development section.

```bash
npm install --global ./paseo-agy-acp-2.11.1.tgz
paseo-agy-acp --doctor
paseo-agy-acp --prepare-kernel
paseo-agy-acp --login
```

`--doctor` checks the local installation, `--prepare-kernel` downloads the pinned kernel when needed, and `--login` signs in via personal Google OAuth. On a headless host, authorize in a browser on another device and paste the localhost callback URL back into the login terminal on the daemon host.

Merge the example below into `agents.providers` in `~/.paseo/config.json`. If the daemon cannot find the executable on its `PATH`, use its absolute path in `command`.

```json
{
  "agents": {
    "providers": {
      "paseo-agy-acp": {
        "enabled": true,
        "extends": "acp",
        "label": "Antigravity Pro",
        "command": ["paseo-agy-acp"]
      }
    }
  }
}
```

Changes apply to newly launched agents. Select **Antigravity Pro** when creating a session in Paseo.

### Register the provider with the optional Paseo plugin

On Paseo 0.17.4 or later, the companion plugin can register the `paseo-agy-acp` provider.

1. On the Paseo daemon host, install the adapter and prepare the kernel if needed. Reuse your existing ACP sign-in or run `paseo-agy-acp --login` for a new account.

   ```bash
   npm install --global paseo-agy-acp@2.11.1
   paseo-agy-acp --prepare-kernel
   ```

2. If you want the companion plugin to register the provider, turn on **Enable plugins** under **Settings → Plugins** for the target daemon, then install the plugin from the same npm release.

   ```bash
   paseo plugin install npm:paseo-agy-acp@2.11.1:plugins/paseo-agy-acp
   ```

3. If you already have an `agents.providers["paseo-agy-acp"]` entry in `~/.paseo/config.json`, remove its `extends` and `kind` fields so the plugin registers the provider. Keep any existing `command`, `env`, and other overrides. Here is a minimal example for overriding the plugin's provider settings. If your daemon cannot find `paseo-agy-acp` on its `PATH`, set `command` to the absolute path of the installed executable.

   ```json
   {
     "agents": {
       "providers": {
         "paseo-agy-acp": {
           "enabled": true,
           "label": "Antigravity Pro",
           "command": ["paseo-agy-acp"]
         }
       }
     }
   }
   ```

   If the daemon can find the adapter on its `PATH` and you have no overrides, the plugin's defaults are enough.

4. Reload the configuration and check that the plugin is `running`.

   ```bash
   paseo reload --json
   paseo plugin ls paseo-agy-acp --json
   ```

Upgrade the adapter and plugin together.

<!-- readme:configuration -->
## Configuration

| Environment variable | Purpose |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Absolute path to an existing kernel or wrapper. Leave unset for managed installation. |
| `PASEO_HOME` | Paseo daemon data directory (default: `~/.paseo`). |
| `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT` | Set to `1` to use session-level background instructions when advertised by the kernel. |
| `AGY_ACP_DIAGNOSTICS` | Set to `1` to log stage timings to stderr (omits prompt text and credentials). |
| `AGY_ACP_CANCEL_TIMEOUT_MS` | Cancellation acknowledgement timeout in milliseconds; positive integer (default: `30000`). |

Supported mode IDs are `default`, `auto_edit`, and `yolo`. Existing configurations may still use `accept-edits` (`auto_edit`) or `dangerously-skip-permissions` (`yolo`), while unknown modes are validated by the kernel. Use `/plan` in chat to request a plan.

Permission requests stay open until answered or cancelled. When using a network proxy, configure its environment variables on the provider and add local MCP endpoints to `NO_PROXY`.

Skill discovery scans configured directories, workspace roots, global Gemini/Agents/Codex roots, and Paseo compatibility directories, with workspace skills overriding global skills of the same name. Setting `user-invocable: false` hides a skill from the slash menu. The session's read-only `paseo_skills` MCP server only reads discovered skill directories, up to 1 MiB per file.

<!-- readme:operations -->
## Operations and verification

When migrating from a version with global queueing, remove `AGY_ACP_ADMISSION_*` and `AGY_ACP_STATE_DIR`. Existing ledger files remain on disk unread, and the `agy-acp-prepare-state` command has been removed. Account quota, upstream 429/502/503 responses, and generation latency remain controlled by the upstream service.

Upgrading from 2.9.2 to 2.10.0 replaces managed kernel 1.5.0 with 1.5.2; 1.5.0 compatibility receipts cannot be reused. After upgrading or rebuilding, run `paseo-agy-acp --prepare-kernel` in a terminal and wait for completion before running provider diagnostics (from a source checkout, run `node "dist/ACP Connector/main.js" --prepare-kernel`). Initial preparation can take several minutes and exceed Paseo's 20-second diagnostic initialization timeout. Already running sessions continue using their loaded kernel.

The adapter sends grouped `configOptions` and omits the legacy flat `models` catalog. This describes the ACP response; Paseo 0.18.1’s plugin SDK flattens the choices. Models with native tiers, including Gemini and Claude 5.5 when offered by the account, use the levels reported by the kernel. Gemini 4 Neon and Hydrogen’s Extra High is passed through unchanged. The fixed-effort shim was tested with an older client path; see the comparison above for its behavior with the 0.18.1 plugin. Managed Linux x86_64 also restores supported third-party entries from the upstream account catalog without changing client identity. Cached kernels are reused only when both the compatibility module and patch recipe match. Model availability still follows the upstream account catalog.

- [Migrate from the old queue](docs/operations/admission.md)
- [Verify the lightweight adapter](docs/operations/lightweight-adapter.md)
- [Operate the kernel wrapper](docs/operations/official-kernel-compat-runbook.md)
- [Verify with a Paseo client](docs/operations/paseo-adapter-verification.md)
- [Verify grouped models with a live account](docs/operations/2026-11-22-grouped-model-acceptance.md)
- [Verify across hosts](docs/operations/paseo-cross-host-e2e.md)
- [Publish to npm](docs/operations/npm-publishing.md)
- [Release, install and update the companion plugin](docs/operations/plugin-releases.md)

Version 2.11.1 removed the Antigravity ACP card from Paseo **Usage**. If you installed the 2.11.0 plugin, update the plugin as well as the adapter to remove the old usage source. [Upgrade guide](docs/operations/paseo-quota.md#已安装-2110-用户的升级步骤)

<!-- readme:development -->
## Development

From the source root, install development dependencies, build the adapter, and pack the npm tarball used in the quickstart:

```bash
npm ci
npm run build
npm pack
```

```bash
npm run validate
npm run test:paseo-provider
npm run test:paseo-client
```

Client tests run against the locked Paseo fixtures from the verification guide and a simulated kernel. To compare the official kernel and adapter using a real account, run the standalone probe:

```bash
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --concurrency 4 --groups native,adapter
```

Both groups use the same model and consume quota from the active account. The probe denies tool permissions, stops on unexpected results, and cleans up its processes. Reports record timings and status only, omitting model output and raw errors. Historical evidence is in `docs/research/` and `docs/design/`.

<!-- readme:license -->
## License

[Apache-2.0](./LICENSE)
