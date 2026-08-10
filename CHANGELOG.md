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
- Tightened crash recovery evidence: a `starting` request is requeued only
  after both connector loss and pre-dispatch process termination are proven.
  A reservation with no started process can still be safely requeued.
- Added a restrictive local key-store primitive for future encrypted runtime
  state. It requires a `0700` state directory and `0600` 32-byte key, and
  rejects unsafe pre-existing paths rather than silently repairing them.
- Added the v2.0.0.0 design baseline in
  `docs/design/v2.0.0.0-admission-controller.md`.
- Bound encrypted turn and delivery rows to their immutable identities with
  AES-GCM additional authenticated data, and replaced raw content hashes with
  keyed fingerprints. A master key now derives independent encryption,
  fingerprint, identity, recovery, and audit keys through versioned HKDF
  domains.
- Hardened the Admission SQLite schema to a fully verified v10 ledger. Startup
  checks the complete migration history, tables, columns, foreign keys, and
  indexes inside a rollback-safe migration transaction rather than trusting a
  maximum version number. The current schema includes SQLite-backed ACP
  sessions, a fenced process-identity record for each dispatched lease,
  controller-owned outbox claim leases, and an identifier-free sanitized event
  journal whose correlations use a purpose-separated HMAC.
- Added Linux process identity, connector ownership, dispatch-boundary,
  cancellation, and terminal-evidence primitives. Unverifiable termination,
  PID reuse, local process killing, or conflicting provider observations stay
  conservative and cannot silently become a completed or cancelled turn.
- Added exact, opt-in protocol records for stable client message identity and
  at-least-once outbox acknowledgement. ACP writer completion is explicitly
  not treated as a remote acknowledgement, and JSON-RPC request IDs are not
  accepted as reconnect-stable business identities.
- Added a disabled runtime factory with conservative source defaults of two
  active turns and one concurrent start. These values are not approved for
  production use until the isolated acceptance gates pass.
- Added an atomic, lease-fenced process-identity plus `dispatch_intent`
  transaction. Exact repeats are idempotent; stale leases, conflicting process
  identities, and injected transaction faults fail closed without a partial
  process record or dispatch transition.
- Split pre-dispatch recovery into proof and mutation layers. Linux process
  inspection now emits only a claim-bound HMAC proof, while the recovery
  coordinator is the sole owner of fenced durable requeue or
  `recovery_required` resolution.
- Added the runtime-owned prompt dispatcher and prompt-free CLI bridge. Fake
  process tests cover the single irreversible prompt write, terminal
  persistence, cancellation, and no automatic business-turn replay.
- Added a fresh-PTY canary that rejects prompt leakage through argv,
  environment, process title, temporary paths, and launcher diagnostics. Its
  prompt correlation and attestation use a caller-supplied purpose-separated
  HMAC key; missing, stale, mismatched, or failed evidence blocks the PTY path.
- Added a SQLite ACP session store and opt-in runtime composition. Enabled
  source configurations preserve session/conversation state across connector
  restarts without sharing `sessions.json`; the disabled default remains on
  the legacy store and prompt path.
- Added the reserved `_paseo-agy-acp/outbox/ack` route. The connector advertises
  at-least-once outbox delivery only when a live durable bridge and ACK route
  are both active; forged acknowledgements fail and exact repeats remain
  idempotent across bridge and controller restarts without resending the
  payload or business turn.
- Hardened the atomic dispatch boundary so a successfully recorded process
  identity is treated as an already durable `dispatch_intent`. Cancellation,
  stale owner/generation revalidation, or an exact-intent replay fault after
  that point now becomes `dispatch_ambiguous` and can never enter the safe
  pre-dispatch requeue path.
- Added controller-owned, payload-free recovery inventories for nonterminal
  dispatches and outbox claims. Partial, orphaned, or mismatched outbox/claim
  fences reject the complete inventory instead of silently dropping recovery
  work or decrypting an update.
- Added a SQLite-backed startup launcher for `auxiliary` and `resident_pty`
  processes. It enforces independent cross-process capacity with generation
  fences and heartbeat evidence; heartbeat expiry never releases a permit.
- Added an asynchronous startup recovery barrier that reconciles dispatch,
  active-session, outbox-claim, startup-permit, and Linux residue inventories.
  It can only observe and block: it has no payload, signal, release, requeue,
  or provider-dispatch capability.
- Added a serialized controller-owned outbox pump. It sweeps expired claims,
  performs bounded delivery work, waits for explicit ACK, and converts sender
  failures to fixed blocked results without replaying a provider turn.
- Added post-write cancellation propagation to the SQLite-primary dispatcher.
  Only an official `CANCELED` or `INTERRUPTED` SQLite terminal confirms
  cancellation; missing or conflicting terminal evidence remains
  `recovery_required`, and prompt references are cleared after every terminal
  or unrecoverable path.
- Added test-only transaction fault seams at provider-terminal/outbox and ACK
  settlement boundaries. Fault-matrix tests prove request, lease, outbox,
  claim, and sanitized-event state rolls back together without leaking the
  injected error or durable payload.
- Added a source-only asynchronous production graph builder. It owns one
  SQLite startup launcher and threads that exact instance through dispatch and
  startup recovery, then assembles SQLite sessions, exact dispatch,
  proof-gated recovery, negotiated ACK delivery, and the outbox pump. It
  returns a dispatch surface only after every capability and recovery barrier
  passes.
- Removed the superseded `StartupGate` and the process-lifecycle startup
  method after independent audit. Linux process lifecycle code now exposes
  recovery, evidence, and cancellation only; the admission dispatcher remains
  the only production owner of provider startup and the irreversible business
  prompt write.
- Queue timeout now atomically transitions the request, deletes its encrypted
  prompt payload, and writes the sanitized journal event. The terminal request
  tombstone remains non-replayable, a new request identity can continue, and a
  journal fault rolls the complete timeout transaction back.
- Minimized controller error strings after audit by removing request,
  delivery, and lease identifiers while retaining typed error classes for
  callers.

### Not Yet Enabled

- The Admission Controller is not enabled in the installed connector. The
  source now contains the durable controller, recovery/readiness barrier,
  SQLite session and startup-permit composition, prompt dispatcher,
  process/recovery contracts, outbox pump, and ACK route. The legacy
  `composeAcpRuntime()` entrypoint still rejects enabled configuration. A real,
  version-specific fresh-PTY launcher certificate and isolated provider
  acceptance are still release blockers before that entrypoint can use the
  source-only production graph. This work does not change production provider
  concurrency, retries, lifecycle, installed binaries, or Paseo runtime state.

### Verification

- `npm test` - 61 test files passed: 871 tests passed, 2 skipped, and 1
  intentional TODO. The TODO is the production fresh-PTY certificate scan,
  which remains blocked because no accepted real launcher source exists; the
  corresponding runtime path stays fail closed.
- `npm run build` - passed.
- A final 126-test admission/dispatch/recovery/outbox/production-composition
  focused integration run passed after the two independent-audit LOW findings
  were fixed. The earlier 212-test integration baseline also passed before the
  audit repair.
- A final 78-test controller and sensitive-data matrix run passed after the
  follow-up audit identifier-minimization finding was closed.
- No real Antigravity process, installed connector, Paseo daemon, tag, push, or
  release was used for this source-development verification.

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
