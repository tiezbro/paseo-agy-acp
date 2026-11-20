import { createHash } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { safeErrorClass } from "./kernel-events.js";

const MAX_STATE_BYTES = 16 * 1024;
const FUTURE_CLOCK_TOLERANCE_MS = 60_000;

/**
 * Authoritative terminal outcome fenced by the compatibility module.
 *
 * The kernel writes this file synchronously inside the ACP server's terminal
 * exception handler, before `PromptResponse` is returned. The connector reads
 * it only after the same response arrives, so stderr/stdout delivery order
 * cannot decide success or failure.
 */
export interface KernelTerminalState {
  readonly v: 1;
  readonly event: "turn_failed";
  readonly session: string;
  readonly errorClass: string;
  readonly sequence: number;
  readonly writtenAt: number;
  readonly stepIndex?: number;
}

export function kernelTerminalStatePath(directory: string, sessionId: string): string {
  return path.join(directory, `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

export function parseKernelTerminalState(value: unknown, expectedSession: string): KernelTerminalState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || record.event !== "turn_failed" || record.session !== expectedSession) return undefined;
  const errorClass = safeErrorClass(record.errorClass);
  const sequence = record.sequence;
  const writtenAt = record.writtenAt;
  if (errorClass === undefined) return undefined;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return undefined;
  if (!Number.isSafeInteger(writtenAt) || (writtenAt as number) < 0) return undefined;
  const stepIndex = record.stepIndex;
  if (stepIndex !== undefined && (!Number.isSafeInteger(stepIndex) || (stepIndex as number) < 0)) return undefined;
  return Object.freeze({
    v: 1,
    event: "turn_failed",
    session: expectedSession,
    errorClass,
    sequence: sequence as number,
    writtenAt: writtenAt as number,
    ...(stepIndex === undefined ? {} : { stepIndex: stepIndex as number })
  });
}

/**
 * One-shot terminal state reader. It never polls and never waits: `read` is
 * called from the prompt-response path, after the kernel has had the chance to
 * write the fenced state.
 */
export class KernelTerminalStateStore {
  readonly #directory: string | undefined;
  readonly #startedAt = new Map<string, number>();
  readonly #lastSequence = new Map<string, number>();

  constructor(directory?: string) {
    this.#directory = directory && directory.trim().length > 0 ? directory : undefined;
  }

  get enabled(): boolean {
    return this.#directory !== undefined;
  }

  beginTurn(sessionId: string, startedAt: number): void {
    this.#startedAt.set(sessionId, startedAt);
    this.#remove(sessionId);
  }

  read(sessionId: string): KernelTerminalState | undefined {
    const directory = this.#directory;
    const startedAt = this.#startedAt.get(sessionId);
    if (directory === undefined || startedAt === undefined) return undefined;
    let value: unknown;
    try {
      const raw = readFileSync(kernelTerminalStatePath(directory, sessionId), "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) {
        this.#remove(sessionId);
        return undefined;
      }
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const state = parseKernelTerminalState(value, sessionId);
    if (
      state === undefined ||
      state.writtenAt < startedAt ||
      state.writtenAt > Date.now() + FUTURE_CLOCK_TOLERANCE_MS ||
      state.sequence <= (this.#lastSequence.get(sessionId) ?? 0)
    ) {
      this.#remove(sessionId);
      return undefined;
    }
    this.#lastSequence.set(sessionId, state.sequence);
    this.#remove(sessionId);
    return state;
  }

  finishTurn(sessionId: string): void {
    this.#startedAt.delete(sessionId);
    this.#remove(sessionId);
  }

  cancel(sessionId: string): void {
    this.#startedAt.delete(sessionId);
    this.#remove(sessionId);
  }

  forget(sessionId: string): void {
    this.#startedAt.delete(sessionId);
    this.#remove(sessionId);
  }

  clear(): void {
    this.#startedAt.clear();
    this.#lastSequence.clear();
  }

  #remove(sessionId: string): void {
    if (this.#directory === undefined) return;
    try {
      unlinkSync(kernelTerminalStatePath(this.#directory, sessionId));
    } catch {
      // Missing or already-consumed state is the normal success path.
    }
  }
}
