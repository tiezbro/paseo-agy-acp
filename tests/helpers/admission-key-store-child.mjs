import { pathToFileURL } from "node:url";

const [modulePath, stateDir, waitForStart] = process.argv.slice(2);
if (!modulePath || !stateDir) {
  throw new Error("usage: admission-key-store-child.mjs <module-path> <state-dir> [wait]");
}

if (waitForStart === "wait") {
  process.stdout.write("ready\n");
  await new Promise((resolve) => {
    process.stdin.once("data", resolve);
    process.stdin.resume();
  });
}

const { loadOrCreateAdmissionKey } = await import(pathToFileURL(modulePath).href);
const key = loadOrCreateAdmissionKey(stateDir);
process.stdout.write(`${JSON.stringify({ key: key.toString("hex") })}\n`);
