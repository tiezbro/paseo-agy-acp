# Changelog

All notable changes to `paseo-agy-acp` are recorded here.

## 2.7.1 - 2026-10-28

### 2.7.1 修复

- Admission 状态事务改用 `BEGIN IMMEDIATE`，在读取快照前获取写锁，避免并发连接
  先读后写时立即报 `database is locked`。沿用 5 秒等待上限、全局容量限制与结算语义，
  不增加 prompt 重放。
- 官方内核冒烟握手使用 Paseo 的 `clientCapabilities`，同步包版本、安装示例和版本断言。

### 2.7.1 验证与运维

- CI 固定安装 `@getpaseo/server@0.13.2`，使用真实 ACP 客户端覆盖新建、模型切换、
  许可拒绝、取消、关闭、冷启动加载与恢复，以及 MCP 目录、参数、请求头、查询参数和协议降级。
  独立 CI job 使用提交的专用 lockfile、npm 官方 registry、SHA-512 integrity 与禁用安装脚本的 npm ci。
- 新增独立进程持锁的入队、激活和结算回归测试。完整验证为 58 个测试文件、361 项通过、
  1 项平台跳过；真实客户端契约 4/4 通过，架构及秘密扫描通过。
- 补充普通用户部署、代理、无桌面登录与跨主机操作指南。作者报告修补源码完成了
  Gemini / Claude Sonnet 4.6 跨 VM 委派及 Gemini 取消和重连；这属于作者本地验收，
  未纳入 CI，原始环境证据未公开供维护者独立复核，不作为产品保证。
- 官方运行时仍为 Registry `antigravity-acp` 1.4.3，内核补丁、哈希及收据保持不变。
  未重新验收完整 UI、双账号隔离、Paseo 0.12.0、其他系统或长时间并发压测。

## 2.7.0 - 2026-10-27

### Added

- Add read-only session-scoped skill resources through MCP, including skill
  bodies and relative resource files with workspace and home configuration
  discovery.
- Add optional native daemon-context negotiation, diagnostic stage timing,
  installation doctor/prepare commands, and capability-aware queue feedback.

### Fixed

- Harden NDJSON UTF-8 framing, cancellation races, EOF and signal shutdown,
  backpressure cleanup, MCP lifecycle closure, blank-turn/error settlement,
  and concrete model tracking after model changes.
- Preserve endpoint rewriting across SSE field order, CR/LF/CRLF delimiters and
  chunk boundaries while leaving ordinary response URLs unchanged.
- Preserve the v2.6.1 official 1.4.3 TOOL presentation, pins, receipts and
  fail-closed runtime integrity checks.

### Compatibility and verification

- Upstream remains Registry `antigravity-acp` 1.4.3. Independently verified
  with Paseo 0.13.2 on Linux x86_64, including skill resource reads, real text
  and tool turns, SSE variants, shutdown cleanup and workspace isolation.
- Complete validation: 57 test files, 357 passed and one conditional skip;
  typecheck, build, architecture and secret scans passed. npm 12 package-content
  compatibility passed on this release tree.
- Complete Paseo daemon/UI, account isolation, Paseo 0.12.0 and other operating
  systems were not retested.


## 2.6.1 - 2026-10-26

### Fixed

