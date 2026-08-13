// Turn ownership for a single ACP session.
//
// One session may only run one prompt turn against the agy backend at a time.
// Requests compete for that slot in three ways: an idle request claims it
// directly, a `queue` request waits in FIFO, and a `steer` request reserves it
// and displaces whatever is running.
//
// The invariants below exist because ad-hoc ownership flags spread across the
// prompt handlers made every `await` a window where the session could be
// half-owned, and every such window was a cancellation bug:
//
//  I1. A claim is one object that exists from admission until the turn is fully
//      finished — including a steer's wait for the previous turn to stop. There
//      is no phase where a request owns the session but has no claim.
//  I2. Every claim carries its AbortController from the moment it is created,
//      so cancel/close/evict always have something to abort in every phase.
//  I3. Cancellation unwinds by throwing (`TurnCancelled`), not by polling a
//      flag after each await. Callers cannot forget to re-check.
//  I4. Every client-bound delivery is raced against the turn's claim (or a
//      queued item's controller). agy's prompt loop awaits each update
//      callback, so a client transport that never settles would otherwise pin
//      the slot forever — killing the backend cannot settle a wedged notify.

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

export type TurnKind = "foreground" | "queued" | "steer";

/** A request's ownership of (or reservation on) the session's single turn slot. */
export class TurnClaim {
  readonly kind: TurnKind;
  /**
   * For claimed queued prompts, the client-visible queue id. Lets a targeted
   * `session/cancel` find the turn its queued item grew into, so it aborts
   * exactly that claim instead of falling back to a session-wide abort.
   */
  readonly tag?: string;
  private readonly controller = new AbortController();
  private isReleased = false;

  constructor(kind: TurnKind, parent?: AbortSignal, tag?: string) {
    this.kind = kind;
    this.tag = tag;
    // A request-scoped signal (v1 `session/prompt` cancellation) folds into the
    // claim, so downstream code only ever consults one signal.
    if (parent) onAbort(parent, () => this.abort());
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  get released(): boolean {
    return this.isReleased;
  }

  abort(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new TurnCancelled());
  }

  throwIfAborted(): void {
    if (this.aborted) throw new TurnCancelled();
  }

  /** @internal — the scheduler marks a claim finished exactly once. */
  markReleased(): boolean {
    if (this.isReleased) return false;
    this.isReleased = true;
    return true;
  }
}

/**
 * Await `promise`, rejecting with `TurnCancelled` as soon as `signal` aborts.
 *
 * The single implementation behind invariant I4: every client-bound delivery
 * goes through here (directly, or via `raceClaim` for turn claims), so a
 * client transport that never settles unwinds on cancel/close instead of
 * pinning the turn slot or the queue-preparation chain.
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

/** Lazily attach a scheduler to a session-like object. */
export function turnsOf(session: { turns?: TurnScheduler }): TurnScheduler {
  return (session.turns ??= new TurnScheduler());
}

export class TurnScheduler {
  private active?: TurnClaim;
  /** Steer reservations in FIFO order; the head is next to take the slot. */
  private reservations: TurnClaim[] = [];
  private waiters = new Set<() => void>();
  private closed = false;

  /** True when a turn is running or a steer has reserved the next turn. */
  busy(): boolean {
    return this.active !== undefined || this.reservations.length > 0;
  }

  get activeClaim(): TurnClaim | undefined {
    return this.active;
  }

  /**
   * Take the slot for a request that found the session idle. Synchronous by
   * design: no await may separate the busy check from the claim (I1).
   */
  claimIdle(kind: Exclude<TurnKind, "steer">, parent?: AbortSignal, tag?: string): TurnClaim {
    if (this.busy()) {
      // Callers must check `busy()` with no await in between; overwriting the
      // slot here would silently orphan a running turn.
      throw new Error("cannot claim a busy session turn slot");
    }
    const claim = new TurnClaim(kind, parent, tag);
    this.active = claim;
    if (this.closed) claim.abort();
    return claim;
  }

  /**
   * Reserve the next turn for a steer. Synchronous, so the claim — and its
   * abort controller — exist before the first await (I1, I2). The reservation
   * keeps the session `busy()`, so no queued follow-up can slip in front.
   */
  reserveSteer(parent?: AbortSignal): TurnClaim {
    const claim = new TurnClaim("steer", parent);
    this.reservations.push(claim);
    if (this.closed) claim.abort();
    return claim;
  }

  /**
   * Wait for `claim` to reach the head of the reservation queue, stop whatever
   * is running, and hand it the slot. Throws `TurnCancelled` if the claim is
   * aborted at any point, including while the backend is being killed.
   *
   * A reservation stays in the queue until it is *released*, not merely until
   * it is promoted. Otherwise a later steer would reach the head while an
   * earlier one was running and displace it before it ever reached the backend.
   */
  async promote(claim: TurnClaim, cancelActive: () => Promise<void>): Promise<void> {
    claim.throwIfAborted();

    while (this.reservations[0] !== claim) {
      if (!this.reservations.includes(claim)) throw new TurnCancelled();
      await this.nextChange(claim);
    }

    const displaced = this.active;
    if (displaced) {
      displaced.abort();
      // Cancellable while the backend shuts down: a stop arriving during a slow
      // kill must not be swallowed and then followed by the replacement turn.
      await raceClaim(cancelActive(), claim);
      while (this.active) await this.nextChange(claim);
    }

    claim.throwIfAborted();
    if (this.reservations[0] !== claim) throw new TurnCancelled();
    this.active = claim;
    this.change();
  }

  /**
   * Finish a claim. Idempotent, and safe to call from a `finally` on any exit
   * path — success, cancellation, or setup failure.
   */
  release(claim: TurnClaim): void {
    if (!claim.markReleased()) return;
    if (this.active === claim) this.active = undefined;
    const idx = this.reservations.indexOf(claim);
    if (idx >= 0) this.reservations.splice(idx, 1);
    this.change();
  }

  /** Abort every live claim (`session/cancel`). Queued items are untouched. */
  abortAll(): void {
    this.active?.abort();
    for (const reservation of [...this.reservations]) reservation.abort();
  }

  /** Abort everything and refuse further claims (close / delete / evict). */
  close(): void {
    this.closed = true;
    this.abortAll();
    this.change();
  }

  private change(): void {
    const pending = [...this.waiters];
    this.waiters.clear();
    for (const waiter of pending) waiter();
  }

  /** Resolve on the next ownership change, or reject if `claim` is aborted. */
  private nextChange(claim: TurnClaim): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (claim.aborted) {
        reject(new TurnCancelled());
        return;
      }
      let off = () => {};
      const waiter = () => {
        off();
        resolve();
      };
      this.waiters.add(waiter);
      off = onAbort(claim.signal, () => {
        this.waiters.delete(waiter);
        reject(new TurnCancelled());
      });
    });
  }
}
