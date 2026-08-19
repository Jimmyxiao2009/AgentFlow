import type { AgentAdapter, AgentRequest, AgentSessionHandle } from "@agentflow/adapter-sdk";
import type {
  AgentRun,
  AgentSession,
  ChangeRequest,
  ISODate,
  PatchSet,
  Task,
  TaskState,
  ValidationRun,
  Workspace,
  WorkflowEvent,
} from "@agentflow/domain";
import { id, now, transitionTask } from "@agentflow/domain";
import { git, WorktreeManager } from "@agentflow/git";
import type { PermissionProfile } from "@agentflow/domain";
import { commandAllowed } from "@agentflow/permission-engine";
import { ProcessSupervisor, redactSecrets } from "@agentflow/process-supervisor";
import type { AdapterEvent } from "@agentflow/protocol";

export interface EventSink {
  append(event: WorkflowEvent): void;
}

export class TaskDagScheduler {
  private readonly tasks = new Map<string, Task>();
  private readonly leases = new Map<
    string,
    { taskId: string; runId: string; expiresAt: ISODate }
  >();
  add(task: Task): void {
    this.tasks.set(task.id, structuredClone(task));
  }
  get(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }
  all(): Task[] {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }
  refreshReadiness(): void {
    for (const task of this.tasks.values()) {
      if (task.state !== "Pending" && task.state !== "Blocked") continue;
      const dependencies = task.dependencyIds.map((dependency) => this.tasks.get(dependency));
      if (
        dependencies.some(
          (dependency) => !dependency || ["Failed", "Cancelled"].includes(dependency.state),
        )
      ) {
        if (task.state !== "Blocked") task.state = transitionTask(task.state, "Blocked");
      } else if (
        dependencies.every(
          (dependency) => dependency?.state === "Integrated" || dependency?.state === "Approved",
        )
      ) {
        task.state = transitionTask(task.state, "Ready");
      }
    }
  }
  claimReady(runId: string, leaseMs = 15 * 60_000): Task | undefined {
    this.refreshReadiness();
    const task = [...this.tasks.values()].find(
      (candidate) => candidate.state === "Ready" && !this.leases.has(candidate.id),
    );
    if (!task) return undefined;
    const lease = {
      taskId: task.id,
      runId,
      expiresAt: new Date(Date.now() + leaseMs).toISOString(),
    };
    task.state = transitionTask(task.state, "Leased");
    task.lease = {
      id: id("lease"),
      taskId: task.id,
      runId,
      expiresAt: lease.expiresAt,
      acquiredAt: now(),
    };
    this.leases.set(task.id, lease);
    return structuredClone(task);
  }
  claim(taskId: string, runId: string, leaseMs = 15 * 60_000): Task {
    this.refreshReadiness();
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "Ready" || this.leases.has(taskId))
      throw new Error(`Task ${taskId} is not ready for lease`);
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    task.state = transitionTask(task.state, "Leased");
    task.lease = { id: id("lease"), taskId, runId, expiresAt, acquiredAt: now() };
    this.leases.set(taskId, { taskId, runId, expiresAt });
    return structuredClone(task);
  }
  start(taskId: string, runId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task || task.lease?.runId !== runId)
      throw new Error("Task lease is missing or owned by another run");
    task.state = transitionTask(task.state, "Running");
    return structuredClone(task);
  }
  releaseExpired(at = new Date()): string[] {
    const released: string[] = [];
    for (const [taskId, lease] of this.leases)
      if (new Date(lease.expiresAt) <= at) {
        const task = this.tasks.get(taskId);
        if (task && task.state === "Leased") {
          task.state = transitionTask(task.state, "Ready");
          task.lease = undefined;
        }
        this.leases.delete(taskId);
        released.push(taskId);
      }
    return released;
  }
  release(taskId: string, next: "Ready" | "Failed", runId?: string): Task {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "Leased") throw new Error(`Task ${taskId} is not leased`);
    // When a caller identifies itself, verify it owns the lease before
    // releasing — prevents a concurrent run from releasing another run's task.
    if (runId && task.lease?.runId !== runId)
      throw new Error("Task lease is owned by another run");
    task.state = transitionTask(task.state, next);
    task.lease = undefined;
    this.leases.delete(taskId);
    return structuredClone(task);
  }
  requeue(taskId: string, runId?: string): Task {
    const task = this.tasks.get(taskId);
    if (!task || !["ChangesRequested", "Failed", "Cancelled"].includes(task.state))
      throw new Error(`Task ${taskId} is not retryable`);
    // A retryable task is no longer leased, but if a caller passes runId we
    // still sanity-check that the task is not actively owned by a live lease.
    if (runId && this.leases.has(taskId))
      throw new Error(`Task ${taskId} is still leased`);
    task.state = transitionTask(task.state, "Ready");
    return structuredClone(task);
  }
  complete(
    taskId: string,
    next: Extract<
      TaskState,
      | "PatchProduced"
      | "ValidationFailed"
      | "ReviewRequested"
      | "ChangesRequested"
      | "Approved"
      | "Failed"
      | "Cancelled"
    >,
    runId?: string,
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    // When a caller identifies itself, verify it owns the task's lease before
    // completing it — a concurrent run (or a stale retry) must not be able to
    // force-complete a task that an active run owns, which would corrupt the
    // state machine for the owning run's later transition.
    if (runId && task.lease && task.lease.runId !== runId)
      throw new Error("Task is owned by another run; cannot complete");
    task.state = transitionTask(task.state, next);
    this.leases.delete(taskId);
    task.lease = undefined;
    return structuredClone(task);
  }
}

