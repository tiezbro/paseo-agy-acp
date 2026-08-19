# Changelog

All notable changes to `paseo-agy-acp` are recorded here.

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
