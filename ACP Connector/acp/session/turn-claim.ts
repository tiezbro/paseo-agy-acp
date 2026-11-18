/** Thrown when a claim is aborted; unwinds the turn pipeline to its reporter. */
export class TurnCancelled extends Error {
  constructor(message = "turn cancelled") {
    super(message);
    this.name = "TurnCancelled";
  }
}

export function isTurnCancelled(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return error instanceof TurnCancelled || name === "TurnCancelled" || name === "AbortError";
}

/**
 * Run `fn` for an abort signal, now or later. Plain `addEventListener` never
 * fires for a signal that is already aborted, which repeatedly produced turns
 * that ran after they had been cancelled.
 */
export function onAbort(signal: AbortSignal, fn: () => void): () => void {
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

/** Cancellation state for one active ACP prompt. Session ownership lives in the proxy. */
export class TurnClaim {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  abort(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new TurnCancelled());
  }

  throwIfAborted(): void {
    if (this.aborted) throw new TurnCancelled();
  }
}

/**
 * Await `promise`, rejecting with `TurnCancelled` as soon as `signal` aborts.
 *
 * Context preparation must unwind on cancel or close even if its input never settles.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TurnCancelled());
      return;
    }
    const off = onAbort(signal, () => reject(new TurnCancelled()));
    promise.then(
      (value) => {
        off();
        resolve(value);
      },
      (error) => {
        off();
        reject(error);
      }
    );
  });
}

/** Await `promise`, rejecting as soon as `claim` is aborted. */
export function raceClaim<T>(promise: Promise<T>, claim: TurnClaim): Promise<T> {
  return raceSignal(promise, claim.signal);
}
