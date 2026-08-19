import type {
  AgentRole,
  AuthenticationProfile,
  ModelDefinition,
  PermissionDimensions,
  PermissionProfileName,
} from "@agentflow/domain";
import type { AdapterEvent } from "@agentflow/protocol";

export type { PermissionDimensions } from "@agentflow/domain";

export interface ProbeContext {
  executable?: string;
  cwd?: string;
  profileId?: string;
  environment?: Record<string, string>;
}
export interface AgentProbeResult {
  ready: boolean;
  version?: string;
  authenticated?: boolean;
  capabilities: {
    streaming: boolean;
    resume: boolean;
    structuredEvents: boolean;
    approvals: boolean;
    worktree: boolean;
  };
  diagnostic?: string;
}
export interface ModelDiscoveryResult {
  models: ModelDefinition[];
  source:
    "official-command" | "local-protocol" | "config" | "known-list" | "manual" | "cli-default";
  warning?: string;
}
export interface AgentSessionOptions {
  sessionId: string;
  conversationId: string;
  role: AgentRole;
  taskId?: string;
  workspacePath?: string;
  profile: AuthenticationProfile;
  modelId?: string;
  providerModelId?: string;
  permissionProfile: PermissionProfileName;
  permissionDimensions?: PermissionDimensions;
  resumeNativeSessionId?: string;
}
export interface AgentSessionHandle {
  id: string;
  nativeSessionId?: string;
  adapterId: string;
  role: AgentRole;
  workspacePath?: string;
}
export interface AgentRequest {
  prompt: string;
  mode: "Ask" | "Investigate" | "Plan" | "Implement" | "Fix" | "Review";
  modelId?: string;
  providerModelId?: string;
  permissionProfile?: PermissionProfileName;
  permissionDimensions?: PermissionDimensions;
  intent?: "build";
  attachments?: string[];
  resumeNativeSessionId?: string;
}
export interface AdapterApprovalDecision {
  requestId: string;
  decision: "allow" | "deny";
}
export interface AgentAdapter {
  readonly id: string;
  readonly capabilities?: AgentProbeResult["capabilities"];
  probe(context: ProbeContext, signal: AbortSignal): Promise<AgentProbeResult>;
  discoverModels(
    profile: AuthenticationProfile,
    signal: AbortSignal,
  ): Promise<ModelDiscoveryResult>;
  startSession(options: AgentSessionOptions, signal: AbortSignal): Promise<AgentSessionHandle>;
  run(
    session: AgentSessionHandle,
    request: AgentRequest,
    signal: AbortSignal,
  ): AsyncIterable<AdapterEvent>;
  resolveApproval?(
    session: AgentSessionHandle,
    decision: AdapterApprovalDecision,
    signal: AbortSignal,
  ): Promise<void>;
  cancel(session: AgentSessionHandle, signal: AbortSignal): Promise<void>;
  stopSession(session: AgentSessionHandle, signal: AbortSignal): Promise<void>;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
