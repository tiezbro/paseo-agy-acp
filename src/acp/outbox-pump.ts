import type {
  AcpOutboxDeliveryBridge,
  OutboxDeliveryOrphanSweepResult,
  OutboxDeliveryResult
} from "./outbox-delivery.js";

const DEFAULT_MAX_DELIVERIES = 32;
const MAX_DELIVERIES_PER_RUN = 1_000;
const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type OutboxPumpBridge = Pick<
  AcpOutboxDeliveryBridge,
  "drainNextPendingDelivery" | "sweepExpiredDeliveryClaims"
>;

export type OutboxPumpStatus = "idle" | "bounded" | "blocked" | "closed";

export type OutboxPumpBlockReason =
  | "invalid_input"
  | "clock_failed"
  | "sweep_failed"
  | "delivery_failed"
  | "unexpected_delivery_state";

export interface OutboxPumpDeliveryRecord {
  readonly status: "awaiting_ack" | "recovery_required";
  readonly eventId: string;
  readonly claimGeneration: number;
}

export interface OutboxPumpReport {
  readonly status: OutboxPumpStatus;
  readonly reason?: OutboxPumpBlockReason;
  /** Number of next-pending bridge calls, including the final null or failed call. */
  readonly attempted: number;
  readonly swept: readonly OutboxPumpDeliveryRecord[];
  readonly deliveries: readonly OutboxPumpDeliveryRecord[];
}

export type OutboxPumpScheduledTrigger = () => Promise<OutboxPumpReport>;

export type OutboxPumpSchedule = (
  trigger: OutboxPumpScheduledTrigger
) => void | (() => void);

export interface AcpOutboxPumpOptions {
  readonly bridge: OutboxPumpBridge;
  readonly defaultMaxDeliveries?: number;
  /** Used only by an injected schedule trigger; direct calls supply their own time. */
  readonly clock?: () => number;
  /**
   * Optional external scheduling registration. The callback receives only a
   * pump trigger and cannot access the bridge, payload, or controller.
   */
  readonly schedule?: OutboxPumpSchedule;
}

export class AcpOutboxPumpConfigurationError extends Error {
  constructor(reason: "invalid_options" | "schedule_registration_failed") {
    super(`outbox pump configuration error: ${reason}`);
    this.name = "AcpOutboxPumpConfigurationError";
  }
}

/**
 * A serialized, bounded driver for controller-owned outbox delivery claims.
 * It never owns a provider turn, payload, retry policy, timer, or ACK state.
 */
export class AcpOutboxPump {
  readonly #bridge: OutboxPumpBridge;
  readonly #defaultMaxDeliveries: number;
  readonly #clock: () => number;
  #cancelSchedule: (() => void) | undefined;
  #inFlight: Promise<OutboxPumpReport> | undefined;
  #closed = false;

  constructor(options: AcpOutboxPumpOptions) {
    if (!isBridge(options?.bridge)) throw new AcpOutboxPumpConfigurationError("invalid_options");
    this.#bridge = options.bridge;
    this.#defaultMaxDeliveries = readMax(options.defaultMaxDeliveries ?? DEFAULT_MAX_DELIVERIES);
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new AcpOutboxPumpConfigurationError("invalid_options");
    }
    this.#clock = options.clock ?? Date.now;

    if (options.schedule !== undefined) {
      if (typeof options.schedule !== "function") throw new AcpOutboxPumpConfigurationError("invalid_options");
      let cancellation: unknown;
      try {
        cancellation = options.schedule(this.#scheduledTrigger);
      } catch {
        throw new AcpOutboxPumpConfigurationError("schedule_registration_failed");
      }
      if (cancellation !== undefined && typeof cancellation !== "function") {
        throw new AcpOutboxPumpConfigurationError("invalid_options");
      }
      this.#cancelSchedule = cancellation as (() => void) | undefined;
    }
  }

  /** Coalesce a wake-up with the current worker, or run one default bounded batch. */
  poke(now: number): Promise<OutboxPumpReport> {
    return this.#start(now, this.#defaultMaxDeliveries);
  }

  /** Coalesce with the current worker, or run at most `max` next-pending calls. */
  drain(now: number, max: number): Promise<OutboxPumpReport> {
    return this.#start(now, max);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const cancel = this.#cancelSchedule;
    this.#cancelSchedule = undefined;
    try {
      cancel?.();
    } catch {
      // Schedule teardown is external. It cannot reopen the pump or expose its error.
    }
  }

