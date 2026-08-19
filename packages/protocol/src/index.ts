import { z } from "zod";
import type { AgentRole, PermissionProfileName, WorkflowEvent } from "@agentflow/domain";
import { settingsSchema } from "@agentflow/config";

export const PROTOCOL_VERSION = 1;

export const bridgeRequestSchema = z
  .object({
    id: z.string().min(1),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    method: z.string().regex(/^[a-z][a-z0-9.]*$/),
    payload: z.unknown(),
  })
  .strict();

export const bridgeErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
    details: z.unknown().optional(),
  })
  .strict();
export const bridgeResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: bridgeErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ok && value.error)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Successful response cannot contain an error",
      });
    if (!value.ok && !value.error)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Failed response must contain an error",
      });
  });

export const bridgeEventSchema = z
  .object({
    id: z.string().min(1),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    schemaVersion: z.number().int().positive(),
    aggregateId: z.string().min(1),
    conversationId: z.string().optional(),
    changeRequestId: z.string().optional(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string().datetime(),
    type: z.string().min(1),
    source: z.enum(["ui", "runtime", "adapter", "system"]).optional(),
    role: z.enum(["Planner", "Worker", "Reviewer", "Investigator"]).optional(),
    payload: z.unknown(),
  })
  .strict();

export const openProjectPayloadSchema = z.object({ repositoryPath: z.string().min(1) }).strict();
export const projectStatusPayloadSchema = z.object({ projectId: z.string().min(1) }).strict();
export const updateProjectPayloadSchema = z
  .object({
    projectId: z.string().min(1),
    debugCommand: z.string().trim().max(2000).optional(),
  })
  .strict();
export const debugStartPayloadSchema = z.object({ projectId: z.string().min(1) }).strict();
export const debugStopPayloadSchema = z.object({ projectId: z.string().min(1) }).strict();
export const createConversationPayloadSchema = z
  .object({
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    mode: z.enum(["Ask", "Investigate", "Plan", "Implement", "Fix", "Review"]),
  })
  .strict();
const conversationModes = ["Ask", "Investigate", "Plan", "Implement", "Fix", "Review"] as const;
const permissionProfiles = [
  "Read Only",
  "Repository Safe",
  "Workspace Write",
  "Elevated with Approval",
  "Custom",
] as const;
const permissionProfileSchema = z.enum(permissionProfiles);
export const sendMessagePayloadSchema = z
  .object({
    conversationId: z.string().min(1),
    text: z.string().trim().min(1).max(100_000),
    mode: z.enum(conversationModes),
    intent: z.enum(["build"]).optional(),
    adapterId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    permissionProfile: permissionProfileSchema.optional(),
  })
  .strict();
export const approvePlanPayloadSchema = z
  .object({
    changeRequestId: z.string().min(1),
    action: z.enum(["approve", "request-changes", "approve-and-run"]),
  })
  .strict();
export const permissionDecisionPayloadSchema = z
  .object({
    requestId: z.string().min(1),
    decision: z.enum([
      "allow-once",
      "allow-task",
      "allow-conversation",
      "add-project-rule",
      "deny",
      "deny-and-stop",
    ]),
  })
  .strict();
export const stopRunPayloadSchema = z.object({ runId: z.string().min(1) }).strict();
export const taskRunPayloadSchema = z
  .object({
    taskId: z.string().min(1),
    adapterId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    permissionProfile: permissionProfileSchema.optional(),
    prompt: z.string().trim().min(1).max(100_000).optional(),
    resumeNativeSessionId: z.string().min(1).max(500).optional(),
  })
  .strict();
export const readyTasksRunPayloadSchema = z
  .object({
    changeRequestId: z.string().min(1),
    adapterId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    permissionProfile: permissionProfileSchema.optional(),
  })
  .strict();
export const retryRunPayloadSchema = z.object({ runId: z.string().min(1) }).strict();
export const validationRunPayloadSchema = z.object({ patchSetId: z.string().min(1) }).strict();
export const reviewStartPayloadSchema = z
  .object({
    patchSetId: z.string().min(1),
    adapterId: z.string().min(1).optional(),
    profileId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  })
  .strict();
export const integrationApplyPayloadSchema = z
  .object({ changeRequestId: z.string().min(1), patchSetIds: z.array(z.string().min(1)).min(1) })
  .strict();
export const pullRequestProjectionPayloadSchema = z
  .object({ changeRequestId: z.string().min(1) })
  .strict();
export const settingsGetPayloadSchema = z.object({}).strict();
export const settingsSavePayloadSchema = z.object({ settings: settingsSchema.partial() }).strict();
export const profilesProbePayloadSchema = z.object({}).strict();
export const artifactReadPayloadSchema = z.object({ artifactId: z.string().min(1) }).strict();

export const methodPayloadSchemas = {
  "project.open": openProjectPayloadSchema,
  "project.status": projectStatusPayloadSchema,
  "project.update": updateProjectPayloadSchema,
  "debug.start": debugStartPayloadSchema,
  "debug.stop": debugStopPayloadSchema,
  "conversation.create": createConversationPayloadSchema,
  "message.send": sendMessagePayloadSchema,
  "plan.approval": approvePlanPayloadSchema,
  "permission.resolve": permissionDecisionPayloadSchema,
  "run.stop": stopRunPayloadSchema,
  "task.run": taskRunPayloadSchema,
  "task.run.ready": readyTasksRunPayloadSchema,
  "run.retry": retryRunPayloadSchema,
  "run.resume": retryRunPayloadSchema,
  "validation.run": validationRunPayloadSchema,
  "review.start": reviewStartPayloadSchema,
  "integration.apply": integrationApplyPayloadSchema,
  "pull-request.project": pullRequestProjectionPayloadSchema,
  "settings.get": settingsGetPayloadSchema,
  "settings.save": settingsSavePayloadSchema,
  "profiles.probe": profilesProbePayloadSchema,
  "artifact.read": artifactReadPayloadSchema,
  "runtime.status": z.object({}).strict(),
} as const;

export type MethodPayloads = {
  "project.open": z.infer<typeof openProjectPayloadSchema>;
  "project.status": z.infer<typeof projectStatusPayloadSchema>;
  "project.update": z.infer<typeof updateProjectPayloadSchema>;
  "debug.start": z.infer<typeof debugStartPayloadSchema>;
  "debug.stop": z.infer<typeof debugStopPayloadSchema>;
  "conversation.create": z.infer<typeof createConversationPayloadSchema>;
  "message.send": z.infer<typeof sendMessagePayloadSchema>;
  "plan.approval": z.infer<typeof approvePlanPayloadSchema>;
  "permission.resolve": z.infer<typeof permissionDecisionPayloadSchema>;
  "run.stop": z.infer<typeof stopRunPayloadSchema>;
  "task.run": z.infer<typeof taskRunPayloadSchema>;
  "task.run.ready": z.infer<typeof readyTasksRunPayloadSchema>;
  "run.retry": z.infer<typeof retryRunPayloadSchema>;
  "run.resume": z.infer<typeof retryRunPayloadSchema>;
  "validation.run": z.infer<typeof validationRunPayloadSchema>;
  "review.start": z.infer<typeof reviewStartPayloadSchema>;
  "integration.apply": z.infer<typeof integrationApplyPayloadSchema>;
  "pull-request.project": z.infer<typeof pullRequestProjectionPayloadSchema>;
  "settings.get": z.infer<typeof settingsGetPayloadSchema>;
  "settings.save": z.infer<typeof settingsSavePayloadSchema>;
  "profiles.probe": z.infer<typeof profilesProbePayloadSchema>;
  "artifact.read": z.infer<typeof artifactReadPayloadSchema>;
  "runtime.status": Record<string, never>;
};

export type BridgeRequest<TPayload = unknown> = {
  id: string;
  protocolVersion: number;
  method: string;
  payload: TPayload;
};
export type BridgeResponse<TResult = unknown> = {
  id: string;
  ok: boolean;
  result?: TResult;
  error?: z.infer<typeof bridgeErrorSchema>;
};
export type BridgeEvent<TPayload = unknown> = {
  id: string;
  protocolVersion: number;
  schemaVersion: number;
  aggregateId: string;
  conversationId?: string;
  changeRequestId?: string;
  taskId?: string;
  runId?: string;
  sequence: number;
  timestamp: string;
  type: string;
  source?: "ui" | "runtime" | "adapter" | "system";
  role?: AgentRole;
  payload: TPayload;
};

export const eventTypes = [
  "conversation.created",
  "message.created",
  "message.delta",
  "message.completed",
  "session.created",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.retried",
  "session.resumed",
  "tool.started",
  "tool.completed",
  "command.started",
  "command.completed",
  "approval.requested",
  "approval.resolved",
  "file.changed",
  "structure.produced",
  "specification.produced",
  "specification.approved",
  "task.created",
  "task.ready",
  "task.started",
  "patchset.created",
  "validation.started",
  "validation.completed",
  "review.requested",
  "finding.created",
  "review.completed",
  "integration.started",
  "integration.completed",
  "routing.decided",
  "debug.started",
  "debug.output",
  "debug.stopped",
  "debug.exited",
] as const;

export const workflowEventSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.number().int().positive(),
    type: z.string().min(1),
    aggregateId: z.string().min(1),
    conversationId: z.string().optional(),
    changeRequestId: z.string().optional(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string().datetime(),
    source: z.enum(["ui", "runtime", "adapter", "system"]),
    role: z.enum(["Planner", "Worker", "Reviewer", "Investigator"]).optional(),
    payload: z.unknown(),
  })
  .strict();

