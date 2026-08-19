export type Id = string;
export type ISODate = string;

export type ChangeRequestState =
  | "Draft"
  | "Planning"
  | "AwaitingSpecApproval"
  | "Ready"
  | "Running"
  | "Validating"
  | "Reviewing"
  | "IntegrationReady"
  | "Completed"
  | "Rejected"
  | "Cancelled"
  | "Failed";

export type TaskState =
  | "Pending"
  | "Blocked"
  | "Ready"
  | "Leased"
  | "Running"
  | "PatchProduced"
  | "ValidationFailed"
  | "ReviewRequested"
  | "ChangesRequested"
  | "Approved"
  | "Integrated"
  | "Failed"
  | "Cancelled";

export type ConversationMode = "Ask" | "Investigate" | "Plan" | "Implement" | "Fix" | "Review";
export type AgentRole = "Planner" | "Worker" | "Reviewer" | "Investigator";
export type RiskLevel = "Low" | "Medium" | "High" | "Critical";
export type PermissionProfileName =
  "Read Only" | "Repository Safe" | "Workspace Write" | "Elevated with Approval" | "Custom";
export type ReviewVerdict = "Approved" | "Changes requested" | "Rejected";

export interface Project {
  id: Id;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  policyRevision?: Id;
  debugCommand?: string;
  /** Project-level instructions loaded from `.agentflow/rules.md` at repository root. */
  rulesContent?: string;
}

export interface Conversation {
  id: Id;
  projectId: Id;
  title: string;
  mode: ConversationMode;
  changeRequestId?: Id;
  createdAt: ISODate;
  updatedAt: ISODate;
  archivedAt?: ISODate;
}

export interface ChangeRequest {
  id: Id;
  projectId: Id;
  conversationId: Id;
  title: string;
  state: ChangeRequestState;
  baseCommit?: string;
  integrationBranch?: string;
  specificationRevisionId?: Id;
  structureRevisionId?: Id;
  createdAt: ISODate;
  updatedAt: ISODate;
  targetBranch?: string;
  failureReason?: string;
}

export interface SpecificationRevision {
  id: Id;
  changeRequestId: Id;
  revision: number;
  immutable: true;
  requirements: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  architectureAnalysis: string;
  design: string;
  structureChanges: string[];
  decisions: Id[];
  taskDag: Id[];
  validationStrategy: string[];
  risk: RiskLevel;
  agentAllocation: AgentAllocation[];
  createdAt: ISODate;
  approvedAt?: ISODate;
}

export interface StructureRevision {
  id: Id;
  changeRequestId: Id;
  revision: number;
  immutable: true;
  summary: string;
  affectedBoundaries: string[];
  rationale: string;
  approvedAt?: ISODate;
  createdAt: ISODate;
}

export interface Decision {
  id: Id;
  changeRequestId: Id;
  title: string;
  rationale: string;
  supersedes?: Id;
  createdAt: ISODate;
}

export interface TaskContract {
  objective: string;
  dependencies: Id[];
  allowedReadPaths: string[];
  allowedWritePaths: string[];
  forbiddenPaths: string[];
  requiredCapabilities: string[];
  acceptanceCriteria: string[];
  requiredValidationCommands: string[];
  preferredExecutorRoles: AgentRole[];
  riskLevel: RiskLevel;
}

export interface Task {
  id: Id;
  changeRequestId: Id;
  key: string;
  title: string;
  state: TaskState;
  contract: TaskContract;
  dependencyIds: Id[];
  lease?: TaskLease;
  patchSetIds: Id[];
  specificationRevisionId?: Id;
  createdAt: ISODate;
  updatedAt: ISODate;
  failureReason?: string;
}

export interface TaskDependency {
  taskId: Id;
  dependsOnTaskId: Id;
  kind: "Blocks" | "Orders";
}
export interface TaskLease {
  id: Id;
  taskId: Id;
  runId: Id;
  expiresAt: ISODate;
  acquiredAt: ISODate;
}

