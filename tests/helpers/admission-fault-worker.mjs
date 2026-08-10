import path from "node:path";
import { pathToFileURL } from "node:url";

const [
  controllerModule,
  databasePath,
  requestId,
  leaseId,
  generationText,
  ownerInstanceId,
  childPidText,
  childStartTimeTicks
] = process.argv.slice(2);

if (
  !controllerModule ||
  !path.isAbsolute(controllerModule) ||
  !databasePath ||
  !path.isAbsolute(databasePath) ||
  !requestId ||
  !leaseId ||
  !generationText ||
  !ownerInstanceId ||
  !childPidText ||
  !childStartTimeTicks
) {
  throw new Error(
    "usage: admission-fault-worker.mjs <controller-module> <database> <request> <lease> <generation> <owner> <child-pid> <child-start-ticks>"
  );
}

const generation = Number(generationText);
const childPid = Number(childPidText);
if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(childPid) || childPid < 1) {
  throw new Error("worker fence or process identity is invalid");
}

const { AdmissionController } = await import(pathToFileURL(controllerModule).href);
const controller = new AdmissionController({
  databasePath,
  policy: {
    maxActiveTurns: 1,
    maxConcurrentStarts: 1,
    minStartIntervalMs: 0,
    queueTimeoutMs: 30 * 60_000,
    capacityCooldownMs: 30_000
  },
  encryptionKey: Buffer.alloc(32, 31),
  contentFingerprintKey: Buffer.alloc(32, 32),
  claimTokenKey: Buffer.alloc(32, 33)
});

process.stdout.write("ready\n");
process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.includes("\n")) break;
}

if (input.trim() !== "go") throw new Error("worker start barrier was not released");

const result = controller.recordProcessIdentity({
  requestId,
  leaseId,
  generation,
  ownerInstanceId,
  processIdentity: {
    connector: {
      ownerInstanceId,
      createdAt: "2026-08-10T00:00:00.000Z",
      bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      pid: 7001,
      startTimeTicks: "900001",
      pidNamespaceInode: 4026533001,
      ppid: 7000,
      pgrp: 7001,
      session: 7001
    },
    child: {
      bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      pid: childPid,
      startTimeTicks: childStartTimeTicks,
      pidNamespaceInode: 4026533001,
      ppid: 7001,
      pgrp: childPid,
      session: childPid
    }
  },
  promptChannel: "stdin"
});

controller.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
