import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it } from "vitest";

describe("runtime sidecar boundary", () => {
  it("handshakes, streams, and rejects unknown methods", async () => {
    type RuntimeEvent = { type?: string; runId?: string };
    type RuntimeMessage = {
      type?: string;
      kind?: string;
      event?: RuntimeEvent;
      id?: string;
      ok?: boolean;
      result?: { id?: string; runId?: string; runs?: unknown[] };
      error?: { code?: string };
    };
    const root = mkdtempSync(path.join(tmpdir(), "agentflow-runtime-test-"));
    const repository = path.join(root, "repo");
    mkdirSync(repository, { recursive: true });
    writeFileSync(path.join(repository, "README.md"), "fixture\n");
    const git = (args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "user.name", "AgentFlow Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["add", "."]);
    git(["commit", "-qm", "fixture"]);
    const child = spawn(process.execPath, [path.resolve("apps/runtime/dist/main.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENTFLOW_DATA_DIR: path.join(root, "data"),
        AGENTFLOW_USE_FAKE_ADAPTER: "1",
        AGENTFLOW_FAKE_DELAY_MS: "20",
        AGENTFLOW_AUTO_PROBE: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = new Map<string, (value: RuntimeMessage) => void>();
    const events: RuntimeEvent[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      const input = readline.createInterface({ input: child.stdout });
      input.on("line", (line) => {
        const message = JSON.parse(line) as RuntimeMessage;
        if (message.type === "runtime.ready") resolve();
        if (message.kind === "event" && message.event) events.push(message.event);
        if (message.id && responses.has(message.id)) {
          responses.get(message.id)!(message);
          responses.delete(message.id);
        }
      });
      child.once("error", reject);
    });
    const request = (method: string, payload: unknown) =>
      new Promise<RuntimeMessage>((resolve) => {
        const id = `${method}-${crypto.randomUUID()}`;
        responses.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ id, protocolVersion: 1, method, payload })}\n`);
      });
    const waitForEvent = async (predicate: (event: RuntimeEvent) => boolean, fromIndex = 0) => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const match = events.slice(fromIndex).find(predicate);
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for runtime event");
    };
    try {
      await ready;
      const opened = await request("project.open", { repositoryPath: repository });
      const projectStatus = await request("project.status", { projectId: opened.result.id });
      expect(projectStatus).toMatchObject({
        ok: true,
        result: { projectId: opened.result.id, branch: expect.any(String), changedFiles: [] },
      });
      const conversation = await request("conversation.create", {
        projectId: opened.result.id,
        title: "Runtime test",
        mode: "Ask",
      });
      const message = await request("message.send", {
        conversationId: conversation.result.id,
        text: "hello",
        mode: "Ask",
      });
      const unknown = await request("unknown.method", {});
      expect(message.ok).toBe(true);
      expect(events.some((event) => event.type === "message.delta")).toBe(true);
      expect(events.some((event) => event.type === "message.completed")).toBe(true);
      const retried = await request("run.retry", { runId: message.result?.runId });
      expect(retried).toMatchObject({ ok: true, result: { runId: expect.any(String) } });
      const resumed = await request("run.resume", { runId: retried.result?.runId });
      expect(resumed).toMatchObject({ ok: true, result: { runId: expect.any(String) } });
      const slowEventStart = events.length;
      const slowMessage = request("message.send", {
        conversationId: conversation.result.id,
        text: "stop this run",
        mode: "Ask",
      });
      const started = await waitForEvent(
        (event) => event.type === "run.started" && typeof event.runId === "string",
        slowEventStart,
      );
      const stopped = await request("run.stop", { runId: started.runId });
      expect(stopped).toMatchObject({ ok: true, result: { stopped: true } });
      await expect(slowMessage).resolves.toMatchObject({
        ok: false,
        error: { code: "REQUEST_FAILED" },
      });
      await waitForEvent(
        (event) => event.type === "run.cancelled" && event.runId === started.runId,
      );
      const settings = await request("settings.get", {});
      expect(settings).toMatchObject({ ok: true, result: { schemaVersion: 2 } });
      const savedSettings = await request("settings.save", {
        settings: {
          schemaVersion: 1,
          theme: "Light",
          accent: "Cyan",
          locale: "zh-CN",
          workerCount: 3,
          requireIndependentReviewer: true,
          requireApprovalNetwork: true,
          requireApprovalPackages: true,
          retentionDays: 45,
        },
      });
      expect(savedSettings).toMatchObject({
        ok: true,
        result: { theme: "Light", locale: "zh-CN", workerCount: 3, retentionDays: 45 },
      });
      expect(unknown).toMatchObject({ ok: false, error: { code: "UNKNOWN_METHOD" } });
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