export interface Provider {
  id: Id;
  name: string;
  vendor: string;
}
export interface ModelDefinition {
  id: Id;
  adapterId: string;
  providerId: string;
  /** Provider-native identifier. `id` remains AgentFlow's stable routing key. */
  providerModelId?: string;
  name: string;
  verified: boolean;
  cliDefault: boolean;
  capabilities: string[];
}
export interface AuthenticationProfile {
  id: Id;
  name: string;
  adapterId: string;
  configDirectory?: string;
  status: "Ready" | "RequiresLogin" | "Unavailable";
  version?: string;
  diagnostic?: string;
}
export interface AgentAdapter {
  id: string;
  name: string;
  providerId: string;
  capabilities: string[];
}
export interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  policy: Record<string, unknown>;
}

export interface RunConfiguration {
  preset: "Balanced" | "Fast" | "Quality" | "Conservative" | "Parallel" | "Manual";
  adapterId?: string;
  profileId?: Id;
  modelId?: string;
  role: AgentRole;
  reasoningEffort?: "Low" | "Medium" | "High";
  permissionProfile: PermissionProfileName;
  workerCount: number;
  executionStrategy: "Serial" | "Parallel";
}

export interface AgentAllocation {
  taskId: Id;
  role: AgentRole;
  adapterId: string;
  modelId?: string;
  reason: string;
}
export interface RoutingDecision {
  id: Id;
  runId?: Id;
  input: RunConfiguration;
  candidates: RoutingCandidate[];
  selected?: RoutingCandidate;
  matchedRule: string;
  reason: string;
  fallbackAttempts: string[];
  rejectedCandidates: string[];
  createdAt: ISODate;
}
export interface RoutingCandidate {
  adapterId: string;
  profileId?: Id;
  modelId?: string;
  role: AgentRole;
  permissionProfile: PermissionProfileName;
  score: number;
  eligible: boolean;
  rejectionReason?: string;
}

export interface PermissionProfile {
  id: string;
  name: PermissionProfileName;
  dimensions: PermissionDimensions;
}
export interface PermissionDimensions {
  readPaths: string[];
  writePaths: string[];
  protectedPaths: string[];
  commands: string[];
  network: boolean;
  packageInstall: boolean;
  dependencyChanges: boolean;
  projectFileChanges: boolean;
  externalProcesses: boolean;
  environmentAccess: "none" | "allowlist";
  secretAccess: boolean;
  clipboard: boolean;
  browser: boolean;
  externalDirectories: boolean;
  remoteGit: boolean;
}
export interface PermissionRequest {
  id: Id;
  runId: Id;
  command?: string;
  workingDirectory?: string;
  reason: string;
  requested: Partial<PermissionDimensions>;
  effective: PermissionDimensions;
  status: "Pending" | "Allowed" | "Denied";
  createdAt: ISODate;
  resolvedAt?: ISODate;
}

export interface AgentSession {
  id: Id;
  conversationId: Id;
  adapterId: string;
  nativeSessionId?: string;
  role: AgentRole;
  taskId?: Id;
  workspaceId?: Id;
  state: "Starting" | "Ready" | "Running" | "Stopped" | "Crashed";
  createdAt: ISODate;
  updatedAt: ISODate;
}
export interface AgentRun {
  id: Id;
  sessionId: Id;
  conversationId: Id;
  taskId?: Id;
  role: AgentRole;
  state: "Queued" | "Running" | "WaitingApproval" | "Completed" | "Failed" | "Cancelled";
  attempt: number;
  retryOf?: Id;
  workspaceId?: Id;
  startedAt?: ISODate;
  completedAt?: ISODate;
  exitCode?: number;
  error?: string;
}
export interface Workspace {
  id: Id;
  projectId: Id;
  changeRequestId: Id;
  taskId: Id;
  path: string;
  branch: string;
  baseCommit: string;
  ownerRunId?: Id;
  status: "Preparing" | "Ready" | "Running" | "Released" | "Orphaned";
}
export interface PatchSet {
  id: Id;
  taskId: Id;
  sequence: number;
  baseCommit: string;
  resultCommit: string;
  changedFiles: string[];
  diffArtifactId: Id;
  validationRunIds: Id[];
  producingRunId: Id;
  createdAt: ISODate;
  reviewState: "Pending" | "Approved" | "ChangesRequested" | "Rejected";
  supersedes?: Id;
  immutable: true;
}
export interface ValidationRun {
  id: Id;
  patchSetId?: Id;
  checkName: string;
  status: "Passed" | "Failed" | "Skipped";
  blocking: boolean;
  command: string;
  durationMs: number;
  exitCode: number;
  summary: string;
  logArtifactId?: Id;
  createdAt: ISODate;
}
export interface ReviewRound {
  id: Id;
  changeRequestId: Id;
  patchSetId?: Id;
  reviewerRunId: Id;
  verdict: ReviewVerdict;
  independent: boolean;
  createdAt: ISODate;
  completedAt?: ISODate;
}
export interface ReviewFinding {
  id: Id;
  reviewRoundId: Id;
  severity: "Blocking" | "Warning" | "Suggestion";
  category: string;
  file?: string;
  line?: number;
  message: string;
  evidence: string;
  violatedRule?: string;
  suggestedAction?: string;
  status: "Open" | "Resolved" | "Dismissed";
  humanNote?: string;
}
export interface IntegrationAttempt {
  id: Id;
  changeRequestId: Id;
  workspaceId?: Id;
  integrationBranch: string;
  patchSetIds: Id[];
  status: "Started" | "Conflict" | "Validated" | "Completed" | "Failed";
  conflictingFiles: string[];
  commit?: string;
  createdAt: ISODate;
  completedAt?: ISODate;
}
export interface PullRequestProjection {
  changeRequestId: Id;
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
}

