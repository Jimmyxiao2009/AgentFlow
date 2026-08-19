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

  it("does not retry removing an already-released worktree on every restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-released-worktree-"));
    const dataDirectory = join(root, "data");
    const first = new AgentFlowApplication({ dataDirectory });
    first.store.saveProjection("project:p1", 1, {
      id: "p1",
      name: "demo",
      // Deliberately not a Git repository, so an attempted `git worktree
      // remove` here fails loudly instead of silently no-op'ing.
      repositoryPath: root,
      defaultBranch: "main",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    first.store.saveProjection("workspace:w1", 1, {
      id: "w1",
      projectId: "p1",
      changeRequestId: "cr1",
      taskId: "t1",
      path: join(root, "already-removed-worktree"),
      branch: "agentflow/cr1/TASK-001/run1",
      baseCommit: "0000000000000000000000000000000000000000",
      status: "Released",
    });
    first.close();
    const second = new AgentFlowApplication({ dataDirectory });
    const result = await second.cleanupOrphanedWorktrees();
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
    second.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("application settings security", () => {
  it("redacts provider API keys from the audit log when settings are saved", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-settings-audit-"));
    const app = new AgentFlowApplication({ dataDirectory: root });
    const secret = "sk-test-supersecret-key-1234567890";
    app.saveSettings({
      settings: {
        schemaVersion: 2,
        theme: "Dark",
        accent: "Blue",
        locale: "en-US",
        workerCount: 2,
        restoreWorkspace: true,
        confirmClose: true,
        autoProbe: false,
        manualModels: [],
        aiProviders: [
          { id: "p1", name: "Test Provider", endpoint: "https://example.com/v1", apiKey: secret },
        ],
        recentLimit: "10",
        defaultProjectDirectory: "",
        editor: "VS Code",
        density: "Comfortable",
        uiTextSize: "Default",
        codeTextSize: "13",
        timestampFormat: "Relative",
        retries: "1",
        planApproval: "Always ask",
        blockOnFailingValidation: true,
        requireIndependentReviewer: true,
        integrationPolicy: "Manual",
        concurrencyLimit: "2",
        allowRiskOverrides: false,
        requireApprovalNetwork: true,
        requireApprovalPackages: true,
        customPermissionDimensions: {
          readPaths: ["**/*"],
          writePaths: [],
          protectedPaths: [".git", ".env", ".ssh", "main", "master"],
          commands: ["git status", "git diff", "git log", "git show"],
          network: false,
          packageInstall: false,
          dependencyChanges: false,
          projectFileChanges: false,
          externalProcesses: false,
          environmentAccess: "none",
          secretAccess: false,
          clipboard: false,
          browser: false,
          externalDirectories: false,
          remoteGit: false,
        },
        pushPolicy: "Ask each time",
        inAppNotif: true,
        systemNotif: true,
        soundNotif: false,
        notifPlanApproval: true,
        notifAgentFailure: true,
        notifBlockedTask: true,
        notifReviewComplete: true,
        notifValidationComplete: false,
        notifIntegrationReady: true,
        retentionDays: 30,
        reducedMotion: false,
        highContrastFocus: false,
        screenReaderAnnouncements: true,
      },
    });
    // The audit trail must record that settings changed without retaining the
    // raw API key. Query the audit_events table directly (the sidecar's own
    // storage) to assert the secret never reached durable audit history.
    const auditRows = (
      app.store as unknown as {
        db: { prepare: (sql: string) => { all: () => Array<{ detail: string }> } };
      }
    ).db.prepare("SELECT detail FROM audit_events").all();
    const auditText = auditRows.map((row) => row.detail).join("\n");
    expect(auditText).not.toContain(secret);
    expect(auditText).toContain("[REDACTED]");
    // The live settings projection still holds the key for the sidecar's own use.
    expect(app.getSettings().aiProviders[0]?.apiKey).toBe(secret);
    app.close();
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

  it("still denies a permanently-denied request even when a human clicks allow", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-permanent-deny-"));
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
        // A Custom profile requesting exactly its own upper-bound dimensions
        // never "exceeds" the profile-dimension check on its own -- only the
        // v1 permanent-denial rule (isPermanentlyDenied) can catch this.
        approvalRequested: "Custom",
        approvalRaw: { command: "git push --force origin main" },
      }),
      eventSink: (event) => {
        if (event.type === "approval.requested") resolveApprovalEvent(event);
      },
    });
    try {
      app.saveSettings({
        settings: {
          customPermissionDimensions: {
            readPaths: ["**/*"],
            writePaths: ["docs/**"],
            protectedPaths: [".git", ".env", ".ssh", "main", "master"],
            commands: ["git status", "git diff", "git log", "git show"],
            network: false,
            packageInstall: false,
            dependencyChanges: false,
            projectFileChanges: false,
            externalProcesses: false,
            environmentAccess: "none",
            secretAccess: false,
            clipboard: false,
            browser: false,
            externalDirectories: false,
            remoteGit: true,
          },
        },
      });
      const project = await app.openProject({ repositoryPath: repository });
      const conversation = app.createConversation({
        projectId: project.id,
        title: "Permanent deny test",
        mode: "Plan",
      });
      const plan = await app.sendMessage({
        conversationId: conversation.id,
        text: "Implement something",
        mode: "Plan",
      });
      app.approvePlan({ changeRequestId: plan.changeRequestId, action: "approve-and-run" });
      const task = app
        .status()
        .tasks.find(
          (item) => item.key === "TASK-001" && item.changeRequestId === plan.changeRequestId,
        )!;
      const run = app
        .runTask({ taskId: task.id, permissionProfile: "Custom" })
        .catch((error: unknown) => error);
      const event = (await approval) as { payload: { requestId: string } };
      const requestId = event.payload.requestId;
      const request = app.status().permissions.find((item) => item.id === requestId);
      // The Custom profile granted remoteGit itself, so nothing about this
      // request's dimensions exceeds its own upper bound -- without the
      // isPermanentlyDenied() check, "allow-once" below would succeed.
      expect(request?.requested.remoteGit).toBe(true);
      await app.resolvePermission({ requestId, decision: "allow-once" });
      const result = await run;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("Permission denied");
      expect(app.status().permissions.find((item) => item.id === requestId)?.status).toBe(
        "Denied",
      );
    } finally {
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
