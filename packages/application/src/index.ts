import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { FakeAdapter } from "@agentflow/adapter-fake";
import type { AgentAdapter } from "@agentflow/adapter-sdk";
import { defaultSettings, migrateSettings, type AgentFlowSettings } from "@agentflow/config";
import type {
  AgentRun,
  AgentSession,
  AuthenticationProfile,
  ChangeRequest,
  Conversation,
  Decision,
  IntegrationAttempt,
  ModelDefinition,
  PermissionDimensions,
  PermissionRequest,
  PatchSet,
  PermissionProfileName,
  Project,
  PullRequestProjection,
  ReviewFinding,
  ReviewRound,
  RiskLevel,
  RoutingDecision,
  SpecificationRevision,
  StructureRevision,
  Task,
  ValidationRun,
  Workspace,
  WorkflowEvent,
} from "@agentflow/domain";
import { id, now, transitionChangeRequest, transitionTask } from "@agentflow/domain";
import { ensureGitRepository, git, WorktreeManager, verifyRepository } from "@agentflow/git";
import { SqliteEventStore } from "@agentflow/persistence";
import {
  builtInPermissionProfiles,
  effectivePermissions,
  isPermanentlyDenied,
} from "@agentflow/permission-engine";
import { lines, Logger, ProcessSupervisor, redactSecrets, redactStructured } from "@agentflow/process-supervisor";
import { parseMethodPayload, type AdapterEvent } from "@agentflow/protocol";
import { route } from "@agentflow/routing-engine";
import {
  assertDeterministicGate,
  IntegrationService,
  projectPullRequest,
  reviewGate,
  TaskDagScheduler,
  ValidationRunner,
  WorkflowOrchestrator,
  createImmutablePatchSet,
} from "@agentflow/workflow-engine";

export interface ApplicationOptions {
  dataDirectory: string;
  eventSink?: (event: WorkflowEvent) => void;
  fakeAdapter?: FakeAdapter;
  adapters?: AgentAdapter[];
  profiles?: AuthenticationProfile[];
}
export interface MessageResult {
  messageId: string;
  text: string;
  runId?: string;
  changeRequestId?: string;
  specificationRevisionId?: string;
}

export function classifyPlanRisk(text: string): "Low" | "High" {
  // Match risk terms as substrings so derived words are also caught:
  // "authentication"/"authz", "migrations", "credentials", "dependencies",
  // "networking". The previous \b(term)\b anchors required an exact word, so
  // "authentication" did not match "auth" and a risky plan was misclassified
  // as Low risk and auto-approved.
  return /(auth|credential|database|migration|network|depend|secur|delet|public|schema)/i.test(
    text,
  )
    ? "High"
    : "Low";
}

// Ask mode is read-only by design. Rather than a separate classifier call,
// the model itself is asked to say so in its own reply when a request needs
// more than reading files, using a fixed marker line the UI can detect and
// turn into an escalation prompt (approve -> resend under Implement/Plan).
const askEscalationInstructions = [
  "",
  "You are running in read-only Ask mode: you can read the repository but cannot write files, run commands, or make changes.",
  "If answering this properly requires editing files or running write commands, do not attempt it. Instead end your reply with a line of exactly this form:",
  'AGENTFLOW_ESCALATE: {"capability":"write","reason":"<one short sentence>"}',
  "If the request is large enough that it should be split into multiple tasks run in parallel on separate branches, end your reply with:",
  'AGENTFLOW_ESCALATE: {"capability":"workers","reason":"<one short sentence>"}',
  "Only include an AGENTFLOW_ESCALATE line when escalation is genuinely needed; otherwise just answer normally.",
].join("\n");

interface PlannerTaskDraft {
  title: string;
  objective: string;
  dependsOn: Array<number | string>;
  allowedWritePaths: string[];
  acceptanceCriteria: string[];
  riskLevel: RiskLevel;
}

interface PlannerDraft {
  summary: string;
  architectureAnalysis: string;
  design: string;
  nonGoals: string[];
  acceptanceCriteria: string[];
  structureChanges: string[];
  decisions: Array<{ title: string; rationale: string }>;
  validationStrategy: string[];
  tasks: PlannerTaskDraft[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function safeWritePaths(value: unknown): string[] {
  const paths = stringList(value)
    .map((item) => item.replaceAll("\\", "/").trim())
    .filter(
      (item) =>
        item &&
        !item.startsWith("/") &&
        !/^[A-Za-z]:\//.test(item) &&
        !item.split("/").includes("..") &&
        !item.startsWith(".git") &&
        !/(^|\/)(?:main|master)(?:\/|$)/.test(item),
    );
  return paths.length ? [...new Set(paths)] : ["**/*"];
}

function manualModelKey(adapterId: string, providerModelId: string): string {
  return `manual-${adapterId}-${Buffer.from(providerModelId).toString("base64url").slice(0, 96)}`;
}

function extractPlannerJson(output: string): Record<string, unknown> | undefined {
  const candidates = [
    output.trim(),
    ...(output.match(/```(?:json)?\s*([\s\S]*?)```/gi) ?? []).map((block) =>
      block.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, ""),
    ),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = recordOf(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      /* Providers may return prose around an otherwise useful plan. */
    }
  }
  return undefined;
}

function createPlannerDraft(prompt: string, output: string): PlannerDraft {
  const parsed = extractPlannerJson(output);
  const shortPrompt = prompt.replace(/\s+/g, " ").trim().slice(0, 240);
  const fallbackTasks: PlannerTaskDraft[] = [
    {
      title: `Define implementation contract: ${shortPrompt}`,
      objective: `Define the implementation contract for the requested change: ${shortPrompt}`,
      dependsOn: [],
      allowedWritePaths: ["docs/**"],
      acceptanceCriteria: ["The implementation contract is explicit and reviewable"],
      riskLevel: "Medium",
    },
    {
      title: `Implement requested change: ${shortPrompt}`,
      objective: `Implement the approved requested change in the assigned worktree: ${shortPrompt}`,
      dependsOn: [0],
      allowedWritePaths: ["**/*"],
      acceptanceCriteria: ["The requested behavior is implemented without main-checkout writes"],
      riskLevel: classifyPlanRisk(prompt),
    },
    {
      title: `Validate requested change: ${shortPrompt}`,
      objective:
        "Run deterministic validation and document evidence for the approved implementation.",
      dependsOn: [0],
      allowedWritePaths: ["tests/**", "docs/**"],
      acceptanceCriteria: ["Required deterministic validation passes"],
      riskLevel: "Medium",
    },
  ];
  const rawTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const tasks = rawTasks
    .map((item): PlannerTaskDraft | undefined => {
      const task = recordOf(item);
      if (!task) return undefined;
      const title = typeof task?.title === "string" ? task.title.trim() : "";
      if (!title) return undefined;
      const objective =
        typeof task.objective === "string" && task.objective.trim() ? task.objective.trim() : title;
      const dependsOn = Array.isArray(task.dependsOn)
        ? task.dependsOn.filter(
            (dependency): dependency is number | string =>
              (typeof dependency === "number" && Number.isInteger(dependency)) ||
              (typeof dependency === "string" && dependency.trim().length > 0),
          )
        : [];
      const risk = task.riskLevel;
      return {
        title: title.slice(0, 300),
        objective: objective.slice(0, 2_000),
        dependsOn,
        allowedWritePaths: safeWritePaths(task.allowedWritePaths),
        acceptanceCriteria: stringList(task.acceptanceCriteria).slice(0, 10),
        riskLevel:
          risk === "Low" || risk === "Medium" || risk === "High" || risk === "Critical"
            ? risk
            : "Medium",
      };
    })
    .filter((task): task is PlannerTaskDraft => Boolean(task));
  const normalizedTasks = tasks.length ? tasks : fallbackTasks;
  return {
    summary:
      (typeof parsed?.summary === "string" && parsed.summary.trim()) ||
      output.trim().slice(0, 8_000) ||
      `Read-only planning completed for: ${shortPrompt}`,
    architectureAnalysis:
      (typeof parsed?.architectureAnalysis === "string" && parsed.architectureAnalysis.trim()) ||
      `The requested change is planned from the repository boundary: ${shortPrompt}`,
    design:
      (typeof parsed?.design === "string" && parsed.design.trim()) ||
      `Implementation is gated by an approved specification and isolated task worktrees for: ${shortPrompt}`,
    nonGoals: stringList(parsed?.nonGoals).length
      ? stringList(parsed?.nonGoals)
      : ["No direct main-checkout writes"],
    acceptanceCriteria: stringList(parsed?.acceptanceCriteria).length
      ? stringList(parsed?.acceptanceCriteria)
      : ["All deterministic validation gates pass"],
    structureChanges: stringList(parsed?.structureChanges),
    decisions: Array.isArray(parsed?.decisions)
      ? parsed.decisions
          .map((item) => {
            const decision = recordOf(item);
            return decision && typeof decision.title === "string"
              ? {
                  title: decision.title.slice(0, 200),
                  rationale:
                    typeof decision.rationale === "string"
                      ? decision.rationale.slice(0, 2_000)
                      : "Planner supplied an explicit decision.",
                }
              : undefined;
          })
          .filter((item): item is { title: string; rationale: string } => Boolean(item))
      : [],
    validationStrategy: stringList(parsed?.validationStrategy).length
      ? stringList(parsed?.validationStrategy)
      : ["format", "typecheck", "test", "security"],
    tasks: normalizedTasks,
  };
}

export class AgentFlowApplication {
  readonly fake?: FakeAdapter;
  readonly store: SqliteEventStore;
  private readonly projects = new Map<string, Project>();
  private readonly debugProcesses = new ProcessSupervisor();
  private readonly runningDebugProjectIds = new Set<string>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly changeRequests = new Map<string, ChangeRequest>();
  private readonly specifications = new Map<string, SpecificationRevision>();
  private readonly structures = new Map<string, StructureRevision>();
  private readonly decisions = new Map<string, Decision>();
  private readonly routingDecisions = new Map<string, RoutingDecision>();
  private readonly tasks = new Map<string, Task>();
  private readonly scheduler = new TaskDagScheduler();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly runRequests = new Map<
    string,
    {
      conversationId: string;
      text: string;
      mode: "Ask" | "Investigate" | "Plan" | "Implement" | "Fix" | "Review";
      intent?: "build";
      adapterId: string;
      profileId: string;
      modelId?: string;
      permissionProfile:
        "Read Only" | "Repository Safe" | "Workspace Write" | "Elevated with Approval" | "Custom";
      permissionDimensions?: PermissionDimensions;
    }
  >();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly patchSets = new Map<string, PatchSet>();
  private readonly validationRuns = new Map<string, ValidationRun>();
  private readonly reviewRounds = new Map<string, ReviewRound>();
  private readonly reviewFindings = new Map<string, ReviewFinding>();
  private readonly permissionRequests = new Map<string, PermissionRequest>();
  private readonly integrationAttempts = new Map<string, IntegrationAttempt>();
  private readonly worktrees: WorktreeManager;
  private readonly validation: ValidationRunner;
  private readonly integration = new IntegrationService();
  private readonly orchestrator: WorkflowOrchestrator;
  private readonly activeRuns = new Map<string, AbortController>();
  // Scoped permission grants: when a user picks "allow-task" or
  // "allow-conversation", the approved permission fingerprint is remembered so
  // the same request (same command/workingDirectory/reason) does not re-prompt
  // within that scope. Keyed by `task:<taskId>` or `conversation:<conversationId>`.
  private readonly grantedScopes = new Map<string, Set<string>>();
  private readonly pendingApprovals = new Map<
    string,
    {
      resolve: (decision: string) => void;
      reject: (error: Error) => void;
      controller: AbortController;
    }
  >();
  private readonly profiles: AuthenticationProfile[];
  private readonly adapters: Map<string, AgentAdapter>;
  private readonly models = new Map<string, ModelDefinition>();
  private settings: AgentFlowSettings;
  constructor(private readonly options: ApplicationOptions) {
    this.fake = options.fakeAdapter;
    this.adapters = new Map<string, AgentAdapter>([
      ...(this.fake ? ([["fake", this.fake]] as Array<[string, AgentAdapter]>) : []),
      ...(options.adapters ?? []).map((adapter): [string, AgentAdapter] => [adapter.id, adapter]),
    ]);
    this.profiles = [
      ...(this.fake
        ? [
            {
              id: "profile-fake",
              name: "Fake Fixture",
              adapterId: "fake",
              status: "Ready" as const,
            },
          ]
        : []),
      ...(options.profiles ?? []).filter((profile) => profile.adapterId !== "fake"),
    ];
    if (this.fake) {
      this.models.set("fake-default", {
        id: "fake-default",
        adapterId: "fake",
        providerId: "fixture",
        name: "Fake Deterministic Model",
        verified: true,
        cliDefault: true,
        capabilities: ["streaming", "resume"],
      });
    }
    this.store = new SqliteEventStore(path.join(options.dataDirectory, "agentflow.db"));
    this.settings = migrateSettings(
      this.store.readProjection<AgentFlowSettings>("settings:global")?.payload ?? defaultSettings,
    );
    this.store.saveProjection("settings:global", this.settings.schemaVersion, this.settings);
    this.worktrees = new WorktreeManager({ dataRoot: options.dataDirectory });
    this.orchestrator = new WorkflowOrchestrator(
      this.worktrees,
      {
        append: (event) => {
          this.store.append(event);
          this.options.eventSink?.(event);
        },
      },
      {
        saveArtifact: (artifact) =>
          this.store.saveArtifact({ ...artifact, createdAt: artifact.createdAt }),
      },
    );
    this.validation = new ValidationRunner({
      saveArtifact: (artifact) =>
        this.store.saveArtifact({ ...artifact, createdAt: artifact.createdAt }),
    });
    for (const name of this.store.projectionNames("project:")) {
      const item = this.store.readProjection<Project>(name)?.payload;
      if (item) this.projects.set(item.id, item);
    }
    for (const name of this.store.projectionNames("conversation:")) {
      const item = this.store.readProjection<Conversation>(name)?.payload;
      if (item) this.conversations.set(item.id, item);
    }
    for (const name of this.store.projectionNames("cr:")) {
      const item = this.store.readProjection<ChangeRequest>(name)?.payload;
      if (item) this.changeRequests.set(item.id, item);
    }
    for (const name of this.store.projectionNames("spec:")) {
      const item = this.store.readProjection<SpecificationRevision>(name)?.payload;
      if (item) this.specifications.set(item.id, item);
    }
    for (const name of this.store.projectionNames("structure:")) {
      const item = this.store.readProjection<StructureRevision>(name)?.payload;
      if (item) this.structures.set(item.id, item);
    }
    for (const name of this.store.projectionNames("decision:")) {
      const item = this.store.readProjection<Decision>(name)?.payload;
      if (item) this.decisions.set(item.id, item);
    }
    for (const name of this.store.projectionNames("routing:")) {
      const item = this.store.readProjection<RoutingDecision>(name)?.payload;
      if (item) this.routingDecisions.set(item.id, item);
    }
    for (const name of this.store.projectionNames("task:")) {
      const item = this.store.readProjection<Task>(name)?.payload;
      if (item) {
        this.tasks.set(item.id, item);
        this.scheduler.add(item);
      }
    }
    for (const name of this.store.projectionNames("workspace:")) {
      const item = this.store.readProjection<Workspace>(name)?.payload;
      if (item) this.workspaces.set(item.id, item);
    }
    for (const name of this.store.projectionNames("patchset:")) {
      const item = this.store.readProjection<PatchSet>(name)?.payload;
      if (item) this.patchSets.set(item.id, item);
    }
    for (const name of this.store.projectionNames("run:")) {
      const item = this.store.readProjection<AgentRun>(name)?.payload;
      if (item) this.runs.set(item.id, item);
    }
    for (const name of this.store.projectionNames("run-request:")) {
      const item = this.store.readProjection<{
        conversationId: string;
        text: string;
        mode: "Ask" | "Investigate" | "Plan" | "Implement" | "Fix" | "Review";
        intent?: "build";
        adapterId: string;
        profileId: string;
        modelId?: string;
        permissionProfile:
          "Read Only" | "Repository Safe" | "Workspace Write" | "Elevated with Approval" | "Custom";
        permissionDimensions?: PermissionDimensions;
      }>(name)?.payload;
      const runId = name.slice("run-request:".length);
      if (item) this.runRequests.set(runId, item);
    }
    for (const name of this.store.projectionNames("session:")) {
      const item = this.store.readProjection<AgentSession>(name)?.payload;
      if (item) this.sessions.set(item.id, item);
    }
    for (const name of this.store.projectionNames("validation:")) {
      const item = this.store.readProjection<ValidationRun>(name)?.payload;
      if (item) this.validationRuns.set(item.id, item);
    }
    for (const name of this.store.projectionNames("review:")) {
      const item = this.store.readProjection<ReviewRound>(name)?.payload;
      if (item) this.reviewRounds.set(item.id, item);
    }
    for (const name of this.store.projectionNames("finding:")) {
      const item = this.store.readProjection<ReviewFinding>(name)?.payload;
      if (item) this.reviewFindings.set(item.id, item);
    }
    for (const name of this.store.projectionNames("permission:")) {
      const item = this.store.readProjection<PermissionRequest>(name)?.payload;
      if (item) this.permissionRequests.set(item.id, item);
    }
    for (const name of this.store.projectionNames("integration:")) {
      const item = this.store.readProjection<IntegrationAttempt>(name)?.payload;
      if (item) this.integrationAttempts.set(item.id, item);
    }
    for (const run of this.runs.values()) {
      if (!["Queued", "Running", "WaitingApproval"].includes(run.state)) continue;
      run.state = "Failed";
      run.completedAt = now();
      run.error = "Runtime restarted before this run was reconciled; retry is available.";
      this.store.saveProjection(`run:${run.id}`, 1, run);
      if (run.workspaceId) {
        const workspace = this.workspaces.get(run.workspaceId);
        if (workspace && ["Preparing", "Ready", "Running"].includes(workspace.status)) {
          workspace.status = "Orphaned";
          this.store.saveProjection(`workspace:${workspace.id}`, 1, workspace);
        }
      }
      const session = this.sessions.get(run.sessionId);
      if (session) {
        session.state = "Crashed";
        session.updatedAt = now();
        this.store.saveProjection(`session:${session.id}`, 1, session);
      }
      if (run.taskId) {
        const task = this.tasks.get(run.taskId);
        if (task && ["Leased", "Running"].includes(task.state)) {
          const recovered = this.scheduler.complete(task.id, "Failed");
          this.saveTask(recovered);
        }
      }
    }
    for (const lease of this.store.taskLeases()) {
      const task = this.tasks.get(lease.taskId);
      if (!task || task.state !== "Leased") {
        this.store.deleteTaskLease(lease.taskId);
        continue;
      }
      const expired = new Date(lease.expiresAt).getTime() <= Date.now();
      const recovered = this.scheduler.release(task.id, expired ? "Ready" : "Failed");
      this.saveTask(recovered);
      this.store.deleteTaskLease(task.id);
    }
    for (const request of this.permissionRequests.values()) {
      if (request.status !== "Pending") continue;
      request.status = "Denied";
      request.resolvedAt = now();
      this.store.saveProjection(`permission:${request.id}`, 1, request);
    }
  }