export interface WorkflowEvent<TPayload = unknown> {
  id: Id;
  schemaVersion: number;
  type: string;
  aggregateId: Id;
  conversationId?: Id;
  changeRequestId?: Id;
  taskId?: Id;
  runId?: Id;
  sequence: number;
  timestamp: ISODate;
  source: "ui" | "runtime" | "adapter" | "system";
  role?: AgentRole;
  payload: TPayload;
}
export interface AuditEvent {
  id: Id;
  actor: "user" | "system" | "agent";
  action: string;
  target: string;
  detail: string;
  timestamp: ISODate;
}

const changeTransitions: Record<ChangeRequestState, ChangeRequestState[]> = {
  Draft: ["Planning", "Cancelled"],
  Planning: ["AwaitingSpecApproval", "Failed", "Cancelled"],
  AwaitingSpecApproval: ["Ready", "Planning", "Rejected", "Cancelled"],
  Ready: ["Running", "Cancelled"],
  Running: ["Validating", "Failed", "Cancelled"],
  Validating: ["Reviewing", "Running", "Failed"],
  Reviewing: ["IntegrationReady", "Running", "Failed"],
  IntegrationReady: ["Completed", "Running", "Failed"],
  Completed: [],
  Rejected: [],
  Cancelled: [],
  Failed: ["Planning", "Cancelled"],
};

const taskTransitions: Record<TaskState, TaskState[]> = {
  Pending: ["Blocked", "Ready", "Cancelled"],
  Blocked: ["Ready", "Cancelled"],
  Ready: ["Leased", "Cancelled"],
  Leased: ["Running", "Ready", "Failed", "Cancelled"],
  Running: ["PatchProduced", "Failed", "Cancelled"],
  PatchProduced: ["ValidationFailed", "ReviewRequested", "Failed"],
  ValidationFailed: ["Ready", "ChangesRequested", "Failed"],
  ReviewRequested: ["ChangesRequested", "Approved", "Failed"],
  ChangesRequested: ["Ready", "Cancelled"],
  Approved: ["Integrated", "ChangesRequested"],
  Integrated: [],
  Failed: ["Ready", "Cancelled"],
  Cancelled: ["Ready"],
};

export function transitionChangeRequest(
  current: ChangeRequestState,
  next: ChangeRequestState,
): ChangeRequestState {
  if (!changeTransitions[current].includes(next))
    throw new Error(`Invalid ChangeRequest transition: ${current} -> ${next}`);
  return next;
}

export function transitionTask(current: TaskState, next: TaskState): TaskState {
  if (!taskTransitions[current].includes(next))
    throw new Error(`Invalid Task transition: ${current} -> ${next}`);
  return next;
}

export function now(): ISODate {
  return new Date().toISOString();
}
export function id(prefix: string): Id {
  return `${prefix}-${crypto.randomUUID()}`;
}
