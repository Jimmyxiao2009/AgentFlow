import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
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
import type { AuthenticationProfile, PermissionProfileName } from "@agentflow/domain";
import type { AdapterEvent } from "@agentflow/protocol";

export interface AiProviderConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  model?: string;
  models?: string[];
}

export interface VercelAiAdapterOptions {
  providers: AiProviderConfig[];
  defaultModelId?: string;
}

const capabilities = {
  streaming: true,
  resume: false,
  structuredEvents: true,
  approvals: false,
  worktree: true,
} as const;

/**
 * Direct Vercel AI SDK adapter for OpenAI-compatible providers. It deliberately
 * owns no CLI process, login flow, or provider-specific child process.
 */
export class VercelAiAdapter implements AgentAdapter {
  readonly id = "vercel-ai";
  readonly capabilities = capabilities;
  private providers: AiProviderConfig[];
  private defaultModelId?: string;
  private readonly discoveredModels = new Map<string, string[]>();

  constructor(options: VercelAiAdapterOptions = { providers: [] }) {
    this.providers = options.providers;
    this.defaultModelId = options.defaultModelId;
  }

  setProviders(providers: AiProviderConfig[], defaultModelId?: string): void {
    this.providers = providers;
    this.defaultModelId = defaultModelId;
    this.discoveredModels.clear();
  }

  async probe(_context: ProbeContext, signal: AbortSignal): Promise<AgentProbeResult> {
    throwIfAborted(signal);
    const ready = this.providers.some(
      (provider) => provider.endpoint.trim() && provider.apiKey.trim(),
    );
    return {
      ready,
      version: ready ? "Vercel AI SDK" : undefined,
      authenticated: ready,
      capabilities,
      diagnostic: ready
        ? undefined
        : "No AI providers with both an API endpoint and API key configured. Add them in Settings.",
    };
  }

