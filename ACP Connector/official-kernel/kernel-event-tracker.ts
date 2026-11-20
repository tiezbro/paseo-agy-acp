import type { KernelEvent } from "./kernel-events.js";

export interface KernelBackendNotice {
  readonly kind: "backend_http_error";
  readonly sessionId: string;
  readonly httpStatus: number;
  readonly emittedAt?: number;
}

export interface KernelRetryNotice {
  readonly kind: "model_retry_scheduled";
  readonly sessionId: string;
  readonly delayMs?: number;
  readonly emittedAt: number;
}

export type KernelNotice = KernelBackendNotice | KernelRetryNotice;

export interface KernelTurnSignals {
  readonly lastHttpStatus?: number;
}

interface TurnState {
  readonly notices: Set<number>;
  readonly startedAt: number;
  staleStepIndex: number;
  lastHttpStatus?: number;
}

/**
 * Tracks only progress signals for one active prompt per session.
 *
 * This tracker never decides that a turn failed. A stale signal from an older
 * turn is rejected by its structured `emittedAt` and `stepIndex` identity so it
 * cannot leak into the next turn or another session. A retry plan is a distinct
 * real decision every time, so it is never deduplicated.
 */
export class KernelEventTracker {
  readonly #turns = new Map<string, TurnState>();
  readonly #lastStepIndex = new Map<string, number>();

  beginTurn(sessionId: string, startedAt: number): void {
    this.#turns.set(sessionId, {
      notices: new Set<number>(),
      startedAt,
      staleStepIndex: this.#lastStepIndex.get(sessionId) ?? -1
    });
  }

  observe(event: KernelEvent): KernelNotice | undefined {
    const state = this.#turns.get(event.session);
    if (state === undefined) return undefined;
    if (event.emittedAt !== undefined && event.emittedAt < state.startedAt) return undefined;
    if (event.event === "model_retry_scheduled") {
      // A retry decision stamped in the same millisecond as the new prompt is
      // ambiguous; fail closed instead of attributing an old turn's plan to it.
      if (event.emittedAt <= state.startedAt) return undefined;
      return Object.freeze({
        kind: "model_retry_scheduled",
        sessionId: event.session,
        emittedAt: event.emittedAt,
        ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs })
      });
    }
    if (event.stepIndex !== undefined) {
      if (event.stepIndex <= state.staleStepIndex) return undefined;
      state.staleStepIndex = event.stepIndex;
      this.#lastStepIndex.set(event.session, event.stepIndex);
    }
    state.lastHttpStatus = event.httpStatus;
    if (state.notices.has(event.httpStatus)) return undefined;
    state.notices.add(event.httpStatus);
    return Object.freeze({
      kind: "backend_http_error",
      sessionId: event.session,
      httpStatus: event.httpStatus,
      ...(event.emittedAt === undefined ? {} : { emittedAt: event.emittedAt })
    });
  }

  endTurn(sessionId: string): KernelTurnSignals | undefined {
    const state = this.#turns.get(sessionId);
    if (state === undefined) return undefined;
    this.#turns.delete(sessionId);
    return state.lastHttpStatus === undefined ? undefined : { lastHttpStatus: state.lastHttpStatus };
  }

  cancelTurn(sessionId: string): void {
    this.#turns.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.#turns.delete(sessionId);
    this.#lastStepIndex.delete(sessionId);
  }

  clear(): void {
    this.#turns.clear();
    this.#lastStepIndex.clear();
  }

  hasActiveTurn(sessionId: string): boolean {
    return this.#turns.has(sessionId);
  }
}
