import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "@agentflow/adapter-fake";
import { AgentFlowApplication } from "./index.js";

describe("application workflow chain", () => {
  it("runs Plan → PatchSet → validation → independent review → integration", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-application-e2e-"));
    const repository = join(root, "repo");
    const dataRoot = join(root, "data");
    mkdirSync(repository, { recursive: true });
    writeFileSync(
      join(repository, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          scripts: {
            test: 'node -e "process.exit(0)"',
            typecheck: 'node -e "process.exit(0)"',
            "format:check": 'node -e "process.exit(0)"',
            lint: 'node -e "process.exit(0)"',
            build: 'node -e "process.exit(0)"',
            "security:scan": 'node -e "process.exit(0)"',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(repository, "README.md"), "fixture\n");
    const runGit = (args: string[]) =>
      execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    runGit(["init", "-q"]);
    runGit(["config", "user.name", "AgentFlow Fixture"]);
    runGit(["config", "user.email", "fixture@example.invalid"]);
    runGit(["add", "."]);
    runGit(["commit", "-qm", "fixture"]);
    let emitReviewFinding = false;
    const app = new AgentFlowApplication({
      dataDirectory: dataRoot,
      fakeAdapter: new FakeAdapter({
        delayMs: 0,
        writeFiles: (request) =>
          request.prompt.includes("security") || request.prompt.includes("Define")
            ? [{ path: "docs/contract.md", content: "isolated\n" }]
            : request.prompt.includes("Implement")
              ? [{ path: "packages/worker-contract.ts", content: "isolated\n" }]
              : [{ path: "tests/restart-contract.test.ts", content: "isolated\n" }],
        reviewFindings: () =>
          emitReviewFinding
            ? [
                {
                  severity: "Blocking",
                  category: "security",
                  file: "docs/contract.md",
                  line: 1,
                  message: "Fixture review finding",
                  evidence: "The fixture intentionally requests one fix iteration.",
                },
              ]
            : [],
      }),
    });
    const project = await app.openProject({ repositoryPath: repository });
    const conversation = app.createConversation({
      projectId: project.id,
      title: "Workflow e2e",
      mode: "Plan",
    });
    const implicitPlanConversation = app.createConversation({
      projectId: project.id,
      title: "Implicit implementation plan",
      mode: "Implement",
    });
    const implicitPlan = await app.sendMessage({
      conversationId: implicitPlanConversation.id,
      text: "Implement with an automatically created plan",
      mode: "Implement",
    });
    expect(implicitPlan.specificationRevisionId).toBeTruthy();
    await expect(
      app.sendMessage({
        conversationId: implicitPlanConversation.id,
        text: "Review before validation",
        mode: "Review",
      }),
    ).rejects.toThrow("validated PatchSet");
    const plan = await app.sendMessage({
      conversationId: conversation.id,
      text: "Implement an isolated worker",
      mode: "Plan",
    });
    const plannedState = app.status();
    const plannedSpecification = plannedState.specifications.find(
      (specification) => specification.id === plan.specificationRevisionId,
    )!;
    expect(plannedSpecification.immutable).toBe(true);
    expect(plannedSpecification.taskDag).toHaveLength(3);
    expect(
      plannedState.structures.some(
        (structure) => structure.changeRequestId === plan.changeRequestId,
      ),
    ).toBe(true);
    expect(
      plannedState.decisions.some((decision) => decision.changeRequestId === plan.changeRequestId),
    ).toBe(true);
    app.approvePlan({ changeRequestId: plan.changeRequestId, action: "approve-and-run" });
    const approvedState = app.status();
    const approvedChangeRequest = approvedState.changeRequests.find(
      (changeRequest) => changeRequest.id === plan.changeRequestId,
    )!;
    expect(approvedChangeRequest.specificationRevisionId).not.toBe(plan.specificationRevisionId);
    expect(plannedSpecification.approvedAt).toBeUndefined();
    expect(
      approvedState.specifications.find(
        (specification) => specification.id === approvedChangeRequest.specificationRevisionId,
      )?.revision,
    ).toBe(2);
    const task = app
      .status()
      .tasks.find(
        (item) => item.key === "TASK-001" && item.changeRequestId === plan.changeRequestId,
      )!;
    await expect(app.runTask({ taskId: task.id, permissionProfile: "Read Only" })).rejects.toThrow(
      "cannot execute a task with write paths",
    );
    const implementation = await app.sendMessage({
      conversationId: conversation.id,
      text: "Implement the approved plan",
      mode: "Implement",
    });
    expect(implementation.text).toContain("Started");
    const initialExecutionRun = app
      .status()
      .runs.filter((run) => run.taskId === task.id)
      .at(-1)!;
    const retried = await app.retryRun({ runId: initialExecutionRun.id });
    expect(retried.runId).toBeTruthy();
    const resumed = await app.retryRun({ runId: retried.runId! }, true);
    expect(resumed.runId).toBeTruthy();
    const executionPatchSet = app
      .status()
      .patchSets.find((patchSet) => patchSet.taskId === task.id)!;
    expect(executionPatchSet.changedFiles).toContain("docs/contract.md");
    const diffArtifact = app.readArtifact({ artifactId: executionPatchSet.diffArtifactId });
    expect(diffArtifact.kind).toBe("diff");
    expect(diffArtifact.content).toContain("isolated");
    const validations = await app.runValidation({ patchSetId: executionPatchSet.id });
    expect(validations.every((validation) => validation.status === "Passed")).toBe(true);
    expect(validations.every((validation) => validation.logArtifactId)).toBe(true);
    expect(app.readArtifact({ artifactId: validations[0]!.logArtifactId! }).kind).toBe(
      "validation-log",
    );
    emitReviewFinding = true;
    const review = await app.startReview({ patchSetId: executionPatchSet.id });
    expect(review.review.verdict).toBe("Changes requested");
    expect(review.findings).toHaveLength(1);
    expect(app.status().findings[0]?.message).toBe("Fixture review finding");
    emitReviewFinding = false;
    const fix = await app.sendMessage({
      conversationId: conversation.id,
      text: "Fix the blocking security finding in the reviewed PatchSet",
      mode: "Fix",
    });
    expect(fix.runId).toBeTruthy();
    const fixedPatchSet = app
      .status()
      .patchSets.find(
        (patchSet) => patchSet.taskId === task.id && patchSet.id !== executionPatchSet.id,
      )!;
    const fixedValidation = await app.runValidation({ patchSetId: fixedPatchSet.id });
    expect(fixedValidation.every((validation) => validation.status === "Passed")).toBe(true);
    const fixedReview = await app.startReview({ patchSetId: fixedPatchSet.id });
    expect(fixedReview.review.verdict).toBe("Approved");
    const readyTasks = app
      .status()
      .tasks.filter(
        (item) => item.changeRequestId === plan.changeRequestId && item.state === "Ready",
      );
    expect(readyTasks.map((item) => item.key)).toEqual(["TASK-002", "TASK-003"]);
    const parallelExecutions = await app.runReadyTasks({ changeRequestId: plan.changeRequestId });
    expect(parallelExecutions).toHaveLength(2);
    expect(new Set(parallelExecutions.map((item) => item.workspace.path)).size).toBe(2);
    const approvedPatchSets = [fixedReview.approvedPatchSet!];
    for (const execution of parallelExecutions) {
      const validation = await app.runValidation({ patchSetId: execution.patchSet!.id });
      expect(validation.every((item) => item.status === "Passed")).toBe(true);
      const taskReview = await app.startReview({ patchSetId: execution.patchSet!.id });
      expect(taskReview.review.verdict).toBe("Approved");
      approvedPatchSets.push(taskReview.approvedPatchSet!);
    }
    const attempt = await app.integrate({
      changeRequestId: plan.changeRequestId,
      patchSetIds: approvedPatchSets.map((patchSet) => patchSet.id),
    });
    expect(attempt.status).toBe("Completed");
    expect(
      app.status().changeRequests.find((item) => item.id === plan.changeRequestId)?.state,
    ).toBe("Completed");
    app.close();
    rmSync(root, { recursive: true, force: true });
  }, 90_000);
});
