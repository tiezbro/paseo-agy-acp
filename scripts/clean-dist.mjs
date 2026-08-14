import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const target = path.resolve(root, "dist");

if (path.dirname(target) !== root || path.basename(target) !== "dist") {
  throw new Error("refusing to clean an unexpected build directory");
}

rmSync(target, { recursive: true, force: true });
