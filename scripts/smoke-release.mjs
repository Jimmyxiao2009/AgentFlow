import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  process.platform === "win32" ? "agentflow-desktop.exe" : "agentflow-desktop",
);
if (!existsSync(executable)) throw new Error(`Release executable is missing: ${executable}`);

const bundleRoot = path.join(root, "apps", "desktop", "src-tauri", "target", "release", "bundle");
const bundleRequirements =
  process.platform === "win32"
    ? [
        [
          "MSI",
          path.join(bundleRoot, "msi"),
          (name, isDirectory) => !isDirectory && name.endsWith(".msi"),
        ],
        [
          "NSIS",
          path.join(bundleRoot, "nsis"),
          (name, isDirectory) => !isDirectory && name.endsWith(".exe"),
        ],
      ]
    : process.platform === "darwin"
      ? [
          [
            "macOS app",
            path.join(bundleRoot, "macos"),
            (name, isDirectory) => isDirectory && name.endsWith(".app"),
          ],
          [
            "DMG",
            path.join(bundleRoot, "dmg"),
            (name, isDirectory) => !isDirectory && name.endsWith(".dmg"),
          ],
        ]
      : [
          [
            "AppImage",
            path.join(bundleRoot, "appimage"),
            (name, isDirectory) => !isDirectory && name.endsWith(".AppImage"),
          ],
          [
            "Deb",
            path.join(bundleRoot, "deb"),
            (name, isDirectory) => !isDirectory && name.endsWith(".deb"),
          ],
        ];

function hasBundle(rootDirectory, matcher) {
  if (!existsSync(rootDirectory)) return false;
  return readdirSync(rootDirectory, { withFileTypes: true }).some((entry) => {
    if (matcher(entry.name, entry.isDirectory())) return true;
    return entry.isDirectory() && hasBundle(path.join(rootDirectory, entry.name), matcher);
  });
}

for (const [label, directory, matcher] of bundleRequirements) {
  if (!hasBundle(directory, matcher))
    throw new Error(`${label} bundle is missing under ${directory}`);
}

const dataDirectory = mkdtempSync(path.join(tmpdir(), "agentflow-release-smoke-"));
const useXvfb = process.platform === "linux" && process.env.CI === "true";
const command = useXvfb ? "xvfb-run" : executable;
const args = useXvfb ? ["-a", executable] : [];
const child = spawn(command, args, {
  cwd: root,
  env: { ...process.env, AGENTFLOW_AUTO_PROBE: "0", AGENTFLOW_DATA_DIR: dataDirectory },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  detached: process.platform !== "win32",
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const closed = new Promise((resolve) =>
  child.once("close", (code, signal) => resolve({ code, signal })),
);
const earlyExit = await Promise.race([
  closed,
  new Promise((resolve) => setTimeout(() => resolve(undefined), 8_000)),
]);
if (earlyExit)
  throw new Error(
    `Release process exited before smoke window: ${JSON.stringify(earlyExit)}\n${output}`,
  );

if (process.platform === "win32" && child.pid) {
  spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
} else if (child.pid) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}
await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
if (!child.killed && child.exitCode === null) {
  if (process.platform === "win32" && child.pid)
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  else child.kill("SIGKILL");
}
child.stdout?.destroy();
child.stderr?.destroy();
rmSync(dataDirectory, { recursive: true, force: true });
console.log(`Release smoke passed: ${path.basename(executable)}`);
process.exit(0);
