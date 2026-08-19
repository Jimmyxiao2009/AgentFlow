import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it } from "vitest";

type RuntimeMessage = {
  type?: string;
  id?: string;
  ok?: boolean;
  result?: { id?: string; projects?: Array<{ id: string }>; settings?: { locale?: string } };
  error?: { code?: string };
};

async function startRuntime(dataDirectory: string): Promise<{
  child: ChildProcess;
  request: (method: string, payload: unknown) => Promise<RuntimeMessage>;
  ready: Promise<void>;
}> {
  const child = spawn(process.execPath, [path.resolve("apps/runtime/dist/main.js")], {
    cwd: process.cwd(),
    env: { ...process.env, AGENTFLOW_DATA_DIR: dataDirectory, AGENTFLOW_AUTO_PROBE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map<string, (value: RuntimeMessage) => void>();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const input = readline.createInterface({ input: child.stdout });
  input.on("line", (line) => {
    const message = JSON.parse(line) as RuntimeMessage;
    if (message.type === "runtime.ready") resolveReady();
    if (message.id && responses.has(message.id)) {
      responses.get(message.id)!(message);
      responses.delete(message.id);
    }
  });
  child.once("error", rejectReady);
  const request = (method: string, payload: unknown) =>
    new Promise<RuntimeMessage>((resolve) => {
      const id = `${method}-${crypto.randomUUID()}`;
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, protocolVersion: 1, method, payload })}\n`);
    });
  return { child, request, ready };
}

async function closeRuntime(child: ChildProcess, force = false): Promise<void> {
  if (force) {
    child.kill();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    return;
  }
  child.stdin.end();
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

describe("runtime crash and restart recovery", () => {
  it("reconstructs durable projects and settings after a sidecar crash", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentflow-runtime-restart-"));
    const repository = path.join(root, "repo");
    const dataDirectory = path.join(root, "data");
    mkdirSync(repository, { recursive: true });
    writeFileSync(path.join(repository, "README.md"), "fixture\n");
    const git = (args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "user.name", "AgentFlow Restart Test"]);
    git(["config", "user.email", "restart@example.invalid"]);
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);

    const first = await startRuntime(dataDirectory);
    try {
      await first.ready;
      const opened = await first.request("project.open", { repositoryPath: repository });
      expect(opened.ok).toBe(true);
      const saved = await first.request("settings.save", {
        settings: {
          schemaVersion: 1,
          theme: "Light",
          accent: "Blue",
          locale: "zh-CN",
          defaultProjectDirectory: repository,
          workerCount: 2,
          requireIndependentReviewer: true,
          requireApprovalNetwork: true,
          requireApprovalPackages: true,
          retentionDays: 30,
        },
      });
      expect(saved).toMatchObject({ ok: true, result: { locale: "zh-CN" } });
    } finally {
      await closeRuntime(first.child, true);
    }

    const second = await startRuntime(dataDirectory);
    try {
      await second.ready;
      const status = await second.request("runtime.status", {});
      expect(status).toMatchObject({
        ok: true,
        result: {
          projects: [{ id: expect.any(String) }],
          settings: { locale: "zh-CN", defaultProjectDirectory: repository },
        },
      });
    } finally {
      await closeRuntime(second.child);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
