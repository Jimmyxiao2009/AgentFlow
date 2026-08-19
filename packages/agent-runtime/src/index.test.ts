import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentFlowStateStore,
  AuditTrail,
  BeliefGraph,
  CommanderWorkerRuntime,
  EpochBarrier,
  TaskGraph,
  checkScope,
  emptyStructuredState,
  evaluateOperation,
  futureSystemTransactionScope,
  leastPrivilegeCapability,
  protectControlPlane,
  validateWorkerResult,
  verifyIndependently,
} from "./index.js";

describe("agent runtime safety contracts", () => {
  it("enforces scope and least privilege", () => {
    const capability = leastPrivilegeCapability(["src/**/*.ts"]);
    expect(
      checkScope(
        {
          taskId: "t",
          allowedReadPaths: ["**/*"],
          allowedWritePaths: ["src/**/*.ts"],
          forbiddenPaths: [".git/**"],
          objective: "patch",
        },
        "write",
        "src/a.ts",
      ).allowed,
    ).toBe(true);
    expect(
      checkScope(
        {
          taskId: "t",
          allowedReadPaths: ["**/*"],
          allowedWritePaths: ["src/**/*.ts"],
          forbiddenPaths: [".git/**"],
          objective: "patch",
        },
        "write",
        ".git/config",
      ).allowed,
    ).toBe(false);
    expect(
      evaluateOperation({
        command: "npm install",
        workingDirectory: ".",
        capability,
        scope: {
          taskId: "t",
          allowedReadPaths: ["**/*"],
          allowedWritePaths: ["src/**/*.ts"],
          forbiddenPaths: [],
          objective: "patch",
        },
      }).outcome,
    ).toBe("deny");
  });
  it("blocks a literal forbidden name at any depth, not just at the root", () => {
    const scope = {
      taskId: "t",
      allowedReadPaths: ["**/*"],
      allowedWritePaths: ["**/*"],
      forbiddenPaths: [".env"],
      objective: "patch",
    };
    expect(checkScope(scope, "write", ".env").allowed).toBe(false);
    expect(checkScope(scope, "write", "server/.env").allowed).toBe(false);
  });
  it("keeps architecture changes behind proposal/barrier", () => {
    const barrier = new EpochBarrier(17);
    barrier.startWorker("w1");
    expect(barrier.deferProposal("p1")).toBe("deferred");
    barrier.beginBarrier();
    expect(barrier.snapshot().status).toBe("draining");
    barrier.finishWorker("w1");
    expect(barrier.snapshot().status).toBe("barrier");
    expect(barrier.closeAndAdvance().worldVersion).toBe(18);
  });
  it("requires evidence and independent verification", async () => {
    const result = {
      taskId: "t",
      runId: "w",
      status: "completed" as const,
      claim: "fixed",
      evidence: [{ id: "e", kind: "test" as const, summary: "pass", reproducible: true }],
      artifacts: [],
      filesRead: [],
      filesChanged: [],
      commandsRun: ["npm test"],
      tests: [{ name: "test", status: "passed" as const }],
      reproductionSteps: [],
      unresolved: [],
      assumptions: [],
      interfacesChanged: [],
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    };
    expect(() => validateWorkerResult(result)).not.toThrow();
    expect(
      (
        await verifyIndependently({
          worker: result,
          reproduce: async () => [
            { id: "ve", kind: "experiment", summary: "reproduced", reproducible: true },
          ],
        })
      ).status,
    ).toBe("confirmed");
  });
  it("supports task graph, audit, checkpoints and belief invalidation", () => {
    const graph = new TaskGraph();
    graph.add({ id: "a", dependencyIds: [], state: "completed" });
    graph.add({ id: "b", dependencyIds: ["a"], state: "pending" });
    expect(graph.ready().map((n) => n.id)).toEqual(["b"]);
    const audit = new AuditTrail();
    expect(
      audit.append({
        actor: "policy",
        action: "deny",
        target: "npm install",
        detail: "minimum privilege",
      }).id,
    ).toMatch(/^audit-/);
    expect(emptyStructuredState().version).toBe(1);
    const beliefs = new BeliefGraph();
    beliefs.addNode({ id: "claim", kind: "claim", status: "active" });
    beliefs.addNode({ id: "patch", kind: "patch", status: "active" });
    beliefs.addEdge({ from: "patch", to: "claim", relation: "depends_on" });
    expect(beliefs.invalidate("claim")).toEqual(["claim", "patch"]);
  });
  it("persists resumable state and isolates agent artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentflow-runtime-"));
    try {
      const store = new AgentFlowStateStore(root);
      const state = emptyStructuredState();
      state.activeTaskIds.push("task-1");
      await store.save("project-1", state);
      const loaded = await store.load();
      expect(loaded?.projectId).toBe("project-1");
      expect(loaded?.state.activeTaskIds).toEqual(["task-1"]);
      expect(await store.saveArtifact("worker-report.txt", "evidence")).toContain("artifacts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("dispatches workers through the epoch and records decisions", async () => {
    const graph = new TaskGraph();
    graph.add({ id: "task-1", dependencyIds: [], state: "pending" });
    const audit = new AuditTrail();
    const runtime = new CommanderWorkerRuntime(graph, new EpochBarrier(), audit);
    expect(runtime.plan()).toEqual([
      { taskId: "task-1", action: "dispatch", reason: "dependencies satisfied" },
    ]);
    const result = {
      taskId: "task-1",
      runId: "run-1",
      status: "completed" as const,
      claim: "done",
      evidence: [{ id: "e", kind: "test" as const, summary: "pass", reproducible: true }],
      artifacts: [],
      filesRead: [],
      filesChanged: [],
      commandsRun: ["npm test"],
      tests: [],
      reproductionSteps: [],
      unresolved: [],
      assumptions: [],
      interfacesChanged: [],
      confidence: 1,
      createdAt: new Date().toISOString(),
    };
    await expect(
      runtime.dispatch({
        taskId: "task-1",
        runId: "run-1",
        scope: {
          taskId: "task-1",
          allowedReadPaths: ["**/*"],
          allowedWritePaths: [],
          forbiddenPaths: [],
          objective: "test",
        },
        capability: leastPrivilegeCapability(),
        execute: async () => result,
      }),
    ).resolves.toEqual(result);
    expect(graph.get("task-1")?.state).toBe("completed");
    expect(audit.all()).toHaveLength(1);
  });
  it("denies control-plane mutations and keeps system transactions deferred", () => {
    expect(
      protectControlPlane({ name: "git", path: ".git", kind: "repository" }, "reset").outcome,
    ).toBe("deny");
    expect(futureSystemTransactionScope.status).toBe("deferred");
  });
});
