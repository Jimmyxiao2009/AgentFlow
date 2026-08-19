import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "@agentflow/adapter-fake";
import { AgentFlowApplication } from "./index.js";

describe("application recovery", () => {
  it("reloads durable project projections after a restart", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-app-"));
    const first = new AgentFlowApplication({ dataDirectory: root });
    first.store.saveProjection("project:p1", 1, {
      id: "p1",
      name: "demo",
      repositoryPath: "C:/demo",
      defaultBranch: "main",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    first.saveSettings({
      settings: {
        schemaVersion: 1,
        theme: "Light",
        accent: "Purple",
        locale: "zh-CN",
        workerCount: 4,
        requireIndependentReviewer: true,
        requireApprovalNetwork: true,
        requireApprovalPackages: true,
        retentionDays: 60,
      },
    });
    first.store.saveProjection("session:s1", 1, {
      id: "s1",
      conversationId: "c1",
      adapterId: "fake",
      role: "Investigator",
      state: "Running",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    first.store.saveProjection("run:r1", 1, {
      id: "r1",
      sessionId: "s1",
      conversationId: "c1",
      role: "Investigator",
      state: "Running",
      attempt: 1,
      startedAt: "2025-01-01T00:00:00.000Z",
    });
    first.close();
    const second = new AgentFlowApplication({ dataDirectory: root });
    expect(second.status().projects[0]?.id).toBe("p1");
    expect(second.status().runs.find((run) => run.id === "r1")?.state).toBe("Failed");
    expect(second.status().settings).toMatchObject({
      theme: "Light",
      locale: "zh-CN",
      workerCount: 4,
    });
    second.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("application permissions", () => {
  it("keeps manually configured models explicit and unverified", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-manual-model-"));
    const app = new AgentFlowApplication({
      dataDirectory: root,
      fakeAdapter: new FakeAdapter({ delayMs: 0 }),
    });
    try {
      app.saveSettings({
        settings: {
          manualModels: [
            {
              adapterId: "fake",
              providerId: "fixture",
              modelId: "manual-provider-model",
              name: "Manual provider model",
            },
          ],
        },
      });
      await app.probeProfiles();
      expect(app.status().models).toContainEqual(
        expect.objectContaining({
          adapterId: "fake",
          providerModelId: "manual-provider-model",
          name: "Manual provider model",
          verified: false,
          cliDefault: false,
        }),
      );
    } finally {
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pauses a run until the structured permission request is resolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-permission-"));
    const repository = join(root, "repo");
    const dataDirectory = join(root, "data");
    execFileSync("git", ["init", "-q", repository]);
    execFileSync("git", ["-C", repository, "config", "user.email", "fixture@example.invalid"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "AgentFlow Fixture"]);
    writeFileSync(join(repository, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "fixture"]);
    let resolveApprovalEvent!: (event: unknown) => void;
    const approval = new Promise<unknown>((resolve) => {
      resolveApprovalEvent = resolve;
    });
    const app = new AgentFlowApplication({
      dataDirectory,
      fakeAdapter: new FakeAdapter({
        delayMs: 0,
        requestApproval: true,
        approvalRequested: "Read Only",
      }),
      eventSink: (event) => {
        if (event.type === "approval.requested") resolveApprovalEvent(event);
      },
    });
    try {
      const project = await app.openProject({ repositoryPath: repository });
      const conversation = app.createConversation({
        projectId: project.id,
        title: "Permission test",
        mode: "Ask",
      });
      const run = app.sendMessage({
        conversationId: conversation.id,
        text: "Inspect the repository",
        mode: "Ask",
      });
      const event = (await approval) as { payload: { requestId: string } };
      const requestId = event.payload.requestId;
      expect(app.status().permissions.find((request) => request.id === requestId)?.status).toBe(
        "Pending",
      );
      await app.resolvePermission({ requestId, decision: "allow-once" });
      const result = await run;
      expect(result.runId).toBeTruthy();
      expect(app.status().permissions.find((request) => request.id === requestId)?.status).toBe(
        "Allowed",
      );
    } finally {
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
