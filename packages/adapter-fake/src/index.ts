import type {
  AgentAdapter,
  AgentProbeResult,
  AgentRequest,
  AgentSessionHandle,
  AgentSessionOptions,
  ModelDiscoveryResult,
  ProbeContext,
} from "@agentflow/adapter-sdk";
import { throwIfAborted } from "@agentflow/adapter-sdk";
import type { AuthenticationProfile } from "@agentflow/domain";
import type { PermissionProfileName } from "@agentflow/domain";
import type { AdapterEvent } from "@agentflow/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FakeAdapterOptions {
  delayMs?: number;
  failAfter?: number;
  requestApproval?: boolean;
  approvalRequested?: PermissionProfileName;
  approvalRaw?: Record<string, unknown>;
  writeFiles?:
    | Array<{ path: string; content: string }>
    | ((request: AgentRequest) => Array<{ path: string; content: string }>);
  reviewFindings?:
    | Array<{
        severity: "Blocking" | "Warning" | "Suggestion";
        category: string;
        file?: string;
        line?: number;
        message: string;
        evidence?: string;
        violatedRule?: string;
        suggestedAction?: string;
      }>
    | ((request: AgentRequest) => Array<{
        severity: "Blocking" | "Warning" | "Suggestion";
        category: string;
        file?: string;
        line?: number;
        message: string;
        evidence?: string;
        violatedRule?: string;
        suggestedAction?: string;
      }>);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Operation aborted"));
      },
      { once: true },
    );
  });

export class FakeAdapter implements AgentAdapter {
  readonly id = "fake";
  readonly capabilities = {
    streaming: true,
    resume: true,
    structuredEvents: true,
    approvals: true,
    worktree: true,
  } as const;
  private readonly options: Required<FakeAdapterOptions>;
  private readonly sessions = new Set<string>();

  constructor(options: FakeAdapterOptions = {}) {
    this.options = {
      delayMs: 4,
      failAfter: 0,
      requestApproval: false,
      approvalRequested: "Elevated with Approval",
      approvalRaw: { fixture: true },
      writeFiles: [],
      reviewFindings: [],
      ...options,
    };
  }

  async probe(_context: ProbeContext, signal: AbortSignal): Promise<AgentProbeResult> {
    throwIfAborted(signal);
    return {
      ready: true,
      version: "fixture-1",
      authenticated: true,
      capabilities: {
        streaming: true,
        resume: true,
        structuredEvents: true,
        approvals: true,
        worktree: true,
      },
    };
  }

  async discoverModels(
    _profile: AuthenticationProfile,
    signal: AbortSignal,
  ): Promise<ModelDiscoveryResult> {
    throwIfAborted(signal);
    return {
      source: "known-list",
      models: [
        {
          id: "fake-default",
          adapterId: this.id,
          providerId: "fixture",
          name: "Fake Deterministic Model",
          verified: true,
          cliDefault: true,
          capabilities: ["streaming", "resume"],
        },
      ],
    };
  }

  async startSession(
    options: AgentSessionOptions,
    signal: AbortSignal,
  ): Promise<AgentSessionHandle> {
    throwIfAborted(signal);
    const handle = {
      id: options.sessionId,
      nativeSessionId: `fake-native-${options.sessionId}`,
      adapterId: this.id,
      role: options.role,
      workspacePath: options.workspacePath,
    };
    this.sessions.add(handle.id);
    return handle;
  }

  async *run(
    session: AgentSessionHandle,
    request: AgentRequest,
    signal: AbortSignal,
  ): AsyncIterable<AdapterEvent> {
    if (!this.sessions.has(session.id)) throw new Error(`Unknown fake session: ${session.id}`);
    const writeFiles =
      typeof this.options.writeFiles === "function"
        ? this.options.writeFiles(request)
        : this.options.writeFiles;
    if (request.mode === "Implement" && writeFiles.length && session.workspacePath) {
      if (
        !["Workspace Write", "Elevated with Approval"].includes(
          request.permissionProfile ?? "Read Only",
        )
      )
        throw new Error(
          `Fake adapter refused writes under permission profile ${request.permissionProfile ?? "Read Only"}`,
        );
      for (const file of writeFiles) {
        const resolved = path.resolve(session.workspacePath, file.path);
        if (!resolved.startsWith(`${path.resolve(session.workspacePath)}${path.sep}`))
          throw new Error(`Fixture write escaped workspace: ${file.path}`);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, file.content, "utf8");
        yield {
          kind: "file.changed",
          sequence: 0,
          timestamp: new Date().toISOString(),
          sessionId: session.id,
          role: session.role,
          raw: { fixture: true, file: file.path },
        };
      }
    }
    const text =
      request.mode === "Plan"
        ? "I inspected the repository and drafted an immutable specification with a dependency-aware task plan."
        : `Deterministic fake response for ${request.mode}: ${request.prompt}`;
    let sequence = 0;
    for (const token of text.split(/(\s+)/)) {
      throwIfAborted(signal);
      await sleep(this.options.delayMs, signal);
      yield {
        kind: "text.delta",
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        role: session.role,
        text: token,
        raw: { fixture: true },
      };
      if (this.options.failAfter > 0 && sequence >= this.options.failAfter) {
        yield {
          kind: "run.failed",
          sequence: sequence++,
          timestamp: new Date().toISOString(),
          sessionId: session.id,
          role: session.role,
          text: "Fixture failure",
          raw: { fixture: true, reason: "failAfter" },
        };
        return;
      }
    }
    // Planning is always Read Only (see runPlanner()); a real planner
    // adapter wouldn't ask for elevated permission mid-plan, so the fixture
    // shouldn't either -- otherwise every requestApproval fixture would also
    // have to account for the Plan run auto-denying and aborting first.
    if (this.options.requestApproval && request.mode !== "Plan")
      yield {
        kind: "permission.requested",
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        role: session.role,
        permission: {
          reason: "Fixture asks to install a package",
          requested: this.options.approvalRequested,
        },
        raw: this.options.approvalRaw,
      };
    const reviewFindings =
      typeof this.options.reviewFindings === "function"
        ? this.options.reviewFindings(request)
        : this.options.reviewFindings;
    if (request.mode === "Review")
      for (const finding of reviewFindings)
        yield {
          kind: "review.finding",
          sequence: sequence++,
          timestamp: new Date().toISOString(),
          sessionId: session.id,
          role: session.role,
          reviewFinding: finding,
          raw: { fixture: true },
        };
    yield {
      kind: "text.completed",
      sequence: sequence++,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      role: session.role,
      raw: { fixture: true },
    };
    yield {
      kind: "run.completed",
      sequence,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      role: session.role,
      raw: { fixture: true },
    };
  }

  async resolveApproval(
    _session: AgentSessionHandle,
    _decision: { requestId: string; decision: "allow" | "deny" },
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
  }
  async cancel(session: AgentSessionHandle, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.sessions.delete(session.id);
  }
  async stopSession(session: AgentSessionHandle, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.sessions.delete(session.id);
  }
}
