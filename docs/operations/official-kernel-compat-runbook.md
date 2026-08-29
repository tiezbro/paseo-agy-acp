# Official Kernel Local Compatibility Runbook

## Overview
This runbook provides precise operations for applying the local-only RC01 compatibility layer for the official Antigravity ACP kernel. This lifecycle enables discovering and operating non-Gemini models (e.g., Claude 4.6, GPT-OSS 120B) via precise local request compatibility transforms, without redistributing Google proprietary artifacts or overriding upstream backend controls.

> [!WARNING]
> **Boundary & ToS**: This is an explicitly **opt-in**, **local-only** operation applied by the host operator. It is **not** an official Google fix or distribution. Neither modified binaries nor runfiles may be uploaded, published, or distributed.

## Prerequisites and Strict Pins

- **Node/Build Requirement**: A Node.js environment is required, and `npm run build` must have been executed successfully against this working directory before proceeding.
- **Disk Headroom**: The observed engineered footprint requires ~3 GiB for this RC01 temp artifact. Operators must enforce a conservative >=6 GiB free headroom check (which is filesystem-dependent) before staging.

This compatibility lifecycle is strictly pinned to the official RC01 release. Any hash mismatch enforces a **fail-closed** policy out of caution (stale official hash refusal on updates).

| Artifact | Expected SHA-256 |
| -------- | ---------------- |
| `agy_acp_server.par` | `46b5925100903a23e0ec7da8b8a218c224494dfffeb3fd30fcd84e91acbc8b07` |
| `localharness_external` | `8a8d8efc8dcf1f8cb87db6c932957ecf14684cd7d71ee5670b5515c16a685404` |
| `model_selection.py` (preimage) | `2dabcfcbb7e165cdd4fb73e05c08a8b01230837d818f39a0a13cd3cfbca87b71` |
| `ccpa_connection/proxy_server.py` (preimage) | `e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de` |
| `server.py` (unmodified) | `8ede74f3cec50e0a76796ef1af91840bab16b7ee36664a2499f07d3119013d7b` |

## Disk and Permission Expectations

The lifecycle strictly controls directory states and prevents data leakage:
- **Default Installation Root**: `~/.local/opt/paseo-agy-acp-kernel-compat/`
- **Root Permissions**: Must be owned by the current user and restricted to `0700`.
- **Artifact Isolation**: Extracted `agy_acp_server` and `localharness_external` binaries are stripped to `0500` (read/execute only, preventing corruption).
- **Receipt Isolation**: The evidence file (`receipt.json`) is maintained at `0600`. It ensures credentials, prompts, and PII are excluded, but it must still be treated as private disk material.
- **Production Preflight Control**: The system does not mutate production daemon records or stray `/tmp` files.

---

## Operations Lifecycle

*(Note: When a non-default root is used, `--state-root` must be repeated for every command)*

### 1. Prepare
Extracts the official components, verifies preimage hashes, applies minimum string markers, and computes post-images. No modification is made to the active pointer.

*Note: The returned JSON contains `{ prepared }`. The property `prepared.artifactId` is the handle, and `prepared.stableWrapperPath` is the stable active wrapper that production MUST target. (Do not confuse this with `prepared.wrapperPath`, which is the per-release smoke wrapper that production must NOT target).*

```bash
set -euo pipefail
TMP_PREPARE=$(mktemp)
chmod 0600 "$TMP_PREPARE"
trap 'rm -f "$TMP_PREPARE"' EXIT

# Safely extract identifiers without logging secrets or receipts
node ./scripts/prepare-official-kernel-compat.mjs prepare \
  --state-root <ABSOLUTE_PATH_PLACEHOLDER_STATE_ROOT> \
  --par <ABSOLUTE_PATH_PLACEHOLDER_PAR> \
  --external-harness <ABSOLUTE_PATH_PLACEHOLDER_HARNESS> > "$TMP_PREPARE"

ARTIFACT_ID=$(jq -e -r '.prepared.artifactId | select(test("^[A-Za-z0-9_-]+$"))' "$TMP_PREPARE")
STABLE_WRAPPER_PATH=$(jq -e -r '.prepared.stableWrapperPath | select(startswith("/")) | select(test("\\s") | not)' "$TMP_PREPARE")

if [[ -z "$ARTIFACT_ID" || -z "$STABLE_WRAPPER_PATH" ]]; then
  echo "Error: Failed to obtain valid artifactId or stableWrapperPath" >&2
  exit 1
fi
```

### 2. Verify
Allows deterministic validation of the prepared artifact's postimage bounds.

