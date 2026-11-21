# paseo-agy-acp

[English](./README.md) | [中文](./README.zh-CN.md) | [Changelog](./CHANGELOG.md)

`paseo-agy-acp` connects an existing Paseo installation to the official Google Antigravity ACP kernel. The adapter package is `2.9.2` and its reference kernel is official `agy_acp_server` 1.5.0 with the managed Linux compatibility layer. Install this package and configure a custom ACP provider in Paseo. No Paseo code changes are required.

<!-- readme:positioning -->
## Purpose

Choose **Antigravity Pro** in Paseo to start `paseo-agy-acp`. It can run alongside the built-in **Antigravity** provider (`antigravity`). Antigravity Pro uses the unmodified official ACP 1.5.0 kernel. The built-in provider drives `agy` on the host.

![Antigravity Pro and built-in Antigravity side by side in Paseo](./docs/images/antigravity-and-antigravity-pro.png)

Google’s kernel handles authentication, models, tools, retries and conversation history. The adapter supplies Paseo’s working directory, background instructions and skills, then delivers replies, permission requests and errors to Paseo. This is a community project. The Google kernel is downloaded separately.

<!-- readme:value -->
## Why use paseo-agy-acp?

This refactor makes the adapter a thin interface to the official kernel. The unmodified 1.5.0 kernel decides capabilities, names, order, modes, retries and cancellation. Paseo presents the signals the kernel already emits. Install this package only. Do not change Paseo. The adapter no longer rewrites official behavior with a global queue, and it does not report Paseo as another client.

What the new architecture delivers:

- It connects directly to the official kernel instead of scraping the `agy` interface.
- A scheduled retry or an HTTP 503 is shown immediately, and the turn continues.
- `max_tokens`, `max_turn_requests` and `refusal` appear as failures instead of looking like success.
- Model filtering and skill presentation follow the official defaults.

“Official” says whether the unmodified 1.5.0 kernel provides the capability named in the first column. The last column describes Paseo’s built-in `antigravity-provider` implementation. “Not verified” means there is insufficient evidence for that comparison. [Official capability catalog](docs/research/2026-11-19-official-capability-catalog.md)