export function makeBridgeRequest<T>(method: string, payload: T): BridgeRequest<T> {
  return { id: crypto.randomUUID(), protocolVersion: PROTOCOL_VERSION, method, payload };
}

export function parseMethodPayload<TMethod extends keyof MethodPayloads>(
  method: TMethod,
  payload: unknown,
): MethodPayloads[TMethod] {
  return methodPayloadSchemas[method].parse(payload) as MethodPayloads[TMethod];
}

export function validateEvent(event: unknown): WorkflowEvent {
  return workflowEventSchema.parse(event) as WorkflowEvent;
}

export type AdapterEventKind =
  | "text.delta"
  | "text.completed"
  | "tool.started"
  | "tool.completed"
  | "permission.requested"
  | "file.changed"
  | "review.finding"
  | "native.raw"
  | "run.completed"
  | "run.failed";
export interface AdapterEvent {
  kind: AdapterEventKind;
  sequence: number;
  timestamp: string;
  sessionId: string;
  role: AgentRole;
  text?: string;
  tool?: { name: string; input?: unknown; output?: unknown };
  permission?: { reason: string; requested: PermissionProfileName };
  reviewFinding?: {
    severity: "Blocking" | "Warning" | "Suggestion";
    category: string;
    file?: string;
    line?: number;
    message: string;
    evidence?: string;
    violatedRule?: string;
    suggestedAction?: string;
  };
  raw?: unknown;
}