```bash
set -euo pipefail
TMP_VERIFY=$(mktemp)
chmod 0600 "$TMP_VERIFY"
trap 'rm -f "$TMP_VERIFY"' EXIT

node ./scripts/prepare-official-kernel-compat.mjs verify \
  --state-root <ABSOLUTE_PATH_PLACEHOLDER_STATE_ROOT> \
  --artifact-id "$ARTIFACT_ID" > "$TMP_VERIFY"

VERIFIED_ID=$(jq -e -r '.artifactId | select(. != null and . != "")' "$TMP_VERIFY")
VERIFIED_AT=$(jq -e -r '.verifiedAt | select(. != null and . != "")' "$TMP_VERIFY")

if [[ "$VERIFIED_ID" != "$ARTIFACT_ID" || -z "$VERIFIED_AT" ]]; then
  echo "Error: Verification failed or mismatch" >&2
  exit 1
fi
```

### 3. Activate
Atomically swaps the active internal pointer to the prepared artifact, driven by single-writer symlinks.

*Note: The CLI JSON output is unwrapped here. `.wrapperPath` is the stable active wrapper, and `.releaseWrapperPath` is the per-release wrapper.*

```bash
set -euo pipefail
TMP_ACTIVATE=$(mktemp)
chmod 0600 "$TMP_ACTIVATE"
trap 'rm -f "$TMP_ACTIVATE"' EXIT

node ./scripts/prepare-official-kernel-compat.mjs activate \
  --state-root <ABSOLUTE_PATH_PLACEHOLDER_STATE_ROOT> \
  --artifact-id "$ARTIFACT_ID" > "$TMP_ACTIVATE"

ACTIVE_WRAPPER=$(jq -e -r '.wrapperPath | select(startswith("/")) | select(test("\\s") | not)' "$TMP_ACTIVATE")
if [[ -z "$ACTIVE_WRAPPER" ]]; then
  echo "Error: Failed to obtain active wrapperPath" >&2
  exit 1
fi
```
> [!IMPORTANT]
> The lifecycle `activate` and `rollback` commands switch **only** among prepared compatibility artifacts (`current` and `previous`). They do NOT restore official behavior. The generated wrapper strictly isolates execution: if it detects a corrupted receipt or post-image drift, it strongly **fails closed** and terminates. The legacy kernel or unchanged invocation is expressly prohibited from functioning as a fallback. To restore official behavior, the operator must explicitly restore the production launcher back to the exact official wrapper path.

### 4. Status
Returns `current` and `previous` active artifacts for audit purposes, including their verification status and the active path.

```bash
set -euo pipefail
TMP_STATUS=$(mktemp)
chmod 0600 "$TMP_STATUS"
trap 'rm -f "$TMP_STATUS"' EXIT

node ./scripts/prepare-official-kernel-compat.mjs status \
  --state-root <ABSOLUTE_PATH_PLACEHOLDER_STATE_ROOT> > "$TMP_STATUS"

STATUS_VERIFIED=$(jq -e -r '.current.verified | select(. == true)' "$TMP_STATUS")
STATUS_WRAPPER_PATH=$(jq -e -r '.stableWrapperPath | select(startswith("/")) | select(test("\\s") | not)' "$TMP_STATUS")

if [[ -z "$STATUS_VERIFIED" || -z "$STATUS_WRAPPER_PATH" ]]; then
  echo "Error: Status check failed or stableWrapperPath is invalid" >&2
  exit 1
fi
```

### 5. Rollback
Triggers an atomic inversion to the previously active compatibility artifact. *(Note: This is not an official rollback, as it merely jumps to the previous compat artifact.)*

```bash
set -euo pipefail
TMP_ROLLBACK=$(mktemp)
chmod 0600 "$TMP_ROLLBACK"
trap 'rm -f "$TMP_ROLLBACK"' EXIT

node ./scripts/prepare-official-kernel-compat.mjs rollback \
  --state-root <ABSOLUTE_PATH_PLACEHOLDER_STATE_ROOT> > "$TMP_ROLLBACK"

RB_WRAPPER_PATH=$(jq -e -r '.wrapperPath | select(startswith("/")) | select(test("\\s") | not)' "$TMP_ROLLBACK")
if [[ -z "$RB_WRAPPER_PATH" ]]; then
  echo "Error: Rollback failed to return a valid wrapperPath" >&2
  exit 1
fi
```

### 6. Cleanup
Removes unreferenced runfiles and receipt evidence.

```bash
set -euo pipefail
TMP_CLEANUP=$(mktemp)
chmod 0600 "$TMP_CLEANUP"
trap 'rm -f "$TMP_CLEANUP"' EXIT

node ./scripts/prepare-official-kernel-compat.mjs cleanup \
  --state-root <ABSOLUTE_PATH_PLACEHOLDER_STATE_ROOT> \
  --remove-unreferenced > "$TMP_CLEANUP"

# Verify the CLI process succeeded (exit code 0 handled by pipefail)
# and emitted a valid removal/skips JSON object.
jq -e 'type == "object"' "$TMP_CLEANUP" > /dev/null
```
> [!NOTE]
> The `--remove-unreferenced` flag protects `current` and `previous` active releases; it **cannot** clear active compat states. After an official takeover, leave the active root private and remove only unreferenced releases. Any full root removal requires separate proof that no production path/process references it alongside an independent audit.