| Capability | What it does | Official | Paseo adaptation | Built-in antigravity |
| --- | --- | --- | --- | --- |
| Adapter connection identity | Identifies which provider answered the connection. | No | Preserves the kernel’s advertised capabilities. The handshake reports `agy-acp`, the title `paseo-agy-acp (official Antigravity ACP kernel)` and the adapter version. | Registers as `antigravity`, shows as Antigravity and launches `agy`. |
| Terminal Google sign-in | Signs in with a personal Google account or renews authorization. | Yes | Run `paseo-agy-acp --login` on the daemon host. It only uses `oauth-personal`. Chat has no sign-in or account-switch control. | Run `agy` in a terminal to sign in. The provider uses the CLI’s login state. |
| Crash recovery and history replay | Reopens the conversation with its messages and tool history. | Yes | Paseo prefers `loadSession` to replay user messages, replies, recorded thoughts and tools. It restores context alone only if load is unavailable and the kernel advertises resume. | Can, but `--conversation` only continues the saved conversation by ID. The CLI does not replay its timeline. |
| Local session list | Lists the kernel’s saved sessions for a working directory. | Yes | Forwards `session/list` and the session IDs. The default data directory is `~/.gemini/antigravity-acp`. | Cannot list the CLI’s saved sessions. The provider can reopen a known conversation ID. |
| Working directory and extra roots | Sets the session’s working directory and additional directories it may access. | Yes | Fills a missing working directory from `PASEO_AGENT_CWD` and passes through any `additionalDirectories` the client supplies. | Can, but the provider passes only the working directory as `--add-dir`. |
| Interrupt the current turn | Stops a request and keeps the session for the next message. | Yes | Forwards cancellation. If the kernel acknowledges a local cancel with `end_turn`, the client receives `cancelled`. After 30 seconds without acknowledgement, the adapter closes the connection by default. | Can, but stops the CLI process. The next prompt restarts it with the saved conversation ID. |
| Overlapping prompt protection | Prevents a second request from starting in an active session. | No | Rejects the overlapping request. Other sessions dispatch directly, with no global seat limit or cooldown in the adapter. | Also rejects an overlapping prompt in the same session with `TURN_ACTIVE`. |
| Images and attachments | Sends an image, a local file location or an embedded resource with a message. | Yes | Pasted images use ACP image blocks. Uploaded files, including audio, pass a local file location to the kernel. The adapter also relays ACP resource blocks supplied directly. | Can, but writes images to temporary files and sends their paths to the CLI. Its message interface accepts only text and images. |
| Per-message background instructions | Picks up revised daemon instructions on the next message in the session. | No | By default the adapter reads and prepends the current instructions to each message. Native session context appends them once at creation, load or resume. | Can, but prepends instructions only to the first message of a new conversation and skips the prefix on resume. |
| `/usage` and `/logout` | Shows usage or signs out when the command is sent on its own. | Yes | The kernel handles these commands directly when the daemon has no saved note, or when `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT=1` activates native session context. Otherwise the prefixed note makes the command an ordinary model message. The result appears as a regular reply. | Cannot run these slash commands. The provider disables slash commands when starting the CLI. |
| Slash skills and `/plan` | Makes workspace and personal skills available alongside the official commands. | No | Keeps `/plan`, `/logout` and `/usage`, then appends local skills that users can invoke. Official names win on collision. `/plan` requests a plan and keeps the current permission mode. | Cannot offer the slash menu. It disables slash commands and sends Paseo an empty command list. |
| Models and thinking levels | Lists models available to the account and accepts the thinking levels the kernel offers. | Yes | Preserves concrete model IDs and grouped thinking options. The managed Linux compatibility layer also lists supported Claude/GPT models actually offered by the upstream account catalog, while retaining upstream disabled-model checks. | Can, but gets its list from `agy models` and selects effort through the model ID alone. |
| Three modes and unattended YOLO | Default follows approval policy, Auto Edit approves edits and YOLO approves routine tool calls. | Yes | Select `yolo` for unattended routine tools. Administrator review rules still apply. Paseo’s Auto Accept for client permission requests is a separate setting. | Can, but offers only Full access and always starts with `--dangerously-skip-permissions`. Default and Auto Edit are unavailable. |
| Tool approvals and single-choice questions | Approves tools, saves a permission where offered or answers a question from the kernel. | Yes | Sends the official choices to Paseo’s permission panel. Questions with multiple allow options need a person to choose. Selecting YOLO alone does not answer them in stock Paseo. | Cannot present interactive CLI permissions or single-choice questions for the user to answer in Paseo. |
| Workspace trust and hooks | Asks whether a workspace hook may be trusted and saves an explicit choice. | Yes | Presents trust and distrust as a normal permission request. A person chooses by default. With Paseo Auto Accept enabled, a trust request with a single allow option can be approved automatically. | Cannot relay the workspace trust choices to Paseo. The built-in provider has no permission interface for them. |
| Streaming replies and thought summaries | Shows the reply as it arrives and any thought summary the model supplies. | Yes | Delivers reply text and official thoughts separately. Loading history can replay recorded summaries. | Can, but only adds reply text to the timeline. It has no separate thought-summary entry. |
| System message envelopes | Recognizes passages explicitly enclosed in `SYSTEM_MESSAGE`. | No | Sends complete envelopes outside code fences as separate ACP text messages readable in stock Paseo. Citations and command receipts remain regular replies. | Cannot distinguish the envelope. It accumulates text by reply step. |
| Tool progress and results | Shows what a tool is doing, its output and its final status. | Yes | Matches updates by the official call ID and preserves file locations, command output and exit codes when supplied. | Can, but shell entries map only the command and its output. They have no separate exit-code field. |
| MCP tool connections | Lets the kernel call MCP servers configured for the session. | Yes | Passes stdio through directly and connects HTTP and SSE through a local protocol bridge. Calls and results appear on the timeline. | Can, but uses the CLI’s own MCP configuration. The provider cannot connect tools supplied by Paseo. |
| Context and token usage | Reports used context, capacity and per-turn token counts. | Yes | Forwards official `usage_update` events and response usage. Stock Paseo can read input, output and cache-read counts. | Can, but totals only input, output and cache reads. It has no official context-capacity update. |
| Empty-success detection | Distinguishes normal completion from an `end_turn` with no visible output. | No | A visible reply or tool activity counts as output. A wholly empty success returns `-32000` and appears as a failed turn. | Cannot detect an empty success. It marks a CLI `SUCCESS` completed without checking for visible output. |
| Three reasons for an incomplete turn | Distinguishes a token limit, a per-turn request limit and exhausted quota. | Yes | Converts `max_tokens`, `max_turn_requests` and `refusal` to `-32000` errors. Paseo shows the corresponding English explanation. `error.data.stopReason` keeps the original value. | Cannot map the three ACP reasons. It handles the CLI’s `SUCCESS` or `ERROR` result. |
| Immediate retry and HTTP 503 notices | Shows whether the kernel has scheduled a retry or the backend reported an error while the turn is active. | No | The managed Linux x86_64 wrapper reports an explicit retry decision immediately. It also reports HTTP 503 immediately, once per status code per turn. The turn continues. A 502 or 503 alone does not establish a scheduled retry. | Cannot report these live notices. The provider does not parse the two signals or publish corresponding timeline updates. |
| Confirmed terminal failure | Detects when the kernel reports an execution failure and still returns `end_turn`. | No | When the managed wrapper confirms the failure for this turn, the adapter returns `-32000` and keeps the long diagnostic out of the answer. | Can, but reports failure from a CLI `ERROR` or a process error. It has no equivalent ACP outcome correction. |
| Enterprise accounts and policy | Eligible enterprise sessions can use administrator policy and an enterprise browser. | Yes | The package’s login command supports personal Google sign-in only. It offers no enterprise, API key, Agent Platform or gateway sign-in. | Not verified |