  async discoverModels(
    _profile: AuthenticationProfile,
    signal: AbortSignal,
  ): Promise<ModelDiscoveryResult> {
    throwIfAborted(signal);
    const warnings: string[] = [];
    for (const provider of this.providers) {
      try {
        const response = await fetch(`${this.baseUrl(provider.endpoint)}/models`, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${provider.apiKey}`,
          },
          signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body: unknown = await response.json();
        const data =
          body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
            ? (body as { data: unknown[] }).data
            : [];
        const models = [...new Set(
          data
            .map((item) =>
              item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
                ? (item as { id: string }).id.trim()
                : "",
            )
            .filter(Boolean),
        )];
        this.discoveredModels.set(provider.id, models);
      } catch (error) {
        if (signal.aborted) throw error;
        this.discoveredModels.delete(provider.id);
        if (warnings.length < 3) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`${provider.name}: ${message.slice(0, 160)}`);
        }
      }
    }
    return {
      source: "config",
      models: this.providers.flatMap((provider) =>
        this.providerModels(provider).map((model) => ({
          id: `${provider.id}::${model}`,
          adapterId: this.id,
          providerId: provider.id,
          providerModelId: model,
          name: model,
          verified: true,
          cliDefault: false,
          capabilities: ["streaming"],
        })),
      ),
      ...(warnings.length ? { warning: `Model discovery failed for ${warnings.join("; ")}` } : {}),
    };
  }

  async startSession(
    options: AgentSessionOptions,
    signal: AbortSignal,
  ): Promise<AgentSessionHandle> {
    throwIfAborted(signal);
    this.resolveProvider(options.modelId);
    return {
      id: options.sessionId,
      nativeSessionId: `vercel-ai-${options.sessionId}`,
      adapterId: this.id,
      role: options.role,
      workspacePath: options.workspacePath,
    };
  }

  async *run(
    session: AgentSessionHandle,
    request: AgentRequest,
    signal: AbortSignal,
  ): AsyncIterable<AdapterEvent> {
    const { provider, model } = this.resolveProvider(request.modelId);
    const sdkProvider = createOpenAICompatible({
      name: provider.id,
      baseURL: this.baseUrl(provider.endpoint),
      apiKey: provider.apiKey,
    });
    const build =
      request.intent === "build"
        ? this.buildTools(session, request.permissionProfile)
        : undefined;
    const result = streamText({
      model: sdkProvider.chatModel(model),
      system: this.systemPrompt(request.mode, session.role, request.intent === "build"),
      prompt: request.prompt,
      tools: build?.tools,
      stopWhen: build?.stopWhen,
      abortSignal: signal,
      temperature: 0.2,
    });
    let sequence = 0;
    try {
      for await (const delta of result.textStream) {
        throwIfAborted(signal);
        if (!delta) continue;
        yield this.event("text.delta", sequence++, session, delta);
      }
      for (const file of build?.changedPaths ?? []) {
        yield {
          ...this.event("file.changed", sequence++, session),
          raw: { provider: "vercel-ai", file },
        };
      }
      yield this.event("text.completed", sequence++, session);
      yield this.event("run.completed", sequence, session);
    } catch (error) {
      if (signal.aborted) throw error;
      yield this.event(
        "run.failed",
        sequence,
        session,
        `Vercel AI SDK request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async cancel(_session: AgentSessionHandle, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async stopSession(_session: AgentSessionHandle, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  private event(
    kind: AdapterEvent["kind"],
    sequence: number,
    session: AgentSessionHandle,
    text?: string,
  ): AdapterEvent {
    return {
      kind,
      sequence,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      role: session.role,
      ...(text ? { text } : {}),
      raw: { provider: "vercel-ai" },
    };
  }

  private providerModels(provider: AiProviderConfig): string[] {
    const discovered = this.discoveredModels.get(provider.id);
    return discovered?.length
      ? discovered
      : provider.models?.filter(Boolean) ?? (provider.model ? [provider.model] : []);
  }

  private resolveProvider(modelId?: string): { provider: AiProviderConfig; model: string } {
    if (!this.providers.length) {
      throw new Error("No AI providers configured. Add one in Settings > Models.");
    }
    if (!modelId || modelId === "auto" || modelId === "vercel-ai-default") {
      const configuredDefault = this.defaultModelId
        ? this.resolveConfiguredModel(this.defaultModelId)
        : undefined;
      if (configuredDefault) return configuredDefault;
      const provider = this.providers.find((item) => this.providerModels(item).length > 0);
      const model = provider && this.providerModels(provider)[0];
      if (!provider || !model) throw new Error("No models configured for the available AI providers.");
      return { provider, model };
    }
    const resolved = this.resolveConfiguredModel(modelId);
    if (!resolved) throw new Error(`Configured provider model is unavailable: ${modelId}`);
    return resolved;
  }

  private resolveConfiguredModel(modelId: string): { provider: AiProviderConfig; model: string } | undefined {
    const separator = modelId.indexOf("::");
    if (separator <= 0) return undefined;
    const providerId = modelId.slice(0, separator);
    const model = modelId.slice(separator + 2);
    const provider = this.providers.find((item) => item.id === providerId);
    return provider && this.providerModels(provider).includes(model) ? { provider, model } : undefined;
  }

  private baseUrl(endpoint: string): string {
    const base = endpoint.replace(/\/+$/, "");
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }

  private buildTools(
    session: AgentSessionHandle,
    permissionProfile?: PermissionProfileName,
  ) {
    const workspacePath = session.workspacePath;
    if (!workspacePath) throw new Error("Build mode requires a repository workspace");
    const root = path.resolve(workspacePath);
    const resolvePath = (requestedPath: string): string => {
      const normalized = requestedPath.replaceAll("\\", "/").trim();
      if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes(".."))
        throw new Error("Build tools accept only relative repository paths");
      const resolved = path.resolve(root, normalized);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
        throw new Error("Build tool path escaped the repository workspace");
      if (path.relative(root, resolved).split(path.sep).includes(".git"))
        throw new Error("Build tools cannot access .git");
      return resolved;
    };
    const changedPaths: string[] = [];
    // Only attach the write_file tool when the selected permission profile
    // actually permits writes. The application layer gates build intent behind
    // a write-capable profile, but the adapter must not trust that blindly — a
    // Read-Only (or read-only Custom) build request must not be handed a file
    // writer even if the caller mis-routes it.
    const canWrite =
      permissionProfile === "Workspace Write" ||
      permissionProfile === "Elevated with Approval" ||
      permissionProfile === "Custom";
    const write_file = tool({
      description: "Create or replace one UTF-8 text file inside the current repository. Use only for the requested small fix.",
      inputSchema: z.object({
        path: z.string().min(1).max(500),
        content: z.string().max(500_000),
      }),
      execute: async ({ path: filePath, content }) => {
        const resolved = resolvePath(filePath);
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, "utf8");
        changedPaths.push(filePath);
        return { path: filePath, written: true };
      },
    });
    return {
      tools: {
        read_file: tool({
          description: "Read a UTF-8 text file from the current repository. Use this before editing a file.",
          inputSchema: z.object({ path: z.string().min(1).max(500) }),
          execute: async ({ path: filePath }) => ({
            path: filePath,
            content: (await readFile(resolvePath(filePath), "utf8")).slice(0, 120_000),
          }),
        }),
        ...(canWrite ? { write_file } : {}),
      },
      stopWhen: stepCountIs(8),
      changedPaths,
    };
  }

  private systemPrompt(
    mode: AgentRequest["mode"],
    role: AgentSessionHandle["role"],
    build: boolean,
  ): string {
    const roleInstructions: Record<string, string> = {
      Planner: "You are a read-only planning agent. Analyze the codebase and return a structured implementation plan. Do not edit files.",
      Worker: "You are an implementation agent. Make only the requested changes in the assigned worktree.",
      Reviewer: "You are an independent code reviewer. Identify correctness, security, and quality issues.",
      Investigator: "You are a read-only investigation agent. Answer questions about the codebase.",
    };
    const modeInstructions: Record<string, string> = {
      Ask: "Answer the question about the codebase. Do not edit files.",
      Investigate: "Investigate the codebase and report concrete findings. Do not edit files.",
      Plan: "Return the requested plan as a JSON object.",
      Implement: "Implement the requested change and explain the result.",
      Fix: "Fix the identified issue and explain the result.",
      Review: "Review the code changes and report findings ordered by severity.",
    };
    return [
      roleInstructions[role],
      modeInstructions[mode],
      build
        ? "You are in direct Build mode for a small bug fix. Inspect relevant files with read_file before changing them. Use write_file only for the minimal requested repository change. Never access .git, files outside the workspace, secrets, or unrelated files. Finish by summarizing the files changed and validation still needed."
        : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