  async reconcileInterruptedWork(): Promise<void> {
    for (const workspace of this.workspaces.values()) {
      if (workspace.status !== "Orphaned") continue;
      const task = this.tasks.get(workspace.taskId);
      const run = this.runs.get(workspace.ownerRunId ?? "");
      if (!task || !run) continue;
      try {
        await access(workspace.path);
        const head = await git(workspace.path, ["rev-parse", "HEAD"]);
        if (head.exitCode !== 0 || head.stdout.trim() === workspace.baseCommit) continue;
        const resultCommit = head.stdout.trim();
        const existing = [...this.patchSets.values()].find(
          (patchSet) =>
            patchSet.producingRunId === run.id && patchSet.resultCommit === resultCommit,
        );
        if (!existing) {
          const [files, diff] = await Promise.all([
            git(workspace.path, [
              "diff",
              "--name-only",
              "--no-ext-diff",
              workspace.baseCommit,
              resultCommit,
            ]),
            git(workspace.path, [
              "diff",
              "--no-ext-diff",
              "--binary",
              workspace.baseCommit,
              resultCommit,
            ]),
          ]);
          const changedFiles = files.stdout
            .split(/\r?\n/)
            .map((file) => file.trim())
            .filter(Boolean);
          if (!changedFiles.length || diff.exitCode !== 0) continue;
          const diffArtifactId = id("artifact");
          await this.store.saveArtifact({
            id: diffArtifactId,
            kind: "diff",
            contentType: "text/x-diff",
            content: redactSecrets(diff.stdout),
            createdAt: now(),
          });
          const patchSet = createImmutablePatchSet({
            id: id("patchset"),
            taskId: task.id,
            sequence: task.patchSetIds.length + 1,
            baseCommit: workspace.baseCommit,
            resultCommit,
            changedFiles,
            diffArtifactId,
            validationRunIds: [],
            producingRunId: run.id,
            createdAt: now(),
            reviewState: "Pending",
          });
          this.patchSets.set(patchSet.id, patchSet);
          this.store.saveProjection(`patchset:${patchSet.id}`, 1, patchSet);
          task.patchSetIds = [...task.patchSetIds, patchSet.id];
          if (task.state === "Failed" || task.state === "Cancelled")
            this.scheduler.requeue(task.id);
          if (this.scheduler.get(task.id)?.state === "Ready") {
            this.scheduler.claim(task.id, run.id);
            this.scheduler.start(task.id, run.id);
          }
          if (this.scheduler.get(task.id)?.state === "Running") {
            const recovered = this.scheduler.complete(task.id, "PatchProduced");
            recovered.patchSetIds = [...task.patchSetIds];
            this.saveTask(recovered);
          } else this.saveTask(task);
          this.emit({
            type: "patchset.recovered",
            aggregateId: patchSet.id,
            conversationId: run.conversationId,
            changeRequestId: task.changeRequestId,
            taskId: task.id,
            runId: run.id,
            source: "system",
            role: "Worker",
            payload: patchSet,
          });
        }
        workspace.status = "Ready";
        this.store.saveProjection(`workspace:${workspace.id}`, 1, workspace);
      } catch (error: unknown) {
        // Log the recovery failure so it is diagnosable; the orphan marker is preserved for retry.
        Logger.warn("Failed to reconcile orphaned workspace", {
          workspaceId: workspace.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Remove worktrees whose tasks have reached a terminal state (Integrated,
   * Failed, Cancelled) or whose owning run no longer exists.  Releases disk
   * space and prunes stale Git worktree entries.
   */
  async cleanupOrphanedWorktrees(): Promise<{ removed: string[]; errors: string[] }> {
    const removed: string[] = [];
    const errors: string[] = [];
    for (const workspace of this.workspaces.values()) {
      // "Released" means the worktree was already removed by a prior call --
      // reprocessing it here would just retry `git worktree remove` against a
      // path that no longer exists, failing every time and, since
      // workspaces are never pruned from this map, doing so again on every
      // future restart for the lifetime of the installation.
      if (workspace.status === "Orphaned") {
        const task = this.tasks.get(workspace.taskId);
        const run = workspace.ownerRunId ? this.runs.get(workspace.ownerRunId) : undefined;
        const terminal = task && ["Integrated", "Failed", "Cancelled"].includes(task.state);
        if (terminal || !run) {
          const project = this.projects.get(workspace.projectId);
          if (!project) continue;
          try {
            await this.worktrees.remove(project.repositoryPath, workspace.path);
            removed.push(workspace.id);
            workspace.status = "Released";
            this.store.saveProjection(`workspace:${workspace.id}`, 1, workspace);
          } catch (error: unknown) {
            errors.push(`${workspace.id}: ${(error as Error).message}`);
          }
        }
      }
    }
    return { removed, errors };
  }

  /**
   * Prepends project-level rules (from `.agentflow/rules.md`) to the user's
   * prompt so the agent is aware of project-specific conventions, constraints,
   * and preferences without the user repeating them each time.
   */
  private augmentPrompt(projectId: string, text: string): string {
    const project = this.projects.get(projectId);
    if (!project?.rulesContent) return text;
    const rules = this.truncateForContext(project.rulesContent, 4_000); // ~4k token budget for rules
    return [
      "# Project rules\nFollow these project-level instructions for all work in this repository:",
      rules,
      "# User request",
      this.truncateForContext(text, 28_000), // ~28k token budget for user prompt
    ].join("\n\n");
  }

  /**
   * Truncates text to fit within `maxTokens`, keeping the head and appending a
   * truncation notice.  Used to prevent overflowing model context windows.
   */
  private truncateForContext(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 100)}\n\n[... truncated to fit context window ...]`;
  }

  private emit<T>(
    event: Omit<WorkflowEvent<T>, "id" | "schemaVersion" | "sequence" | "timestamp">,
  ): WorkflowEvent<T> {
    const complete: WorkflowEvent<T> = {
      ...event,
      id: id("event"),
      schemaVersion: 1,
      sequence: this.store.lastSequence(event.aggregateId) + 1,
      timestamp: now(),
    };
    this.store.append(complete);
    this.options.eventSink?.(complete);
    return complete;
  }

  async probeProfiles(signal = new AbortController().signal): Promise<AuthenticationProfile[]> {
    this.models.clear();
    await Promise.all(
      this.profiles.map(async (profile) => {
        const adapter = this.adapters.get(profile.adapterId);
        if (!adapter) return;
        try {
          if (adapter.id !== "fake") {
            const result = await adapter.probe(
              { cwd: process.cwd(), profileId: profile.id },
              signal,
            );
            profile.version = result.version?.slice(0, 200);
            profile.diagnostic = result.diagnostic
              ? redactSecrets(result.diagnostic).slice(0, 2_000)
              : undefined;
            profile.status = result.ready
              ? result.authenticated === false
                ? "RequiresLogin"
                : "Ready"
              : "Unavailable";
          }
          if (profile.status === "Ready") {
            const discovery = await adapter.discoverModels(profile, signal);
            for (const model of discovery.models) this.models.set(model.id, model);
            for (const configured of this.settings.manualModels) {
              if (configured.adapterId !== adapter.id) continue;
              const modelId = manualModelKey(adapter.id, configured.modelId);
              this.models.set(modelId, {
                id: modelId,
                adapterId: adapter.id,
                providerId: configured.providerId,
                providerModelId: configured.modelId,
                name: configured.name,
                verified: false,
                cliDefault: false,
                capabilities: adapter.capabilities?.structuredEvents
                  ? ["structured-events"]
                  : ["text-stream"],
              });
            }
          }
        } catch (error: unknown) {
          if (!signal.aborted) {
            profile.status = "Unavailable";
            profile.diagnostic = redactSecrets(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 2_000);
          }
        }
      }),
    );
    return this.profiles.map((profile) => ({ ...profile }));
  }

  /**
   * Prunes old artifacts (diffs, validation logs, transcripts) beyond the
   * configured retention window to prevent unbounded SQLite growth. Artifacts
   * still referenced by a live PatchSet or ValidationRun are preserved so
   * pruning never corrupts historical PatchSet history.
   */
  pruneArtifacts(): number {
    const referenced = new Set<string>();
    for (const patchSet of this.patchSets.values())
      if (patchSet.diffArtifactId) referenced.add(patchSet.diffArtifactId);
    for (const validation of this.validationRuns.values())
      if (validation.logArtifactId) referenced.add(validation.logArtifactId);
    return this.store.pruneArtifacts(this.settings.retentionDays, referenced);
  }

  getSettings(): AgentFlowSettings {
    return { ...this.settings };
  }

  /**
   * Settings returned across the bridge to the renderer never carry provider
   * API keys (docs/security.md: "renderer never receives provider tokens").
   * The sidecar keeps the live key internally via getSettings() for running
   * providers (vercelAiAdapter); the renderer only needs to know a provider
   * was configured, not its secret. The renderer preserves a locally-edited
   * key in its own state and re-sends it on save, so blanking the echo does
   * not clear a configured key.
   */
  getSettingsForRenderer(): AgentFlowSettings {
    return {
      ...this.settings,
      aiProviders: this.settings.aiProviders.map((provider) => ({
        ...provider,
        apiKey: "",
      })),
    };
  }

  saveSettings(payload: unknown): AgentFlowSettings {
    const input = parseMethodPayload("settings.save", payload);
    this.settings = migrateSettings(input.settings);
    this.store.saveProjection("settings:global", this.settings.schemaVersion, this.settings);
    // Never persist raw credentials to the append-only audit log — redact
    // apiKey-shaped fields so the audit trail records that settings changed
    // without retaining the secret. The projection above keeps the live key
    // for the sidecar's own use; the audit trail does not need it.
    this.store.appendAudit({
      id: id("audit"),
      actor: "user",
      action: "settings.updated",
      target: "settings:global",
      detail: JSON.stringify(redactStructured(this.settings)),
      timestamp: now(),
    });
    return this.getSettings();
  }

  readArtifact(payload: unknown) {
    const input = parseMethodPayload("artifact.read", payload);
    const artifact = this.store.readArtifact(input.artifactId);
    if (!artifact) throw new Error("Artifact does not exist");
    return { ...artifact, content: redactSecrets(artifact.content) };
  }

  private createPermissionRequest(
    run: AgentRun,
    event: AdapterEvent,
    upperBoundName: PermissionProfileName,
  ): PermissionRequest {
    const permission = event.permission;
    const profiles = builtInPermissionProfiles(this.settings.customPermissionDimensions);
    const requestedProfile = profiles.find((candidate) => candidate.name === permission?.requested);
    const upperBound =
      profiles.find((candidate) => candidate.name === upperBoundName) ??
      profiles.find((candidate) => candidate.name === "Read Only");
    if (!permission || !upperBound) throw new Error("Malformed permission request");
    const raw =
      event.raw && typeof event.raw === "object" ? (event.raw as Record<string, unknown>) : {};
    const request: PermissionRequest = {
      id: id("permission"),
      runId: run.id,
      command: typeof raw.command === "string" ? raw.command : undefined,
      workingDirectory: typeof raw.workingDirectory === "string" ? raw.workingDirectory : undefined,
      reason: permission.reason,
      requested: requestedProfile?.dimensions ?? {},
      effective: effectivePermissions(upperBound.dimensions, requestedProfile?.dimensions ?? {}),
      status: "Pending",
      createdAt: now(),
    };
    this.permissionRequests.set(request.id, request);
    this.store.saveProjection(`permission:${request.id}`, 1, request);
    return request;
  }

  /**
   * A stable fingerprint of what a permission request asks for, so an
   * allow-task/allow-conversation grant can match a later identical request
   * without re-prompting. Command, working directory, reason, and the
   * requested boolean dimensions are the distinguishing fields.
   */
  private permissionFingerprint(request: PermissionRequest): string {
    const dims = request.requested;
    const booleans = [
      "network",
      "packageInstall",
      "dependencyChanges",
      "projectFileChanges",
      "externalProcesses",
      "secretAccess",
      "clipboard",
      "browser",
      "externalDirectories",
      "remoteGit",
    ]
      .map((key) => `${key}=${Boolean(dims[key as keyof typeof dims])}`)
      .join(",");
    return `${request.command ?? ""}|${request.workingDirectory ?? ""}|${request.reason}|${booleans}`;
  }

  /** Records a scoped grant (allow-task / allow-conversation) for later reuse. */
  private recordScopedGrant(scopeKey: string, request: PermissionRequest): void {
    let set = this.grantedScopes.get(scopeKey);
    if (!set) {
      set = new Set();
      this.grantedScopes.set(scopeKey, set);
    }
    set.add(this.permissionFingerprint(request));
  }

  /** True if an identical request was already granted within the scope. */
  private hasScopedGrant(scopeKey: string, request: PermissionRequest): boolean {
    return this.grantedScopes.get(scopeKey)?.has(this.permissionFingerprint(request)) ?? false;
  }

  private permissionExceedsEffective(request: PermissionRequest): boolean {
    const requested = request.requested;
    const effective = request.effective;
    const booleanDimensions = [
      "network",
      "packageInstall",
      "dependencyChanges",
      "projectFileChanges",
      "externalProcesses",
      "secretAccess",
      "clipboard",
      "browser",
      "externalDirectories",
      "remoteGit",
    ] as const;
    return (
      booleanDimensions.some(
        (dimension) => requested[dimension] === true && !effective[dimension],
      ) ||
      (requested.commands ?? []).some((command) => !effective.commands.includes(command)) ||
      (requested.readPaths ?? []).some((readPath) => !effective.readPaths.includes(readPath)) ||
      (requested.writePaths ?? []).some((writePath) => !effective.writePaths.includes(writePath))
    );
  }

  private validateModelSelection(adapterId: string, modelId?: string): void {
    if (!modelId) return;
    const model = this.models.get(modelId);
    if (!model || model.adapterId !== adapterId)
      throw new Error(`Model is unavailable for adapter: ${modelId}`);
  }

  private selectRunRoute(
    role: "Worker" | "Reviewer" | "Investigator",
    options: { adapterId?: string; profileId?: string; modelId?: string },
    permissionProfile: PermissionProfileName,
    runId: string,
    aggregateId: string,
    conversationId: string,
    changeRequestId?: string,
  ) {
    const decision = route(
      {
        preset: "Balanced",
        adapterId: options.adapterId,
        profileId: options.profileId,
        modelId: options.modelId,
        role,
        permissionProfile,
        workerCount: this.settings.workerCount,
        executionStrategy: this.settings.workerCount > 1 ? "Parallel" : "Serial",
      },
      {
        profiles: this.profiles,
        models: [...this.models.values()],
        availableAdapters: [...this.adapters.keys()],
        requestedRole: role,
      },
      id("routing"),
    );
    decision.runId = runId;
    this.routingDecisions.set(decision.id, decision);
    this.store.saveProjection(`routing:${decision.id}`, 1, decision);
    this.emit({
      type: "routing.decided",
      aggregateId,
      conversationId,
      changeRequestId,
      runId,
      source: "runtime",
      role,
      payload: decision,
    });
    if (!decision.selected?.profileId) throw new Error(`Run route unavailable: ${decision.reason}`);
    return decision.selected;
  }

  /**
   * Resolves a permission request for an in-flight run. If the user previously
   * granted an identical request within the task or conversation scope, the
   * request is auto-allowed (recorded + emitted) without re-prompting;
   * otherwise the user is asked via waitForPermission. This is what makes
   * allow-task / allow-conversation distinct from allow-once.
   */
  private async resolvePermissionForRun(
    request: PermissionRequest,
    run: AgentRun,
    controller: AbortController,
  ): Promise<string> {
    const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
    const scopeKeys = [`conversation:${run.conversationId}`];
    if (task) scopeKeys.push(`task:${task.id}`);
    const autoAllowed = scopeKeys.some((key) => this.hasScopedGrant(key, request));
    if (autoAllowed) {
      request.status = "Allowed";
      request.resolvedAt = now();
      this.store.saveProjection(`permission:${request.id}`, 1, request);
      this.emit({
        type: "approval.resolved",
        aggregateId: request.id,
        conversationId: run.conversationId,
        runId: run.id,
        source: "ui",
        payload: { requestId: request.id, decision: "allow-task", autoApproved: true },
      });
      return "allow-task";
    }
    return this.waitForPermission(request.id, controller);
  }

  private waitForPermission(requestId: string, controller: AbortController): Promise<string> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pendingApprovals.delete(requestId);
        reject(new Error("Run aborted while waiting for permission"));
      };
      const settle = (decision: string) => {
        controller.signal.removeEventListener("abort", onAbort);
        this.pendingApprovals.delete(requestId);
        resolve(decision);
      };
      const fail = (error: Error) => {
        controller.signal.removeEventListener("abort", onAbort);
        this.pendingApprovals.delete(requestId);
        reject(error);
      };
      this.pendingApprovals.set(requestId, { resolve: settle, reject: fail, controller });
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async openProject(payload: unknown): Promise<Project> {
    const { repositoryPath } = parseMethodPayload("project.open", payload);
    await ensureGitRepository(repositoryPath);
    const repository = await verifyRepository(repositoryPath);
    let rulesContent: string | undefined;
    try {
      const rulesPath = path.join(repository.root, ".agentflow", "rules.md");
      const raw = await readFile(rulesPath, "utf8");
      rulesContent = raw.trim().slice(0, 16_384) || undefined;
    } catch {
      // No project rules file — that's fine.
    }
    const project: Project = {
      id: id("project"),
      name: path.basename(repository.root),
      repositoryPath: repository.root,
      defaultBranch: repository.branch || "main",
      createdAt: now(),
      updatedAt: now(),
      rulesContent,
    };
    this.projects.set(project.id, project);
    this.store.saveProjection(`project:${project.id}`, 1, project);
    return project;
  }

  async projectStatus(payload: unknown): Promise<{
    projectId: string;
    repositoryPath: string;
    branch: string;
    head: string;
    changedFiles: string[];
    status: string;
    unifiedDiff: string;
  }> {
    const input = parseMethodPayload("project.status", payload);
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("Project does not exist");
    const repository = await verifyRepository(project.repositoryPath);
    const [statusResult, unstagedResult, stagedResult] = await Promise.all([
      git(repository.root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      git(repository.root, ["diff", "--no-ext-diff", "--binary"]),
      git(repository.root, ["diff", "--cached", "--no-ext-diff", "--binary"]),
    ]);
    const changedFiles = statusResult.stdout
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    return {
      projectId: project.id,
      repositoryPath: repository.root,
      branch: repository.branch || project.defaultBranch,
      head: repository.head,
      changedFiles,
      status: redactSecrets(statusResult.stdout).slice(0, 100_000),
      unifiedDiff: redactSecrets(
        [unstagedResult.stdout, stagedResult.stdout].filter(Boolean).join("\n"),
      ).slice(0, 500_000),
    };
  }

  async updateProject(payload: unknown): Promise<Project> {
    const input = parseMethodPayload("project.update", payload);
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("Project does not exist");
    if (input.debugCommand !== undefined) project.debugCommand = input.debugCommand || undefined;
    project.updatedAt = now();
    this.store.saveProjection(`project:${project.id}`, 1, project);
    return project;
  }

  async startDebugProcess(payload: unknown): Promise<{ projectId: string }> {
    const input = parseMethodPayload("debug.start", payload);
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("Project does not exist");
    const command = project.debugCommand?.trim();
    if (!command) throw new Error("This project has no configured debug/run command");
    if (this.runningDebugProjectIds.has(project.id))
      throw new Error("A debug process is already running for this project");
    const [executable, ...args] = command.split(/\s+/).filter(Boolean);
    if (!executable) throw new Error("This project has no configured debug/run command");
    const processId = `debug-${project.id}`;
    this.runningDebugProjectIds.add(project.id);
    this.emit({
      type: "debug.started",
      aggregateId: project.id,
      source: "system",
      payload: { command },
    });
    let child;
    try {
      child = this.debugProcesses.spawn(processId, {
        executable,
        args,
        cwd: project.repositoryPath,
      });
    } catch (error) {
      this.runningDebugProjectIds.delete(project.id);
      const message = error instanceof Error ? error.message : "Unable to start debug process";
      this.emit({
        type: "debug.exited",
        aggregateId: project.id,
        source: "system",
        payload: { error: message },
      });
      throw error;
    }
    const streamLines = async (stream: NodeJS.ReadableStream, streamName: "stdout" | "stderr") => {
      for await (const line of lines(stream)) {
        this.emit({
          type: "debug.output",
          aggregateId: project.id,
          source: "system",
          payload: { line: redactSecrets(line), stream: streamName },
        });
      }
    };
    void Promise.all([streamLines(child.stdout, "stdout"), streamLines(child.stderr, "stderr")]);
    child.once("close", (exitCode: number | null) => {
      this.runningDebugProjectIds.delete(project.id);
      this.emit({
        type: "debug.exited",
        aggregateId: project.id,
        source: "system",
        payload: { exitCode },
      });
    });
    return { projectId: project.id };
  }

  /**
   * Launches the project's configured debug/run command for a bounded window
   * so the independent reviewer gets real evidence about whether the app boots,
   * without granting the (Read Only) reviewer run any execute permission itself.
   * Generalizes across any project type, since it only shells out to whatever
   * command the user configured - no assumption of a web/browser target.
   */
  private async runBootCheck(project: Project): Promise<string> {
    const command = project.debugCommand?.trim();
    if (!command) return "";
    if (this.runningDebugProjectIds.has(project.id))
      return "A debug process is already running for this project; skipped the automatic boot check to avoid interrupting it.";
    const [executable, ...args] = command.split(/\s+/).filter(Boolean);
    if (!executable) return "";
    const processId = `review-boot-check-${project.id}`;
    let child;
    try {
      child = this.debugProcesses.spawn(processId, {
        executable,
        args,
        cwd: project.repositoryPath,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to start debug process";
      return `Unable to launch the configured debug command (\`${command}\`) for verification: ${message}`;
    }
    this.emit({
      type: "debug.started",
      aggregateId: project.id,
      source: "system",
      payload: { command, reason: "review-boot-check" },
    });
    const outputLines: string[] = [];
    const collect = async (stream: NodeJS.ReadableStream, streamName: "stdout" | "stderr") => {
      for await (const line of lines(stream)) {
        const safe = redactSecrets(line);
        if (outputLines.length < 40) outputLines.push(`[${streamName}] ${safe}`);
        this.emit({
          type: "debug.output",
          aggregateId: project.id,
          source: "system",
          payload: { line: safe, stream: streamName },
        });
      }
    };
    const [exitInfo] = await Promise.all([
      new Promise<{ exitCode: number | null; crashed: boolean }>((resolve) => {
        const timeout = setTimeout(() => {
          this.debugProcesses.cancel(processId);
        }, 8_000);
        child.once("close", (exitCode: number | null) => {
          clearTimeout(timeout);
          resolve({ exitCode, crashed: exitCode !== null && exitCode !== 0 });
        });
      }),
      collect(child.stdout, "stdout"),
      collect(child.stderr, "stderr"),
    ]);
    this.emit({
      type: "debug.exited",
      aggregateId: project.id,
      source: "system",
      payload: { exitCode: exitInfo.exitCode, reason: "review-boot-check" },
    });
    const sample = outputLines.join("\n") || "(no output captured)";
    return exitInfo.crashed
      ? `Boot check FAILED: the configured debug command (\`${command}\`) exited with code ${exitInfo.exitCode} within an 8s observation window. Output:\n${sample}`
      : `Boot check: the configured debug command (\`${command}\`) was launched and did not crash within an 8s observation window. Output sample:\n${sample}`;
  }

  stopDebugProcess(payload: unknown): { projectId: string } {
    const input = parseMethodPayload("debug.stop", payload);
    const project = this.projects.get(input.projectId);
    if (!project) throw new Error("Project does not exist");
    this.debugProcesses.cancel(`debug-${project.id}`);
    this.emit({
      type: "debug.stopped",
      aggregateId: project.id,
      source: "system",
      payload: {},
    });
    return { projectId: project.id };
  }

  createConversation(payload: unknown): Conversation {
    const input = parseMethodPayload("conversation.create", payload);
    if (!this.projects.has(input.projectId)) throw new Error("Project does not exist");
    const conversation: Conversation = {
      id: id("conversation"),
      projectId: input.projectId,
      title: input.title,
      mode: input.mode,
      createdAt: now(),
      updatedAt: now(),
    };
    this.conversations.set(conversation.id, conversation);
    this.store.saveProjection(`conversation:${conversation.id}`, 1, conversation);
    this.emit({
      type: "conversation.created",
      aggregateId: conversation.id,
      conversationId: conversation.id,
      source: "runtime",
      payload: conversation,
    });
    return conversation;
  }

  private async runPlanner(
    conversation: Conversation,
    prompt: string,
    adapterId: string,
    profileId: string,
    modelId: string | undefined,
    signal: AbortSignal,
    resumeNativeSessionId?: string,
  ): Promise<string> {
    const adapter = this.adapters.get(adapterId);
    const profile = this.profiles.find((candidate) => candidate.id === profileId);
    const project = this.projects.get(conversation.projectId);
    if (!adapter || !profile || profile.adapterId !== adapterId || profile.status !== "Ready")
      throw new Error(`No ready planning profile is configured for adapter: ${adapterId}`);
    if (!project) throw new Error("Project does not exist");
    const providerModelId = modelId ? this.models.get(modelId)?.providerModelId : undefined;
    const session: AgentSession = {
      id: id("session"),
      conversationId: conversation.id,
      adapterId,
      role: "Planner",
      state: "Ready",
      createdAt: now(),
      updatedAt: now(),
    };
    const run: AgentRun = {
      id: id("run"),
      sessionId: session.id,
      conversationId: conversation.id,
      role: "Planner",
      state: "Running",
      attempt: 1,
      startedAt: now(),
    };
    this.sessions.set(session.id, session);
    this.runs.set(run.id, run);
    this.runRequests.set(run.id, {
      conversationId: conversation.id,
      text: prompt,
      mode: "Plan",
      adapterId,
      profileId,
      modelId,
      permissionProfile: "Read Only",
    });
    this.store.saveProjection(`session:${session.id}`, 1, session);
    this.store.saveProjection(`run:${run.id}`, 1, run);
    this.store.saveProjection(`run-request:${run.id}`, 1, this.runRequests.get(run.id));
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });
    this.activeRuns.set(run.id, controller);
    this.emit({
      type: "run.started",
      aggregateId: conversation.id,
      conversationId: conversation.id,
      runId: run.id,
      source: "runtime",
      role: "Planner",
      payload: run,
    });
    this.emit({
      type: "session.created",
      aggregateId: conversation.id,
      conversationId: conversation.id,
      runId: run.id,
      source: "runtime",
      role: "Planner",
      payload: session,
    });
    let handle: Awaited<ReturnType<AgentAdapter["startSession"]>> | undefined;
    let output = "";
    try {
      handle = await adapter.startSession(
        {
          sessionId: session.id,
          conversationId: conversation.id,
          role: "Planner",
          profile,
          workspacePath: project.repositoryPath,
          modelId,
          providerModelId,
          permissionProfile: "Read Only",
          resumeNativeSessionId,
        },
        controller.signal,
      );
      session.nativeSessionId = handle.nativeSessionId;
      session.state = "Running";
      this.store.saveProjection(`session:${session.id}`, 1, session);
      for await (const event of adapter.run(
        handle,
        {
          prompt,
          mode: "Plan",
          modelId,
          providerModelId,
          permissionProfile: "Read Only",
          resumeNativeSessionId,
        },
        controller.signal,
      )) {
        if (event.kind === "run.failed")
          throw new Error(event.text || "Planner adapter reported a failed run");
        if (event.kind === "permission.requested") {
          const request = this.createPermissionRequest(run, event, "Read Only");
          request.status = "Denied";
          request.resolvedAt = now();
          this.store.saveProjection(`permission:${request.id}`, 1, request);
          this.emit({
            type: "approval.requested",
            aggregateId: conversation.id,
            conversationId: conversation.id,
            runId: run.id,
            source: "adapter",
            role: "Planner",
            payload: { ...event, requestId: request.id, permissionRequest: request },
          });
          throw new Error("Planning is read-only; the provider requested a denied permission");
        }
        if (event.kind === "text.delta") {
          output += event.text ?? "";
          this.emit({
            type: "message.delta",
            aggregateId: conversation.id,
            conversationId: conversation.id,
            runId: run.id,
            source: "adapter",
            role: "Planner",
            payload: event,
          });
        } else if (event.kind === "text.completed")
          this.emit({
            type: "message.completed",
            aggregateId: conversation.id,
            conversationId: conversation.id,
            runId: run.id,
            source: "adapter",
            role: "Planner",
            payload: { ...event, text: output },
          });
        else
          this.emit({
            type: event.kind === "file.changed" ? "file.changed" : `adapter.${event.kind}`,
            aggregateId: conversation.id,
            conversationId: conversation.id,
            runId: run.id,
            source: "adapter",
            role: "Planner",
            payload: event,
          });
      }
      session.nativeSessionId = handle.nativeSessionId;
      run.state = "Completed";
      run.completedAt = now();
      session.state = "Stopped";
      session.updatedAt = now();
      this.store.saveProjection(`session:${session.id}`, 1, session);
      this.store.saveProjection(`run:${run.id}`, 1, run);
      this.emit({
        type: "run.completed",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        runId: run.id,
        source: "runtime",
        role: "Planner",
        payload: run,
      });
      return output;
    } catch (error: unknown) {
      if (handle) {
        session.nativeSessionId = handle.nativeSessionId;
        this.store.saveProjection(`session:${session.id}`, 1, session);
      }
      run.state = controller.signal.aborted ? "Cancelled" : "Failed";
      run.completedAt = now();
      run.error = error instanceof Error ? error.message : "Planning run failed";
      session.state = controller.signal.aborted ? "Stopped" : "Crashed";
      session.updatedAt = now();
      this.store.saveProjection(`run:${run.id}`, 1, run);
      this.store.saveProjection(`session:${session.id}`, 1, session);
      this.emit({
        type: run.state === "Cancelled" ? "run.cancelled" : "run.failed",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        runId: run.id,
        source: "runtime",
        role: "Planner",
        payload: run,
      });
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.activeRuns.delete(run.id);
    }
  }

  async sendMessage(
    payload: unknown,
    signal = new AbortController().signal,
    resumeNativeSessionId?: string,
    retryContext?: { attempt: number; retryOf: string },
  ): Promise<MessageResult> {
    const input = parseMethodPayload("message.send", payload);
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) throw new Error("Conversation does not exist");
    const conversationChanges = [...this.changeRequests.values()].filter(
      (changeRequest) => changeRequest.conversationId === conversation.id,
    );
    if (input.mode === "Implement") {
      const approvedChange = conversationChanges.find((changeRequest) =>
        ["Ready", "Running", "IntegrationReady"].includes(changeRequest.state),
      );
      if (!approvedChange) return this.sendMessage({ ...input, mode: "Plan" }, signal);
      const messageId = id("message");
      this.emit({
        type: "message.created",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        source: "ui",
        payload: { id: messageId, text: input.text, mode: input.mode },
      });
      const results = await this.runReadyTasks(
        {
          changeRequestId: approvedChange.id,
          adapterId: input.adapterId,
          profileId: input.profileId,
          permissionProfile: input.permissionProfile,
        },
        signal,
      );
      const text = results.length
        ? `Started ${results.length} ready implementation task${results.length === 1 ? "" : "s"}.`
        : "No ready implementation tasks remain for this approved plan.";
      this.emit({
        type: "message.completed",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        changeRequestId: approvedChange.id,
        source: "runtime",
        payload: { id: messageId, text },
      });
      return { messageId, text, changeRequestId: approvedChange.id };
    }
    if (input.mode === "Fix") {
      const changeRequest = conversationChanges.find((candidate) =>
        ["Running", "Reviewing", "IntegrationReady"].includes(candidate.state),
      );
      const task = changeRequest
        ? [...this.tasks.values()].find(
            (candidate) =>
              candidate.changeRequestId === changeRequest.id &&
              candidate.state === "ChangesRequested",
          )
        : undefined;
      if (!task) throw new Error("Fix requires a task with requested review changes");
      const messageId = id("message");
      this.emit({
        type: "message.created",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        source: "ui",
        payload: { id: messageId, text: input.text, mode: input.mode },
      });
      const result = await this.runTask(
        {
          taskId: task.id,
          adapterId: input.adapterId,
          profileId: input.profileId,
          permissionProfile: input.permissionProfile,
          prompt: input.text,
        },
        signal,
      );
      const text = `Fix task ${task.key} produced PatchSet ${result.patchSet?.id ?? "pending"}.`;
      this.emit({
        type: "message.completed",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        changeRequestId: task.changeRequestId,
        taskId: task.id,
        runId: result.run.id,
        source: "runtime",
        role: "Worker",
        payload: { id: messageId, text },
      });
      return { messageId, text, runId: result.run.id, changeRequestId: task.changeRequestId };
    }
    if (input.mode === "Review") {
      const changeRequest = conversationChanges.find((candidate) =>
        ["Validating", "Reviewing", "IntegrationReady"].includes(candidate.state),
      );
      const patchSet = changeRequest
        ? [...this.patchSets.values()]
            .filter(
              (candidate) => this.tasks.get(candidate.taskId)?.changeRequestId === changeRequest.id,
            )
            .at(-1)
        : undefined;
      const hasValidation = patchSet
        ? [...this.validationRuns.values()].some(
            (validation) => validation.patchSetId === patchSet.id,
          )
        : false;
      if (patchSet && hasValidation) {
        const reviewChangeRequest = changeRequest!;
        const messageId = id("message");
        this.emit({
          type: "message.created",
          aggregateId: conversation.id,
          conversationId: conversation.id,
          source: "ui",
          payload: { id: messageId, text: input.text, mode: input.mode },
        });
        const reviewResult = await this.startReview(
          {
            patchSetId: patchSet.id,
            adapterId: input.adapterId,
            profileId: input.profileId,
            modelId: input.modelId,
          },
          signal,
        );
        const text = `Review ${reviewResult.review.verdict.toLowerCase()} with ${reviewResult.findings.length} finding${reviewResult.findings.length === 1 ? "" : "s"}.`;
        this.emit({
          type: "message.completed",
          aggregateId: conversation.id,
          conversationId: conversation.id,
          changeRequestId: reviewChangeRequest.id,
          source: "runtime",
          role: "Reviewer",
          payload: { id: messageId, text },
        });
        return { messageId, text, changeRequestId: reviewChangeRequest.id };
      }
      throw new Error("Review requires a validated PatchSet; run deterministic validation first");
    }
    const messageId = id("message");
    this.emit({
      type: "message.created",
      aggregateId: conversation.id,
      conversationId: conversation.id,
      source: "ui",
      payload: { id: messageId, text: input.text, mode: input.mode },
    });
    const isBuild = input.intent === "build";
    if (input.mode !== "Plan" || isBuild) {
      const project = this.projects.get(conversation.projectId);
      if (!project) throw new Error("Project does not exist");
      if (!isBuild && input.permissionProfile && input.permissionProfile !== "Read Only")
        throw new Error(
          "Conversation runs are read-only; writing requires an approved task worktree",
        );
      if (isBuild && input.permissionProfile !== "Workspace Write")
        throw new Error("Build mode requires the Workspace Write permission profile");
      const permissionProfile = isBuild ? ("Workspace Write" as const) : ("Read Only" as const);
      const role = isBuild ? ("Worker" as const) : ("Investigator" as const);
      const runId = id("run");
      const selected = this.selectRunRoute(
        role,
        {
          adapterId: input.adapterId,
          profileId: input.profileId,
          modelId: input.modelId,
        },
        permissionProfile,
        runId,
        conversation.id,
        conversation.id,
      );
      const adapterId = selected.adapterId;
      const modelId = selected.modelId;
      const providerModelId = modelId ? this.models.get(modelId)?.providerModelId : undefined;
      const adapter = this.adapters.get(adapterId);
      if (!adapter) throw new Error(`Adapter is unavailable: ${adapterId}`);
      const profile = this.profiles.find((candidate) => candidate.id === selected.profileId);
      if (!profile || profile.adapterId !== adapterId || profile.status !== "Ready")
        throw new Error(`No ready authentication profile is configured for adapter: ${adapterId}`);
      const session: AgentSession = {
        id: id("session"),
        conversationId: conversation.id,
        adapterId,
        role,
        state: "Ready",
        createdAt: now(),
        updatedAt: now(),
      };
      const run: AgentRun = {
        id: runId,
        sessionId: session.id,
        conversationId: conversation.id,
        role: session.role,
        state: "Running",
        // Set the attempt/retryOf at creation time so a retried run that FAILS
        // persists the correct attempt — previously attempt was hardcoded to 1
        // and only written back after success, so a failing retry chain kept
        // attempt=1 forever and the retry limit was never enforced.
        attempt: retryContext?.attempt ?? 1,
        retryOf: retryContext?.retryOf,
        startedAt: now(),
      };
      this.sessions.set(session.id, session);
      this.runs.set(run.id, run);
      this.runRequests.set(run.id, {
        conversationId: conversation.id,
        text: this.augmentPrompt(conversation.projectId, input.text),
        mode: input.mode,
        intent: input.intent,
        adapterId,
        profileId: profile.id,
        modelId,
        permissionProfile,
      });
      this.store.saveProjection(`session:${session.id}`, 1, session);
      this.store.saveProjection(`run:${run.id}`, 1, run);
      this.store.saveProjection(`run-request:${run.id}`, 1, this.runRequests.get(run.id));
      const controller = new AbortController();
      if (signal.aborted) controller.abort(signal.reason);
      this.activeRuns.set(run.id, controller);
      const forwardAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", forwardAbort, { once: true });
      this.emit({
        type: "run.started",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        runId: run.id,
        source: "runtime",
        role: run.role,
        payload: run,
      });
      this.emit({
        type: "session.created",
        aggregateId: conversation.id,
        conversationId: conversation.id,
        runId: run.id,
        source: "runtime",
        role: run.role,
        payload: session,
      });
      let handle: Awaited<ReturnType<AgentAdapter["startSession"]>> | undefined;
      try {
        handle = await adapter.startSession(
          {
            sessionId: session.id,
            conversationId: conversation.id,
            role: session.role,
            workspacePath: project.repositoryPath,
            profile,
            modelId,
            providerModelId,
            permissionProfile,
            resumeNativeSessionId,
          },
          controller.signal,
        );
        session.nativeSessionId = handle.nativeSessionId;
        session.state = "Running";
        this.store.saveProjection(`session:${session.id}`, 1, session);
        let output = "";
        for await (const event of adapter.run(
          handle,
          {
            prompt:
              input.mode === "Ask"
                ? `${this.augmentPrompt(conversation.projectId, input.text)}\n${askEscalationInstructions}`
                : this.augmentPrompt(conversation.projectId, input.text),
            mode: input.mode,
            intent: input.intent,
            modelId,
            providerModelId,
            permissionProfile,
            resumeNativeSessionId,
          },
          controller.signal,
        )) {
          if (event.kind === "run.failed") {
            throw new Error(event.text || "Adapter reported a failed run");
          } else if (event.kind === "text.delta") {
            output += event.text ?? "";
            this.emit({
              type: "message.delta",
              aggregateId: conversation.id,
              conversationId: conversation.id,
              runId: run.id,
              source: "adapter",
              role: run.role,
              payload: event,
            });
          } else if (event.kind === "permission.requested") {
            const request = this.createPermissionRequest(run, event, permissionProfile);
            run.state = "WaitingApproval";
            this.store.saveProjection(`run:${run.id}`, 1, run);
            this.emit({
              type: "approval.requested",
              aggregateId: conversation.id,
              conversationId: conversation.id,
              runId: run.id,
              source: "adapter",
              role: run.role,
              payload: { ...event, requestId: request.id, permissionRequest: request },
            });
            if (!adapter.resolveApproval) {
              request.status = "Denied";
              request.resolvedAt = now();
              this.store.saveProjection(`permission:${request.id}`, 1, request);
              throw new Error(
                `Adapter ${adapter.id} cannot resolve approval requests; run stopped safely`,
              );
            }
            const decision = await this.resolvePermissionForRun(request, run, controller);
            await adapter.resolveApproval(
              handle!,
              {
                requestId: request.id,
                decision: decision.startsWith("deny") ? "deny" : "allow",
              },
              controller.signal,
            );
            if (decision === "deny-and-stop")
              throw new Error("Permission denied; run stopped by user");
            run.state = "Running";
            this.store.saveProjection(`run:${run.id}`, 1, run);
          } else if (event.kind === "text.completed")
            this.emit({
              type: "message.completed",
              aggregateId: conversation.id,
              conversationId: conversation.id,
              runId: run.id,
              source: "adapter",
              role: run.role,
              payload: { ...event, text: output },
            });
          else
            this.emit({
              type: event.kind === "file.changed" ? "file.changed" : `adapter.${event.kind}`,
              aggregateId: conversation.id,
              conversationId: conversation.id,
              runId: run.id,
              source: "adapter",
              role: run.role,
              payload: event,
            });
        }
        session.nativeSessionId = handle.nativeSessionId;
        this.store.saveProjection(`session:${session.id}`, 1, session);
        run.state = "Completed";
        run.completedAt = now();
        this.store.saveProjection(`run:${run.id}`, 1, run);
        this.emit({
          type: "run.completed",
          aggregateId: conversation.id,
          conversationId: conversation.id,
          runId: run.id,
          source: "runtime",
          role: run.role,
          payload: run,
        });
        return { messageId, text: output, runId: run.id };
      } catch (error: unknown) {
        if (handle) {
          session.nativeSessionId = handle.nativeSessionId;
          this.store.saveProjection(`session:${session.id}`, 1, session);
        }
        run.state = controller.signal.aborted ? "Cancelled" : "Failed";
        run.completedAt = now();
        run.error = error instanceof Error ? error.message : "Run failed";
        this.store.saveProjection(`run:${run.id}`, 1, run);
        this.emit({
          type: run.state === "Cancelled" ? "run.cancelled" : "run.failed",
          aggregateId: conversation.id,
          conversationId: conversation.id,
          runId: run.id,
          source: "runtime",
          role: run.role,
          payload: run,
        });
        throw error;
      } finally {
        signal.removeEventListener("abort", forwardAbort);
        this.activeRuns.delete(run.id);
      }
    }
    const planProject = this.projects.get(conversation.projectId);
    if (!planProject) throw new Error("Project does not exist");
    const planRepository = await verifyRepository(planProject.repositoryPath);
    const previousChangeRequest = conversationChanges
      .filter((candidate) => ["Planning", "AwaitingSpecApproval"].includes(candidate.state))
      .at(-1);
    const previousSpecification = previousChangeRequest?.specificationRevisionId
      ? this.specifications.get(previousChangeRequest.specificationRevisionId)
      : undefined;
    const changeRequestId = previousChangeRequest?.id ?? id("cr");
    const planRisk = classifyPlanRisk(input.text);
    const autoApprove =
      this.settings.planApproval === "Auto-approve low risk" && planRisk === "Low";
    const changeRequest: ChangeRequest = previousChangeRequest
      ? {
          ...previousChangeRequest,
          state: "Planning",
          baseCommit: planRepository.head,
          targetBranch: planRepository.branch || "main",
          updatedAt: now(),
        }
      : {
          id: changeRequestId,
          projectId: conversation.projectId,
          conversationId: conversation.id,
          title: conversation.title,
          state: "Planning",
          baseCommit: planRepository.head,
          targetBranch: planRepository.branch || "main",
          integrationBranch: `agentflow/${changeRequestId}/integration`,
          createdAt: now(),
          updatedAt: now(),
        };
    if (previousChangeRequest) {
      for (const task of [...this.tasks.values()].filter(
        (candidate) => candidate.changeRequestId === changeRequest.id,
      )) {
        if (["Pending", "Blocked", "Ready"].includes(task.state))
          this.saveTask({
            ...task,
            state: transitionTask(task.state, "Cancelled"),
            lease: undefined,
          });
      }
    }
    changeRequest.state = transitionChangeRequest(changeRequest.state, "AwaitingSpecApproval");
    if (autoApprove) {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Ready");
      changeRequest.updatedAt = now();
    }
    const routing = route(
      {
        preset: "Balanced",
        role: "Planner",
        adapterId: input.adapterId,
        profileId: input.profileId,
        workerCount: this.settings.workerCount,
        executionStrategy: this.settings.workerCount > 1 ? "Parallel" : "Serial",
        permissionProfile: "Read Only",
      },
      {
        profiles: this.profiles,
        models: [...this.models.values()],
        availableAdapters: [...this.adapters.keys()],
        requestedRole: "Planner",
      },
      id("routing"),
    );
    this.routingDecisions.set(routing.id, routing);
    this.store.saveProjection(`routing:${routing.id}`, 1, routing);
    this.emit({
      type: "routing.decided",
      aggregateId: changeRequest.id,
      conversationId: conversation.id,
      changeRequestId: changeRequest.id,
      source: "runtime",
      role: "Planner",
      payload: routing,
    });
    if (!routing.selected || !routing.selected.profileId)
      throw new Error(`Planning route unavailable: ${routing.reason}`);
    const plannerPrompt = [
      this.augmentPrompt(conversation.projectId, input.text),
      "",
      "You are AgentFlow's read-only planner. Do not edit files or request elevated permissions.",
      "Return one JSON object (no markdown) with keys: summary, architectureAnalysis, design, nonGoals, acceptanceCriteria, structureChanges, decisions, validationStrategy, tasks.",
      "Each task must contain title, objective, dependsOn (prior task indexes or TASK keys), allowedWritePaths, acceptanceCriteria, and riskLevel (Low, Medium, High, or Critical).",
    ].join("\n");
    const plannerOutput = await this.runPlanner(
      conversation,
      plannerPrompt,
      routing.selected.adapterId,
      routing.selected.profileId,
      routing.selected.modelId,
      signal,
      resumeNativeSessionId,
    );
    const plannerDraft = createPlannerDraft(input.text, plannerOutput);
    const plannerSummary = plannerDraft.summary.trim().slice(0, 8_000);
    const specificationId = id("spec");
    const taskBase = (key: string, draft: PlannerTaskDraft, dependencyIds: string[]): Task => ({
      id: id("task"),
      changeRequestId: changeRequest.id,
      key,
      title: draft.title,
      state: dependencyIds.length ? "Pending" : "Ready",
      contract: {
        objective: draft.objective,
        dependencies: dependencyIds,
        allowedReadPaths: ["**/*"],
        allowedWritePaths: draft.allowedWritePaths,
        forbiddenPaths: [".git", ".env", "main", "master"],
        requiredCapabilities: ["worktree"],
        acceptanceCriteria: draft.acceptanceCriteria.length
          ? draft.acceptanceCriteria
          : ["Task output matches the approved specification"],
        requiredValidationCommands: [
          "npm run format:check",
          "npm run lint",
          "npm run typecheck",
          "npm test",
          "npm run build",
          "npm run security:scan",
        ],
        preferredExecutorRoles: ["Worker"],
        riskLevel: draft.riskLevel,
      },
      dependencyIds,
      patchSetIds: [],
      specificationRevisionId: specificationId,
      createdAt: now(),
      updatedAt: now(),
    });
    const taskKeys = plannerDraft.tasks.map(
      (_, index) => `TASK-${String(index + 1).padStart(3, "0")}`,
    );
    const plannedTasks: Task[] = [];
    plannerDraft.tasks.forEach((draft, index) => {
      const dependencyIds = [
        ...new Set(
          draft.dependsOn
            .map((dependency) => {
              const dependencyIndex =
                typeof dependency === "number"
                  ? dependency
                  : taskKeys.indexOf(String(dependency).toUpperCase());
              return dependencyIndex >= 0 && dependencyIndex < index
                ? plannedTasks[dependencyIndex]?.id
                : undefined;
            })
            .filter((dependency): dependency is string => Boolean(dependency)),
        ),
      ];
      plannedTasks.push(taskBase(taskKeys[index]!, draft, dependencyIds));
    });
    const structureRevision: StructureRevision = Object.freeze({
      id: id("structure"),
      changeRequestId: changeRequest.id,
      revision: (previousSpecification?.revision ?? 0) + 1,
      immutable: true,
      summary: plannerSummary
        ? plannerDraft.architectureAnalysis.slice(0, 500)
        : "No architecture boundary change was authorized before implementation.",
      affectedBoundaries: plannerDraft.structureChanges,
      rationale:
        plannerDraft.design ||
        "The structure revision makes the read-only planning decision explicit and durable.",
      approvedAt: autoApprove ? now() : undefined,
      createdAt: now(),
    });
    const decisionDrafts = plannerDraft.decisions.length
      ? plannerDraft.decisions
      : [
          {
            title: "Use an isolated, dependency-aware execution plan",
            rationale:
              "The planner output is stored with an immutable specification before any worker can write a worktree.",
          },
        ];
    const decisions = decisionDrafts.map((draft) => ({
      id: id("decision"),
      changeRequestId: changeRequest.id,
      title: draft.title,
      rationale: draft.rationale,
      supersedes: previousSpecification?.decisions.at(-1),
      createdAt: now(),
    }));
    this.structures.set(structureRevision.id, structureRevision);
    decisions.forEach((item) => this.decisions.set(item.id, item));
    this.store.saveProjection(`structure:${structureRevision.id}`, 1, structureRevision);
    decisions.forEach((item) => this.store.saveProjection(`decision:${item.id}`, 1, item));
    this.emit({
      type: "structure.produced",
      aggregateId: changeRequest.id,
      conversationId: conversation.id,
      changeRequestId: changeRequest.id,
      source: "runtime",
      role: "Planner",
      payload: structureRevision,
    });
    plannedTasks.forEach((task) => {
      this.tasks.set(task.id, task);
      this.scheduler.add(task);
      this.store.saveProjection(`task:${task.id}`, 1, task);
      this.emit({
        type: "task.created",
        aggregateId: changeRequest.id,
        conversationId: conversation.id,
        changeRequestId: changeRequest.id,
        taskId: task.id,
        source: "runtime",
        role: "Planner",
        payload: task,
      });
      if (task.state === "Ready")
        this.emit({
          type: "task.ready",
          aggregateId: changeRequest.id,
          conversationId: conversation.id,
          changeRequestId: changeRequest.id,
          taskId: task.id,
          source: "runtime",
          role: "Planner",
          payload: task,
        });
    });
    const specification: SpecificationRevision = Object.freeze({
      id: specificationId,
      changeRequestId: changeRequest.id,
      revision: (previousSpecification?.revision ?? 0) + 1,
      immutable: true,
      requirements: [input.text],
      nonGoals: plannerDraft.nonGoals,
      acceptanceCriteria: plannerDraft.acceptanceCriteria,
      architectureAnalysis:
        plannerSummary || "AgentFlow workflow state remains canonical outside conversation text.",
      design: plannerSummary
        ? `Plan approval precedes task execution.\n\nPlanner summary:\n${plannerSummary}`
        : "Plan approval precedes task execution.",
      structureChanges: structureRevision.affectedBoundaries,
      decisions: decisions.map((item) => item.id),
      taskDag: plannedTasks.map((task) => task.id),
      validationStrategy: plannerDraft.validationStrategy,
      risk: planRisk,
      agentAllocation: routing.selected
        ? [
            {
              taskId: plannedTasks[0]?.id ?? specificationId,
              role: "Planner" as const,
              adapterId: routing.selected.adapterId,
              modelId: routing.selected.modelId,
              reason: routing.reason,
            },
          ]
        : [],
      createdAt: now(),
      approvedAt: autoApprove ? now() : undefined,
    });
    changeRequest.specificationRevisionId = specification.id;
    changeRequest.structureRevisionId = structureRevision.id;
    conversation.changeRequestId = changeRequest.id;
    conversation.updatedAt = now();
    this.changeRequests.set(changeRequest.id, changeRequest);
    this.specifications.set(specification.id, specification);
    this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    this.store.saveProjection(`spec:${specification.id}`, 1, specification);
    this.store.saveProjection(`conversation:${conversation.id}`, 1, conversation);
    this.emit({
      type: "specification.produced",
      aggregateId: changeRequest.id,
      conversationId: conversation.id,
      changeRequestId: changeRequest.id,
      source: "runtime",
      role: "Planner",
      payload: specification,
    });
    if (autoApprove)
      this.emit({
        type: "specification.approved",
        aggregateId: changeRequest.id,
        conversationId: conversation.id,
        changeRequestId: changeRequest.id,
        source: "runtime",
        payload: { action: "auto-approve-low-risk" },
      });
    return {
      messageId,
      text: autoApprove ? "Low-risk plan approved automatically." : "Plan ready for approval.",
      changeRequestId: changeRequest.id,
      specificationRevisionId: specification.id,
    };
  }

