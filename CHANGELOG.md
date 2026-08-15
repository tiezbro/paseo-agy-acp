# Changelog

All notable changes to `paseo-agy-acp` are recorded here.

## Unreleased

### Changed

- Converged the repository into exactly two source areas. `ACP Connector/`
  retains ACP protocol handling, sessions, the existing Antigravity online
  output path, permissions, cancellation, and error mapping.
  `Admission Controller/` now contains only the shared queue and seat kernel.
- Wrapped the existing `AgyCliSession.prompt` path with a disabled-by-default
  shared Admission coordinator. The source defaults are three active account
  seats, one concurrent start, a two-second start interval, a 30-minute queue
  timeout, and a 30-second provider/model capacity cooldown. The only supported
  seat override is `1`; `2`, `4`, `5`, and every other value fail closed.
- Made terminal settlement and seat release one controller transaction.
  Confirmed Antigravity capacity failures start cooldown; uncertain post-write
  failures retain visible `recovery_required` capacity debt and cannot replay
  the business prompt.
- Reset the Admission database contract to `shared-admission-queue` schema v1
  with eight business tables plus `schema_migrations`. Extra legacy tables
  fail closed.

### Added

- Added durable oldest-eligible queue selection with agent fairness, encrypted
  queued prompts, queue progress, global start throttling, lease heartbeats,
  immutable Linux process identity, and proof-gated startup seat recovery.
- Added focused final-plan tests for cross-process seats, agent fairness,
  start throttling, timeout payload deletion, capacity cooldown, heartbeat,
  immediate terminal release, atomic identity plus dispatch intent, and
  no-replay behavior after an uncertain prompt write.

### Removed

- Removed the unapproved second delivery architecture: controller outbox,
  delivery claims, custom ACK route, terminal reconnect replay, client route
  fencing, shadow terminal observers, and custom request identity.
- Removed the unused production graph, alternate dispatcher/prompt seam,
  manual recovery claims and requeue APIs, startup-permit subsystem, exact
  terminal binder, legacy migration pipeline, and their dedicated tests.
- Preserved official ACP `session/load` and `session/resume`, conversation
  SQLite replay, `StreamPoller`/`Translator` online updates, and the
  stream-json identity primitive.

### Verification

- `npm run validate` passed: production/test TypeScript, clean build,
  33 test files with 527 passed and 2 skipped, and the architecture boundary
  gate.
- `rtk tsc -p tsconfig.test.json --noEmit` passed.
- `rtk git diff --check` passed.
- No real Antigravity provider, installed connector, production Paseo daemon,
  push, tag, or release was used.

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
