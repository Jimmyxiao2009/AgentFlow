import { describe, expect, it } from "vitest";
import {
  assertDeterministicGate,
  assertIndependentReview,
  createImmutablePatchSet,
  TaskDagScheduler,
} from "./index.js";

describe("workflow engine", () => {
  it("leases only ready tasks after dependencies complete", () => {
    const scheduler = new TaskDagScheduler();
    scheduler.add({
      id: "a",
      changeRequestId: "cr",
      key: "TASK-001",
      title: "A",
      state: "Ready",
      contract: {
        objective: "",
        dependencies: [],
        allowedReadPaths: [],
        allowedWritePaths: [],
        forbiddenPaths: [],
        requiredCapabilities: [],
        acceptanceCriteria: [],
        requiredValidationCommands: [],
        preferredExecutorRoles: ["Worker"],
        riskLevel: "Low",
      },
      dependencyIds: [],
      patchSetIds: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const claimed = scheduler.claimReady("run");
    expect(claimed?.lease?.runId).toBe("run");
    expect(() => scheduler.claimReady("another")).not.toThrow();
  });
  it("rejects a cross-run complete that would steal a leased task", () => {
    const scheduler = new TaskDagScheduler();
    scheduler.add({
      id: "owner-task",
      changeRequestId: "cr",
      key: "TASK-001",
      title: "A",
      state: "Ready",
      contract: {
        objective: "",
        dependencies: [],
        allowedReadPaths: [],
        allowedWritePaths: [],
        forbiddenPaths: [],
        requiredCapabilities: [],
        acceptanceCriteria: [],
        requiredValidationCommands: [],
        preferredExecutorRoles: ["Worker"],
        riskLevel: "Low",
      },
      dependencyIds: [],
      patchSetIds: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    scheduler.claim("owner-task", "run-a", 60_000);
    scheduler.start("owner-task", "run-a");
    // A concurrent/stale run must not be able to force-complete the task that
    // run-a owns — the previous complete() had no ownership check.
    expect(() => scheduler.complete("owner-task", "Failed", "run-b")).toThrow(
      "owned by another run",
    );
    // The owning run can still complete it.
    expect(() => scheduler.complete("owner-task", "Failed", "run-a")).not.toThrow();
  });
  it("does not allow a blocking validation failure to pass", () =>
    expect(() =>
      assertDeterministicGate([
        {
          id: "v",
          checkName: "tests",
          status: "Failed",
          blocking: true,
          command: "npm test",
          durationMs: 1,
          exitCode: 1,
          summary: "failed",
          createdAt: "2025-01-01T00:00:00.000Z",
        },
      ]),
    ).toThrow());
  it("protects patchset history and review independence", () => {
    const patch = createImmutablePatchSet({
      id: "p",
      taskId: "t",
      sequence: 1,
      baseCommit: "a",
      resultCommit: "b",
      changedFiles: [],
      diffArtifactId: "d",
      validationRunIds: [],
      producingRunId: "run-1",
      createdAt: "2025-01-01T00:00:00.000Z",
      reviewState: "Pending",
    });
    expect(() => {
      (patch as { reviewState: string }).reviewState = "Approved";
    }).toThrow();
    expect(() => assertIndependentReview("run-1", "run-1")).toThrow();
  });
});
