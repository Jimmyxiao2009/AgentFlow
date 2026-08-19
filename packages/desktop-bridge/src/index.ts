import {
  makeBridgeRequest,
  PROTOCOL_VERSION,
  bridgeResponseSchema,
  bridgeEventSchema,
  type BridgeEvent,
  type BridgeResponse,
} from "@agentflow/protocol";

type PermissionProfileName =
  "Read Only" | "Repository Safe" | "Workspace Write" | "Elevated with Approval" | "Custom";

export { replayRuntimeTimeline, runtimeEventToTimelineActivity } from "./replay.js";
export type {
  ReplayedTimelineActivity,
  ReplayedTimelineMessage,
  RuntimeTimelineEvent,
} from "./replay.js";

export interface BridgeTransport {
  request<T>(method: string, payload: unknown): Promise<T>;
  command?<T>(command: NativeDialogCommand, args?: unknown): Promise<T>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
}

export type NativeDialogCommand =
  | "pick_repository"
  | "pick_default_project_directory"
  | "pick_context_files"
  | "open_provider_login"
  | "notify_user";

function nativeCommand<T>(
  transport: BridgeTransport,
  command: NativeDialogCommand,
  args?: unknown,
): Promise<T> {
  if (!transport.command) throw new Error("Native desktop commands are unavailable");
  return transport.command<T>(command, args);
}

export function createTypedBridge(transport: BridgeTransport) {
  type RunOptions = {
    adapterId?: string;
    profileId?: string;
    modelId?: string;
    permissionProfile?: PermissionProfileName;
    intent?: "build";
    resumeNativeSessionId?: string;
  };
  return {
    openProject: (repositoryPath: string) => transport.request("project.open", { repositoryPath }),
    projectStatus: (projectId: string) => transport.request("project.status", { projectId }),
    updateProject: (projectId: string, patch: { debugCommand?: string }) =>
      transport.request("project.update", { projectId, ...patch }),
    startDebugProcess: (projectId: string) => transport.request("debug.start", { projectId }),
    stopDebugProcess: (projectId: string) => transport.request("debug.stop", { projectId }),
    createConversation: (projectId: string, title: string, mode: string) =>
      transport.request("conversation.create", { projectId, title, mode }),
    sendMessage: (conversationId: string, text: string, mode: string, options?: RunOptions) =>
      transport.request("message.send", { conversationId, text, mode, ...options }),
    approvePlan: (
      changeRequestId: string,
      action: "approve" | "request-changes" | "approve-and-run",
    ) => transport.request("plan.approval", { changeRequestId, action }),
    resolvePermission: (requestId: string, decision: string) =>
      transport.request("permission.resolve", { requestId, decision }),
    stopRun: (runId: string) => transport.request("run.stop", { runId }),
    runTask: (taskId: string, options?: RunOptions) =>
      transport.request("task.run", { taskId, ...options }),
    runReadyTasks: (changeRequestId: string, options?: RunOptions) =>
      transport.request("task.run.ready", { changeRequestId, ...options }),
    retryRun: (runId: string) => transport.request("run.retry", { runId }),
    resumeRun: (runId: string) => transport.request("run.resume", { runId }),
    runValidation: (patchSetId: string) => transport.request("validation.run", { patchSetId }),
    startReview: (patchSetId: string, options?: RunOptions) =>
      transport.request("review.start", { patchSetId, ...options }),
    integrate: (changeRequestId: string, patchSetIds: string[]) =>
      transport.request("integration.apply", { changeRequestId, patchSetIds }),
    projectPullRequest: (changeRequestId: string) =>
      transport.request("pull-request.project", { changeRequestId }),
    getSettings: () => transport.request("settings.get", {}),
    saveSettings: (settings: unknown) => transport.request("settings.save", { settings }),
    probeProfiles: () => transport.request("profiles.probe", {}),
    readArtifact: (artifactId: string) => transport.request("artifact.read", { artifactId }),
    pickRepository: (defaultPath?: string) =>
      nativeCommand<string | null>(transport, "pick_repository", { defaultPath }),
    pickDefaultProjectDirectory: () =>
      nativeCommand<string | null>(transport, "pick_default_project_directory"),
    pickContextFiles: (repositoryPath: string) =>
      nativeCommand<string[]>(transport, "pick_context_files", { repositoryPath }),
    openProviderLogin: (adapterId: string) =>
      nativeCommand<void>(transport, "open_provider_login", { adapterId }),
    notifyUser: (title: string, body: string) =>
      nativeCommand<void>(transport, "notify_user", { title, body }),
    subscribe: (listener: (event: BridgeEvent) => void) => transport.subscribe(listener),
    status: () => transport.request("runtime.status", {}),
  };
}

export async function createTauriTransport(): Promise<BridgeTransport> {
  const tauri = (
    globalThis as {
      __TAURI__?: {
        core?: { invoke?: (command: string, args?: unknown) => Promise<unknown> };
        event?: {
          listen?: (
            name: string,
            listener: (event: { payload: unknown }) => void,
          ) => Promise<() => void>;
        };
      };
    }
  ).__TAURI__;
  if (!tauri?.core?.invoke) throw new Error("Tauri bridge is unavailable");
  const listeners = new Set<(event: BridgeEvent) => void>();
  const seenEventIds = new Set<string>();
  const lastSequenceByAggregate = new Map<string, number>();
  // Must be registered (awaited) before any bridge_request goes out — otherwise
  // events emitted for a run that starts immediately after connecting (e.g. the
  // very first message in a brand-new conversation) can fire before this
  // listener exists and are silently dropped by Tauri's event system.
  await tauri.event?.listen?.("agentflow.event", (event) => {
    const parsed = bridgeEventSchema.safeParse(event.payload);
    if (!parsed.success) return;
    const payload = parsed.data as BridgeEvent;
    if (seenEventIds.has(payload.id)) return;
    const previousSequence = lastSequenceByAggregate.get(payload.aggregateId);
    if (previousSequence !== undefined && payload.sequence <= previousSequence) return;
    seenEventIds.add(payload.id);
    lastSequenceByAggregate.set(payload.aggregateId, payload.sequence);
    if (seenEventIds.size > 10_000) {
      const oldest = seenEventIds.values().next().value;
      if (oldest) seenEventIds.delete(oldest);
    }
    listeners.forEach((listener) => listener(payload));
  });
  return {
    async request<T>(method: string, payload: unknown): Promise<T> {
      const response = (await tauri.core!.invoke!("bridge_request", {
        request: makeBridgeRequest(method, payload),
      })) as BridgeResponse<T>;
      const parsed = bridgeResponseSchema.parse(response) as BridgeResponse<T>;
      if (!parsed.ok) throw new Error(parsed.error?.message ?? "AgentFlow request failed");
      return parsed.result as T;
    },
    command<T>(command: NativeDialogCommand, args?: unknown): Promise<T> {
      return tauri.core!.invoke!(command, args) as Promise<T>;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function protocolVersion(): number {
  return PROTOCOL_VERSION;
}
