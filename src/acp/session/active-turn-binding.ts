import {
  ActiveSessionLeaseFenceError,
  type ActiveConnectorIdentity,
  type ActiveSessionAdvance,
  type ActiveSessionFence,
  type ActiveSessionRegistration,
  type ActiveSessionTerminalState
} from "./active-registry.js";

const IDENTIFIER_MAX_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const OWNER_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REGISTRATION_FIELDS = [
  "agentId",
  "sessionId",
  "requestId",
  "conversationId",
  "cursor",
  "connectorIdentity"
] as const;
const CONNECTOR_FIELDS = [
  "ownerInstanceId",
  "createdAt",
  "bootId",
  "pid",
  "startTimeTicks",
  "pidNamespaceInode",
  "ppid",
  "pgrp",
  "session"
] as const;
const FENCE_FIELDS = ["requestId", "ownerInstanceId", "leaseGeneration"] as const;
const ADVANCE_FIELDS = ["conversationId", "cursor"] as const;
const TERMINAL_STATES = new Set<ActiveSessionTerminalState>(["completed", "failed", "cancelled"]);

export type ActiveSessionTurnBindingErrorCode =
  | "invalid_input"
  | "invalid_registry"
  | "registry_error"
  | "stale_fence"
  | "wrong_order"
  | "conversation_rebind"
  | "cursor_regression"
  | "invalid_terminal"
  | "terminal_already_marked"
  | "closed";

/** A non-payload-bearing failure for the request-scoped turn binding facade. */
export class ActiveSessionTurnBindingError extends Error {
  readonly code: ActiveSessionTurnBindingErrorCode;

  constructor(code: ActiveSessionTurnBindingErrorCode) {
    super(`active session turn binding error: ${code}`);
    this.name = "ActiveSessionTurnBindingError";
    this.code = code;
  }
}

/** Narrow registry surface so the facade never receives a broader runtime composition. */
export interface ActiveSessionTurnRegistry {
  register(input: unknown): ActiveSessionFence;
  advance(fenceInput: unknown, updateInput: unknown): void;
  markTerminal(fenceInput: unknown, terminalState: unknown): void;
  archiveTerminal(fenceInput: unknown): boolean;
}

/**
 * A request-scoped state machine around one registered active-session fence.
 * It retains only fence, conversation/cursor, and terminal state; prompt,
 * process, controller, route, and provider payload data never enter its API.
 */
export class ActiveSessionTurnBinding {
  readonly #registry: ActiveSessionTurnRegistry;
  readonly #fence: ActiveSessionFence;
  #conversationId: string | null;
  #cursor: number;
  #terminalState: ActiveSessionTerminalState | null = null;
  #sealed = false;

  private constructor(
    registry: ActiveSessionTurnRegistry,
    fence: ActiveSessionFence,
    conversationId: string | null,
    cursor: number
  ) {
    this.#registry = registry;
    this.#fence = fence;
    this.#conversationId = conversationId;
    this.#cursor = cursor;
  }

  /** Register once and capture the exact owner-generation fence privately. */
  static register(registryInput: unknown, registrationInput: unknown): ActiveSessionTurnBinding {
    const registry = requireRegistry(registryInput);
    const registration = normalizeRegistration(registrationInput);
    let returnedFence: unknown;
    try {
      returnedFence = registry.register(registration.value);
    } catch (error) {
      throw registryFailure(error);
    }

    let fence: ActiveSessionFence;
    try {
      fence = normalizeFence(returnedFence);
    } catch {
      throw new ActiveSessionTurnBindingError("registry_error");
    }
    if (
      fence.requestId !== registration.requestId ||
      fence.ownerInstanceId !== registration.ownerInstanceId
    ) {
      throw new ActiveSessionTurnBindingError("registry_error");
    }

    return Object.preventExtensions(new ActiveSessionTurnBinding(
      registry,
      fence,
      registration.conversationId,
      registration.cursor
    ));
  }

