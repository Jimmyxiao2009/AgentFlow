import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

const root = process.cwd();
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "agentflow-perf-"));
const repository = path.join(fixtureRoot, "repo");
mkdirSync(repository, { recursive: true });
writeFileSync(path.join(repository, "README.md"), "performance fixture\n");
const git = (args) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
git(["init", "-q"]);
git(["config", "user.name", "AgentFlow Performance"]);
git(["config", "user.email", "performance@example.invalid"]);
git(["add", "."]);
git(["commit", "-qm", "fixture"]);

const child = spawn(process.execPath, [path.resolve(root, "apps/runtime/dist/main.js")], {
  cwd: root,
  env: {
    ...process.env,
    AGENTFLOW_AUTO_PROBE: "0",
    AGENTFLOW_USE_FAKE_ADAPTER: "1",
    AGENTFLOW_DATA_DIR: path.join(fixtureRoot, "data"),
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const responses = new Map();
const events = [];
const startedAt = performance.now();
let readyAt;
const input = readline.createInterface({ input: child.stdout });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "runtime.ready") readyAt = performance.now();
  if (message.kind === "event") events.push(message.event);
  if (message.id && responses.has(message.id)) {
    responses.get(message.id)(message);
    responses.delete(message.id);
  }
});
const request = (method, payload) =>
  new Promise((resolve) => {
    const id = `${method}-${crypto.randomUUID()}`;
    responses.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, protocolVersion: 1, method, payload })}\n`);
  });
const waitReady = async () => {
  while (readyAt === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
};
const workingSetBytes = () => {
  if (process.platform !== "win32" || !child.pid) return undefined;
  try {
    return Number(
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Process -Id ${child.pid}).WorkingSet64`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim(),
    );
  } catch {
    return undefined;
  }
};

try {
  await waitReady();
  const idleMemoryBytes = workingSetBytes();
  const statusStart = performance.now();
  await request("runtime.status", {});
  const statusMs = performance.now() - statusStart;
  const opened = await request("project.open", { repositoryPath: repository });
  const conversation = await request("conversation.create", {
    projectId: opened.result.id,
    title: "Performance fixture",
    mode: "Ask",
  });
  const streamStart = performance.now();
  let firstDeltaMs;
  const firstDelta = new Promise((resolve) => {
    const timer = globalThis.setInterval(() => {
      const event = events.find((candidate) => candidate.type === "message.delta");
      if (event) {
        globalThis.clearInterval(timer);
        firstDeltaMs = performance.now() - streamStart;
        resolve(event);
      }
    }, 2);
  });
  const response = request("message.send", {
    conversationId: conversation.result.id,
    text: "measure streaming latency",
    mode: "Ask",
  });
  await firstDelta;
  await response;
  const activeMemoryBytes = workingSetBytes();
  const artifactId = `artifact-perf-${crypto.randomUUID()}`;
  const database = new Database(path.join(fixtureRoot, "data", "agentflow.db"));
  database
    .prepare(
      "INSERT INTO artifacts(id, kind, content, content_type, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      artifactId,
      "diff",
      `diff --git a/large.txt b/large.txt\n${"+large diff line\n".repeat(300_000)}`,
      "text/x-diff",
      new Date().toISOString(),
    );
  database.close();
  const largeDiffStart = performance.now();
  const largeDiff = await request("artifact.read", { artifactId });
  const largeDiffMs = performance.now() - largeDiffStart;
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        measuredAt: new Date().toISOString(),
        runtimeReadyMs: Number((readyAt - startedAt).toFixed(1)),
        runtimeStatusMs: Number(statusMs.toFixed(1)),
        firstStreamDeltaMs: Number(firstDeltaMs.toFixed(1)),
        largeDiffLoadMs: Number(largeDiffMs.toFixed(1)),
        largeDiffBytes: Buffer.byteLength(largeDiff.result.content, "utf8"),
        idleMemoryMiB:
          idleMemoryBytes === undefined
            ? undefined
            : Number((idleMemoryBytes / 1024 / 1024).toFixed(1)),
        activeMemoryMiB:
          activeMemoryBytes === undefined
            ? undefined
            : Number((activeMemoryBytes / 1024 / 1024).toFixed(1)),
        eventCount: events.length,
        note: "Sidecar/runtime baseline; signed Tauri frame profiles remain platform-specific. Renderer benchmark is recorded in docs/performance.md.",
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  rmSync(fixtureRoot, { recursive: true, force: true });
}