  approvePlan(payload: unknown): ChangeRequest {
    const input = parseMethodPayload("plan.approval", payload);
    const changeRequest = this.changeRequests.get(input.changeRequestId);
    if (!changeRequest) throw new Error("Change request does not exist");
    if (input.action === "request-changes") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Planning");
      changeRequest.updatedAt = now();
      this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
      return changeRequest;
    }
    changeRequest.state = transitionChangeRequest(changeRequest.state, "Ready");
    if (input.action === "approve-and-run")
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Running");
    changeRequest.updatedAt = now();
    const specification = changeRequest.specificationRevisionId
      ? this.specifications.get(changeRequest.specificationRevisionId)
      : undefined;
    const structure = changeRequest.structureRevisionId
      ? this.structures.get(changeRequest.structureRevisionId)
      : undefined;
    if (specification && !specification.approvedAt) {
      const approvedSpecification: SpecificationRevision = Object.freeze({
        ...specification,
        id: id("spec"),
        revision: specification.revision + 1,
        approvedAt: now(),
      });
      this.specifications.set(approvedSpecification.id, approvedSpecification);
      this.store.saveProjection(`spec:${approvedSpecification.id}`, 1, approvedSpecification);
      changeRequest.specificationRevisionId = approvedSpecification.id;
      for (const task of [...this.tasks.values()].filter(
        (candidate) => candidate.changeRequestId === changeRequest.id,
      )) {
        this.saveTask({ ...task, specificationRevisionId: approvedSpecification.id });
      }
    }
    if (structure && !structure.approvedAt) {
      const approvedStructure: StructureRevision = Object.freeze({
        ...structure,
        id: id("structure"),
        revision: structure.revision + 1,
        approvedAt: now(),
      });
      this.structures.set(approvedStructure.id, approvedStructure);
      this.store.saveProjection(`structure:${approvedStructure.id}`, 1, approvedStructure);
      changeRequest.structureRevisionId = approvedStructure.id;
    }
    const approvalDecision: Decision = {
      id: id("decision"),
      changeRequestId: changeRequest.id,
      title: "Approve the specification and structure revision",
      rationale: "The user explicitly approved the immutable planning revisions before execution.",
      supersedes: specification?.decisions.at(-1),
      createdAt: now(),
    };
    this.decisions.set(approvalDecision.id, approvalDecision);
    this.store.saveProjection(`decision:${approvalDecision.id}`, 1, approvalDecision);
    this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    this.emit({
      type: "specification.approved",
      aggregateId: changeRequest.id,
      conversationId: changeRequest.conversationId,
      changeRequestId: changeRequest.id,
      source: "ui",
      payload: { action: input.action },
    });
    return changeRequest;
  }