The nine facts that remain unconfirmed are listed in [section 14 of the catalog](docs/research/2026-11-19-official-capability-catalog.md#十四仍未确认).

<!-- readme:architecture -->
## Architecture

```text
Paseo → ACP / NDJSON → paseo-agy-acp → agy_acp_server 1.5.0 → Google
```

Each adapter process starts one kernel child. Managed installation verifies Google’s original download. On Linux x86_64 it adds a kernel event observer in a separate compatibility runtime. You can also connect an unmodified official executable directly. Retry, HTTP and terminal-failure notices then depend on the signals that executable supplies.

The kernel stores session history. The adapter has no scheduling database or runtime npm dependencies. It opens new sessions in sequence on a connection so that early command menus attach to the correct workspace. Different sessions can process prompts concurrently.

<!-- readme:requirements -->
## Requirements

- Node.js 22 or later and Paseo with custom ACP provider support.
- A Google account authorized to use the official Antigravity service.
- A non-root user for the managed Linux x86_64 wrapper.

<!-- readme:quickstart -->
## Try it

On the host running the Paseo daemon, install the npm package for this version. If you have the source checkout, the Development section shows how to produce the same package file.

```bash
npm install --global ./paseo-agy-acp-2.9.2.tgz
paseo-agy-acp --doctor
paseo-agy-acp --prepare-kernel
paseo-agy-acp --login
```

`--doctor` checks the local installation. `--prepare-kernel` downloads the pinned kernel when needed. Sign in using personal Google OAuth. On a headless host, authorize in a browser on another device, then paste the localhost callback URL into the login terminal on the daemon host.

Merge the provider below into `agents.providers` in `~/.paseo/config.json`. If the daemon cannot find the executable on its `PATH`, use its absolute path in `command`.

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

The configuration applies to newly launched agents. Choose **Antigravity Pro** when creating a session in Paseo.

<!-- readme:configuration -->
## Configuration

| Environment variable | Purpose |
| --- | --- |
| `PASEO_AGY_ACP_OFFICIAL_BIN` | Absolute path to an existing kernel or wrapper. Leave unset for managed installation. |
| `PASEO_HOME` | Paseo daemon data directory. Defaults to `~/.paseo`. |
| `PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT` | Set to `1` to use session-level background instructions if the kernel advertises support. |
| `AGY_ACP_DIAGNOSTICS` | Set to `1` to write stage timings to stderr. Logs omit prompt text and credentials. |
| `AGY_ACP_CANCEL_TIMEOUT_MS` | Positive integer in milliseconds to wait for cancellation acknowledgement. Defaults to `30000`. |

The mode IDs are `default`, `auto_edit` and `yolo`. Existing configurations may use `accept-edits` for `auto_edit`, or `dangerously-skip-permissions` for `yolo`. The kernel validates unknown modes. To request a plan, use `/plan` in chat.

Permission requests remain open until answered or cancelled. To use a network proxy, set its environment variables on the provider and include local MCP endpoints in `NO_PROXY`.

Skill discovery covers configured directories, workspace roots, global Gemini, Agents and Codex roots, and Paseo compatibility directories. Workspace skills take precedence over global skills of the same name. `user-invocable: false` hides a skill’s slash menu entry. The session’s read-only `paseo_skills` MCP server reads only discovered skill directories, up to 1 MiB per file.

<!-- readme:operations -->
## Operations and verification

When migrating from a version with global queueing, remove `AGY_ACP_ADMISSION_*` and `AGY_ACP_STATE_DIR`. Old ledgers stay on disk and the adapter no longer reads them. The `agy-acp-prepare-state` command has been removed. Account quota, upstream 429/502/503 responses and generation latency remain under the service’s control.

The adapter preserves the concrete `models` catalog alongside grouped `configOptions`, including distinct thinking variants. On managed Linux x64, it also restores supported third-party entries from the upstream account catalog without changing client identity. Cached kernels are reused only when both the compatibility module and patch recipe match. After upgrading or rebuilding, run `paseo-agy-acp --prepare-kernel` in a terminal and wait for it to finish before running provider diagnostics. For a source checkout, use `node "dist/ACP Connector/main.js" --prepare-kernel`. Initial preparation can take several minutes (about 314 seconds on the test host), exceeding Paseo’s 20-second diagnostic initialization timeout. Existing running sessions keep their loaded kernel. Model availability still follows the upstream account catalog.

- [Migrate from the old queue](docs/operations/admission.md)
- [Verify the lightweight adapter](docs/operations/lightweight-adapter.md)
- [Operate the kernel wrapper](docs/operations/official-kernel-compat-runbook.md)
- [Verify with a Paseo client](docs/operations/paseo-adapter-verification.md)
- [Verify across hosts](docs/operations/paseo-cross-host-e2e.md)
- [Publish to npm](docs/operations/npm-publishing.md)

<!-- readme:development -->
## Development

From the source root, install development dependencies, build the adapter and produce the npm package used in the quickstart.

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

The client tests use the locked Paseo fixtures from the verification guide and a simulated kernel. To compare the official kernel with the adapter using a real account, run the separate probe.

```bash
node scripts/compare-kernel.mjs --run --kernel /absolute/path/agy_acp_server.par --concurrency 4 --groups native,adapter
```

Both groups use the same model and consume the existing account’s quota. The probe denies tool permissions, stops on unexpected results and cleans up its processes. Reports contain timings and status only. They omit model output and raw errors. Historical evidence is in `docs/research/` and `docs/design/`.

<!-- readme:license -->
## License

[Apache-2.0](./LICENSE)