export function createImmutablePatchSet(input: Omit<PatchSet, "immutable">): PatchSet {
  return Object.freeze({ ...structuredClone(input), immutable: true as const });
}
export function createPatchSetRevision(
  previous: PatchSet,
  input: Omit<PatchSet, "immutable" | "sequence" | "supersedes">,
): PatchSet {
  return createImmutablePatchSet({
    ...input,
    sequence: previous.sequence + 1,
    supersedes: previous.id,
  });
}
export function assertDeterministicGate(validation: ValidationRun[]): void {
  // An empty validation list means no deterministic checks have run. Failing
  // closed here prevents a PatchSet from reaching review/integration without
  // any validation evidence — the previous `[].find(...)` was a no-op that
  // always passed.
  if (validation.length === 0) throw new Error("At least one validation run is required before review");
  // A blocking check that did not explicitly pass (Failed OR Skipped OR any
  // other non-Passed terminal state) must block. The previous predicate only
  // matched status === "Failed", so a blocking check marked "Skipped" slipped
  // through the gate.
  const blocker = validation.find((run) => run.blocking && run.status !== "Passed");
  if (blocker)
    throw new Error(`Blocking validation did not pass: ${blocker.checkName} (${blocker.status})`);
}
export function assertIndependentReview(implementingRunId: string, reviewerRunId: string): void {
  if (implementingRunId === reviewerRunId)
    throw new Error("Reviewer must be independent from the implementing run");
}

