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
| Package | `paseo-agy-acp@1.0.0.0` |

## Source Changes

### 1. Paseo Append-System-Prompt Bridge

**Files:** `src/acp/session/prompt.ts`, `tests/queue-steer.test.ts`

Recovers Paseo `daemon.appendSystemPrompt` text from agent state when `PASEO_HOME` and
`PASEO_AGENT_ID` are present. Prepends the recovered text only to the backend prompt
sent to Antigravity, keeping ACP-visible `user_message` unchanged. Fails open to the
original prompt when Paseo metadata is missing.

This is an explicit, auditable exception to the Zero Prompt Injection invariant:
it only prepends daemon-authored system context, never adapter prose, and only
activates when both Paseo environment variables are present.

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

- `npm run build` — passes
- `npm test` — 381 passed, 1 skipped (1 expected failure when PASEO_HOME is set,
  see README Known Issues)
- `npm pack` — produces `paseo-agy-acp-1.0.0.0.tgz`
