const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

/** ACP protocol namespace used for a client.session/update route. */
export type AcpSessionClientProtocol = "v1" | "v2";

/**
 * Narrow adapter for the standard ACP client.session/update notification.
 * Implementations normally close over an ACP AgentContext and call its
 * `notify(session/update, { sessionId, update })` method.
 */
export type AcpSessionUpdateSender = (sessionId: string, update: unknown) => void | Promise<void>;

/** Exact metadata accepted while binding one client-side session/update route. */
export interface AcpSessionClientRouteBinding {
  readonly sessionId: string;
  readonly protocol: AcpSessionClientProtocol;
  /** Opaque, per-connection fence. A reconnect must use a fresh value. */
  readonly connectionFence: string;
  readonly sender: AcpSessionUpdateSender;
}

/** Exact metadata needed to resolve or unbind a previously bound route. */
export interface AcpSessionClientRouteReference {
  readonly sessionId: string;
  readonly protocol: AcpSessionClientProtocol;
  readonly connectionFence: string;
}

/** A sender capability that remains valid only while its bound route is current. */
export interface AcpSessionClientRoute {
  send(update: unknown): Promise<void>;
}

export class AcpSessionClientRouteError extends Error {
  constructor(detail: string) {
    super(`ACP session client route error: ${detail}`);
    this.name = "AcpSessionClientRouteError";
  }
}

export class AcpSessionClientRouteClosedError extends AcpSessionClientRouteError {
  constructor() {
    super("registry is closed");
    this.name = "AcpSessionClientRouteClosedError";
  }
}

export class AcpSessionClientRouteConflictError extends AcpSessionClientRouteError {
  constructor() {
    super("an active route already has a different exact binding");
    this.name = "AcpSessionClientRouteConflictError";
  }
}

export class AcpSessionClientRouteFenceError extends AcpSessionClientRouteError {
  constructor() {
    super("connection fence does not match the active route");
    this.name = "AcpSessionClientRouteFenceError";
  }
}

export class AcpSessionClientRouteNotFoundError extends AcpSessionClientRouteError {
  constructor() {
    super("route is unknown or has been unbound");
    this.name = "AcpSessionClientRouteNotFoundError";
  }
}

export class AcpSessionClientRouteProtocolError extends AcpSessionClientRouteError {
  constructor() {
    super("protocol is invalid for the requested session route");
    this.name = "AcpSessionClientRouteProtocolError";
  }
}

/** Raised by a previously resolved handle after its route was unbound or replaced. */
export class AcpSessionClientRouteStaleSenderError extends AcpSessionClientRouteError {
  constructor() {
    super("resolved sender is stale and cannot write session updates");
    this.name = "AcpSessionClientRouteStaleSenderError";
  }
}

interface RouteEntry extends AcpSessionClientRouteBinding {
  readonly route: AcpSessionClientRoute;
}

/**
 * In-memory capability registry for outbound standard ACP session/update
 * notifications. It intentionally never persists update payloads, prompts,
 * tokens, headers, or client objects.
 */
export class AcpSessionClientRouteRegistry {
  readonly #routes = new Map<string, RouteEntry>();
  #closed = false;

  /**
   * Bind a sender to one session/protocol/fence tuple. Retrying the exact same
   * binding returns the original guarded sender capability; any different
   * active sender or fence is rejected.
   */
  bind(input: unknown): AcpSessionClientRoute {
    this.assertOpen();
    const binding = normalizeBinding(input);
    const key = routeKey(binding.sessionId, binding.protocol);
    const existing = this.#routes.get(key);
    if (existing !== undefined) {
      if (sameBinding(existing, binding)) return existing.route;
      throw new AcpSessionClientRouteConflictError();
    }

    const entry = this.createEntry(binding);
    this.#routes.set(key, entry);
    return entry.route;
  }

  /** Resolve one exact current route or fail closed with a typed error. */
  resolve(input: unknown): AcpSessionClientRoute {
    this.assertOpen();
    return this.requireEntry(normalizeReference(input)).route;
  }

  /** Remove exactly one route. A stale, missing, or wrong fence cannot unbind it. */
  unbind(input: unknown): boolean {
    this.assertOpen();
    const reference = normalizeReference(input);
    this.requireEntry(reference);
    this.#routes.delete(routeKey(reference.sessionId, reference.protocol));
    return true;
  }

  /** Clear all live route capabilities; subsequent operations fail closed. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#routes.clear();
  }

  private createEntry(binding: AcpSessionClientRouteBinding): RouteEntry {
    let entry!: RouteEntry;
    const route = Object.freeze({
      send: async (update: unknown): Promise<void> => {
        this.assertOpen();
        if (this.#routes.get(routeKey(entry.sessionId, entry.protocol)) !== entry) {
          throw new AcpSessionClientRouteStaleSenderError();
        }
        await entry.sender(entry.sessionId, update);
      }
    });
    entry = Object.freeze({ ...binding, route });
    return entry;
  }

  private requireEntry(reference: AcpSessionClientRouteReference): RouteEntry {
    const entry = this.#routes.get(routeKey(reference.sessionId, reference.protocol));
    if (entry !== undefined) {
      if (entry.connectionFence !== reference.connectionFence) throw new AcpSessionClientRouteFenceError();
      return entry;
    }
    if (this.hasSession(reference.sessionId)) throw new AcpSessionClientRouteProtocolError();
    throw new AcpSessionClientRouteNotFoundError();
  }

  private hasSession(sessionId: string): boolean {
    for (const route of this.#routes.values()) {
      if (route.sessionId === sessionId) return true;
    }
    return false;
  }

  private assertOpen(): void {
    if (this.#closed) throw new AcpSessionClientRouteClosedError();
  }
}

function normalizeBinding(value: unknown): AcpSessionClientRouteBinding {
  const record = exactRecord(value, ["sessionId", "protocol", "connectionFence", "sender"]);
  if (record === null) throw new AcpSessionClientRouteError("route binding must contain only allowlisted fields");
  if (typeof record.sender !== "function") throw new AcpSessionClientRouteError("route sender is invalid");

  return Object.freeze({
    sessionId: readIdentifier(record.sessionId, "session ID"),
    protocol: readProtocol(record.protocol),
    connectionFence: readIdentifier(record.connectionFence, "connection fence"),
    sender: record.sender as AcpSessionUpdateSender
  });
}

function normalizeReference(value: unknown): AcpSessionClientRouteReference {
  const record = exactRecord(value, ["sessionId", "protocol", "connectionFence"]);
  if (record === null) throw new AcpSessionClientRouteError("route reference must contain only allowlisted fields");

  return Object.freeze({
    sessionId: readIdentifier(record.sessionId, "session ID"),
    protocol: readProtocol(record.protocol),
    connectionFence: readIdentifier(record.connectionFence, "connection fence")
  });
}

function readProtocol(value: unknown): AcpSessionClientProtocol {
  if (value !== "v1" && value !== "v2") throw new AcpSessionClientRouteProtocolError();
  return value;
}

function readIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new AcpSessionClientRouteError(`${label} is invalid`);
  }
  return value;
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

function routeKey(sessionId: string, protocol: AcpSessionClientProtocol): string {
  return `${protocol}\0${sessionId}`;
}

function sameBinding(left: RouteEntry, right: AcpSessionClientRouteBinding): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.protocol === right.protocol &&
    left.connectionFence === right.connectionFence &&
    left.sender === right.sender
  );
}