---

## Production Launcher Integration

The production environment MUST target the stable active wrapper (identified by `STABLE_WRAPPER_PATH`), **not** the per-release wrapper path.

Because the launcher layout is host-specific, **P7 operations must orchestrate the following strict invariants and checklist natively**:

1. **Owner-only, hash-recorded backup**: Create an owner-only, no-overwrite backup of the original launcher. Record its hash.
2. **Independently audited, exact-preimage modification**: The replacement script must be pre-audited and exactly gated by the original preimage hash constraint.
3. **Same-directory temp write**: Write the modified launcher to a temporary file in the *same* directory as the production launcher.
4. **Mode/Owner check**: Verify the mode and owner of the temporary file explicitly match the original.
5. **Syntax validation**: Run `sh -n` to validate the shell syntax of the new temp script.
6. **Atomic apply**: Execute `fsync` and perform an atomic rename (`mv`) over the original production launcher path.
7. **Post-image verify**: Verify the final post-image hash of the swapped production launcher against expectations.
8. **DO NOT restart the daemon**: New provider processes will natively read the updated launcher. Do not maliciously bounce the Paseo daemon on this context switch.

Before and After this integration, environmental integrity MUST be proven via a concrete, host-agnostic capture:
```bash
# Capture the fingerprint BEFORE and AFTER the launcher integration swap
paseo daemon status --json | jq '{pid, listen, startedAt, serverId}'

# Verify no stray localhost/6768 listener exists before proceeding
if ss -tlnp | grep -q ':6768\b'; then
  echo "Error: stray TCP 6768 listener found. Must fail closed." >&2
  exit 1
fi
```

---

## Acceptance Verification

The default acceptance standard is the catalog-only verification via the redacted harness. Live, tools, resume, and cancel flags (`--live/--tools/--resume/--cancel`) are strictly optional and must not be treated as explicitly required runbook validations.

```bash
# Default parity acceptance (catalog-only)
node ./scripts/official-kernel-model-parity.mjs --stable-wrapper "$STABLE_WRAPPER_PATH"

# Optional verification bound through the product proxy
P4_MODEL_PARITY_THROUGH_PRODUCT=1 node ./scripts/official-kernel-model-parity.mjs --stable-wrapper "$STABLE_WRAPPER_PATH"
```

> [!WARNING]
> Operators must treat harness stdout as **private evidence**. Capture and log counts/IDs only. If the receipt schema already redacts items, rely on it natively. **Never** copy or paste prompts, thoughts, session IDs, or credentials into public audit logs.

---

## Sub-System Policies and Behaviors

### Dynamic Admission Policy
Production compatibility validations correctly process upstream dynamic Admission policies.
- It **does not** artificially cap concurrent capacity to `8`.
- `8` is simply the current/default tested queue value, not a ceiling limit. Operators should not manually hardcode this value to 8.
- Requests form queues and proceed properly along boundaries without forced truncation.

### Official Update Takeover and Stale Refusal
The generated wrapper is entirely self-contained and **does not** dynamically monitor newly installed official PAR paths on disk. If an unknown new hash arrives from upstream, a new `prepare` operation will fail, but it will **not** auto-disable a currently active RC01 compat wrapper.

Official takeover is strictly **operator-driven**:
1. Detect a new official hash and updated model catalog components.
2. Disconnect the wrapper: Explicitly restore the production launcher back to the exact official wrapper path. *(Note: Unsetting the environment variable is insufficient to restore official behavior if the launcher script itself internally exports it).*
3. Verify baseline daemon behavioral parity natively.
4. Trigger `cleanup --remove-unreferenced` to clear deprecated compat states.

---

## Troubleshooting Categories

1. **Missing Models from Model Catalog**
   - The operator must hold actual raw CCPA eligibility. Ensure the account natively holds raw entitlement to these models. Avoid extracting or inspecting personal operator user profiles/PII to diagnose. If the raw entitlement is unavailable, an `unknown model -32602` error propagates cleanly to fail closed prior to backend contact.
2. **Cancellation-not-confirmed**
   - Official RC01 active cancellation was *not* confirmed. Both the patched models (Claude/GPT) and the unmodified Gemini control raced to `end_turn`. Deterministic Admission queued cancellation coverage lives in separate classification tests, but do not assume daemon cooldown natively halts an active execution cycle cleanly.
3. **503, Quota Limitations, or Timeout**
   - Deterministic fake/controller tests definitively prove classification and release of Admission seats. However, real 503/quota behavior was not intentionally induced against actual backends during verification and remains deferred.

---

## Stop Boundary Notice
This runbook explicitly terminates before formal delivery pipelines. **DO NOT**:
- Apply Git tags, GitHub releases, or generate public publish events.
- Execute a package version bump or revise CHANGELOG release artifacts.
- The `npm pack` command may be used **only** as a local package-content verification step.
