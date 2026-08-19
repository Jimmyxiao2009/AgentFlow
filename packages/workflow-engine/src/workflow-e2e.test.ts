import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "@agentflow/adapter-fake";
import type { AgentRun, AgentSession, Task, WorkflowEvent } from "@agentflow/domain";
import { WorktreeManager, git } from "@agentflow/git";
import { createImmutablePatchSet, IntegrationService, WorkflowOrchestrator } from "./index.js";

describe("isolated worker vertical slice", () => {
  it("creates a worktree, commits the actual diff, and emits an immutable PatchSet", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-e2e-"));
    const repository = join(root, "repo");
    const dataRoot = join(root, "data");
    mkdirSync(repository, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(repository, "README.md"), "fixture\n");
    const gitRun = (args: string[]) =>
      execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    gitRun(["init", "-q"]);
    gitRun(["config", "user.name", "AgentFlow Fixture"]);
    gitRun(["config", "user.email", "fixture@example.invalid"]);
    gitRun(["add", "README.md"]);
    gitRun(["commit", "-qm", "fixture"]);
    const base = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const manager = new WorktreeManager({ dataRoot });
    const events: WorkflowEvent[] = [];
    const task: Task = {
      id: "task-1",
      changeRequestId: "cr-1",
      key: "TASK-001",
      title: "Fixture write",
      state: "Running",
      contract: {
        objective: "write fixture",
        dependencies: [],
        allowedReadPaths: ["**/*"],
        allowedWritePaths: ["agentflow-result.txt"],
        forbiddenPaths: [".git"],
        requiredCapabilities: ["worktree"],
        acceptanceCriteria: ["file exists"],
        requiredValidationCommands: [],
        preferredExecutorRoles: ["Worker"],
        riskLevel: "Low",
      },
      dependencyIds: [],
      patchSetIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: AgentRun = {
      id: "run-1",
      sessionId: "session-1",
      conversationId: "conversation-1",
      taskId: task.id,
      role: "Worker",
      state: "Running",
      attempt: 1,
    };
    const session: AgentSession = {
      id: "session-1",
      conversationId: run.conversationId,
      taskId: task.id,
      adapterId: "fake",
      role: "Worker",
      state: "Running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const workspace = await manager.create(repository, {
      id: "workspace-1",
      projectId: "project-1",
      changeRequestId: "cr-1",
      taskId: task.id,
      branch: "agentflow/fixture-task",
      baseCommit: base,
      taskKey: task.key,
      runId: run.id,
    });
    const adapter = new FakeAdapter({
      delayMs: 0,
      writeFiles: [
        { path: "agentflow-result.txt", content: "created inside the worker worktree\n" },
      ],
    });
    await adapter.startSession(
      {
        sessionId: session.id,
        conversationId: session.conversationId,
        taskId: task.id,
        role: "Worker",
        workspacePath: workspace.path,
        profile: { id: "fixture", name: "Fake", adapterId: "fake", status: "Ready" },
        permissionProfile: "Workspace Write",
      },
      new AbortController().signal,
    );
    const orchestrator = new WorkflowOrchestrator(manager, {
      append: (event) => {
        events.push(event);
      },
    });
    const result = await orchestrator.execute(
      adapter,
      { task, run, session, workspace },
      {
        prompt: task.contract.objective,
        mode: "Implement",
        permissionProfile: "Workspace Write",
      },
      new AbortController().signal,
    );
    expect(result.patchSet?.resultCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.patchSet?.changedFiles).toContain("agentflow-result.txt");
    expect(events.some((event) => event.type === "patchset.created")).toBe(true);
    await manager.remove(repository, workspace.path);
    rmSync(root, { recursive: true, force: true });
  });

  it("aborts integration conflicts and permits a clean retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-integration-recovery-"));
    const repository = join(root, "repo");
    const integrationPath = join(root, "integration");
    mkdirSync(repository, { recursive: true });
    writeFileSync(join(repository, "conflict.txt"), "base\n");
    const gitRun = (cwd: string, args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore" });
    gitRun(repository, ["init", "-q"]);
    gitRun(repository, ["config", "user.name", "AgentFlow Fixture"]);
    gitRun(repository, ["config", "user.email", "fixture@example.invalid"]);
    gitRun(repository, ["add", "."]);
    gitRun(repository, ["commit", "-qm", "base"]);
    const base = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
    gitRun(repository, ["checkout", "-q", "-b", "fixture-patch"]);
    writeFileSync(join(repository, "conflict.txt"), "patch\n");
    gitRun(repository, ["commit", "-qam", "patch"]);
    const patchCommit = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
    gitRun(repository, ["checkout", "-q", "--detach", base]);
    gitRun(repository, [
      "worktree",
      "add",
      "-q",
      "-b",
      "fixture-integration",
      integrationPath,
      base,
    ]);
    writeFileSync(join(integrationPath, "conflict.txt"), "integration\n");
    gitRun(integrationPath, ["commit", "-qam", "integration"]);
    const service = new IntegrationService();
    const patchSet = createImmutablePatchSet({
      id: "patch-conflict",
      taskId: "task-conflict",
      sequence: 1,
      baseCommit: base,
      resultCommit: patchCommit,
      changedFiles: ["conflict.txt"],
      diffArtifactId: "artifact-conflict",
      validationRunIds: [],
      producingRunId: "run-conflict",
      createdAt: new Date().toISOString(),
      reviewState: "Approved",
    });
    try {
      const conflict = await service.applyApprovedPatchSets(integrationPath, [patchSet]);
      expect(conflict.status).toBe("Conflict");
      expect(conflict.conflictingFiles).toContain("conflict.txt");
      gitRun(integrationPath, ["reset", "--hard", base]);
      const retry = await service.applyApprovedPatchSets(integrationPath, [patchSet]);
      expect(retry.status).toBe("Completed");
      expect(retry.commit).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      gitRun(repository, ["worktree", "remove", "--force", integrationPath]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks a forbidden path even when it is nested under an allowed directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-forbidden-nested-"));
    const repository = join(root, "repo");
    const dataRoot = join(root, "data");
    mkdirSync(repository, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(repository, "README.md"), "fixture\n");
    const gitRun = (args: string[]) =>
      execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    gitRun(["init", "-q"]);
    gitRun(["config", "user.name", "AgentFlow Fixture"]);
    gitRun(["config", "user.email", "fixture@example.invalid"]);
    gitRun(["add", "README.md"]);
    gitRun(["commit", "-qm", "fixture"]);
    const base = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const manager = new WorktreeManager({ dataRoot });
    const task: Task = {
      id: "task-forbidden",
      changeRequestId: "cr-forbidden",
      key: "TASK-001",
      title: "Fixture write",
      state: "Running",
      contract: {
        objective: "write fixture",
        dependencies: [],
        allowedReadPaths: ["**/*"],
        allowedWritePaths: ["**/*"],
        forbiddenPaths: [".env"],
        requiredCapabilities: ["worktree"],
        acceptanceCriteria: ["file exists"],
        requiredValidationCommands: [],
        preferredExecutorRoles: ["Worker"],
        riskLevel: "Low",
      },
      dependencyIds: [],
      patchSetIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: AgentRun = {
      id: "run-forbidden",
      sessionId: "session-forbidden",
      conversationId: "conversation-forbidden",
      taskId: task.id,
      role: "Worker",
      state: "Running",
      attempt: 1,
    };
    const session: AgentSession = {
      id: "session-forbidden",
      conversationId: run.conversationId,
      taskId: task.id,
      adapterId: "fake",
      role: "Worker",
      state: "Running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const workspace = await manager.create(repository, {
      id: "workspace-forbidden",
      projectId: "project-forbidden",
      changeRequestId: "cr-forbidden",
      taskId: task.id,
      branch: "agentflow/fixture-forbidden",
      baseCommit: base,
      taskKey: task.key,
      runId: run.id,
    });
    // A worker nesting the forbidden filename one directory deeper must not
    // slip past the ".env" rule just because it isn't the literal root path.
    const adapter = new FakeAdapter({
      delayMs: 0,
      writeFiles: [{ path: "server/.env", content: "SECRET=leaked\n" }],
    });
    await adapter.startSession(
      {
        sessionId: session.id,
        conversationId: session.conversationId,
        taskId: task.id,
        role: "Worker",
        workspacePath: workspace.path,
        profile: { id: "fixture", name: "Fake", adapterId: "fake", status: "Ready" },
        permissionProfile: "Workspace Write",
      },
      new AbortController().signal,
    );
    const orchestrator = new WorkflowOrchestrator(manager, { append: () => {} });
    try {
      await expect(
        orchestrator.execute(
          adapter,
          { task, run, session, workspace },
          {
            prompt: task.contract.objective,
            mode: "Implement",
            permissionProfile: "Workspace Write",
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("PatchSet changed a path outside the task contract: server/.env");
    } finally {
      await manager.remove(repository, workspace.path);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let a sibling path escape an 'src/**' allowed-write rule", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-glob-boundary-"));
    const repository = join(root, "repo");
    const dataRoot = join(root, "data");
    mkdirSync(repository, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(join(repository, "README.md"), "fixture\n");
    const gitRun = (args: string[]) =>
      execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    gitRun(["init", "-q"]);
    gitRun(["config", "user.name", "AgentFlow Fixture"]);
    gitRun(["config", "user.email", "fixture@example.invalid"]);
    gitRun(["add", "README.md"]);
    gitRun(["commit", "-qm", "fixture"]);
    const base = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
    const manager = new WorktreeManager({ dataRoot });
    const task: Task = {
      id: "task-glob",
      changeRequestId: "cr-glob",
      key: "TASK-001",
      title: "Fixture write",
      state: "Running",
      contract: {
        objective: "write fixture",
        dependencies: [],
        allowedReadPaths: ["**/*"],
        // "src/**" must match src/foo.ts but NOT srcfoo/evil.ts — the previous
        // startsWith("src") prefix check accepted the unrelated sibling.
        allowedWritePaths: ["src/**"],
        forbiddenPaths: [".git"],
        requiredCapabilities: ["worktree"],
        acceptanceCriteria: ["file exists"],
        requiredValidationCommands: [],
        preferredExecutorRoles: ["Worker"],
        riskLevel: "Low",
      },
      dependencyIds: [],
      patchSetIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: AgentRun = {
      id: "run-glob",
      sessionId: "session-glob",
      conversationId: "conversation-glob",
      taskId: task.id,
      role: "Worker",
      state: "Running",
      attempt: 1,
    };
    const session: AgentSession = {
      id: "session-glob",
      conversationId: run.conversationId,
      taskId: task.id,
      adapterId: "fake",
      role: "Worker",
      state: "Running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const workspace = await manager.create(repository, {
      id: "workspace-glob",
      projectId: "project-glob",
      changeRequestId: "cr-glob",
      taskId: task.id,
      branch: "agentflow/fixture-glob",
      baseCommit: base,
      taskKey: task.key,
      runId: run.id,
    });
    // A worker writing to a path that merely starts with "src" (no path
    // separator) must be rejected as out of contract.
    const adapter = new FakeAdapter({
      delayMs: 0,
      writeFiles: [{ path: "srcfoo/evil.ts", content: "// escaped\n" }],
    });
    await adapter.startSession(
      {
        sessionId: session.id,
        conversationId: session.conversationId,
        taskId: task.id,
        role: "Worker",
        workspacePath: workspace.path,
        profile: { id: "fixture", name: "Fake", adapterId: "fake", status: "Ready" },
        permissionProfile: "Workspace Write",
      },
      new AbortController().signal,
    );
    const orchestrator = new WorkflowOrchestrator(manager, { append: () => {} });
    try {
      await expect(
        orchestrator.execute(
          adapter,
          { task, run, session, workspace },
          {
            prompt: task.contract.objective,
            mode: "Implement",
            permissionProfile: "Workspace Write",
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("PatchSet changed a path outside the task contract: srcfoo/evil.ts");
    } finally {
      await manager.remove(repository, workspace.path);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