export interface DeterministicCheck {
  name: string;
  executable: string;
  args: string[];
  command: string;
  blocking: boolean;
  timeoutMs?: number;
}
export interface ArtifactWriter {
  saveArtifact(artifact: {
    id: string;
    kind: "diff" | "validation-log" | "transcript" | "report" | "generated-file";
    content: string;
    contentType: string;
    createdAt: string;
  }): void | Promise<void>;
}
export class ValidationRunner {
  constructor(private readonly artifacts?: ArtifactWriter) {}
  async run(
    workspacePath: string,
    patchSetId: string,
    checks: DeterministicCheck[],
    signal?: AbortSignal,
    enforceGate = true,
  ): Promise<ValidationRun[]> {
    const results: ValidationRun[] = [];
    const supervisor = new ProcessSupervisor();
    for (const check of checks) {
      const started = Date.now();
      const result = await supervisor.run(
        `validation-${patchSetId}-${check.name}`,
        {
          executable: check.executable,
          args: check.args,
          cwd: workspacePath,
          env: {
            CI: "1",
            NPM_CONFIG_UPDATE_NOTIFIER: "false",
          },
          timeoutMs: check.timeoutMs ?? 10 * 60_000,
        },
        undefined,
        signal,
      );
      const logArtifactId = id("artifact");
      await this.artifacts?.saveArtifact({
        id: logArtifactId,
        kind: "validation-log",
        contentType: "text/plain",
        content: `# ${check.command}\n# exit code: ${result.exitCode ?? -1}\n# duration: ${result.durationMs}ms\n\nstdout:\n${result.stdout.slice(0, 200_000)}\n\nstderr:\n${result.stderr.slice(0, 200_000)}`,
        createdAt: now(),
      });
      results.push({
        id: id("validation"),
        patchSetId,
        checkName: check.name,
        status: result.exitCode === 0 ? "Passed" : "Failed",
        blocking: check.blocking,
        command: check.command,
        durationMs: Date.now() - started,
        exitCode: result.exitCode ?? -1,
        summary: (result.exitCode === 0 ? result.stdout : result.stderr).slice(0, 2_000),
        logArtifactId,
        createdAt: now(),
      });
    }
    if (enforceGate) assertDeterministicGate(results);
    return results;
  }
}

export interface ReviewGateResult {
  approved: boolean;
  blockingFindings: number;
  warnings: number;
}
export function reviewGate(
  implementingRunId: string,
  reviewerRunId: string,
  findings: Array<{
    severity: "Blocking" | "Warning" | "Suggestion";
    status: "Open" | "Resolved" | "Dismissed";
  }>,
): ReviewGateResult {
  assertIndependentReview(implementingRunId, reviewerRunId);
  const blockingFindings = findings.filter(
    (finding) => finding.severity === "Blocking" && finding.status === "Open",
  ).length;
  const warnings = findings.filter(
    (finding) => finding.severity === "Warning" && finding.status === "Open",
  ).length;
  return { approved: blockingFindings === 0, blockingFindings, warnings };
}

