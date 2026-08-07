# Technical Changelog — paseo-agy-acp

This document records local modifications made to [`shindgew/agy-acp`](https://github.com/shindgew/agy-acp)
that differentiate this community derivative.

Last updated: 2026-08-06

## Baseline

| Item | Detail |
|---|---|
| Upstream | `https://github.com/shindgew/agy-acp.git` |
| Upstream HEAD | `6f44500` (release/v0.4.3) |
| This project | `https://github.com/tiezbro/paseo-agy-acp` |
| Package | `paseo-agy-acp@1.0.0.1` |

## Source Changes

### 1. Paseo Append-System-Prompt Bridge

**Files:** `src/acp/session/prompt.ts`, `tests/queue-steer.test.ts`

Recovers Paseo `daemon.appendSystemPrompt` text from agent state when `PASEO_AGENT_ID`
is present. `PASEO_HOME` is treated as an optional override and falls back to
`~/.paseo` when unset or empty. Prepends the recovered text only to the backend
prompt sent to Antigravity, keeping ACP-visible `user_message` unchanged. Fails
open to the original prompt when Paseo metadata is missing.

This is an explicit, auditable exception to the Zero Prompt Injection invariant:
it only prepends daemon-authored context, never adapter prose, and only activates
for Paseo-managed Agent processes with a valid `PASEO_AGENT_ID`. Because `agy`
does not expose a per-call system/developer prompt flag, this is a backend prompt
prefix bridge rather than a native system-role message.

### 2. Permission Decisions Are Authoritative

**Files:** `src/agy/cli.ts`, `tests/cli.test.ts`

ACP permission denial is treated as authoritative even if Antigravity later writes
a completed/success row to its conversation database. Denied tool call IDs are tracked
and late updates for denied calls are suppressed. An explicit failed `tool_call_update`
is emitted for denied commands and edits.

### 3. Completion Requires Final Assistant Output

**Files:** `src/agy/cli.ts`, `src/agy/db/streaming.ts`, `tests/cli.test.ts`, `tests/db.test.ts`

`turnCompleteCandidate` strengthened so a turn is complete only after a terminal
visible assistant message appears after the last tool/system boundary. Progress rows,
idle markers, terminal lifecycle rows, and system rows are ignored as final output.

### 4. Foreground Command Task-State Fix

**Files:** `src/agy/db/streaming.ts`, `src/agy/cli.ts`, `tests/cli.test.ts`, `tests/db.test.ts`

Foreground `run_command` rows that include `task_details` alongside an explicit
terminal `commandResult.exitCode` are no longer treated as active background tasks.
Print mode drains DB rows after process exit until background work is done and a
final post-tool assistant message exists.

### 5. Whole-File Edit Revert Tolerates Provider Newlines

**Files:** `src/agy/edit/revert.ts`, `tests/cli.test.ts`

Antigravity may materialize a whole-file `write_to_file` with a trailing newline or
CRLF even when the requested content did not include one. Revert now treats `newText`,
`newText + "\n"`, and `newText + "\r\n"` as equivalent for whole-file write operations.

### 6. Test Additions

**Files:** `tests/cli.test.ts`, `tests/db.test.ts`

Coverage added: final DB evidence after permission continuation, terminal command rows
with explicit exit code, no completion before post-tool assistant output, denied tool
terminal state and suppression, no finish on progress plus idle before final answer,
rejected completed write authoritative over provider success, print process waits for
post-tool final assistant output, StreamPoller final-output and lifecycle-boundary behavior.

## Verification

- `env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_HOME npm test` — 383 passed, 1 skipped
- `env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_HOME npm run build` — passes
- `npm pack` — produces `paseo-agy-acp-1.0.0.1.tgz`

## Local Production Connector Switch

2026-08-06:

- Built and tested `paseo-agy-acp@1.0.0.0`.
- Packed `/home/tiezbro/projects/paseo-agy-acp/paseo-agy-acp-1.0.0.0.tgz`.
- Installed it into an isolated prefix:
  `/home/tiezbro/.local/opt/paseo-agy-acp-1.0.0.0-20260806T1159Z`.
- Verified the installed package can import:
  - `dist/main.js`
  - `dist/acp/session/prompt.js`
  - target-local `node-pty`
- Switched global symlink:
  `/home/tiezbro/.local/bin/agy-acp`
  to:
  `/home/tiezbro/.local/opt/paseo-agy-acp-1.0.0.0-20260806T1159Z/bin/agy-acp`.
- Previous symlink backup:
  `/home/tiezbro/.local/bin/agy-acp.backup.20260806T1200Z`.
- Previous target record:
  `/home/tiezbro/.local/bin/agy-acp.backup.20260806T1200Z.txt`.
- Production Paseo daemon `127.0.0.1:6767` was not restarted.
- Production Antigravity canary agent
  `b46d4b7a-67f6-47c6-aa78-032ad4fd6c53` completed on `6767` with
  `Status:"idle"`, `PendingPermissions:[]`, provider
  `antigravity/gemini-3.1-pro`, `thinking=high`, and returned
  `sawDaemonContext:true`.
- Health checks after switch:
  - `127.0.0.1:6767` OK
  - `127.0.0.1:6768` OK

### 2026-08-06: `1.0.0.1` PASEO_HOME fallback fix

- Root cause: production Paseo only guarantees `PASEO_AGENT_ID` and
  `PASEO_AGENT_CWD` for ACP provider processes. `PASEO_HOME` may be unset or
  empty, while the `1.0.0.0` bridge treated it as mandatory and returned an
  empty daemon context before reading Agent state.
- Source fix: `src/acp/session/prompt.ts` now resolves Paseo home as non-empty
  `PASEO_HOME`, then `~/.paseo`.
- Regression: `tests/queue-steer.test.ts` covers both unset and empty
  `PASEO_HOME` with only `PASEO_AGENT_ID` present.
- Installed prefix:
  `/home/tiezbro/.local/opt/paseo-agy-acp-1.0.0.1-20260806T144518Z`.
- Active symlink:
  `/home/tiezbro/.local/bin/agy-acp` ->
  `/home/tiezbro/.local/opt/paseo-agy-acp-1.0.0.1-20260806T144518Z/bin/agy-acp`.
- ACP initialize smoke returned `agentInfo.version:"1.0.0.1"`.
- Production Paseo daemon `127.0.0.1:6767` was not restarted.
- Antigravity marker-only canary `037d0218-c30e-489b-a97c-c9605a4fad33`
  returned `sawThinBootstrap:true` and `sawSelectorSkillPath:true`.
- Antigravity child-scope canary `a6717cf7-65e4-41b8-8417-21e8f822c94b`
  returned `sawThinBootstrap:true`, `scopeDecision:"child"`,
  `selectorLoaded:false`, `policyRead:false`, `childrenCreated:false`.
- Antigravity visible-context multi-turn canary
  `4cad1ad1-181b-457c-8f79-d24b53e64be1` returned
  `sawPaseoBootstrap:true` and `sawAbsoluteSelectorSkillPath:true` on both
  turn 1 and turn 2.
- Residual issue: Antigravity repeated the same `paseo inspect` permission three
  times before completing. This is a permission replay/acknowledgement issue
  separate from the daemon-context bridge.
