# Changelog

All notable changes to `paseo-agy-acp` are recorded here.

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
