import {
  normalizeTerminalObservation,
  reconcileTerminalEvidence,
  type OfficialTerminalObservation,
  type TerminalEvidence,
  type TerminalObservationSource
} from "./terminal-evidence.js";

type MaybePromise<T> = T | Promise<T>;

const ACTIVITY_FIELDS = new Set(["source", "conversationId", "observedAt", "status"]);
const UNAVAILABLE = Symbol("provider-source-unavailable");

export interface StreamJsonProviderObservationSource {
  /** Returns one structured online activity record for the exact bound conversation. */
  readonly readActivity?: (conversationId: string) => MaybePromise<unknown>;
  /** Returns one structured terminal record for the exact bound conversation. */
  readonly readTerminal?: (conversationId: string) => MaybePromise<unknown>;
}

export interface SqliteProviderReconciliationSource {
  /** Returns one structured reconciliation terminal record for the exact bound conversation. */
  readonly readTerminal?: (conversationId: string) => MaybePromise<unknown>;
}

/** Injectable sources only; no provider process, stdout, or SQLite handle is owned here. */
export interface ProviderObserverSources {
  readonly streamJson?: StreamJsonProviderObservationSource | null;
  readonly sqliteReconciliation?: SqliteProviderReconciliationSource | null;
}

export type ProviderActivityObservation =
  | Readonly<{ status: "observed" }>
  | Readonly<{ status: "unobserved" }>;

export interface ProviderTerminalObservations {
  readonly streamJson: OfficialTerminalObservation;
  readonly sqliteReconciliation: OfficialTerminalObservation;
}

export type ProviderTerminalObservation =
  | Readonly<{ status: "observed"; observations: ProviderTerminalObservations }>
  | Readonly<{ status: "unobserved" }>;

/** The narrow, conversation-bound interface intended for later dispatcher wiring. */
export interface BoundProviderObserver {
  observeActivity(): Promise<ProviderActivityObservation>;
  observeTerminal(): Promise<ProviderTerminalObservation>;
}

/**
 * Source ownership remains outside the admission layer. Binding is mandatory so
 * every source read is scoped to one exact provider conversation identifier.
 */
export class ProviderObserver {
  readonly #sources: ProviderObserverSources;

  constructor(sources: ProviderObserverSources) {
    this.#sources = sources;
  }

  bind(conversationId: string): BoundProviderObserver {
    requireConversationId(conversationId);
    return new BoundObserver(this.#sources, conversationId);
  }
}

export function createProviderObserver(sources: ProviderObserverSources): ProviderObserver {
  return new ProviderObserver(sources);
}

class BoundObserver implements BoundProviderObserver {
  readonly #sources: ProviderObserverSources;
  readonly #conversationId: string;
  #terminalIssued = false;
  #terminalReadInProgress = false;

  constructor(sources: ProviderObserverSources, conversationId: string) {
    this.#sources = sources;
    this.#conversationId = conversationId;
  }

  async observeActivity(): Promise<ProviderActivityObservation> {
    try {
      const activity = await readSource(this.#sources, "streamJson", "readActivity", this.#conversationId);
      return activity !== UNAVAILABLE && isStructuredActivity(activity, this.#conversationId)
        ? observedActivity()
        : unobservedActivity();
    } catch {
      return unobservedActivity();
    }
  }

  async observeTerminal(): Promise<ProviderTerminalObservation> {
    if (this.#terminalIssued || this.#terminalReadInProgress) return unobservedTerminal();
    this.#terminalReadInProgress = true;

    try {
      const [streamJson, sqliteReconciliation] = await Promise.all([
        readSource(this.#sources, "streamJson", "readTerminal", this.#conversationId),
        readSource(this.#sources, "sqliteReconciliation", "readTerminal", this.#conversationId)
      ]);
      if (streamJson === UNAVAILABLE || sqliteReconciliation === UNAVAILABLE) return unobservedTerminal();

      const streamObservation = normalizeForSource(streamJson, "stream_json", this.#conversationId);
      const sqliteObservation = normalizeForSource(
        sqliteReconciliation,
        "sqlite_reconciliation",
        this.#conversationId
      );
      if (streamObservation === null || sqliteObservation === null) return unobservedTerminal();

      const reconciliation = reconcileTerminalEvidence(streamObservation, sqliteObservation);
      if (reconciliation.outcome !== "reconciled") return unobservedTerminal();

      this.#terminalIssued = true;
      return Object.freeze({
        status: "observed" as const,
        observations: Object.freeze({
          streamJson: streamObservation,
          sqliteReconciliation: sqliteObservation
        })
      });
    } catch {
      return unobservedTerminal();
    } finally {
      this.#terminalReadInProgress = false;
    }
  }
}

async function readSource(
  sources: unknown,
  sourceName: "streamJson" | "sqliteReconciliation",
  method: "readActivity" | "readTerminal",
  conversationId: string
): Promise<unknown | typeof UNAVAILABLE> {
  try {
    if (typeof sources !== "object" || sources === null) return UNAVAILABLE;
    const source = (sources as Record<string, unknown>)[sourceName];
    if (typeof source !== "object" || source === null) return UNAVAILABLE;
    const reader = (source as Record<string, unknown>)[method];
    if (typeof reader !== "function") return UNAVAILABLE;
    return await reader.call(source, conversationId);
  } catch {
    return UNAVAILABLE;
  }
}

function normalizeForSource(
  input: unknown,
  expectedSource: TerminalObservationSource,
  conversationId: string
): OfficialTerminalObservation | null {
  try {
    const terminal = normalizeTerminalObservation(input);
    if (terminal.source !== expectedSource || terminal.conversationId !== conversationId) return null;
    return officialTerminalObservation(terminal);
  } catch {
    return null;
  }
}

function officialTerminalObservation(terminal: TerminalEvidence): OfficialTerminalObservation {
  const base = {
    source: terminal.source,
    conversationId: terminal.conversationId,
    observedAt: terminal.observedAt,
    status: terminal.status
  };
  if (terminal.outcome !== "failed") return Object.freeze(base);

  const failure = terminal.failure;
  return Object.freeze({
    ...base,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.reason === undefined ? {} : { reason: failure.reason })
  });
}

function isStructuredActivity(input: unknown, conversationId: string): boolean {
  if (!isPlainRecord(input)) return false;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== ACTIVITY_FIELDS.size || keys.some((key) => typeof key !== "string" || !ACTIVITY_FIELDS.has(key))) {
    return false;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return false;
  }

  return (
    input.source === "stream_json" &&
    input.conversationId === conversationId &&
    typeof input.observedAt === "number" &&
    Number.isSafeInteger(input.observedAt) &&
    input.observedAt >= 0 &&
    input.status === "ACTIVE"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireConversationId(conversationId: string): void {
  if (typeof conversationId !== "string" || conversationId.trim().length === 0 || conversationId.includes("\u0000")) {
    throw new Error("provider observer conversation ID is invalid");
  }
}

function observedActivity(): ProviderActivityObservation {
  return Object.freeze({ status: "observed" });
}

function unobservedActivity(): ProviderActivityObservation {
  return Object.freeze({ status: "unobserved" });
}

function unobservedTerminal(): ProviderTerminalObservation {
  return Object.freeze({ status: "unobserved" });
}