- Preserve built-in and user skill lookup without automatically writing built-in
  skill files into project workspaces on the managed Linux x86_64 runtime (#18).
- Pin the official 1.4.3 skill configuration preimage and enforce its patched
  postimage both during lifecycle verification and at wrapper startup. The
  official server control source remains unchanged.

### Compatibility and verification

- Upstream remains Registry `antigravity-acp` 1.4.3. Verified the real harness
  default-mode workspace write and TOOL-mode built-in/user skill reads with an
  empty workspace, plus fail-closed behavior after isolated runtime tampering.
- Smoke-tested the Paseo 0.13.0 ACP client, new sessions, modes and commands,
  and real product-proxy text/tool turns. Paseo 0.12.0, the complete daemon/UI,
  and other operating systems were not retested for this patch.
- Complete validation: 44 test files, 265 passed and one root-only ownership
  test skipped; architecture and secret checks passed. npm 10/11 package checks
  and actual npm 12 packing passed. The existing npm 12 package-content JSON
  assertion remains unsupported in this patch; PR #19 changes are not included.

## 2.6.0 - 2026-10-24

### Changed

- Update the supported Paseo integration references to v0.12.0.
- Adapt the managed official Antigravity ACP runtime to Registry antigravity-acp 1.4.3. Downloads now use the 1.4.3 platform archives and registry SHA-256 checksums, with managed paths under ~/.local/opt/agy-acp-server-1.4.3.
- Re-pin the opt-in Linux compatibility lifecycle to the verified 1.4.3 PAR, harness, and runfiles source hashes. The existing model catalog compatibility patch and PR #17 request transform remain required because the 1.4.3 source still has the same third-party gate and byte-identical proxy source.
- Revalidated ACP protocol negotiation, session/list, session/resume, model/thinking_level configuration, Linux --uid= startup, and EOF shutdown against the official 1.4.3 kernel.


## 2.5.1 - 2026-10-11

### Changed

- Upgrade the managed official Antigravity ACP kernel from 1.2.1 to 1.3.0 for
  every supported platform. New downloads land in
  `~/.local/opt/agy-acp-server-1.3.0` and are verified against the 1.3.0
  SHA-256 pins before use; a mismatch fails closed.
- Re-pin the Linux compatibility lifecycle to the 1.3.0 artifact hashes. The
  CCPA request transform is unchanged because
  `ccpa_connection/proxy_server.py` is byte-identical to 1.2.1. The catalog
  patch keeps its behavior: the 1.3.0 `allow_third_party` client gate
  (JetBrains/Zed/Xcode only) is replaced with the same local
  `is_catalog_model` filter used on 1.2.1, so Paseo still sees the entitled
  non-Gemini models.
- README (EN/ZH), the compatibility runbook, version pins, the version badge,
  tests, and the official-kernel smoke now expect `2.5.1` / kernel `1.3.0`.

### Unchanged

- The Paseo provider id stays `paseo-agy-acp` with display name **Antigravity
  Pro**; Paseo's built-in provider keeps the id `antigravity`. Admission keeps
  `provider: "antigravity"`, the ACP identity stays `agy-acp`, and the npm
  keyword stays `antigravity`.

### Fixed

- The model-parity acceptance harness now waits for the whole process group
  to disappear within the existing SIGTERM/SIGKILL grace budgets before it
  claims process-group cleanup, instead of trusting the direct child's exit
  event. Under CPU load the spawned grandchild could still be alive or
  unreaped at that instant, which made `process_cleanup_unconfirmed`
  intermittent in CI. Race timers are also cleared once they are settled, so
  the harness process no longer sits idle for up to a grace period after a
  run finishes.

### Verification

- Complete validation: 43 test files, 258 passed, 1 skipped; architecture and
  secret checks passed.
- Local lifecycle `prepare`/`verify` against the downloaded 1.3.0 Linux x86_64
  archive succeeded for artifact
  `1.3.0-cf6feaebdacf-compat-v1-0c966320bdbb-110677625daa`, and the patched
  `model_selection.py` and `proxy_server.py` compile.

## 2.5.0 - 2026-10-10

### Changed

- Use the Paseo provider id `paseo-agy-acp` with display name **Antigravity
  Pro** instead of `antigravity`. Paseo v0.11.2 added its own built-in agy
  provider (id `antigravity`, display name Antigravity) that starts the host
  `agy` CLI (`~/.local/bin/agy`); its login lives in
  `~/.gemini/antigravity-cli`. This adapter does not start that `agy` CLI; it
  starts `agy-acp`, which runs the official ACP kernel `agy_acp_server`, and
  its login lives in `~/.gemini/antigravity-acp`.
- The built-in provider and this adapter can run at the same time: the built-in
  provider runs its `agy` processes, and this adapter runs its `agy_acp_server`
  processes. Separate logins mean two Antigravity accounts, so both accounts'
  Gemini Pro quotas can be used at the same time. Admission only limits
  `agy_acp_server`; it does not limit the built-in provider's `agy` processes.
- Configure the custom provider with the Paseo v0.11.2 shape
  `extends: "acp"` plus `label: "Antigravity Pro"` under `agents.providers`.
  README (EN/ZH) examples, version pins, the version badge, tests, and the
  official-kernel smoke now expect `2.5.0`.
- Existing users who keyed this adapter as `antigravity` must rename that key
  to `paseo-agy-acp`. While the old key remains, Paseo hides the built-in agy
  provider and routes the id `antigravity` to this adapter.

### Unchanged

- Admission keeps the internal partition string `provider: "antigravity"`; the
  live state directory keys seats with it, so changing it would split the
  queue.
- ACP `agentInfo` name stays `agy-acp`, and the npm keyword stays
  `antigravity`.

### Verification

- Complete validation: 43 test files, 257 passed, 1 skipped; architecture and
  secret checks passed.

## 2.4.2 - 2026-10-10

### Fixed

- Fold a complete `<SYSTEM_MESSAGE>` envelope into a Paseo Thinking card when it
  starts a line outside a code fence. Ordinary tag mentions, fenced examples,
  and unclosed events stay in the assistant body. Buffered text is released on
  turn end, cancel, and message switch.
- Unroll `carousel` fences and slide markers into standard Markdown.
- Give a reused kernel message id its own body segment after a tool update or
  a later turn, so a Markdown heading is not appended to the earlier prompt.

### Verification

- Complete validation: 43 test files, 257 passed, 1 skipped; architecture and
  secret checks passed.

### Contributors

- Thanks to [@maomomo-eth](https://github.com/maomomo-eth) for the system-event,
  carousel, and message-boundary work in
  [#14](https://github.com/tiezbro/paseo-agy-acp/pull/14).

## 2.4.1 - 2026-09-26

### Fixed

- Forward the official kernel's MCP callback through a local bridge. The kernel
  opens that callback with protocol date `2026-07-28`, and Paseo rejects that
  date. The bridge presents `2025-11-25`, which both sides accept, on
  `session/new`, `session/load`, and `session/resume`.

### Verification

- Complete validation: 38 test files, 222 passed, 1 skipped; architecture and
  secret checks passed. `session/new`, `session/load`, and `session/resume`
  each hand the kernel a local bridge URL, and a `2026-07-28` initialize is
  delivered upstream as `2025-11-25`.

## 2.4.0 - 2026-09-25

### Changed

- On first start, download the official Antigravity ACP 1.2.1 archive that
  matches the current operating system. The npm package stores the official
  URLs and does not contain the kernels. Linux x86_64 also installs the local
  compatibility wrapper. A custom `PASEO_AGY_ACP_OFFICIAL_BIN` that is not a
  managed path is left unchanged.
- Pin the official Antigravity ACP kernel to registry `antigravity-acp` 1.2.1.
  The local compatibility markers stay the same: the CCPA proxy is unchanged,
  and the Gemini-only catalog filter is still rewritten in place. `server.py`
  stays unmodified.
- Activating a new pin generation replaces the active wrapper. The previous
  generation stays on disk and is not a lifecycle rollback target.

### Verification

- Hashes checked against the Linux x86_64 zip published 2026-09-23.
- Complete validation: 37 test files, 218 passed, 1 skipped; architecture and
  secret checks passed. A live `session/new` on the 1.2.1 compatibility wrapper
  returned Gemini 3.8 plus the entitled Claude and GPT-OSS ids.

## 2.3.2 - 2026-09-24

### Fixed

- Pass `--uid=` only when spawning a direct official `.par` on Linux. Darwin
  builds reject that flag at startup.

### Verification

- Complete validation: 37 test files, 217 passed, 1 skipped; architecture and
  secret checks passed. Spawn args are pinned for `linux`, `darwin`, and `win32`.

### Contributors

- Thanks to [@zwmmm](https://github.com/zwmmm) for the Linux-only `--uid=` fix
  in [#12](https://github.com/tiezbro/paseo-agy-acp/pull/12).

## 2.3.1 - 2026-08-31

### Fixed

- Show the official OAuth authorization URL promptly during `--login`, put the
  URL on its own line, and allow pasting the browser callback URL so it can be
  delivered to the kernel's local loopback listener.

### Verification

- Complete validation: 37 test files, 217 passed, 1 skipped; architecture and
  secret checks passed.

### Contributors

- Thanks to [@maomomo-eth](https://github.com/maomomo-eth) for the login prompt
  and callback delivery work in [#10](https://github.com/tiezbro/paseo-agy-acp/pull/10).

## 2.3.0 - 2026-08-30

### Added

- Discover user and workspace `SKILL.md` files from Gemini, Agents, Codex, and
  configured skill roots, then expose user-invocable skills through standard
  ACP slash command hints while preserving native commands.
- Add a tag-triggered npm Trusted Publishing workflow. A matching `vX.Y.Z` tag
  on `main` now validates, packs, records, and publishes the public npm tarball
  automatically with GitHub OIDC provenance and no long-lived npm token.

### Changed

- Scope workspace skill discovery to each ACP session cwd, serialize concurrent
  `session/new` setup, and prevent command hints from leaking between
  workspaces.
- Hide skills marked `user-invocable: false`, preserve workspace-over-global
  precedence, and parse common quoted and multiline frontmatter forms.

### Verification

- Complete validation: 37 test files, 216 passed, 1 skipped; architecture and
  secret checks passed.
- Official-kernel smoke and a live command-update canary preserved native
  commands, exposed the visible workspace skill, and hid the non-invocable
  skill.

### Contributors

- Thanks to [@zwmmm](https://github.com/zwmmm) for the initial implementation
  and review follow-up in [#9](https://github.com/tiezbro/paseo-agy-acp/pull/9).

## 2.2.1 - 2026-08-29

### Changed

- GitHub tags match npm 3-part semver from this release (`v2.2.1` =
  `paseo-agy-acp@2.2.1`). Historical tag `v2.2.0.0` remains the 2.2.0 line.
- README (EN/ZH): `npx` launches this proxy only. Paseo, a locally installed
  official kernel, and `PASEO_AGY_ACP_OFFICIAL_BIN` remain required. The npm
  tarball now ships that copy.

### Unchanged

- Same official ACP kernel, same local Claude/GPT-OSS opt-in, same Admission
  defaults as 2.2.0.

## 2.2.0 - 2026-08-29

### Changed

- npm-publishable semver: `2.2.0` is the same product as GitHub tag
  `v2.2.0.0`. Install with `npx -y paseo-agy-acp@2.2.0`. The package `bin`
  includes a `paseo-agy-acp` alias so `npx` can infer the CLI. npm still does
  **not** ship Google's `.par`.

## 2.2.0.0 - 2026-08-29

### Added

- Local **opt-in** compatibility on the **official** Antigravity ACP kernel so
  entitled Claude 4.6 and GPT-OSS 120B sessions can complete through Paseo.
  Gemini-family models stay the stock official path until an operator prepares
  and points `PASEO_AGY_ACP_OFFICIAL_BIN` at the stable wrapper
  (`agy-acp-kernel-compat-active`).
- `agy-acp-prepare-official-kernel-compat` lifecycle (`prepare` / `verify` /
  `activate` / `status` / `rollback` / `cleanup`), RC01 pin checks, and
  `paseo_model_compat.py` request transforms (tool schema, tool-call ids,
  GPT-OSS generation config; Gemini/unknown identity).
- Isolated acceptance harness coverage (catalog, text, tools, warm resume,
  capability-gated load/media/timeout) and an operator
  [runbook](docs/operations/official-kernel-compat-runbook.md).
- Sanitized maintainer-host production evidence
  ([P7](docs/operations/official-kernel-compat-p7-production-evidence.md)):
  catalog 14, live text/tools; official RC01 active cancel not confirmed;
  real 503/quota not induced.

### Unchanged

- Execution kernel remains official `agy_acp_server`. npm still does **not**
  ship Google's proprietary `.par` or runfiles. Admission defaults stay
  **8 / 8 / 2s** (tested default, not a product ceiling). No daemon restart
  is required for new provider processes to read an updated launcher.

## 2.1.0.0 - 2026-08-23

### Changed

- Switched ACP execution from the PTY/SQLite scraper to the official Google
  `agy-acp` NDJSON server (Registry id `antigravity-acp`). The product binary
  stays `agy-acp` and runs as a thin proxy: it injects Paseo daemon
  `appendSystemPrompt`, maps session modes, rewrites MCP `http` servers to
  `sse`, overlays product identity, and fences Admission around the official
  `session/prompt` write.
- Official live modes are `default`, `auto_edit`, and `yolo`. Legacy
  `accept-edits` maps to `auto_edit`, `dangerously-skip-permissions` maps to
  `yolo`, and `plan` maps to `default` because official has no plan mode.
- Blank official `end_turn` results with no visible assistant output become a
  JSON-RPC error instead of an empty successful turn.
- **Deleted** the scraper kernel. `PASEO_AGY_ACP_KERNEL=legacy` and
  `--legacy-kernel` fail closed. The product source stays **Apache-2.0**; the
  official kernel binary is proprietary and is spawned, not redistributed.
  Set `PASEO_AGY_ACP_OFFICIAL_BIN` to override the pinned official wrapper.
  Official Admission state is isolated under `$AGY_ACP_STATE_DIR/official-kernel`.
- Isolated canary on `127.0.0.1:6768` proved product `2.1.0.0` + official
  kernel + daemon context (`ISOLATED_OFFICIAL_KERNEL_CANARY_OK`). Production
  `127.0.0.1:6767` was not mutated by that canary.
- Default Admission is **8 shared seats / 8 concurrent starts / 2s start
  interval**, from production testing (including a 10-agent Antigravity
  dispatch that did not reproduce the scraper hang). The queue stays enabled
  so Paseo → Antigravity delegation stays steadier under burst. Env integers
  **≥ 1** can raise seats/starts for concurrency experiments; this repo does
  **not** publish a product maximum. Admission schema v3 rebuilds
  `policy_state` so SQLite no longer carries a leftover upper CHECK from the
  old 1–8 ledger. Isolated 6-way yolo stress on `127.0.0.1:6768` also did not
  reproduce the scraper hang; official ACP is still not proven unlimited.
  Optional `AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS=3` and
  `AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS=1` remain a tighter fence, not the
  default.

### Unchanged

- Production Paseo daemon `127.0.0.1:6767` was **not restarted**. After the
  8/8 Admission raise, `~/.local/bin/agy-acp` was retargeted to
  `~/.local/opt/paseo-agy-acp-2.1.0.0-20260823T112457Z/bin/agy-acp-production`
  with a fresh ledger at
  `~/.local/state/paseo-agy-acp/production-official-8` so the
  durable 3+1 fingerprint cannot fail-close the new policy. The default Paseo
  `antigravity` provider still runs that symlink. `antigravity-official-canary`
  is disabled so production is not split. Idle Antigravity agents pick up 8/8
  on the next spawn; live Cursor/Claude agents were left running.
- Stage 2 Scheme pointers and the 2.0.0.0 closeout facts below are unchanged.

## 2.0.0.2 - 2026-08-19

### Changed

- Recorded authorized live Antigravity CLI observation for the trusted-503
  physical-source gate. Current `agy 1.1.14` produced Gemini successes and a
  Claude individual-quota failure on the stream-json `result.error` carrier,
  with no `httpStatus`, `code`, `reason`, or HTTP 503.
- Corrected the earlier 2.0.0.1 verification claim that historical native
  `1.1.12` logs establish the trusted `503 UNAVAILABLE` carrier. Those logs
  remain unverified prose; this release does not close Scheme §4.5 and does
  not change the fail-closed classifier.
- Runtime Admission and Connector code is unchanged from `2.0.0.1`. This
  patch ships evidence and documentation only.

### Verification

- Live observation receipts: `docs/design/receipts/S3-T08/observation-1.txt`
  and `observation-2.txt`, plus raw captures. `LIVE_503_CAPTURED=no`.
- Repository validation is recorded in the release commit. One existing
  symlink cleanup in `tests/edit-reconcile.test.ts` now unlinks the
  directory symlink so current Node `fs.rmSync` does not treat it as a
  directory.

## 2.0.0.1 - 2026-08-17

### Changed

- Promoted `2.0.0.1` after separating the earlier isolated happy-path canary
  from formal production acceptance and completing both.
- Documented why Admission Controller v2 exists: we first encountered
  concurrency failures while running multiple Paseo agents against the same
  Antigravity account, then surveyed the wider community to confirm the
  behavior was not isolated. Antigravity CLI issue
  [#573](https://github.com/google-antigravity/antigravity-cli/issues/573),
  which reports `agy -p` hanging under three or more longer-running neighboring
  CLI processes, is public corroborating evidence rather than the original
  cause. The durable account-wide queue, three shared active seats, one paced
  start permit, reaping, recovery, soft drain, and typed settlement are the
  bounded Paseo-side mitigation; no Google endorsement is claimed.
- Bound fresh Linux interactive streams to the conversation database opened by
  the exact Antigravity child process, preventing concurrent agents from
  attaching to another process's newly-created conversation.
- Made final persisted model-provider errors fail both interactive and print
  turns immediately, instead of waiting for the turn timeout or completing an
  empty successful turn. ACP admission still owns the typed terminal mapping.
- Accepted Paseo's `low`, `medium`, and `high` reasoning selections for Claude
  models whose Antigravity catalog has one base model rather than separate
  effort variants. The native default remains available without `--effort`.
- Made every enabled runtime opener claim or assert the shared durable policy
  before startup recovery. A connector with a mismatched policy now fails
  closed instead of running with an empty `policy_state` singleton.
- Added the packaged `agy-acp-prepare-state` preflight so installation and
  isolated acceptance create account state directories with exact mode `0700`
  and reject existing permissive directories without silently changing them.

### Verification

- The state-directory preflight passed focused tests for secure creation,
  fail-closed handling of an existing `0775` directory, and published-manifest
  exposure. The complete repository validation passed with 58 test files,
  626 passed tests, 2 skipped tests, architecture PASS, and secret scan PASS.
- A fresh `2.0.0.1` tarball installed into a new prefix and exposed the packaged
  preflight binary. That binary created an absent state directory as `0700`;
  its `admission.key` and `runtime.sqlite` were `0600`. A clean isolated Paseo
  daemon on `127.0.0.1:6768` then completed a real Antigravity turn with marker
  `STATE_DIR_FIX_R11_OK`; the durable request was `completed`, with zero leases
  and zero retained payloads afterward.
- The complete fault matrix passed for concurrent admission, queueing and
  pressure, crash/restart recovery, reaping and queued-owner death, soft drain,
  ambiguous dispatch, queue timeout, auth/permission modes, typed terminal
  outcomes, and trusted Provider capacity classification.
- Production-candidate acceptance on `127.0.0.1:6767` passed with real Gemini
  and Claude turns, stable `3 active + 1 queued` FIFO handoff, an additional
  six-request mixed-provider pressure run, zero final leases, zero retained
  payloads, SQLite integrity PASS, and no OOM or candidate-process residue.
- Nine additional `agy 1.1.13` Claude pressure probes completed through the
  production queue. The Provider did not emit a live capacity `503` in that
  window; historical native `1.1.12` logs establish the trusted
  `503 UNAVAILABLE` carrier while deterministic tests verify the current
  classifier and cooldown boundary.

## 2.0.0.0 - 2026-08-16

### Changed

- Closed the final Stage 3 v2 migration for `shared-admission-queue` schema v2:
  `turn_requests.agent_id`, `policy_state` with `policy_fingerprint`,
  `queued_owner_instances`, lease suspect metadata, and the v1 to v2 migration
  ledger are now the local database contract.
- Made durable policy the single runtime authority. Connectors claim or assert
  the same `policy_state`, and soft drain moves `3 -> soft_draining_to_1 ->
  steady(max_active_turns=1)` without killing active turns.
- Closed owner, recovery, and runtime reaper behavior. Queued owner death is
  bounded, `recovery_required` remains non-replayable, and suspect leases are
  released only after process evidence proves the local turn is gone.
- Wired enabled production dispatch through durable dispatch intent before the
  prompt write. Ambiguous or blocked writes become durable terminal states.
- Added the enabled-mode auth gate for v1/v2 login/logout, preserved disabled
  legacy auth, restored the interactive permission chain, and kept official ACP
  session history replay in the connector.
- Mapped `queue_timeout`, `provider_capacity`/provider failure, cancellation,
  and `recovery_required` through typed terminal behavior instead of treating
  known failures as successful `end_turn`.
- Made the packaged ACP entry importable from its built public layout and kept
  provider discovery available before Paseo assigns `PASEO_AGENT_ID` while
  still rejecting business prompts until Admission composition is complete.
- Corrected prompt-free argv ordering and made cold-start interactive PTY
  dispatch wait for Antigravity's authentication/model redraws to settle before
  the single durable fenced prompt write.

### Added

- Added Stage 3 closeout documentation that points README.md and
  README.zh-CN.md at the confirmed Scheme and accepted Stage 2 artifacts.
- Added a clause-by-clause historical disposition for the legacy admission
  design file so it cannot act as a second authority.
- Added `tests/closeout-docs-contract.test.ts` to keep the bilingual
  documentation, CHANGELOG, and historical design disposition aligned.

### Removed

- Removed the old documentation authority claim from the legacy design. It is
  retained only as historical input with dispositions grounded in the Scheme
  and accepted Stage 2 artifacts.

### Verification

- Final validation passed with `npm test -- --maxWorkers=1`: 56 test files,
  611 passed tests, and 2 skipped tests. Architecture boundaries, secret scan,
  GitNexus detect-changes, and `git diff --check` also passed.
- Stage 3 documentation receipts remain in `docs/design/receipts/S3-T21/`.
- A local `2.0.0.0` tarball passed fresh-prefix installation, built public
  entry import, CLI EOF, and native PTY smoke tests.
- The installed tarball ran a real Antigravity `gemini-3.1-pro` Admission turn
  on an isolated `127.0.0.1:6768` daemon. The exact canary response was
  `STAGE4_ADMISSION_CANARY_OK`; the durable request completed and released its
  lease. Production `127.0.0.1:6767` was not switched or mutated.

## 1.0.0.4 - 2026-08-07

### Fixed

- Suppress the connector's posthoc completed-edit approval bridge when the
  active Antigravity session mode is `dangerously-skip-permissions`. This keeps
  Paseo unattended runs fully unattended after Antigravity has already applied
  an edit through `agy --dangerously-skip-permissions`.
- Parse tab-separated `agy models` output as `modelId<TAB>display name` and pass
  the exact provider-native model id to Antigravity. This prevents display
  labels such as `Gemini 3.6 Flash (High)` from being folded into the model id
  and avoids sending unsupported `--effort` flags for exact variant ids.

### Verification

- `npx vitest run tests/cli.test.ts --testNamePattern "posthoc edit review|dangerous permission bypass"` — passes.
- `npx vitest run tests/acp-server.test.ts tests/cli.test.ts --testNamePattern "tab-separated|exact tab-list|modern stable model slugs|passes --effort|parseAgyModels|dangerous permission bypass"` — passes.

## 1.0.0.3 - 2026-08-07

### Changed

- Added bilingual README navigation and refreshed the provider feature table.

## 1.0.0.2 - 2026-08-07

### Added

- Expose Antigravity CLI's native unattended permission bypass as ACP mode id
  `dangerously-skip-permissions`.
- Map that mode directly to the official `agy --dangerously-skip-permissions`
  parameter. The adapter does not introduce a custom `full-access` alias for
  Antigravity.
- Support `/mode dangerously-skip-permissions` and common operator aliases such
  as `/mode yolo`.

### Changed

- When `agy-acp` itself is launched with `--dangerously-skip-permissions`, the
  initial ACP mode is now reported as `dangerously-skip-permissions`.
- Switching away from `dangerously-skip-permissions` through ACP mode/config
  selection disables the bypass for later turns in that session.

### Verification

- `env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_HOME npm test` — 383 passed, 1 skipped.
- `env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_HOME npm run build` — passes.

## 1.0.0.1 - 2026-08-06

### Fixed

- Treat `PASEO_HOME` as optional when reading Paseo daemon context. The bridge
  falls back to `~/.paseo` when `PASEO_AGENT_ID` is present and `PASEO_HOME` is
  unset or empty.

## 1.0.0.0 - 2026-08-06

### Added

- Initial Paseo-focused Antigravity ACP adapter release derived from upstream
  `shindgew/agy-acp`.
- Paseo daemon append-system-prompt bridge.
- Permission denial authority fixes.
- Stronger turn-completion detection.
- Foreground command task-state repair.
- Whole-file edit revert newline tolerance.
