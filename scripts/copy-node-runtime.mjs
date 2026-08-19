import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(root, "apps/runtime/dist");
const executableName = process.platform === "win32" ? "agentflow-node.exe" : "agentflow-node";
const output = resolve(outputDirectory, executableName);

mkdirSync(outputDirectory, { recursive: true });
copyFileSync(process.execPath, output);
if (process.platform !== "win32") chmodSync(output, 0o755);
console.log(`Bundled Node runtime: ${output}`);
