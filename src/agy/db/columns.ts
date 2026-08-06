// Decoders for the auxiliary `steps` columns that sit alongside `step_payload`:
// `error_details`, `permissions`, and `task_details`. Like step-payload.ts,
// these are protobuf blobs with no published schema; the field numbers were
// determined by inspecting real agy conversation databases. `permissions` in
// particular is nested three levels deep (entry -> target -> kind/value).

import { readInt, readMessage, readSubmessage } from "./protowire.js";
import { decodeTaskDetails, type TaskDetails } from "./step-payload.js";

export interface ErrorDetails {
  /** Short, user-facing summary (e.g. "User denied permission for command(...)"). */
  message: string;
  /** The underlying error detail / stderr. */
  detail: string;
  /** Full error with attached stack trace. */
  stackTrace: string;
}

/** error_details: { 1: message, 2: detail, 3: stackTrace }.
 *  `message` is sometimes absent (e.g. cancellations); callers should fall
 *  back to `detail`. */
export function decodeErrorDetails(bytes: Uint8Array): ErrorDetails {
  return readMessage(bytes, { message: "", detail: "", stackTrace: "" }, {
    1: (m, r) => (m.message = r.string()),
    2: (m, r) => (m.detail = r.string()),
    3: (m, r) => (m.stackTrace = r.string())
  });
}

export interface PermissionInfo {
  /** The permission category, e.g. "command". */
  kind: string;
  /** The target the agent asked permission for, e.g. the command string. */
  value: string;
  /** Raw decision varint as stored by agy (semantics not fully specified). */
  decision: number;
}

interface PermissionTarget {
  kind: string;
  value: string;
}

function decodePermissionTarget(bytes: Uint8Array): PermissionTarget {
  return readMessage(bytes, { kind: "", value: "" }, {
    1: (m, r) => (m.kind = r.string()),
    2: (m, r) => (m.value = r.string())
  });
}

interface PermissionEntry {
  target: PermissionTarget | undefined;
  decision: number;
}

function decodePermissionEntry(bytes: Uint8Array): PermissionEntry {
  return readMessage<PermissionEntry>(bytes, { target: undefined, decision: 0 }, {
    1: (m, r) => (m.target = readSubmessage(r, decodePermissionTarget)),
    2: (m, r) => (m.decision = readInt(r))
  });
}

/** permissions: { 2: { 1: { 1: kind, 2: value }, 2: decision } }.
 *  Returns null when no permission entry is present. */
export function decodePermissions(bytes: Uint8Array): PermissionInfo | null {
  let entry: PermissionEntry | undefined;
  readMessage(bytes, {}, {
    2: (_msg, r) => (entry = readSubmessage(r, decodePermissionEntry))
  });
  if (!entry) return null;
  return {
    kind: entry.target?.kind ?? "",
    value: entry.target?.value ?? "",
    decision: entry.decision
  };
}

export { decodeTaskDetails };
export type { TaskDetails };
