import { id, now, type ISODate } from "@agentflow/domain";

export type CapabilityKey =
  | "dependencyMutation"
  | "environmentMutation"
  | "softwareInstallation"
  | "networkMutation"
  | "destructiveOperations"
  | "privilegedOperations";

export interface WorkerCapability {
  readablePaths: string[];
  writablePaths: string[];
  dependencyMutation: boolean;
  environmentMutation: boolean;
  softwareInstallation: boolean;
  networkMutation: boolean;
  destructiveOperations: boolean;
  privilegedOperations: boolean;
}

export const leastPrivilegeCapability = (writablePaths: string[] = []): WorkerCapability => ({
  readablePaths: ["**/*"],
  writablePaths: [...writablePaths],
  dependencyMutation: false,
  environmentMutation: false,
  softwareInstallation: false,
  networkMutation: false,
  destructiveOperations: false,
  privilegedOperations: false,
});

export interface WorkerScope {
  taskId: string;
  allowedReadPaths: string[];
  allowedWritePaths: string[];
  forbiddenPaths: string[];
  objective: string;
}

export interface ScopeDecision {
  allowed: boolean;
  reason?: string;
  path?: string;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function matchesPath(value: string, pattern: string): boolean {
  const candidate = normalizePath(value);
  const rule = normalizePath(pattern);
  if (rule === "**" || rule === "**/*") return true;
  if (rule.endsWith("/**")) return candidate === rule.slice(0, -3) || candidate.startsWith(`${rule.slice(0, -3)}/`);
  if (rule.includes("/**/*.")) {
    const separator = rule.indexOf("/**/*.");
    const prefix = rule.slice(0, separator);
    const extension = rule.slice(separator + 6);
    return candidate.startsWith(`${prefix}/`) && candidate.endsWith(`.${extension}`);
  }
  const escaped = rule.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  const normalizedPattern = escaped;
  return new RegExp(`^${normalizedPattern}$`).test(candidate);
}

// A literal (non-glob) forbidden rule must block that name at any depth --
// ".env" has to catch "server/.env", not just a file literally named ".env"
// at the root -- or a worker could dodge the block by nesting one directory
// deeper. matchesPath()'s regex fallback anchors to the full path, so it
// only catches the root-level case; check path segments too for rules that
// don't already use glob syntax.
function matchesForbidden(value: string, pattern: string): boolean {
  if (pattern.includes("*")) return matchesPath(value, pattern);
  const candidate = normalizePath(value);
  const rule = normalizePath(pattern);
  return candidate === rule || candidate.split("/").includes(rule);
}

export function checkScope(scope: WorkerScope, action: "read" | "write", filePath: string): ScopeDecision {
  const path = normalizePath(filePath);
  if (scope.forbiddenPaths.some((rule) => matchesForbidden(path, rule))) return { allowed: false, path, reason: "path is forbidden by task scope" };
  const rules = action === "read" ? scope.allowedReadPaths : scope.allowedWritePaths;
  return rules.some((rule) => matchesPath(path, rule))
    ? { allowed: true, path }
    : { allowed: false, path, reason: `${action} path exceeds task scope` };
}

export interface OperationRequest {
  command: string;
  workingDirectory: string;
  capability: WorkerCapability;
  scope: WorkerScope;
  privileged?: boolean;
}

export interface PolicyDecision {
  outcome: "allow" | "deny" | "review";
  reason: string;
  fingerprint: string;
}

const destructive = /(?:rm|rmdir|del|erase|format|diskpart|shutdown|reboot|git\s+(?:reset|clean|checkout\s+--|restore\s+--source)|npm\s+(?:uninstall|remove)|winget\s+(?:uninstall|install)|msiexec|reg\s+(?:delete|add)|sc\s+(?:delete|config)|setx)\b/i;
const environmentMutation = /(?:setx|export\s+|\$env:|\benv\s+|set\s+[A-Za-z_][A-Za-z0-9_]*=)/i;
const networkMutation = /(?:netsh|route\s+(?:add|delete)|iptables|firewall|dns|proxy)/i;
const install = /(?:npm\s+(?:install|i)|pnpm\s+(?:add|install)|yarn\s+add|pip\s+install|cargo\s+add|winget\s+install|msiexec)/i;
const dependency = /(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock)/i;

function fingerprint(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

export function evaluateOperation(request: OperationRequest): PolicyDecision {
  const command = request.command.trim();
  if (!command || /[;&|`<>\n\r]/.test(command) || command.includes("..")) return { outcome: "deny", reason: "shell composition and traversal are denied", fingerprint: fingerprint(command) };
  if (request.privileged || /(?:sudo|runas|start-process\s+-verb\s+runas|pkexec)/i.test(command)) return request.capability.privilegedOperations ? { outcome: "review", reason: "privileged operation requires independent review", fingerprint: fingerprint(command) } : { outcome: "deny", reason: "privileged operations are outside worker capability", fingerprint: fingerprint(command) };
  if (destructive.test(command)) return request.capability.destructiveOperations ? { outcome: "review", reason: "destructive operation requires explicit review", fingerprint: fingerprint(command) } : { outcome: "deny", reason: "destructive operation is denied by default", fingerprint: fingerprint(command) };
  if (networkMutation.test(command)) return request.capability.networkMutation ? { outcome: "review", reason: "control-plane/network mutation requires review", fingerprint: fingerprint(command) } : { outcome: "deny", reason: "network/control-plane mutation is outside worker capability", fingerprint: fingerprint(command) };
  if (environmentMutation.test(command)) return request.capability.environmentMutation ? { outcome: "review", reason: "environment mutation requires review", fingerprint: fingerprint(command) } : { outcome: "deny", reason: "environment mutation is denied by default", fingerprint: fingerprint(command) };
  if (install.test(command)) return request.capability.softwareInstallation ? { outcome: "review", reason: "software installation requires review", fingerprint: fingerprint(command) } : { outcome: "deny", reason: "software installation is outside worker capability", fingerprint: fingerprint(command) };
  if (dependency.test(command) && !request.capability.dependencyMutation) return { outcome: "deny", reason: "dependency mutation is outside worker capability", fingerprint: fingerprint(command) };
  return { outcome: "allow", reason: "operation matches the current capability policy", fingerprint: fingerprint(command) };
}

export interface Evidence {
  id: string;
  kind: "experiment" | "test" | "log" | "static" | "review";
  summary: string;
  artifactId?: string;
  derivedFrom?: string[];
  reproducible: boolean;
}

export interface WorkerResult {
  taskId: string;
  runId: string;
  status: "completed" | "failed" | "blocked" | "needs-review";
  claim: string;
  evidence: Evidence[];
  artifacts: string[];
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  tests: Array<{ name: string; status: "passed" | "failed" | "skipped"; exitCode?: number; artifactId?: string }>;
  reproductionSteps: string[];
  unresolved: string[];
  assumptions: string[];
  interfacesChanged: string[];
  confidence: number;
  createdAt: ISODate;
}

export function validateWorkerResult(result: WorkerResult): void {
  if (!result.taskId || !result.runId || !result.claim) throw new Error("WorkerResult requires task, run and claim");
  if (result.confidence < 0 || result.confidence > 1) throw new Error("Worker confidence must be between 0 and 1");
  if (result.status === "completed" && result.evidence.length === 0) throw new Error("Completed WorkerResult requires evidence");
  if (result.status === "completed" && result.filesChanged.length > 0 && result.commandsRun.length === 0) throw new Error("Changed code requires command evidence");
}

export interface VerifierInput { worker: WorkerResult; reproduce: () => Promise<Evidence[]>; }
export interface VerificationReport { status: "confirmed" | "supported" | "rejected"; evidence: Evidence[]; reason: string; }

export async function verifyIndependently(input: VerifierInput): Promise<VerificationReport> {
  const independent = (await input.reproduce()).filter((e) => !e.derivedFrom?.includes(input.worker.runId));
  const reproducible = independent.some((e) => e.reproducible);
  if (reproducible && input.worker.evidence.length > 0) return { status: "confirmed", evidence: independent, reason: "independent reproducible evidence supports the worker claim" };
  if (independent.length > 0) return { status: "supported", evidence: independent, reason: "independent evidence exists but reproduction is incomplete" };
  return { status: "rejected", evidence: [], reason: "no independent evidence was produced" };
}

export interface Epoch { id: string; worldVersion: number; status: "open" | "draining" | "barrier" | "closed"; activeWorkers: Set<string>; deferredProposals: string[]; }
export class EpochBarrier {
  private epoch: Epoch;
  constructor(worldVersion = 1) { this.epoch = { id: id("epoch"), worldVersion, status: "open", activeWorkers: new Set(), deferredProposals: [] }; }
  snapshot(): Epoch { return { ...this.epoch, activeWorkers: new Set(this.epoch.activeWorkers), deferredProposals: [...this.epoch.deferredProposals] }; }
  startWorker(runId: string): void { if (this.epoch.status !== "open") throw new Error("epoch is not accepting workers"); this.epoch.activeWorkers.add(runId); }
  finishWorker(runId: string): void { this.epoch.activeWorkers.delete(runId); if (this.epoch.status === "draining" && this.epoch.activeWorkers.size === 0) this.epoch.status = "barrier"; }
  deferProposal(proposalId: string, blocking = false): "deferred" | "emergency-barrier" { if (blocking) { this.epoch.status = "draining"; return "emergency-barrier"; } this.epoch.deferredProposals.push(proposalId); return "deferred"; }
  beginBarrier(): void { if (this.epoch.activeWorkers.size > 0) { this.epoch.status = "draining"; return; } this.epoch.status = "barrier"; }
  closeAndAdvance(): Epoch { if (this.epoch.activeWorkers.size > 0) throw new Error("cannot advance world while workers are active"); if (this.epoch.status !== "barrier") throw new Error("barrier has not been reached"); const next = { id: id("epoch"), worldVersion: this.epoch.worldVersion + 1, status: "open" as const, activeWorkers: new Set<string>(), deferredProposals: [] }; this.epoch = next; return this.snapshot(); }
}

export interface TaskGraphNode { id: string; dependencyIds: string[]; state: "pending" | "ready" | "running" | "completed" | "failed"; }
export class TaskGraph {
  private readonly nodes = new Map<string, TaskGraphNode>();
  add(node: TaskGraphNode): void { if (this.nodes.has(node.id)) throw new Error(`duplicate task ${node.id}`); this.nodes.set(node.id, structuredClone(node)); this.assertAcyclic(); }
  get(id: string): TaskGraphNode | undefined { const node = this.nodes.get(id); return node && structuredClone(node); }
  ready(): TaskGraphNode[] { return [...this.nodes.values()].filter((node) => node.state === "pending" && node.dependencyIds.every((dep) => this.nodes.get(dep)?.state === "completed")).map((node) => structuredClone(node)); }
  setState(id: string, state: TaskGraphNode["state"]): void { const node = this.nodes.get(id); if (!node) throw new Error(`unknown task ${id}`); node.state = state; }
  private assertAcyclic(): void { const visiting = new Set<string>(); const visited = new Set<string>(); const visit = (id: string): void => { if (visiting.has(id)) throw new Error("task graph contains a cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of this.nodes.get(id)?.dependencyIds ?? []) if (this.nodes.has(dep)) visit(dep); visiting.delete(id); visited.add(id); }; for (const node of this.nodes.values()) visit(node.id); }
}

export interface AuditRecord { id: string; actor: "worker" | "commander" | "policy" | "verifier" | "system"; action: string; target: string; detail: string; timestamp: ISODate; }
export class AuditTrail { private readonly records: AuditRecord[] = []; append(record: Omit<AuditRecord, "id" | "timestamp"> & Partial<Pick<AuditRecord, "id" | "timestamp">>): AuditRecord { const saved = { ...record, id: record.id ?? id("audit"), timestamp: record.timestamp ?? now() }; this.records.push(saved); return saved; } all(): AuditRecord[] { return this.records.map((record) => ({ ...record })); } }

export interface StructuredState { version: 1; activeTaskIds: string[]; workingMemory: Record<string, string>; hypotheses: Record<string, { status: "active" | "rejected" | "superseded"; summary: string; evidenceIds: string[] }>; checkpoints: Array<{ id: string; createdAt: ISODate; state: unknown }>; }
export function emptyStructuredState(): StructuredState { return { version: 1, activeTaskIds: [], workingMemory: {}, hypotheses: {}, checkpoints: [] }; }
export function checkpoint(state: StructuredState): StructuredState { const copy = structuredClone(state); copy.checkpoints.push({ id: id("checkpoint"), createdAt: now(), state: { activeTaskIds: copy.activeTaskIds, workingMemory: copy.workingMemory, hypotheses: copy.hypotheses } }); return copy; }

export type EpistemicNodeKind = "claim" | "fact" | "hypothesis" | "evidence" | "experiment" | "decision" | "patch" | "failure" | "test";
export interface EpistemicNode { id: string; kind: EpistemicNodeKind; status: "active" | "contested" | "invalid" | "reopened"; }
export interface EpistemicEdge { from: string; to: string; relation: "supports" | "contradicts" | "derived_from" | "depends_on" | "rejected_because" | "supersedes" | "validated_by"; }
export class BeliefGraph { private readonly nodes = new Map<string, EpistemicNode>(); private readonly edges: EpistemicEdge[] = []; addNode(node: EpistemicNode): void { this.nodes.set(node.id, { ...node }); } addEdge(edge: EpistemicEdge): void { if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) throw new Error("belief edge references unknown node"); this.edges.push({ ...edge }); } invalidate(nodeId: string): string[] { const invalidated = new Set<string>([nodeId]); this.nodes.get(nodeId)!.status = "invalid"; let changed = true; while (changed) { changed = false; for (const edge of this.edges) if (edge.relation === "depends_on" && invalidated.has(edge.to) && !invalidated.has(edge.from)) { invalidated.add(edge.from); const node = this.nodes.get(edge.from); if (node) { node.status = "invalid"; changed = true; } } } return [...invalidated]; } reopenRejected(nodeId: string): void { const node = this.nodes.get(nodeId); if (!node) throw new Error("unknown belief node"); if (node.status !== "invalid") node.status = "reopened"; } get(nodeId: string): EpistemicNode | undefined { const node = this.nodes.get(nodeId); return node && { ...node }; } edgesFor(nodeId: string): EpistemicEdge[] { return this.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId).map((edge) => ({ ...edge })); } }

export interface AgentFlowStateFile {
  schemaVersion: 1;
  projectId: string;
  updatedAt: ISODate;
  state: StructuredState;
  audit: AuditRecord[];
}

export class AgentFlowStateStore {
  constructor(private readonly root: string) {}
  private file(name: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Invalid AgentFlow state name");
    return `${this.root}/${name}.json`;
  }
  async save(projectId: string, state: StructuredState, audit: AuditRecord[] = []): Promise<void> {
    const fs = await import("node:fs/promises");
    await fs.mkdir(this.root, { recursive: true });
    const payload: AgentFlowStateFile = { schemaVersion: 1, projectId, updatedAt: now(), state: structuredClone(state), audit: structuredClone(audit) };
    const temporary = `${this.file("state")}.${id("tmp")}`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, this.file("state"));
  }
  async load(): Promise<AgentFlowStateFile | undefined> {
    const fs = await import("node:fs/promises");
    try { return JSON.parse(await fs.readFile(this.file("state"), "utf8")) as AgentFlowStateFile; } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async saveArtifact(name: string, content: string): Promise<string> {
    const fs = await import("node:fs/promises");
    const artifacts = `${this.root}/artifacts`;
    await fs.mkdir(artifacts, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const target = `${artifacts}/${safe}`;
    await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
    return target;
  }
}

export interface ControlPlaneTarget { name: string; path: string; kind: "agent-api" | "proxy" | "dns" | "firewall" | "routing" | "runtime" | "toolchain" | "repository" | "execution-backend"; }
export function protectControlPlane(target: ControlPlaneTarget, action: string): PolicyDecision {
  return { outcome: "deny", reason: `Control-plane mutation denied: ${target.kind}:${target.name} (${action})`, fingerprint: fingerprint(`${target.kind}:${target.name}:${action}`) };
}

export interface AgentFilePolicy { root: string; allowedDirectories: string[]; forbiddenProjectPaths: string[]; }
export function agentFilePolicy(dataRoot: string): AgentFilePolicy {
  return { root: dataRoot, allowedDirectories: ["summary", "scratchpad", "checkpoints", "logs", "plans", "worker-reports", "artifacts"], forbiddenProjectPaths: [".git", "src", "packages", "apps", "package.json", "tsconfig.json"] };
}

export interface WorkerJob { taskId: string; runId: string; scope: WorkerScope; capability: WorkerCapability; execute: () => Promise<WorkerResult>; }
export interface CommanderDecision { taskId: string; action: "dispatch" | "defer" | "reject"; reason: string; }
export class CommanderWorkerRuntime {
  constructor(private readonly graph: TaskGraph, private readonly barrier: EpochBarrier, private readonly audit: AuditTrail) {}
  plan(): CommanderDecision[] { return this.graph.ready().map((task) => ({ taskId: task.id, action: "dispatch", reason: "dependencies satisfied" })); }
  async dispatch(job: WorkerJob): Promise<WorkerResult> {
    const policy = evaluateOperation({ command: "worker.execute", workingDirectory: ".", capability: job.capability, scope: job.scope });
    if (policy.outcome === "deny") throw new Error(policy.reason);
    this.barrier.startWorker(job.runId); this.graph.setState(job.taskId, "running");
    this.audit.append({ actor: "commander", action: "dispatch", target: job.taskId, detail: job.runId });
    try { const result = await job.execute(); validateWorkerResult(result); this.graph.setState(job.taskId, result.status === "completed" ? "completed" : "failed"); return result; }
    finally { this.barrier.finishWorker(job.runId); }
  }
}

export interface DeferredDecision { id: string; proposal: string; reason: string; createdAt: ISODate; status: "deferred" | "accepted" | "rejected"; }
export class DeferredDecisionQueue {
  private readonly items: DeferredDecision[] = [];
  add(proposal: string, reason: string): DeferredDecision { const item = { id: id("proposal"), proposal, reason, createdAt: now(), status: "deferred" as const }; this.items.push(item); return { ...item }; }
  list(): DeferredDecision[] { return this.items.map((item) => ({ ...item })); }
  resolve(itemId: string, status: "accepted" | "rejected"): void { const item = this.items.find((candidate) => candidate.id === itemId); if (!item) throw new Error("Unknown deferred decision"); item.status = status; }
}

export const futureSystemTransactionScope = Object.freeze({ status: "deferred", capabilities: ["kernel-driver", "system-snapshot", "shadow-system", "full-environment-rollback"] as const });