  readonly #scheduledTrigger: OutboxPumpScheduledTrigger = () => {
    if (this.#closed) return Promise.resolve(emptyReport("closed"));
    if (this.#inFlight !== undefined) return this.#inFlight;

    let now: number;
    try {
      now = this.#clock();
    } catch {
      return Promise.resolve(blockedReport("clock_failed", 0));
    }
    if (!isTimestamp(now)) return Promise.resolve(blockedReport("clock_failed", 0));
    return this.#start(now, this.#defaultMaxDeliveries);
  };

  #start(now: number, max: number): Promise<OutboxPumpReport> {
    if (this.#closed) return Promise.resolve(emptyReport("closed"));
    if (this.#inFlight !== undefined) return this.#inFlight;
    if (!isTimestamp(now) || !isMax(max)) {
      return Promise.resolve(blockedReport("invalid_input", 0));
    }

    const running = this.#run(now, max);
    this.#inFlight = running;
    const clear = () => {
      if (this.#inFlight === running) this.#inFlight = undefined;
    };
    void running.then(clear, clear);
    return running;
  }

  async #run(now: number, max: number): Promise<OutboxPumpReport> {
    let swept: readonly OutboxPumpDeliveryRecord[];
    try {
      swept = normalizeSweep(this.#bridge.sweepExpiredDeliveryClaims(now));
    } catch {
      return blockedReport("sweep_failed", 0);
    }
    if (this.#closed) return createReport("closed", 0, swept, []);

    const deliveries: OutboxPumpDeliveryRecord[] = [];
    let attempted = 0;
    while (attempted < max) {
      if (this.#closed) return createReport("closed", attempted, swept, deliveries);
      attempted += 1;

      let result: OutboxDeliveryResult | null;
      try {
        result = await this.#bridge.drainNextPendingDelivery(now);
      } catch {
        return createReport("blocked", attempted, swept, deliveries, "delivery_failed");
      }
      if (this.#closed) return createReport("closed", attempted, swept, deliveries);
      if (result === null) return createReport("idle", attempted, swept, deliveries);

      const delivery = normalizeDelivery(result);
      if (delivery === null) {
        return createReport("blocked", attempted, swept, deliveries, "unexpected_delivery_state");
      }
      deliveries.push(delivery);
    }

    return createReport("bounded", attempted, swept, deliveries);
  }
}

function isBridge(value: unknown): value is OutboxPumpBridge {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OutboxPumpBridge>).drainNextPendingDelivery === "function" &&
    typeof (value as Partial<OutboxPumpBridge>).sweepExpiredDeliveryClaims === "function"
  );
}

function readMax(value: unknown): number {
  if (!isMax(value)) throw new AcpOutboxPumpConfigurationError("invalid_options");
  return value;
}

function isMax(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_DELIVERIES_PER_RUN
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeSweep(value: readonly OutboxDeliveryOrphanSweepResult[]): readonly OutboxPumpDeliveryRecord[] {
  if (!Array.isArray(value)) throw new Error("invalid sweep");
  return Object.freeze(value.map((entry) => {
    const normalized = normalizeDelivery(entry);
    if (normalized === null || normalized.status !== "recovery_required") throw new Error("invalid sweep");
    return normalized;
  }));
}

function normalizeDelivery(value: unknown): OutboxPumpDeliveryRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes("status") ||
    !keys.includes("eventId") ||
    !keys.includes("claimGeneration") ||
    (record.status !== "awaiting_ack" && record.status !== "recovery_required") ||
    !isIdentifier(record.eventId) ||
    typeof record.claimGeneration !== "number" ||
    !Number.isSafeInteger(record.claimGeneration) ||
    record.claimGeneration < 1
  ) {
    return null;
  }
  return Object.freeze({
    status: record.status,
    eventId: record.eventId,
    claimGeneration: record.claimGeneration
  });
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function emptyReport(status: "idle" | "closed"): OutboxPumpReport {
  return createReport(status, 0, [], []);
}

function blockedReport(reason: OutboxPumpBlockReason, attempted: number): OutboxPumpReport {
  return createReport("blocked", attempted, [], [], reason);
}

function createReport(
  status: OutboxPumpStatus,
  attempted: number,
  swept: readonly OutboxPumpDeliveryRecord[],
  deliveries: readonly OutboxPumpDeliveryRecord[],
  reason?: OutboxPumpBlockReason
): OutboxPumpReport {
  return Object.freeze({
    status,
    ...(reason === undefined ? {} : { reason }),
    attempted,
    swept: Object.freeze([...swept]),
    deliveries: Object.freeze([...deliveries])
  });
}