  /** Bind one conversation from null/-1, then advance only its nondecreasing cursor. */
  advance(input: unknown): void {
    this.assertUsable();
    if (this.#terminalState !== null) this.fail("wrong_order");

    let update: ActiveSessionAdvance;
    try {
      update = normalizeAdvance(input);
    } catch {
      this.fail("invalid_input");
    }

    if (this.#conversationId === null) {
      if (update.conversationId === null && update.cursor !== -1) this.fail("invalid_input");
    } else {
      if (update.conversationId !== this.#conversationId) this.fail("conversation_rebind");
      if (update.cursor < this.#cursor) this.fail("cursor_regression");
    }

    this.callRegistry(() => this.#registry.advance(this.#fence, update));
    this.#conversationId = update.conversationId;
    this.#cursor = update.cursor;
  }

  /**
   * Persist the final cursor under the captured fence before recording one
   * exact terminal state. A later terminal call is never treated as idempotent.
   */
  markTerminal(stateInput: unknown, finalCursorInput: unknown): void {
    this.assertUsable();
    if (this.#terminalState !== null) this.fail("terminal_already_marked");

    const terminalState = this.readTerminalState(stateInput);
    const finalCursor = this.readFinalCursor(finalCursorInput);
    const finalAdvance = Object.freeze({ conversationId: this.#conversationId, cursor: finalCursor });

    this.callRegistry(() => this.#registry.advance(this.#fence, finalAdvance));
    this.#cursor = finalCursor;
    this.callRegistry(() => this.#registry.markTerminal(this.#fence, terminalState));
    this.#terminalState = terminalState;
  }

  /** Archive is optional and becomes available only after a successful terminal transition. */
  archive(): boolean {
    this.assertUsable();
    if (this.#terminalState === null) this.fail("wrong_order");
    const archived = this.callRegistry(() => this.#registry.archiveTerminal(this.#fence));
    if (typeof archived !== "boolean") this.fail("registry_error");
    return archived;
  }

  private readTerminalState(value: unknown): ActiveSessionTerminalState {
    if (!TERMINAL_STATES.has(value as ActiveSessionTerminalState)) this.fail("invalid_terminal");
    return value as ActiveSessionTerminalState;
  }

  private readFinalCursor(value: unknown): number {
    let cursor: number;
    try {
      cursor = readCursor(value);
    } catch {
      this.fail("invalid_input");
    }
    if (this.#conversationId === null) {
      if (cursor !== -1) this.fail("wrong_order");
      return cursor;
    }
    if (cursor < 0) this.fail("invalid_input");
    if (cursor < this.#cursor) this.fail("cursor_regression");
    return cursor;
  }

  private assertUsable(): void {
    if (this.#sealed) throw new ActiveSessionTurnBindingError("closed");
  }

  private fail(code: Exclude<ActiveSessionTurnBindingErrorCode, "closed">): never {
    this.#sealed = true;
    throw new ActiveSessionTurnBindingError(code);
  }

  private callRegistry<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      this.#sealed = true;
      throw registryFailure(error);
    }
  }
}

export function createActiveSessionTurnBinding(
  registry: unknown,
  registration: unknown
): ActiveSessionTurnBinding {
  return ActiveSessionTurnBinding.register(registry, registration);
}

interface NormalizedRegistration {
  readonly value: ActiveSessionRegistration;
  readonly requestId: string;
  readonly ownerInstanceId: string;
  readonly conversationId: string | null;
  readonly cursor: number;
}

function normalizeRegistration(value: unknown): NormalizedRegistration {
  const fields = exactRecord(value, REGISTRATION_FIELDS);
  if (fields === null) throw new ActiveSessionTurnBindingError("invalid_input");
  const connectorFields = exactRecord(fields.connectorIdentity, CONNECTOR_FIELDS);
  if (connectorFields === null) throw new ActiveSessionTurnBindingError("invalid_input");

  const conversationId = readNullableIdentifier(fields.conversationId);
  const cursor = readCursor(fields.cursor);
  assertConversationBinding(conversationId, cursor);
  const ownerInstanceId = readOwnerInstanceId(connectorFields.ownerInstanceId);
  const connectorIdentity: ActiveConnectorIdentity = Object.freeze({
    ownerInstanceId,
    createdAt: readString(connectorFields.createdAt),
    bootId: readString(connectorFields.bootId),
    pid: readPositiveInteger(connectorFields.pid),
    startTimeTicks: readString(connectorFields.startTimeTicks),
    pidNamespaceInode: readPositiveInteger(connectorFields.pidNamespaceInode),
    ppid: readPositiveInteger(connectorFields.ppid),
    pgrp: readPositiveInteger(connectorFields.pgrp),
    session: readPositiveInteger(connectorFields.session)
  });
  const requestId = readIdentifier(fields.requestId);
  const registration: ActiveSessionRegistration = Object.freeze({
    agentId: readIdentifier(fields.agentId),
    sessionId: readIdentifier(fields.sessionId),
    requestId,
    conversationId,
    cursor,
    connectorIdentity
  });
  return Object.freeze({ value: registration, requestId, ownerInstanceId, conversationId, cursor });
}

function normalizeFence(value: unknown): ActiveSessionFence {
  const fields = exactRecord(value, FENCE_FIELDS);
  if (fields === null) throw new ActiveSessionTurnBindingError("registry_error");
  return Object.freeze({
    requestId: readIdentifier(fields.requestId),
    ownerInstanceId: readOwnerInstanceId(fields.ownerInstanceId),
    leaseGeneration: readLeaseGeneration(fields.leaseGeneration)
  });
}

function normalizeAdvance(value: unknown): ActiveSessionAdvance {
  const fields = exactRecord(value, ADVANCE_FIELDS);
  if (fields === null) throw new ActiveSessionTurnBindingError("invalid_input");
  const conversationId = readNullableIdentifier(fields.conversationId);
  const cursor = readCursor(fields.cursor);
  assertConversationBinding(conversationId, cursor);
  return Object.freeze({ conversationId, cursor });
}

function requireRegistry(value: unknown): ActiveSessionTurnRegistry {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { register?: unknown }).register !== "function" ||
      typeof (value as { advance?: unknown }).advance !== "function" ||
      typeof (value as { markTerminal?: unknown }).markTerminal !== "function" ||
      typeof (value as { archiveTerminal?: unknown }).archiveTerminal !== "function"
    ) {
      throw new ActiveSessionTurnBindingError("invalid_registry");
    }
  } catch (error) {
    if (error instanceof ActiveSessionTurnBindingError) throw error;
    throw new ActiveSessionTurnBindingError("invalid_registry");
  }
  return value as ActiveSessionTurnRegistry;
}

function registryFailure(error: unknown): ActiveSessionTurnBindingError {
  return new ActiveSessionTurnBindingError(
    error instanceof ActiveSessionLeaseFenceError ? "stale_fence" : "registry_error"
  );
}

function readNullableIdentifier(value: unknown): string | null {
  return value === null ? null : readIdentifier(value);
}

function readIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_MAX_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new ActiveSessionTurnBindingError("invalid_input");
  }
  return value;
}

function readOwnerInstanceId(value: unknown): string {
  if (typeof value !== "string" || !OWNER_INSTANCE_ID_PATTERN.test(value)) {
    throw new ActiveSessionTurnBindingError("invalid_input");
  }
  return value;
}

function readString(value: unknown): string {
  if (typeof value !== "string") throw new ActiveSessionTurnBindingError("invalid_input");
  return value;
}

function readPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ActiveSessionTurnBindingError("invalid_input");
  }
  return value;
}

function readCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    throw new ActiveSessionTurnBindingError("invalid_input");
  }
  return value;
}

function readLeaseGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ActiveSessionTurnBindingError("registry_error");
  }
  return value;
}

function assertConversationBinding(conversationId: string | null, cursor: number): void {
  if ((conversationId === null && cursor !== -1) || (conversationId !== null && cursor < 0)) {
    throw new ActiveSessionTurnBindingError("invalid_input");
  }
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expectedKeys.length || Object.getOwnPropertySymbols(value).length !== 0) return null;

    const record: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}
