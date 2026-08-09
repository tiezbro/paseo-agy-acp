# Changelog

All notable changes to `paseo-agy-acp` are recorded here.

## Unreleased

### Added

- Added the internal SQLite-backed Admission Controller core for the v2.0.0.0
  development track. Its initial tests cover idempotent admission,
  cross-instance capacity, parent fairness, cooldown, and conservative
  pre-dispatch versus post-dispatch recovery. Lease generations fence safe
  pre-dispatch requeues, and a durable start history enforces global startup
  spacing.
- Added authenticated encryption for durable turn payloads and ACP delivery
  outbox content. Expired payloads are removed, while delivery records retain
  a stable event ID and require an explicit acknowledgement before they become
  `delivered`.
- Added a versioned SQLite schema ledger and a fail-closed preflight parser for
  legacy `sessions.json`; a present but damaged legacy file is rejected rather
  than interpreted as an empty session store.
- Added queued-request cancellation that atomically removes the encrypted
  prompt. It intentionally refuses to claim cancellation after provider
  admission or dispatch, which requires separate process and provider proof.
- Added OS-process contention coverage and a redacting provider error
  classifier. Recognized `503` capacity and `429` quota evidence is retained
  as a typed outcome; unrecognized raw error text is discarded.
- Added the v2.0.0.0 design baseline in
  `docs/design/v2.0.0.0-admission-controller.md`.

### Not Yet Enabled

- The Admission Controller is not yet wired into live ACP prompt execution.
  It does not change installed connector behavior, provider concurrency,
  retries, lifecycle, or Paseo runtime state in this development increment.

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