  async resolvePermission(payload: unknown): Promise<{ requestId: string; decision: string }> {
    const input = parseMethodPayload("permission.resolve", payload);
    const request = this.permissionRequests.get(input.requestId);
    const pending = this.pendingApprovals.get(input.requestId);
    if (!request || !pending) throw new Error("Permission request is no longer pending");
    // isPermanentlyDenied() encodes hard v1 limits (secret access, automatic
    // force-push, credential-file paths) that no permission profile is ever
    // allowed to grant. A human clicking "allow" must not be able to bypass
    // those the way exceeding a profile's own dimensions already can't.
    const permanentlyDenied = isPermanentlyDenied({
      ...request.requested,
      command: request.command,
      path: request.workingDirectory,
    });
    const invalidApproval =
      !input.decision.startsWith("deny") &&
      (Boolean(permanentlyDenied) || this.permissionExceedsEffective(request));
    const decision = invalidApproval ? "deny-and-stop" : input.decision;
    request.status = decision.startsWith("deny") ? "Denied" : "Allowed";
    request.resolvedAt = now();
    this.store.saveProjection(`permission:${request.id}`, 1, request);
    const run = this.runs.get(request.runId);
    // Record scoped grants so an identical later request does not re-prompt.
    // allow-task remembers the approval for this run's task; allow-conversation
    // remembers it for the whole conversation. add-project-rule is treated as
    // a conversation-scoped grant for now (a durable project rule store is a
    // future enhancement). allow-once intentionally records nothing.
    if (!decision.startsWith("deny") && run) {
      if (decision === "allow-task") {
        const task = run.taskId ? this.tasks.get(run.taskId) : undefined;
        if (task) this.recordScopedGrant(`task:${task.id}`, request);
      } else if (decision === "allow-conversation" || decision === "add-project-rule") {
        this.recordScopedGrant(`conversation:${run.conversationId}`, request);
      }
    }
    this.emit({
      type: "approval.resolved",
      aggregateId: input.requestId,
      conversationId: run?.conversationId,
      runId: run?.id,
      source: "ui",
      payload: { ...input, decision },
    });
    pending.resolve(decision);
    return { ...input, decision };
  }