export interface IntegrationResult {
  status: "Completed" | "Conflict" | "Failed";
  commit?: string;
  conflictingFiles: string[];
  message: string;
}
export class IntegrationService {
  async applyApprovedPatchSets(
    integrationWorkspacePath: string,
    patchSets: PatchSet[],
  ): Promise<IntegrationResult> {
    for (const patchSet of patchSets) {
      if (patchSet.reviewState !== "Approved")
        return {
          status: "Failed",
          conflictingFiles: [],
          message: `PatchSet ${patchSet.id} is not approved`,
        };
      const result = await git(integrationWorkspacePath, ["cherry-pick", patchSet.resultCommit]);
      if (result.exitCode !== 0) {
        // A cherry-pick can fail because of a real merge conflict OR because
        // the change is already present (empty pick). Distinguish them: an
        // empty pick has no unmerged paths, so treat it as already-applied and
        // skip it; only a real conflict with unmerged files aborts integration.
        const conflicts = await git(integrationWorkspacePath, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        const conflictingFiles = conflicts.stdout
          .split(/\r?\n/)
          .map((file) => file.trim())
          .filter(Boolean);
        if (conflictingFiles.length === 0) {
          // Empty cherry-pick: the PatchSet's changes are already on the
          // integration branch. Abort the in-progress empty pick and continue.
          await git(integrationWorkspacePath, ["cherry-pick", "--abort"]);
          continue;
        }
        await git(integrationWorkspacePath, ["cherry-pick", "--abort"]);
        return {
          status: "Conflict",
          conflictingFiles,
          message: result.stderr.slice(0, 2_000),
        };
      }
    }
    const head = await git(integrationWorkspacePath, ["rev-parse", "HEAD"]);
    return head.exitCode === 0
      ? {
          status: "Completed",
          commit: head.stdout.trim(),
          conflictingFiles: [],
          message: "Approved PatchSets integrated",
        }
      : { status: "Failed", conflictingFiles: [], message: head.stderr };
  }
}

export function projectPullRequest(
  changeRequest: ChangeRequest,
  patchSets: PatchSet[],
  validations: ValidationRun[],
  reviewSummary: string,
): {
  changeRequestId: string;
  title: string;
  description: string;
  targetBranch: string;
  integrationBranch: string;
  commits: string[];
  checks: string[];
  riskSummary: string;
  requirementsTraceability: Record<string, string[]>;
  taskTraceability: Record<string, string[]>;
  reviewSummary: string;
} {
  return {
    changeRequestId: changeRequest.id,
    title: changeRequest.title,
    description: `AgentFlow change request ${changeRequest.id}\n\nGenerated from approved PatchSets; remote push and merge remain explicit user actions.`,
    targetBranch: changeRequest.targetBranch ?? "main",
    integrationBranch:
      changeRequest.integrationBranch ?? `agentflow/${changeRequest.id}/integration`,
    commits: patchSets.map((patchSet) => patchSet.resultCommit),
    checks: validations.map((validation) => `${validation.checkName}: ${validation.status}`),
    riskSummary: "Review required before any remote operation",
    requirementsTraceability: {},
    taskTraceability: Object.fromEntries(
      patchSets.map((patchSet) => [patchSet.taskId, [patchSet.id]]),
    ),
    reviewSummary,
  };
}

export interface WorkerExecution {
  session: AgentSession;
  run: AgentRun;
  workspace: Workspace;
  task: Task;
}

export interface WorkerExecutionHandlers {
  onPermissionRequest?: (event: AdapterEvent, session: AgentSessionHandle) => Promise<void>;
}
export class WorkflowOrchestrator {
  constructor(
    private readonly worktrees: WorktreeManager,
    private readonly events: EventSink,
    private readonly artifacts?: ArtifactWriter,
  ) {}

