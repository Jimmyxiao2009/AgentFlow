export interface RuntimeTimelineEvent {
  id?: string;
  type?: string;
  role?: "Planner" | "Worker" | "Reviewer" | "Investigator";
  runId?: string;
  sequence?: number;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

export interface ReplayedTimelineActivity {
  category: "tool" | "command" | "workflow";
  status: "started" | "completed" | "failed" | "info";
  title: string;
  detail?: string;
}

export interface ReplayedTimelineMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  streaming: boolean;
  kind?: "message" | "activity";
  activity?: ReplayedTimelineActivity;
}

function shortValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 240);
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return undefined;
  }
}

/** Converts durable workflow events into compact, human-readable timeline activity. */
export function runtimeEventToTimelineActivity(
  event: RuntimeTimelineEvent,
): ReplayedTimelineMessage | undefined {
  const type = event.type ?? "";
  const payload = event.payload ?? {};
  const tool = payload.tool && typeof payload.tool === "object" ? payload.tool : undefined;
  const toolRecord = tool as Record<string, unknown> | undefined;
  const validation =
    payload.validation && typeof payload.validation === "object" ? payload.validation : payload;
  const validationRecord = validation as Record<string, unknown>;
  let activity: ReplayedTimelineActivity | undefined;
  if (type.endsWith("tool.started"))
    activity = {
      category: "tool",
      status: "started",
      title: `Tool started · ${String(toolRecord?.name ?? "provider tool")}`,
      detail: shortValue(toolRecord?.input),
    };
  else if (type.endsWith("tool.completed"))
    activity = {
      category: "tool",
      status: "completed",
      title: `Tool completed · ${String(toolRecord?.name ?? "provider tool")}`,
      detail: shortValue(toolRecord?.output),
    };
  else if (type.endsWith("command.started"))
    activity = {
      category: "command",
      status: "started",
      title: "Command started",
      detail: shortValue(payload.command),
    };
  else if (type.endsWith("command.completed"))
    activity = {
      category: "command",
      status: "completed",
      title: "Command completed",
      detail: shortValue(payload.command) ?? shortValue(payload.exitCode),
    };
  else if (type === "file.changed" || type.endsWith("file.changed"))
    activity = {
      category: "workflow",
      status: "info",
      title: "File changes detected",
      detail: shortValue(payload.file) ?? shortValue(payload.path),
    };
  else if (type.endsWith("validation.started"))
    activity = {
      category: "workflow",
      status: "started",
      title: "Deterministic validation started",
      detail: shortValue(validationRecord.name),
    };
  else if (type.endsWith("validation.completed"))
    activity = {
      category: "workflow",
      status: validationRecord.status === "Failed" ? "failed" : "completed",
      title: "Deterministic validation completed",
      detail: shortValue(validationRecord.summary) ?? shortValue(validationRecord.status),
    };
  else if (type.endsWith("patchset.created") || type.endsWith("patchset.recovered"))
    activity = {
      category: "workflow",
      status: "completed",
      title: type.endsWith("recovered") ? "PatchSet recovered" : "PatchSet created",
      detail: shortValue(payload.changedFiles),
    };
  else if (type.endsWith("finding.created"))
    activity = {
      category: "workflow",
      status: payload.severity === "Blocking" ? "failed" : "info",
      title: `Review finding · ${String(payload.severity ?? "Unclassified")}`,
      detail: shortValue(payload.message),
    };
  else if (type.endsWith("review.completed"))
    activity = {
      category: "workflow",
      status: payload.verdict === "Rejected" ? "failed" : "completed",
      title: "Independent review completed",
      detail: shortValue(payload.verdict),
    };
  else if (type.endsWith("approval.requested"))
    activity = {
      category: "workflow",
      status: "started",
      title: "Permission approval requested",
      detail: shortValue(payload.permissionRequest) ?? shortValue(payload.reason),
    };
  else if (type.endsWith("approval.resolved"))
    activity = {
      category: "workflow",
      status: payload.decision?.toString().startsWith("deny") ? "failed" : "completed",
      title: "Permission approval resolved",
      detail: shortValue(payload.decision),
    };
  else if (type.endsWith("run.started") || type.endsWith("task.started"))
    activity = {
      category: "workflow",
      status: "started",
      title: type.endsWith("task.started") ? "Task started" : "Agent run started",
      detail: shortValue(payload.taskId) ?? event.role,
    };
  else if (
    type.endsWith("run.completed") ||
    type.endsWith("run.cancelled") ||
    type.endsWith("run.failed")
  )
    activity = {
      category: "workflow",
      status: type.endsWith("failed") || type.endsWith("cancelled") ? "failed" : "completed",
      title: type.endsWith("failed")
        ? "Agent run failed"
        : type.endsWith("cancelled")
          ? "Agent run cancelled"
          : "Agent run completed",
      detail: shortValue(payload.error),
    };
  else if (type === "debug.started")
    activity = {
      category: "command",
      status: "started",
      title: "Debug process started",
      detail: shortValue(payload.command),
    };
  else if (type === "debug.output")
    activity = {
      category: "command",
      status: "info",
      title: `Debug ${String(payload.stream ?? "output")}`,
      detail: shortValue(payload.line),
    };
  else if (type === "debug.stopped")
    activity = {
      category: "command",
      status: "completed",
      title: "Debug process stopped",
    };
  else if (type === "debug.exited")
    activity = {
      category: "command",
      status:
        payload.error || (typeof payload.exitCode === "number" && payload.exitCode !== 0)
          ? "failed"
          : "completed",
      title: "Debug process exited",
      detail: shortValue(payload.error) ?? shortValue(payload.exitCode),
    };
  else if (type.endsWith("integration.started") || type.endsWith("integration.completed"))
    activity = {
      category: "workflow",
      status: type.endsWith("completed") ? "completed" : "started",
      title: type.endsWith("completed") ? "Integration completed" : "Integration started",
      detail: shortValue(payload.message) ?? shortValue(payload.state),
    };
  if (!activity) return undefined;
  return {
    id: `activity-${event.id ?? `${event.type}-${event.sequence ?? Date.now()}`}`,
    role: "agent",
    text: activity.title,
    streaming: false,
    kind: "activity",
    activity,
  };
}