  stopRun(payload: unknown): { runId: string; stopped: boolean } {
    const input = parseMethodPayload("run.stop", payload);
    const controller = this.activeRuns.get(input.runId);
    if (!controller) return { runId: input.runId, stopped: false };
    controller.abort(new Error("Stopped by user"));
    return { runId: input.runId, stopped: true };
  }

  private refreshTaskReadiness(): void {
    this.scheduler.refreshReadiness();
    for (const task of this.scheduler.all()) {
      const current = this.tasks.get(task.id);
      if (!current || current.state !== task.state || current.lease?.id !== task.lease?.id)
        this.saveTask(task);
    }
  }

  private saveTask(task: Task): Task {
    this.tasks.set(task.id, task);
    this.scheduler.add(task);
    this.store.saveProjection(`task:${task.id}`, 1, task);
    return task;
  }

  private recordTaskFailure(
    task: Task,
    run: AgentRun,
    session: AgentSession,
    signal: AbortSignal,
    error: unknown,
  ): void {
    const failed = this.scheduler.complete(task.id, signal.aborted ? "Cancelled" : "Failed");
    this.store.deleteTaskLease(task.id);
    this.saveTask(failed);
    run.state = signal.aborted ? "Cancelled" : "Failed";
    run.error = error instanceof Error ? error.message : "Task run failed";
    run.completedAt = now();
    session.state = signal.aborted ? "Stopped" : "Crashed";
    session.updatedAt = now();
    this.sessions.set(session.id, session);
    this.runs.set(run.id, run);
    this.store.saveProjection(`run:${run.id}`, 1, run);
    this.store.saveProjection(`session:${session.id}`, 1, session);
    if (run.workspaceId) {
      const workspace = this.workspaces.get(run.workspaceId);
      if (workspace) {
        workspace.status = "Orphaned";
        this.store.saveProjection(`workspace:${workspace.id}`, 1, workspace);
      }
    }
    this.emit({
      type: run.state === "Cancelled" ? "run.cancelled" : "run.failed",
      aggregateId: task.changeRequestId,
      taskId: task.id,
      runId: run.id,
      source: "runtime",
      role: "Worker",
      payload: run,
    });
  }

