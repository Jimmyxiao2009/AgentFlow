import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const suspicious = [
  /-----BEGIN [^-\n]+ PRIVATE KEY-----/i,
  /\b(?:sk|ghp|xox[baprs])-[-_A-Za-z0-9]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i,
];
const excludedDirectories = new Set([
  ".git",
  ".agentflow-data",
  "node_modules",
  ".pnpm-store",
  ".kun-canvas",
  "dist",
  "target",
  "smoke-bundled-data-2",
  "smoke-bundled-data-3",
  "smoke-bundled-data-4",
]);
const files = [];
const visit = (directory, prefix = "") => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) visit(path.join(directory, entry.name), relative);
    } else files.push(relative);
  }
};
visit(root);
const findings = [];
for (const relative of files) {
  // Test fixtures legitimately contain fake credential-shaped strings to
  // exercise redaction; they are not real secrets. Skip test files so the
  // scan reports only production-source exposures.
  if (/\.(?:test|spec)\.[a-z]+$/i.test(relative)) continue;
  let content;
  try {
    content = readFileSync(path.join(root, relative), "utf8");
  } catch {
    continue;
  }
  if (suspicious.some((pattern) => pattern.test(content))) findings.push(relative);
}
if (findings.length) {
  console.error(`Potential secrets found in tracked files:\n${findings.join("\n")}`);
  process.exitCode = 1;
} else console.log(`Secret scan passed (${files.length} workspace files)`);