  async execute(
    adapter: AgentAdapter,
    execution: WorkerExecution,
    request: AgentRequest,
    signal: AbortSignal,
    handlers?: WorkerExecutionHandlers,
  ): Promise<{ events: number; patchSet?: PatchSet }> {
    if (execution.workspace.status !== "Ready" && execution.workspace.status !== "Running")
      throw new Error("Worker workspace is not ready");
    if (execution.workspace.ownerRunId !== execution.run.id)
      throw new Error("Worker run does not own this worktree");
    const session: AgentSessionHandle = {
      id: execution.session.id,
      nativeSessionId: execution.session.nativeSessionId,
      adapterId: execution.session.adapterId,
      role: execution.session.role,
      workspacePath: execution.workspace.path,
    };
    let count = 0;
    for await (const event of adapter.run(session, request, signal)) {
      count += 1;
      if (event.kind === "run.failed")
        throw new Error(event.text || "Worker adapter reported a failed run");
      if (event.kind === "permission.requested") {
        if (!handlers?.onPermissionRequest)
          throw new Error("Permission request handler is required for worker execution");
        await handlers.onPermissionRequest(event, session);
        continue;
      }
      this.events.append({
        id: id("event"),
        schemaVersion: 1,
        type: `adapter.${event.kind}`,
        aggregateId: execution.run.id,
        conversationId: execution.run.conversationId,
        taskId: execution.task.id,
        runId: execution.run.id,
        sequence: event.sequence,
        timestamp: event.timestamp,
        source: "adapter",
        role: execution.run.role,
        payload: event,
      });
    }
    const diff = await this.worktrees.diff(execution.workspace.path);
    if (!diff.files.length) return { events: count };
    const permissionProfile = request.permissionProfile ?? "Read Only";
    const customCanWrite =
      permissionProfile === "Custom" && Boolean(request.permissionDimensions?.writePaths.length);
    if (
      !["Workspace Write", "Elevated with Approval"].includes(permissionProfile) &&
      !customCanWrite
    )
      throw new Error(`PatchSet writes are denied under permission profile: ${permissionProfile}`);
    const pathMatches = (file: string, pattern: string): boolean => {
      const normalized = file.replaceAll("\\", "/");
      const rule = pattern.replaceAll("\\", "/");
      if (rule === "**/*" || rule === "**") return true;
      // "src/**" must match "src" and "src/foo.ts" but NOT "srcfoo/evil.ts".
      // The previous startsWith(rule.slice(0,-3)) produced prefix "src" and
      // thus accepted the unrelated sibling "srcfoo/...", letting a worker
      // write outside its task contract.
      if (rule.endsWith("/**")) {
        const prefix = rule.slice(0, -3);
        return normalized === prefix || normalized.startsWith(`${prefix}/`);
      }
      // Support single-level glob: src/*.ts matches src/foo.ts but not src/sub/foo.ts
      if (rule.includes("*")) {
        const regex = new RegExp(
          "^" +
            rule
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*\//g, ".*?/")
            .replace(/\*/g, "[^/]*")
            .replace(/\/\*\*$/, "(/.*)?") +
            "$",
        );
        return regex.test(normalized);
      }
      return normalized === rule;
    };
    // Forbidden rules must catch a literal name at any depth (".env" has to
    // block "server/.env", not just a file literally named ".env" at the
    // repository root) — a plain equality check like pathMatches() uses for
    // allowedWritePaths would let a worker dodge the block by nesting the
    // file one directory deeper. Glob rules already handle this correctly,
    // so only the literal fallback needs the broader, segment-aware check.
    const pathForbidden = (file: string, pattern: string): boolean => {
      const normalized = file.replaceAll("\\", "/");
      const rule = pattern.replaceAll("\\", "/");
      if (rule.includes("*") || rule.endsWith("/**")) return pathMatches(file, pattern);
      return normalized.split("/").includes(rule);
    };
    const outOfContract = diff.files.find(
      (file) =>
        execution.task.contract.forbiddenPaths.some((rule) => pathForbidden(file, rule)) ||
        !execution.task.contract.allowedWritePaths.some((rule) => pathMatches(file, rule)),
    );
    if (outOfContract)
      throw new Error(`PatchSet changed a path outside the task contract: ${outOfContract}`);
    const resultCommit = await this.worktrees.commit(
      execution.workspace.path,
      diff.files,
      `AgentFlow ${execution.task.key} PatchSet ${execution.task.patchSetIds.length + 1}`,
    );
    const diffArtifactId = id("artifact");
    await this.artifacts?.saveArtifact({
      id: diffArtifactId,
      kind: "diff",
      contentType: "text/x-diff",
      content: redactSecrets(diff.unified),
      createdAt: now(),
    });
    const patchSet = createImmutablePatchSet({
      id: id("patchset"),
      taskId: execution.task.id,
      sequence: execution.task.patchSetIds.length + 1,
      baseCommit: execution.workspace.baseCommit,
      resultCommit,
      changedFiles: diff.files,
      diffArtifactId,
      validationRunIds: [],
      producingRunId: execution.run.id,
      createdAt: now(),
      reviewState: "Pending",
    });
    this.events.append({
      id: id("event"),
      schemaVersion: 1,
      type: "patchset.created",
      aggregateId: patchSet.id,
      taskId: patchSet.taskId,
      runId: patchSet.producingRunId,
      sequence: patchSet.sequence,
      timestamp: patchSet.createdAt,
      source: "runtime",
      role: "Worker",
      payload: patchSet,
    });
    return { events: count, patchSet };
  }
}

export function canExecuteCommand(
  command: string,
  profile: PermissionProfile,
  workspace: Workspace,
): boolean {
  return commandAllowed(command, profile, workspace.path, workspace.path);
}

export type WorkflowAggregate = {
  changeRequest: ChangeRequest;
  tasks: Task[];
  runs: AgentRun[];
  sessions: AgentSession[];
  workspaces: Workspace[];
  patchSets: PatchSet[];
};