  // A task's worktree is otherwise always cut from the change request's
  // original baseCommit, so a Worker on a dependent task never actually sees
  // the files a prerequisite task wrote — dependsOn only gated scheduling
  // order, not the code the dependent task starts from. Cherry-pick each
  // dependency's latest approved PatchSet onto the fresh worktree before the
  // agent session starts; diff()/commit() downstream compare against HEAD,
  // so this only makes the dependency's files visible to the worker without
  // pulling them into the task's own PatchSet.
  private async applyDependencyPatchSets(task: Task, workspace: Workspace): Promise<void> {
    if (!task.dependencyIds.length) return;
    let head = workspace.baseCommit;
    for (const dependencyId of task.dependencyIds) {
      const dependencyPatchSet = [...this.patchSets.values()]
        .filter(
          (candidate) => candidate.taskId === dependencyId && candidate.reviewState === "Approved",
        )
        .sort((left, right) => right.sequence - left.sequence)[0];
      if (!dependencyPatchSet) {
        const dependencyTask = this.tasks.get(dependencyId);
        throw new Error(
          `Task ${task.key} depends on ${dependencyTask?.key ?? dependencyId}, which has no approved PatchSet yet`,
        );
      }
      const result = await git(workspace.path, ["cherry-pick", dependencyPatchSet.resultCommit]);
      if (result.exitCode !== 0) {
        await git(workspace.path, ["cherry-pick", "--abort"]);
        const dependencyTask = this.tasks.get(dependencyId);
        throw new Error(
          `Could not bring dependency ${dependencyTask?.key ?? dependencyId}'s changes into task ${task.key}'s worktree: ${result.stderr.slice(0, 2_000)}`,
        );
      }
      head = dependencyPatchSet.resultCommit;
    }
    const resolved = await git(workspace.path, ["rev-parse", "HEAD"]);
    workspace.baseCommit = resolved.exitCode === 0 ? resolved.stdout.trim() : head;
  }