/** Rebuilds the conversation projection after a renderer reload. */
export function replayRuntimeTimeline(
  events: readonly RuntimeTimelineEvent[] = [],
): ReplayedTimelineMessage[] {
  const messages: ReplayedTimelineMessage[] = [];
  const agentMessageIds = new Map<string, string>();
  const seenEventIds = new Set<string>();
  const orderedEvents = [...events]
    .filter((event) => {
      if (!event.id || seenEventIds.has(event.id)) return !event.id;
      seenEventIds.add(event.id);
      return true;
    })
    // Order by wall-clock timestamp when available: `sequence` is a per-aggregate
    // local counter, so sorting a mixed set of events from many aggregates by
    // sequence scrambles the real time order (e.g. a task.started with
    // sequence 0 landing before a message.created with sequence 5 that
    // actually happened earlier). Fall back to sequence only when timestamps
    // are missing or tie.
    .sort((left, right) => {
      if (left.timestamp && right.timestamp) {
        const byTime = left.timestamp.localeCompare(right.timestamp);
        if (byTime !== 0) return byTime;
      }
      return (left.sequence ?? 0) - (right.sequence ?? 0);
    });

  for (const event of orderedEvents) {
    const payload = event.payload ?? {};
    if (event.type === "message.created" && typeof payload.text === "string") {
      messages.push({
        id:
          typeof payload.id === "string" ? payload.id : (event.id ?? `message-${messages.length}`),
        role: payload.role === "agent" || payload.role === "assistant" ? "agent" : "user",
        text: payload.text,
        streaming: false,
      });
    }
    if (event.type === "message.delta" && typeof payload.text === "string") {
      const key = event.runId || event.id || `run-${messages.length}`;
      const existingId = agentMessageIds.get(key);
      if (existingId) {
        const message = messages.find((candidate) => candidate.id === existingId);
        if (message) message.text += payload.text;
      } else {
        const id = `replayed-agent-${key}`;
        agentMessageIds.set(key, id);
        messages.push({ id, role: "agent", text: payload.text, streaming: true });
      }
    }
    if (event.type === "message.completed") {
      const key = event.runId;
      const existingId = key ? agentMessageIds.get(key) : undefined;
      const message = existingId
        ? messages.find((candidate) => candidate.id === existingId)
        : undefined;
      if (message) {
        if (typeof payload.text === "string") message.text = payload.text;
        message.streaming = false;
      } else if (typeof payload.text === "string") {
        messages.push({
          id: `replayed-agent-${key ?? event.id ?? messages.length}`,
          role: "agent",
          text: payload.text,
          streaming: false,
        });
      }
    }
    const activity = runtimeEventToTimelineActivity(event);
    if (activity) messages.push(activity);
  }
  return messages;
}
