import readline from "node:readline";
import path from "node:path";
import { VercelAiAdapter } from "@agentflow/adapter-vercel-ai";
import { AgentFlowApplication, ensureDataDirectory } from "@agentflow/application";
import { bridgeRequestSchema, PROTOCOL_VERSION, type BridgeResponse } from "@agentflow/protocol";

const dataDirectory = path.resolve(process.env.AGENTFLOW_DATA_DIR ?? ".agentflow-data");
const fakeAdapter =
  process.env.AGENTFLOW_USE_FAKE_ADAPTER === "1"
    ? new (await import("@agentflow/adapter-fake")).FakeAdapter({
        delayMs: Number(process.env.AGENTFLOW_FAKE_DELAY_MS ?? 4),
      })
    : undefined;
const allowedMethods = new Set([
  "project.open",
  "project.status",
  "project.update",
  "debug.start",
  "debug.stop",
  "conversation.create",
  "message.send",
  "plan.approval",
  "permission.resolve",
  "run.stop",
  "task.run",
  "task.run.ready",
  "run.retry",
  "run.resume",
  "validation.run",
  "review.start",
  "integration.apply",
  "pull-request.project",
  "settings.get",
  "settings.save",
  "profiles.probe",
  "artifact.read",
  "runtime.status",
]);
const pending = new Set<Promise<void>>();
let queue: Promise<void> = Promise.resolve();

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const vercelAiAdapter = new VercelAiAdapter({ providers: [] });
const application = new AgentFlowApplication({
  dataDirectory,
  fakeAdapter,
  adapters: [vercelAiAdapter],
  profiles: [
    {
      id: "profile-vercel-ai",
      name: "Vercel AI SDK",
      adapterId: "vercel-ai",
      status: "Unavailable",
    },
  ],
  eventSink: (event) =>
    write({ kind: "event", event: { protocolVersion: PROTOCOL_VERSION, ...event } }),
});
function success<T>(id: string, result: T): BridgeResponse<T> {
  return { id, ok: true, result };
}
function failure(id: string, code: string, message: string): BridgeResponse {
  return { id, ok: false, error: { code, message, retryable: false } };
}

async function handle(line: string): Promise<void> {
  if (line.length > 2_000_000) {
    write(failure("unknown", "PAYLOAD_TOO_LARGE", "Request exceeds the runtime limit"));
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    write(failure("unknown", "INVALID_JSON", "Request is not valid JSON"));
    return;
  }
  const parsed = bridgeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    write(
      failure(
        typeof raw === "object" && raw && "id" in raw
          ? String((raw as { id?: unknown }).id)
          : "unknown",
        "INVALID_REQUEST",
        "Malformed or unsupported protocol envelope",
      ),
    );
    return;
  }
  const request = parsed.data;
  if (!allowedMethods.has(request.method)) {
    write(
      failure(request.id, "UNKNOWN_METHOD", "Unknown method rejected by the runtime allowlist"),
    );
    return;
  }
  try {
    const result =
      request.method === "project.open"
        ? await application.openProject(request.payload)
        : request.method === "project.status"
          ? await application.projectStatus(request.payload)
          : request.method === "project.update"
            ? await application.updateProject(request.payload)
            : request.method === "debug.start"
              ? await application.startDebugProcess(request.payload)
              : request.method === "debug.stop"
                ? application.stopDebugProcess(request.payload)
                : request.method === "conversation.create"
                  ? application.createConversation(request.payload)
            : request.method === "message.send"
              ? await application.sendMessage(request.payload)
              : request.method === "plan.approval"
                ? application.approvePlan(request.payload)
                : request.method === "permission.resolve"
                  ? await application.resolvePermission(request.payload)
                  : request.method === "run.stop"
                    ? application.stopRun(request.payload)
                    : request.method === "task.run"
                      ? await application.runTask(request.payload)
                      : request.method === "task.run.ready"
                        ? await application.runReadyTasks(request.payload)
                        : request.method === "run.retry"
                          ? await application.retryRun(request.payload)
                          : request.method === "run.resume"
                            ? await application.retryRun(request.payload, true)
                            : request.method === "validation.run"
                              ? await application.runValidation(request.payload)
                              : request.method === "review.start"
                                ? await application.startReview(request.payload)
                                : request.method === "integration.apply"
                                  ? await application.integrate(request.payload)
                                  : request.method === "pull-request.project"
                                    ? application.projectPullRequest(request.payload)
                                    : request.method === "settings.get"
                                      ? application.getSettings()
                                      : request.method === "settings.save"
                                        ? await (async () => {
                                            const saved = application.saveSettings(request.payload);
                                            vercelAiAdapter.setProviders(
                                              saved.aiProviders,
                                              saved.defaultModelId,
                                            );
                                            await application.probeProfiles(new AbortController().signal);
                                            return saved;
                                          })()
                                        : request.method === "profiles.probe"
                                          ? application.probeProfiles(new AbortController().signal)
                                          : request.method === "artifact.read"
                                            ? application.readArtifact(request.payload)
                                            : application.status();
    write(success(request.id, result));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Request failed";
    write(failure(request.id, "REQUEST_FAILED", message.slice(0, 500)));
  }
}

await ensureDataDirectory(dataDirectory);
// Sync configured API providers into the direct Vercel AI SDK adapter
vercelAiAdapter.setProviders(
  application.getSettings().aiProviders,
  application.getSettings().defaultModelId,
);
await application.reconcileInterruptedWork();
await application.cleanupOrphanedWorktrees();
application.pruneArtifacts();
if (process.env.AGENTFLOW_AUTO_PROBE !== "0" && application.getSettings().autoProbe)
  await application.probeProfiles(new AbortController().signal);
write({ type: "runtime.ready", protocolVersion: PROTOCOL_VERSION });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let method = "";
  try {
    method = typeof JSON.parse(line)?.method === "string" ? JSON.parse(line).method : "";
  } catch {
    /* handle() returns the protocol error */
  }
  const concurrent =
    method === "message.send" ||
    method === "debug.start" ||
    method === "debug.stop" ||
    method === "run.stop" ||
    method === "permission.resolve" ||
    method === "task.run" ||
    method === "task.run.ready" ||
    method === "run.retry" ||
    method === "run.resume" ||
    method === "validation.run" ||
    method === "review.start" ||
    method === "integration.apply" ||
    method === "pull-request.project";
  const request = concurrent ? handle(line) : queue.then(() => handle(line));
  if (!concurrent) queue = request.catch(() => undefined);
  pending.add(request);
  void request.finally(() => pending.delete(request));
});
input.on("close", async () => {
  await Promise.all(pending);
  application.close();
});

// Graceful shutdown on SIGTERM / SIGINT: drain in-flight requests before exiting.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  write({ type: "runtime.shutdown", protocolVersion: PROTOCOL_VERSION, signal });
  await Promise.allSettled(pending);
  application.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