  async runTask(
    payload: unknown,
    signal = new AbortController().signal,
    retryContext?: { attempt: number; retryOf: string },
  ): Promise<{ task: Task; run: AgentRun; workspace: Workspace; patchSet?: PatchSet }> {
    const input = parseMethodPayload("task.run", payload);
    let task = this.tasks.get(input.taskId);
    if (!task) throw new Error("Task does not exist");
    const changeRequest = this.changeRequests.get(task.changeRequestId);
    if (
      !changeRequest ||
      !["Ready", "Running", "Reviewing", "IntegrationReady"].includes(changeRequest.state)
    )
      throw new Error("Change request is not ready to run");
    const project = this.projects.get(changeRequest.projectId);
    if (!project) throw new Error("Project does not exist");
    const runId = id("run");
    const permissionProfile: PermissionProfileName = input.permissionProfile ?? "Workspace Write";
    const permissionDimensions =
      permissionProfile === "Custom" ? this.settings.customPermissionDimensions : undefined;
    if (
      task.contract.allowedWritePaths.length > 0 &&
      !["Workspace Write", "Elevated with Approval"].includes(permissionProfile) &&
      !(permissionProfile === "Custom" && Boolean(permissionDimensions?.writePaths.length))
    )
      throw new Error(
        `Permission profile ${permissionProfile} cannot execute a task with write paths`,
      );
    const selected = this.selectRunRoute(
      "Worker",
      {
        adapterId: input.adapterId,
        profileId: input.profileId,
        modelId: input.modelId,
      },
      permissionProfile,
      runId,
      changeRequest.id,
      changeRequest.conversationId,
      changeRequest.id,
    );
    const adapterId = selected.adapterId;
    const modelId = selected.modelId;
    const providerModelId = modelId ? this.models.get(modelId)?.providerModelId : undefined;
    const adapter = this.adapters.get(adapterId);
    const profile = this.profiles.find((candidate) => candidate.id === selected.profileId);
    if (!adapter) throw new Error(`Adapter is unavailable: ${adapterId}`);
    if (input.resumeNativeSessionId && adapter.capabilities?.resume !== true)
      throw new Error(`Adapter ${adapter.id} does not support native session resume`);
    if (!profile || profile.adapterId !== adapterId || profile.status !== "Ready")
      throw new Error(`No ready authentication profile is configured for adapter: ${adapterId}`);
    // An explicit re-run may reset a task that has produced a PatchSet or whose
    // validation failed, so it can be executed again. Do NOT force-complete a
    // task in ReviewRequested — an independent review run owns it at that point,
    // and forcing it to Failed would later make the review's complete("Approved")
    // throw an illegal transition. Let the review finish (or be stopped) first.
    if (["PatchProduced", "ValidationFailed"].includes(task.state)) {
      task = this.scheduler.complete(task.id, "Failed", runId);
      this.saveTask(task);
    }
    if (["ChangesRequested", "Failed", "Cancelled"].includes(task.state)) {
      task = this.scheduler.requeue(task.id, runId);
      this.saveTask(task);
    }
    if (changeRequest.state === "IntegrationReady") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Running");
      changeRequest.updatedAt = now();
      this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    }
    if (changeRequest.state === "Ready") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Running");
      changeRequest.updatedAt = now();
      this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    }
    if (changeRequest.state === "Reviewing") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Running");
      changeRequest.updatedAt = now();
      this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    }
    const leased = this.scheduler.claim(task.id, runId);
    if (leased.lease) this.store.saveTaskLease(leased.lease);
    const runningTask = this.scheduler.start(task.id, runId);
    this.saveTask(runningTask);
    const runController = new AbortController();
    const forwardAbort = () => runController.abort(signal.reason);
    if (signal.aborted) runController.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });
    this.activeRuns.set(runId, runController);
    const session: AgentSession = {
      id: id("session"),
      conversationId: changeRequest.conversationId,
      taskId: task.id,
      adapterId,
      role: "Worker",
      state: "Ready",
      createdAt: now(),
      updatedAt: now(),
    };
    const run: AgentRun = {
      id: runId,
      sessionId: session.id,
      conversationId: changeRequest.conversationId,
      taskId: task.id,
      role: "Worker",
      state: "Running",
      // Set attempt/retryOf at creation so a retried run that fails still
      // persists the correct attempt (see sendMessage for the full rationale).
      attempt: retryContext?.attempt ?? 1,
      retryOf: retryContext?.retryOf,
      workspaceId: undefined,
      startedAt: now(),
    };
    let repository: { root: string; head: string; branch: string };
    try {
      repository = await verifyRepository(project.repositoryPath);
      const baseCommit = changeRequest.baseCommit ?? repository.head;
      const baseCheck = await git(project.repositoryPath, [
        "cat-file",
        "-e",
        `${baseCommit}^{commit}`,
      ]);
      if (baseCheck.exitCode !== 0)
        throw new Error(`Planned base commit is no longer available: ${baseCommit}`);
      repository = { ...repository, head: baseCommit };
    } catch (error: unknown) {
      this.recordTaskFailure(task, run, session, runController.signal, error);
      signal.removeEventListener("abort", forwardAbort);
      this.activeRuns.delete(runId);
      throw error;
    }
    const workspaceDraft: Pick<
      Workspace,
      "id" | "projectId" | "changeRequestId" | "taskId" | "branch" | "baseCommit"
    > & { taskKey: string; runId: string } = {
      id: id("workspace"),
      projectId: project.id,
      changeRequestId: changeRequest.id,
      taskId: task.id,
      branch: `agentflow/${changeRequest.id}/${task.key}/${runId}`,
      baseCommit: repository.head,
      taskKey: task.key,
      runId,
    };
    let workspace: Workspace;
    try {
      workspace = await this.worktrees.create(project.repositoryPath, workspaceDraft);
    } catch (error: unknown) {
      this.recordTaskFailure(task, run, session, runController.signal, error);
      signal.removeEventListener("abort", forwardAbort);
      this.activeRuns.delete(runId);
      throw error;
    }
    try {
      await this.applyDependencyPatchSets(task, workspace);
    } catch (error: unknown) {
      await this.worktrees.remove(project.repositoryPath, workspace.path).catch(() => undefined);
      this.recordTaskFailure(task, run, session, runController.signal, error);
      signal.removeEventListener("abort", forwardAbort);
      this.activeRuns.delete(runId);
      throw error;
    }
    workspace.status = "Running";
    workspace.ownerRunId = run.id;
    run.workspaceId = workspace.id;
    session.state = "Running";
    this.sessions.set(session.id, session);
    this.runs.set(run.id, run);
    this.workspaces.set(workspace.id, workspace);
    this.runRequests.set(run.id, {
      conversationId: run.conversationId,
      text: this.augmentPrompt(changeRequest.projectId, input.prompt ?? task.contract.objective),
      mode: "Implement",
      intent: "build",
      adapterId,
      profileId: profile.id,
      modelId,
      permissionProfile,
      permissionDimensions,
    });
    this.store.saveProjection(`session:${session.id}`, 1, session);
    this.store.saveProjection(`run:${run.id}`, 1, run);
    this.store.saveProjection(`run-request:${run.id}`, 1, this.runRequests.get(run.id));
    this.store.saveProjection(`workspace:${workspace.id}`, 1, workspace);
    this.emit({
      type: "task.started",
      aggregateId: changeRequest.id,
      conversationId: changeRequest.conversationId,
      changeRequestId: changeRequest.id,
      taskId: task.id,
      runId: run.id,
      source: "runtime",
      role: "Worker",
      payload: { task: leased, run, workspace },
    });
    try {
      const handle = await adapter.startSession(
        {
          sessionId: session.id,
          conversationId: session.conversationId,
          taskId: task.id,
          role: "Worker",
          workspacePath: workspace.path,
          profile,
          modelId,
          providerModelId,
          permissionProfile,
          permissionDimensions,
          resumeNativeSessionId: input.resumeNativeSessionId,
        },
        runController.signal,
      );
      session.nativeSessionId = handle.nativeSessionId;
      this.store.saveProjection(`session:${session.id}`, 1, session);
      const result = await this.orchestrator.execute(
        adapter,
        { session, run, workspace, task },
        {
          prompt: input.prompt ?? task.contract.objective,
          mode: "Implement",
          intent: "build",
          modelId,
          providerModelId,
          permissionProfile,
          permissionDimensions,
          resumeNativeSessionId: input.resumeNativeSessionId,
        },
        runController.signal,
        {
          onPermissionRequest: async (event, sessionHandle) => {
            const request = this.createPermissionRequest(run, event, permissionProfile);
            run.state = "WaitingApproval";
            this.store.saveProjection(`run:${run.id}`, 1, run);
            this.emit({
              type: "approval.requested",
              aggregateId: changeRequest.id,
              conversationId: changeRequest.conversationId,
              changeRequestId: changeRequest.id,
              taskId: task.id,
              runId: run.id,
              source: "adapter",
              role: "Worker",
              payload: { ...event, requestId: request.id, permissionRequest: request },
            });
            if (!adapter.resolveApproval) {
              request.status = "Denied";
              request.resolvedAt = now();
              this.store.saveProjection(`permission:${request.id}`, 1, request);
              throw new Error(
                `Adapter ${adapter.id} cannot resolve approval requests; worker run stopped safely`,
              );
            }
            const decision = await this.resolvePermissionForRun(request, run, runController);
            await adapter.resolveApproval(
              sessionHandle,
              {
                requestId: request.id,
                decision: decision.startsWith("deny") ? "deny" : "allow",
              },
              runController.signal,
            );
            if (decision === "deny-and-stop")
              throw new Error("Permission denied; run stopped by user");
            run.state = "Running";
            this.store.saveProjection(`run:${run.id}`, 1, run);
          },
        },
      );
      if (!result.patchSet) throw new Error("Writing task completed without a PatchSet");
      const patchSet = result.patchSet;
      this.patchSets.set(patchSet.id, patchSet);
      this.store.saveProjection(`patchset:${patchSet.id}`, 1, patchSet);
      const completed = this.scheduler.complete(task.id, "PatchProduced");
      this.store.deleteTaskLease(task.id);
      completed.patchSetIds = [...completed.patchSetIds, patchSet.id];
      this.saveTask(completed);
      run.state = "Completed";
      run.completedAt = now();
      session.state = "Stopped";
      workspace.status = "Ready";
      this.store.saveProjection(`run:${run.id}`, 1, run);
      this.store.saveProjection(`session:${session.id}`, 1, session);
      this.store.saveProjection(`workspace:${workspace.id}`, 1, workspace);
      this.emit({
        type: "patchset.created",
        aggregateId: patchSet.id,
        conversationId: run.conversationId,
        changeRequestId: changeRequest.id,
        taskId: task.id,
        runId: run.id,
        source: "runtime",
        role: "Worker",
        payload: patchSet,
      });
      return { task: completed, run, workspace, patchSet };
    } catch (error: unknown) {
      this.recordTaskFailure(task, run, session, runController.signal, error);
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      this.activeRuns.delete(runId);
    }
  }

  async runReadyTasks(
    payload: unknown,
    signal = new AbortController().signal,
  ): Promise<Array<{ task: Task; run: AgentRun; workspace: Workspace; patchSet?: PatchSet }>> {
    const input = parseMethodPayload("task.run.ready", payload);
    this.refreshTaskReadiness();
    const readyTasks = [...this.tasks.values()].filter(
      (task) => task.changeRequestId === input.changeRequestId && task.state === "Ready",
    );
    const concurrency = Math.max(
      1,
      Math.min(this.settings.workerCount, Number(this.settings.concurrencyLimit)),
    );
    const results: Array<{
      task: Task;
      run: AgentRun;
      workspace: Workspace;
      patchSet?: PatchSet;
    }> = [];
    // Dynamic pool scheduling: launch up to `concurrency` tasks at once.
    // As soon as one finishes, the next ready task starts immediately —
    // no waiting for the entire batch to complete.
    const queue = [...readyTasks];
    const runOne = async (): Promise<void> => {
      const task = queue.shift();
      if (!task) return;
      try {
        const result = await this.runTask(
          {
            taskId: task.id,
            adapterId: input.adapterId,
            profileId: input.profileId,
            modelId: input.modelId,
            permissionProfile: input.permissionProfile,
          },
          signal,
        );
        results.push(result);
      } catch {
        // A single task failure must not abort other concurrent tasks.
        // runTask() already records the failure via recordTaskFailure()
        // before rethrowing; here we just keep the queue moving.
        if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
      }
    };
    const launchWorker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
        await runOne();
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, readyTasks.length) }, () =>
      launchWorker(),
    );
    await Promise.all(workers);
    return results;
  }

  async runValidation(
    payload: unknown,
    signal = new AbortController().signal,
  ): Promise<ValidationRun[]> {
    const input = parseMethodPayload("validation.run", payload);
    const patchSet = this.patchSets.get(input.patchSetId);
    if (!patchSet) throw new Error("PatchSet does not exist");
    const task = this.tasks.get(patchSet.taskId);
    const producingRun = this.runs.get(patchSet.producingRunId);
    const workspace = producingRun?.workspaceId
      ? this.workspaces.get(producingRun.workspaceId)
      : task
        ? [...this.workspaces.values()].find((item) => item.ownerRunId === patchSet.producingRunId)
        : undefined;
    if (!task || !workspace) throw new Error("PatchSet workspace does not exist");
    const changeRequest = this.changeRequests.get(task.changeRequestId);
    if (changeRequest?.state === "Running") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Validating");
      changeRequest.updatedAt = now();
      this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    // Read the workspace's package.json scripts once so we can skip npm
    // validation commands that the project does not actually define. The
    // planner emits a fixed set of npm scripts (format:check, lint, etc.);
    // on a non-npm project those commands would all fail and block every
    // task. Skipping undefined scripts keeps validation meaningful instead
    // of producing a wall of spurious blocking failures.
    let packageScripts: Set<string> | undefined;
    try {
      const raw = await readFile(path.join(workspace.path, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      packageScripts = new Set(Object.keys(parsed.scripts ?? {}));
    } catch {
      // No package.json (or unreadable): don't filter — let npm fail naturally
      // so the user sees the project isn't an npm project.
      packageScripts = undefined;
    }
    const checks = task.contract.requiredValidationCommands
      .map((command): {
        name: string;
        executable: string;
        args: string[];
        command: string;
        blocking: boolean;
      } | undefined => {
        const runScript = command.startsWith("npm run ") ? command.slice("npm run ".length) : null;
        if (command === "npm test")
          return {
            name: "tests",
            executable: npm,
            args: ["test"],
            command,
            blocking: this.settings.blockOnFailingValidation,
          };
        if (runScript) {
          // Skip npm scripts the project does not define (non-npm or partial
          // toolchains) so validation isn't blocked by a missing script.
          if (packageScripts && !packageScripts.has(runScript)) return undefined;
          return {
            name: runScript.replaceAll(":", "-"),
            executable: npm,
            args: ["run", runScript],
            command,
            blocking: this.settings.blockOnFailingValidation || runScript === "security:scan",
          };
        }
        // Support non-npm commands (e.g. cargo test, make test, go test, pnpm test)
        const parts = command.split(/\s+/).filter(Boolean);
        if (parts.length === 0) return undefined;
        const executable = parts[0]!;
        const args = parts.slice(1);
        const name = args.length ? `${executable}-${args[0]}` : executable;
        return {
          name: name.slice(0, 60),
          executable,
          args,
          command,
          blocking: this.settings.blockOnFailingValidation,
        };
      })
      .filter((check): check is {
        name: string;
        executable: string;
        args: string[];
        command: string;
        blocking: boolean;
      } => Boolean(check));
    this.emit({
      type: "validation.started",
      aggregateId: patchSet.id,
      taskId: task.id,
      runId: patchSet.producingRunId,
      source: "runtime",
      role: "Worker",
      payload: { patchSetId: patchSet.id, checks },
    });
    const results = await this.validation.run(workspace.path, patchSet.id, checks, signal, false);
    results.forEach((result) => {
      this.validationRuns.set(result.id, result);
      this.store.saveProjection(`validation:${result.id}`, 1, result);
      this.emit({
        type: "validation.completed",
        aggregateId: patchSet.id,
        taskId: task.id,
        runId: patchSet.producingRunId,
        source: "runtime",
        role: "Worker",
        payload: result,
      });
    });
    try {
      if (!results.length)
        throw new Error("No supported deterministic validation checks were configured");
      assertDeterministicGate(results);
      const next = this.scheduler.complete(task.id, "ReviewRequested");
      this.saveTask(next);
      this.emit({
        type: "review.requested",
        aggregateId: patchSet.id,
        conversationId: changeRequest?.conversationId,
        taskId: task.id,
        runId: patchSet.producingRunId,
        source: "runtime",
        role: "Reviewer",
        payload: { patchSetId: patchSet.id },
      });
    } catch (error: unknown) {
      const next = this.scheduler.complete(task.id, "ValidationFailed");
      this.saveTask(next);
      // Revert changeRequest from Validating back to Running so the user can retry.
      if (changeRequest?.state === "Validating") {
        changeRequest.state = transitionChangeRequest(changeRequest.state, "Running");
        changeRequest.updatedAt = now();
        this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Blocking validation failed for PatchSet ${patchSet.id}: ${detail}`);
    }
    return results;
  }

  async startReview(
    payload: unknown,
    signal = new AbortController().signal,
  ): Promise<{ review: ReviewRound; findings: ReviewFinding[]; approvedPatchSet?: PatchSet }> {
    const input = parseMethodPayload("review.start", payload);
    const patchSet = this.patchSets.get(input.patchSetId);
    if (!patchSet) throw new Error("PatchSet does not exist");
    const validations = [...this.validationRuns.values()].filter(
      (run) => run.patchSetId === patchSet.id,
    );
    if (validations.length === 0)
      throw new Error(`PatchSet ${patchSet.id} has no validation runs; run validation before review`);
    assertDeterministicGate(validations);
    const reviewerRunId = id("run");
    if (reviewerRunId === patchSet.producingRunId)
      throw new Error("Reviewer run must be independent");
    const task = this.tasks.get(patchSet.taskId)!;
    const changeRequest = this.changeRequests.get(task.changeRequestId)!;
    const project = this.projects.get(changeRequest.projectId);
    if (!project) throw new Error("Project does not exist");
    const selected = this.selectRunRoute(
      "Reviewer",
      { adapterId: input.adapterId, profileId: input.profileId, modelId: input.modelId },
      "Read Only",
      reviewerRunId,
      changeRequest.id,
      changeRequest.conversationId,
      changeRequest.id,
    );
    const reviewAdapterId = selected.adapterId;
    const reviewAdapter = this.adapters.get(reviewAdapterId);
    const reviewProfile = this.profiles.find((profile) => profile.id === selected.profileId);
    const modelId = selected.modelId;
    const providerModelId = modelId ? this.models.get(modelId)?.providerModelId : undefined;
    if (!reviewAdapter || !reviewProfile)
      throw new Error(`Selected reviewer route is unavailable: ${reviewAdapterId}`);
    if (changeRequest.state === "Validating") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Reviewing");
      changeRequest.updatedAt = now();
      this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    }
    const reviewerSession: AgentSession = {
      id: id("session"),
      conversationId: changeRequest.conversationId,
      taskId: task.id,
      adapterId: reviewAdapterId,
      role: "Reviewer",
      state: "Running",
      createdAt: now(),
      updatedAt: now(),
    };
    const reviewerRun: AgentRun = {
      id: reviewerRunId,
      sessionId: reviewerSession.id,
      conversationId: changeRequest.conversationId,
      taskId: task.id,
      role: "Reviewer",
      state: "Running",
      attempt: 1,
      workspaceId: undefined,
      startedAt: now(),
    };
    this.sessions.set(reviewerSession.id, reviewerSession);
    this.runs.set(reviewerRun.id, reviewerRun);
    this.store.saveProjection(`session:${reviewerSession.id}`, 1, reviewerSession);
    this.store.saveProjection(`run:${reviewerRun.id}`, 1, reviewerRun);
    this.emit({
      type: "run.started",
      aggregateId: changeRequest.id,
      conversationId: changeRequest.conversationId,
      changeRequestId: changeRequest.id,
      taskId: task.id,
      runId: reviewerRun.id,
      source: "runtime",
      role: "Reviewer",
      payload: reviewerRun,
    });
    this.emit({
      type: "session.created",
      aggregateId: changeRequest.id,
      conversationId: changeRequest.conversationId,
      changeRequestId: changeRequest.id,
      taskId: task.id,
      runId: reviewerRun.id,
      source: "runtime",
      role: "Reviewer",
      payload: reviewerSession,
    });
    const reviewId = id("review");
    const findings: ReviewFinding[] = [];
    let reviewWorkspace: Workspace | undefined;
    try {
      reviewWorkspace = await this.worktrees.create(project.repositoryPath, {
        id: id("workspace"),
        projectId: project.id,
        changeRequestId: changeRequest.id,
        taskId: task.id,
        branch: `agentflow/${changeRequest.id}/${task.key}/review/${reviewerRunId}`,
        baseCommit: patchSet.resultCommit,
        taskKey: `${task.key}-review`,
        runId: reviewerRunId,
      });
      this.workspaces.set(reviewWorkspace.id, reviewWorkspace);
      this.store.saveProjection(`workspace:${reviewWorkspace.id}`, 1, reviewWorkspace);
      reviewerSession.workspaceId = reviewWorkspace.id;
      reviewerRun.workspaceId = reviewWorkspace.id;
      this.store.saveProjection(`session:${reviewerSession.id}`, 1, reviewerSession);
      this.store.saveProjection(`run:${reviewerRun.id}`, 1, reviewerRun);
      const handle = await reviewAdapter.startSession(
        {
          sessionId: reviewerSession.id,
          conversationId: reviewerSession.conversationId,
          taskId: task.id,
          role: "Reviewer",
          workspacePath: reviewWorkspace?.path,
          profile: reviewProfile,
          modelId,
          providerModelId,
          permissionProfile: "Read Only",
        },
        signal,
      );
      reviewerSession.nativeSessionId = handle.nativeSessionId;
      this.store.saveProjection(`session:${reviewerSession.id}`, 1, reviewerSession);
      this.runRequests.set(reviewerRun.id, {
        conversationId: reviewerRun.conversationId,
        text: `Review PatchSet ${patchSet.id} for task ${task.key}`,
        mode: "Review",
        adapterId: reviewAdapterId,
        profileId: reviewProfile.id,
        modelId,
        permissionProfile: "Read Only",
      });
      this.store.saveProjection(
        `run-request:${reviewerRun.id}`,
        1,
        this.runRequests.get(reviewerRun.id),
      );
      const bootCheckSummary = await this.runBootCheck(project);
      const reviewPrompt = bootCheckSummary
        ? `Review PatchSet ${patchSet.id} for task ${task.key}. Check correctness, security, and contract compliance.\n\nThe following is evidence from automatically launching this project's configured debug/run command, captured by the system before your review started (you do not need to launch it yourself):\n\n${bootCheckSummary}`
        : `Review PatchSet ${patchSet.id} for task ${task.key}. Check correctness, security, and contract compliance.`;
      for await (const event of reviewAdapter.run(
        handle,
        {
          prompt: reviewPrompt,
          mode: "Review",
          modelId,
          providerModelId,
          permissionProfile: "Read Only",
        },
        signal,
      )) {
        if (event.kind === "run.failed") {
          throw new Error(event.text || "Reviewer adapter reported a failed run");
        } else if (event.kind === "review.finding" && event.reviewFinding) {
          const finding: ReviewFinding = {
            id: id("finding"),
            reviewRoundId: reviewId,
            severity: event.reviewFinding.severity,
            category: event.reviewFinding.category,
            file: event.reviewFinding.file,
            line: event.reviewFinding.line,
            message: event.reviewFinding.message,
            evidence: event.reviewFinding.evidence ?? "Provider supplied a structured finding.",
            violatedRule: event.reviewFinding.violatedRule,
            suggestedAction: event.reviewFinding.suggestedAction,
            status: "Open",
          };
          findings.push(finding);
          this.reviewFindings.set(finding.id, finding);
          this.store.saveProjection(`finding:${finding.id}`, 1, finding);
          this.emit({
            type: "finding.created",
            aggregateId: changeRequest.id,
            conversationId: changeRequest.conversationId,
            changeRequestId: changeRequest.id,
            taskId: task.id,
            runId: reviewerRun.id,
            source: "adapter",
            role: "Reviewer",
            payload: finding,
          });
        } else if (event.kind === "text.delta")
          this.emit({
            type: "message.delta",
            aggregateId: changeRequest.id,
            conversationId: changeRequest.conversationId,
            changeRequestId: changeRequest.id,
            taskId: task.id,
            runId: reviewerRun.id,
            source: "adapter",
            role: "Reviewer",
            payload: event,
          });
        else
          this.emit({
            type: `adapter.${event.kind}`,
            aggregateId: changeRequest.id,
            conversationId: changeRequest.conversationId,
            changeRequestId: changeRequest.id,
            taskId: task.id,
            runId: reviewerRun.id,
            source: "adapter",
            role: "Reviewer",
            payload: event,
          });
      }
      const reviewDiff = await this.worktrees.diff(reviewWorkspace.path);
      if (reviewDiff.files.length) throw new Error("Reviewer modified its read-only worktree");
      // Remove the read-only review worktree now that the review is done — it
      // has no further use and would otherwise leak a worktree directory and
      // branch on every review. Mirror the task path's cleanup.
      await this.worktrees.remove(project.repositoryPath, reviewWorkspace.path).catch(() => undefined);
      reviewWorkspace.status = "Released";
      this.store.saveProjection(`workspace:${reviewWorkspace.id}`, 1, reviewWorkspace);
    } catch (error: unknown) {
      // The review failed (adapter error, reviewer wrote files, or abort).
      // Remove the review worktree so it does not leak; mark it Released so the
      // orphan reclaimer does not reprocess it on the next restart.
      if (reviewWorkspace) {
        await this.worktrees
          .remove(project.repositoryPath, reviewWorkspace.path)
          .catch(() => undefined);
        reviewWorkspace.status = "Released";
        this.store.saveProjection(`workspace:${reviewWorkspace.id}`, 1, reviewWorkspace);
      }
      reviewerRun.state = signal.aborted ? "Cancelled" : "Failed";
      reviewerRun.completedAt = now();
      reviewerRun.error = error instanceof Error ? error.message : "Review run failed";
      reviewerSession.state = signal.aborted ? "Stopped" : "Crashed";
      reviewerSession.updatedAt = now();
      this.store.saveProjection(`run:${reviewerRun.id}`, 1, reviewerRun);
      this.store.saveProjection(`session:${reviewerSession.id}`, 1, reviewerSession);
      this.emit({
        type: signal.aborted ? "run.cancelled" : "run.failed",
        aggregateId: changeRequest.id,
        conversationId: changeRequest.conversationId,
        changeRequestId: changeRequest.id,
        taskId: task.id,
        runId: reviewerRun.id,
        source: "runtime",
        role: "Reviewer",
        payload: reviewerRun,
      });
      throw error;
    }
    const review: ReviewRound = {
      id: reviewId,
      changeRequestId: task.changeRequestId,
      patchSetId: patchSet.id,
      reviewerRunId,
      verdict: "Approved",
      independent: true,
      createdAt: now(),
      completedAt: now(),
    };
    const gate = reviewGate(patchSet.producingRunId, reviewerRunId, findings);
    review.verdict = gate.approved ? "Approved" : "Changes requested";
    this.reviewRounds.set(review.id, review);
    this.store.saveProjection(`review:${review.id}`, 1, review);
    reviewerRun.state = "Completed";
    reviewerRun.completedAt = now();
    reviewerSession.state = "Stopped";
    reviewerSession.updatedAt = now();
    this.store.saveProjection(`run:${reviewerRun.id}`, 1, reviewerRun);
    this.store.saveProjection(`session:${reviewerSession.id}`, 1, reviewerSession);
    this.emit({
      type: "review.completed",
      aggregateId: patchSet.id,
      conversationId: reviewerRun.conversationId,
      changeRequestId: review.changeRequestId,
      runId: reviewerRunId,
      source: "runtime",
      role: "Reviewer",
      payload: review,
    });
    this.emit({
      type: "run.completed",
      aggregateId: changeRequest.id,
      conversationId: changeRequest.conversationId,
      changeRequestId: changeRequest.id,
      taskId: task.id,
      runId: reviewerRun.id,
      source: "runtime",
      role: "Reviewer",
      payload: reviewerRun,
    });
    const nextTask = this.scheduler.complete(
      task.id,
      gate.approved ? "Approved" : "ChangesRequested",
    );
    this.saveTask(nextTask);
    if (gate.approved && changeRequest.state === "Reviewing") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "IntegrationReady");
      changeRequest.updatedAt = now();
      this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    }
    const approvedPatchSet = gate.approved
      ? Object.freeze({
          ...patchSet,
          id: id("patchset"),
          sequence: patchSet.sequence + 1,
          supersedes: patchSet.id,
          reviewState: "Approved" as const,
        })
      : undefined;
    if (approvedPatchSet) {
      this.patchSets.set(approvedPatchSet.id, approvedPatchSet);
      this.store.saveProjection(`patchset:${approvedPatchSet.id}`, 1, approvedPatchSet);
    }
    if (approvedPatchSet && this.settings.integrationPolicy === "Auto when approved") {
      const changeTasks = [...this.tasks.values()].filter(
        (candidate) => candidate.changeRequestId === changeRequest.id,
      );
      const allTasksApproved =
        changeTasks.length > 0 &&
        changeTasks.every((candidate) => ["Approved", "Integrated"].includes(candidate.state));
      if (allTasksApproved) {
        const latestApprovedPatchSets = changeTasks
          .map(
            (candidate) =>
              [...this.patchSets.values()]
                .filter(
                  (candidatePatchSet) =>
                    candidatePatchSet.taskId === candidate.id &&
                    candidatePatchSet.reviewState === "Approved",
                )
                .sort((left, right) => right.sequence - left.sequence)[0],
          )
          .filter((candidatePatchSet): candidatePatchSet is PatchSet => Boolean(candidatePatchSet));
        if (latestApprovedPatchSets.length === changeTasks.length)
          await this.integrate({
            changeRequestId: changeRequest.id,
            patchSetIds: latestApprovedPatchSets.map((candidate) => candidate.id),
          });
      }
    }
    return { review, findings, approvedPatchSet };
  }

  async integrate(payload: unknown): Promise<IntegrationAttempt> {
    const input = parseMethodPayload("integration.apply", payload);
    const changeRequest = this.changeRequests.get(input.changeRequestId);
    if (!changeRequest) throw new Error("Change request does not exist");
    if (changeRequest.state !== "IntegrationReady")
      throw new Error("Change request is not ready for integration");
    const incompleteTasks = [...this.tasks.values()].filter(
      (task) =>
        task.changeRequestId === changeRequest.id &&
        !["Approved", "Integrated"].includes(task.state),
    );
    if (incompleteTasks.length)
      throw new Error(
        `Integration is blocked until every task is approved: ${incompleteTasks.map((task) => task.key).join(", ")}`,
      );
    const project = this.projects.get(changeRequest.projectId);
    if (!project) throw new Error("Project does not exist");
    const patchSets = input.patchSetIds
      .map((patchSetId) => this.patchSets.get(patchSetId))
      .filter((patchSet): patchSet is PatchSet => Boolean(patchSet));
    if (patchSets.length !== input.patchSetIds.length)
      throw new Error("One or more PatchSets do not exist");
    const repository = await verifyRepository(project.repositoryPath);
    const integrationBranch =
      changeRequest.integrationBranch ?? `agentflow/${changeRequest.id}/integration`;
    let integrationWorkspace = [...this.workspaces.values()].find(
      (workspace) =>
        workspace.projectId === project.id &&
        workspace.changeRequestId === changeRequest.id &&
        workspace.taskId === "integration",
    );
    if (!integrationWorkspace) {
      const existingPath = this.worktrees.worktreePath(
        project.id,
        changeRequest.id,
        "integration",
        "integration",
      );
      const existingRoot = await git(existingPath, ["rev-parse", "--show-toplevel"]);
      if (
        existingRoot.exitCode === 0 &&
        path.resolve(existingRoot.stdout.trim()).toLowerCase() ===
          path.resolve(existingPath).toLowerCase()
      ) {
        integrationWorkspace = {
          id: id("workspace"),
          projectId: project.id,
          changeRequestId: changeRequest.id,
          taskId: "integration",
          path: existingPath,
          branch: integrationBranch,
          baseCommit: changeRequest.baseCommit ?? repository.head,
          ownerRunId: "integration",
          status: "Ready",
        };
        this.workspaces.set(integrationWorkspace.id, integrationWorkspace);
        this.store.saveProjection(`workspace:${integrationWorkspace.id}`, 1, integrationWorkspace);
      }
    }
    if (integrationWorkspace) {
      // Reusing an existing integration worktree (e.g. retrying after a prior
      // conflict): reset it hard back to the base commit before cherry-picking.
      // A prior failed attempt may have left successfully cherry-picked commits
      // on the branch (cherry-pick --abort only undoes the failing pick), so
      // without this reset a retry would re-apply those commits and either
      // duplicate them or spuriously conflict. Resetting to base makes every
      // integration attempt start clean, as the docs require ("retry without
      // recreating the branch").
      const baseCommit = changeRequest.baseCommit ?? repository.head;
      await git(integrationWorkspace.path, ["reset", "--hard", baseCommit]);
      integrationWorkspace.baseCommit = baseCommit;
      integrationWorkspace.status = "Ready";
      this.store.saveProjection(`workspace:${integrationWorkspace.id}`, 1, integrationWorkspace);
    } else {
      integrationWorkspace = await this.worktrees.create(project.repositoryPath, {
        id: id("workspace"),
        projectId: project.id,
        changeRequestId: changeRequest.id,
        taskId: "integration",
        branch: integrationBranch,
        baseCommit: changeRequest.baseCommit ?? repository.head,
        taskKey: "integration",
        runId: "integration",
      });
      this.workspaces.set(integrationWorkspace.id, integrationWorkspace);
      this.store.saveProjection(`workspace:${integrationWorkspace.id}`, 1, integrationWorkspace);
    }
    const attempt: IntegrationAttempt = {
      id: id("integration"),
      changeRequestId: changeRequest.id,
      workspaceId: integrationWorkspace.id,
      integrationBranch,
      patchSetIds: patchSets.map((patchSet) => patchSet.id),
      status: "Started",
      conflictingFiles: [],
      createdAt: now(),
    };
    this.integrationAttempts.set(attempt.id, attempt);
    this.emit({
      type: "integration.started",
      aggregateId: changeRequest.id,
      conversationId: changeRequest.conversationId,
      changeRequestId: changeRequest.id,
      source: "runtime",
      payload: attempt,
    });
    const result = await this.integration.applyApprovedPatchSets(
      integrationWorkspace.path,
      patchSets,
    );
    attempt.status = result.status === "Completed" ? "Completed" : result.status;
    attempt.conflictingFiles = result.conflictingFiles;
    attempt.commit = result.commit;
    attempt.completedAt = now();
    this.store.saveProjection(`integration:${attempt.id}`, 1, attempt);
    changeRequest.integrationBranch = integrationBranch;
    if (result.status === "Completed") {
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Completed");
      changeRequest.failureReason = undefined;
    } else if (result.status === "Failed") {
      // A genuine integration failure (not a retryable conflict) moves the
      // change request to Failed so it is not stuck in IntegrationReady with
      // no path forward. Record the reason for diagnostics.
      changeRequest.state = transitionChangeRequest(changeRequest.state, "Failed");
      changeRequest.failureReason = result.message.slice(0, 2_000);
    } else {
      // Conflict: stay IntegrationReady (retryable) but record why.
      changeRequest.failureReason = result.message.slice(0, 2_000);
    }
    this.store.saveProjection(`cr:${changeRequest.id}`, 1, changeRequest);
    this.emit({
      type: "integration.completed",
      aggregateId: changeRequest.id,
      conversationId: changeRequest.conversationId,
      changeRequestId: changeRequest.id,
      source: "runtime",
      payload: { attempt, result },
    });
    // A completed integration's worktree has served its purpose (the result is
    // recorded on the change request / attempt); remove it so it does not leak.
    // On a conflict, keep the worktree branch for a retry — mark it Released so
    // the orphan reclaimer can eventually collect it if the user never retries.
    if (result.status === "Completed") {
      await this.worktrees
        .remove(project.repositoryPath, integrationWorkspace.path)
        .catch(() => undefined);
      integrationWorkspace.status = "Released";
    } else {
      integrationWorkspace.status = "Released";
    }
    this.store.saveProjection(`workspace:${integrationWorkspace.id}`, 1, integrationWorkspace);
    return attempt;
  }

  projectPullRequest(payload: unknown): PullRequestProjection {
    const input = parseMethodPayload("pull-request.project", payload);
    const changeRequest = this.changeRequests.get(input.changeRequestId);
    if (!changeRequest) throw new Error("Change request does not exist");
    const patchSets = [...this.patchSets.values()].filter(
      (patchSet) => this.tasks.get(patchSet.taskId)?.changeRequestId === changeRequest.id,
    );
    const validations = [...this.validationRuns.values()].filter((run) =>
      patchSets.some((patchSet) => patchSet.id === run.patchSetId),
    );
    return projectPullRequest(
      changeRequest,
      patchSets,
      validations,
      [...this.reviewRounds.values()]
        .filter((review) => review.changeRequestId === changeRequest.id)
        .map((review) => review.verdict)
        .join(", "),
    );
  }

  async retryRun(payload: unknown, resume = false): Promise<MessageResult> {
    const input = parseMethodPayload(resume ? "run.resume" : "run.retry", payload);
    const request = this.runRequests.get(input.runId);
    if (!request)
      throw new Error("Run cannot be retried after restart because its request is unavailable");
    const previous = this.runs.get(input.runId);
    if (!previous || !["Failed", "Cancelled", "Completed"].includes(previous.state))
      throw new Error("Only a finished run can be retried or resumed");
    if (resume) {
      const adapter = this.adapters.get(request.adapterId);
      if (adapter?.capabilities?.resume !== true)
        throw new Error(`Adapter ${request.adapterId} does not support native session resume`);
      if (!this.sessions.get(previous.sessionId)?.nativeSessionId)
        throw new Error("No native provider session is available for resume; use Retry instead");
    }
    if (!resume && previous.attempt > Number(this.settings.retries))
      throw new Error(`Retry limit reached (${this.settings.retries})`);
    this.emit({
      type: resume ? "session.resumed" : "run.retried",
      aggregateId: previous.conversationId,
      conversationId: previous.conversationId,
      runId: previous.id,
      source: "ui",
      role: previous.role,
      payload: { previousRunId: previous.id },
    });
    const previousSession = this.sessions.get(previous.sessionId);
    const retryContext = { attempt: previous.attempt + 1, retryOf: previous.id };
    if (request.mode === "Implement" && previous.taskId) {
      const result = await this.runTask(
        {
          taskId: previous.taskId,
          adapterId: request.adapterId,
          profileId: request.profileId,
          modelId: request.modelId,
          permissionProfile: request.permissionProfile,
          prompt: request.text,
          resumeNativeSessionId: resume ? previousSession?.nativeSessionId : undefined,
        },
        new AbortController().signal,
        retryContext,
      );
      return {
        messageId: id("message"),
        text: `Retried task ${result.task.key} and produced ${result.patchSet?.id ?? "no PatchSet"}.`,
        runId: result.run.id,
        changeRequestId: result.task.changeRequestId,
      };
    }
    const result = await this.sendMessage(
      {
        conversationId: request.conversationId,
        text: request.text,
        mode: request.mode,
        intent: request.intent,
        adapterId: request.adapterId,
        profileId: request.profileId,
        modelId: request.modelId,
        permissionProfile: request.permissionProfile,
      },
      new AbortController().signal,
      resume ? previousSession?.nativeSessionId : undefined,
      retryContext,
    );
    if (result.runId) {
      const replacement = this.runs.get(result.runId);
      if (replacement) {
        this.store.saveProjection(`run:${replacement.id}`, 1, replacement);
      }
    }
    return result;
  }

  status(): {
    dataDirectory: string;
    projects: Project[];
    conversations: Conversation[];
    changeRequests: ChangeRequest[];
    specifications: SpecificationRevision[];
    structures: StructureRevision[];
    decisions: Decision[];
    tasks: Task[];
    runs: AgentRun[];
    patchSets: PatchSet[];
    validations: ValidationRun[];
    reviews: ReviewRound[];
    findings: ReviewFinding[];
    permissions: PermissionRequest[];
    integrations: IntegrationAttempt[];
    workspaces: Workspace[];
    routingDecisions: RoutingDecision[];
    events: WorkflowEvent[];
    profiles: AuthenticationProfile[];
    adapterIds: string[];
    resumeAvailableRunIds: string[];
    settings: AgentFlowSettings;
    models: ModelDefinition[];
  } {
    this.refreshTaskReadiness();
    const events = [...this.conversations.keys()].flatMap((conversationId) =>
      this.store.eventsForConversation(conversationId),
    );
    return {
      dataDirectory: this.options.dataDirectory,
      projects: [...this.projects.values()],
      conversations: [...this.conversations.values()],
      changeRequests: [...this.changeRequests.values()],
      specifications: [...this.specifications.values()],
      structures: [...this.structures.values()],
      decisions: [...this.decisions.values()],
      tasks: [...this.tasks.values()],
      runs: [...this.runs.values()],
      patchSets: [...this.patchSets.values()],
      validations: [...this.validationRuns.values()],
      reviews: [...this.reviewRounds.values()],
      findings: [...this.reviewFindings.values()],
      permissions: [...this.permissionRequests.values()],
      integrations: [...this.integrationAttempts.values()],
      workspaces: [...this.workspaces.values()],
      routingDecisions: [...this.routingDecisions.values()],
      events: events
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .slice(-500),
      profiles: this.profiles.map((profile) => ({ ...profile })),
      adapterIds: [...this.adapters.keys()],
      resumeAvailableRunIds: [...this.runs.values()]
        .filter((run) => {
          const request = this.runRequests.get(run.id);
          const adapter = request ? this.adapters.get(request.adapterId) : undefined;
          return (
            adapter?.capabilities?.resume === true &&
            Boolean(this.sessions.get(run.sessionId)?.nativeSessionId)
          );
        })
        .map((run) => run.id),
      settings: this.getSettingsForRenderer(),
      models: [...this.models.values()],
    };
  }
  private closed = false;
  close(): void {
    // Tolerate double-close: both the stdin-close and the SIGTERM/SIGINT
    // shutdown paths can call close() (e.g. a signal arriving after stdin
    // closed), and better-sqlite3 throws on a second close(). The flag makes
    // the second call a no-op instead of an unhandled error in shutdown.
    if (this.closed) return;
    this.closed = true;
    // Abort any in-flight runs and cancel debug subprocesses so shutdown does
    // not orphan provider/debug child processes. The ProcessSupervisor kills
    // the whole process tree per platform (taskkill /T on Windows, process
    // group signal elsewhere).
    for (const controller of this.activeRuns.values()) controller.abort();
    this.debugProcesses.stopAll();
    try {
      this.store.close();
    } catch {
      /* database may already be closed during a race between shutdown paths */
    }
  }
}

export async function ensureDataDirectory(directory: string): Promise<void> {
  await access(directory).catch(async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory, { recursive: true });
  });
}
