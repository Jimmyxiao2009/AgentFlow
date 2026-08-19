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
import type { AdapterEvent } from "@agentflow/protocol";

/**
 * MAF provider configuration as supplied by the user in Settings.
 * Each entry maps to one OpenAI-compatible chat-completions endpoint.
 */
export interface MafProviderConfig {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  /** Single model (legacy). Prefer `models` for multi-model providers. */
  model?: string;
  /** All models exposed by this provider (model ids sent on the wire). */
  models?: string[];
  apiVersion?: string;
}

export interface MafAdapterOptions {
  /** All configured MAF providers (from AgentFlow settings). */
  providers: MafProviderConfig[];
}

/**
 * Microsoft Agent Framework adapter.
 *
 * Unlike CLI adapters that shell out to a local executable, MAF talks to
 * OpenAI-compatible HTTP endpoints (Azure OpenAI, OpenAI, Ollama, etc.)
 * that the user configures in Settings → Agents → MAF Providers.
 *
 * Each provider config carries an endpoint URL, API key, model name, and
 * optional api-version query parameter (for Azure). The adapter streams
 * chat-completion chunks back as `text.delta` AdapterEvents.
 */
export class MafAdapter implements AgentAdapter {
  readonly id = "maf";
  readonly capabilities = {
    streaming: true,
    resume: false,
    structuredEvents: true,
    approvals: false,
    worktree: true,
  } as const;

  private providers: MafProviderConfig[];

  constructor(options: MafAdapterOptions = { providers: [] }) {
    this.providers = options.providers;
  }

  /** Update provider list at runtime when settings change. */
  setProviders(providers: MafProviderConfig[]): void {
    this.providers = providers;
  }

  /** Effective model list for a provider (multi-model aware). */
  private providerModels(provider: MafProviderConfig): string[] {
    if (provider.models && provider.models.length) return provider.models;
    return provider.model ? [provider.model] : [];
  }

  async probe(_context: ProbeContext, signal: AbortSignal): Promise<AgentProbeResult> {
    throwIfAborted(signal);
    const hasConfig = this.providers.length > 0;
    return {
      ready: hasConfig,
      version: hasConfig ? this.providers[0]!.apiVersion ?? "v1" : undefined,
      authenticated: hasConfig,
      capabilities: {
        streaming: true,
        resume: false,
        structuredEvents: true,
        approvals: false,
        worktree: true,
      },
      diagnostic: hasConfig
        ? undefined
        : "No MAF providers configured. Add a provider in Settings → Agents.",
    };
  }

  async discoverModels(
    _profile: AuthenticationProfile,
    signal: AbortSignal,
  ): Promise<ModelDiscoveryResult> {
    throwIfAborted(signal);
    const models: ModelDiscoveryResult["models"] = [];
    for (const p of this.providers) {
      for (const model of this.providerModels(p)) {
        models.push({
          id: `${p.id}::${model}`,
          adapterId: this.id,
          providerId: p.id,
          providerModelId: model,
          name: model,
          verified: true,
          cliDefault: false,
          capabilities: ["streaming"],
        });
      }
    }
    return { source: "manual", models };
  }

  async startSession(
    options: AgentSessionOptions,
    signal: AbortSignal,
  ): Promise<AgentSessionHandle> {
    throwIfAborted(signal);
    // Resolve eagerly so a missing/misconfigured model fails at session
    // start rather than silently on the first run() call.
    this.resolveProvider(options.modelId);
    return {
      id: options.sessionId,
      nativeSessionId: `maf-${options.sessionId}`,
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
    if (!session.id) throw new Error(`Unknown MAF session: ${session.id}`);

    const { provider, model } = this.resolveProvider(request.modelId);
    const url = this.buildUrl(provider);
    const systemPrompt = this.buildSystemPrompt(request.mode, session.role);
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: request.prompt },
      ],
      stream: true,
      temperature: 0.2,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
          "api-key": provider.apiKey,
        },
        body,
        signal,
      });
    } catch (error: unknown) {
      yield {
        kind: "run.failed",
        sequence: 0,
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        role: session.role,
        text: `MAF request failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: { error: true },
      };
      return;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      yield {
        kind: "run.failed",
        sequence: 0,
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        role: session.role,
        text: `MAF HTTP ${response.status}: ${errorText.slice(0, 500)}`,
        raw: { status: response.status },
      };
      return;
    }

    if (!response.body) {
      yield {
        kind: "run.failed",
        sequence: 0,
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        role: session.role,
        text: "MAF response has no body",
        raw: {},
      };
      return;
    }

    // Parse Server-Sent Events stream (OpenAI-compatible)
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sequence = 0;

    try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            yield {
              kind: "text.completed",
              sequence: sequence++,
              timestamp: new Date().toISOString(),
              sessionId: session.id,
              role: session.role,
              raw: { maf: true },
            };
            yield {
              kind: "run.completed",
              sequence,
              timestamp: new Date().toISOString(),
              sessionId: session.id,
              role: session.role,
              raw: { maf: true },
            };
            return;
          }
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              yield {
                kind: "text.delta",
                sequence: sequence++,
                timestamp: new Date().toISOString(),
                sessionId: session.id,
                role: session.role,
                text: delta,
                raw: { maf: true },
              };
            }
          } catch {
            // Malformed SSE line — skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended without [DONE]
    yield {
      kind: "text.completed",
      sequence: sequence++,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      role: session.role,
      raw: { maf: true },
    };
    yield {
      kind: "run.completed",
      sequence,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      role: session.role,
      raw: { maf: true },
    };
  }

  async cancel(session: AgentSessionHandle, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async stopSession(session: AgentSessionHandle, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  private resolveProvider(modelId?: string): { provider: MafProviderConfig; model: string } {
    if (this.providers.length === 0)
      throw new Error("No MAF providers configured. Add one in Settings → Agents.");
    if (!modelId || modelId === "auto" || modelId === "maf-default") {
      const provider = this.providers[0]!;
      const model = this.providerModels(provider)[0];
      if (!model) throw new Error(`MAF provider ${provider.id} has no models configured.`);
      return { provider, model };
    }
    const sep = modelId.indexOf("::");
    if (sep > 0) {
      const providerId = modelId.slice(0, sep);
      const model = modelId.slice(sep + 2);
      const provider = this.providers.find((p) => p.id === providerId);
      if (!provider)
        throw new Error(
          `MAF provider not found: ${providerId}. Configured: ${this.providers.map((p) => p.id).join(", ")}`,
        );
      return { provider, model };
    }
    const provider = this.providers.find((p) => p.id === modelId) ?? this.providers[0]!;
    const model = this.providerModels(provider)[0];
    if (!model) throw new Error(`MAF provider ${provider.id} has no models configured.`);
    return { provider, model };
  }

  private buildUrl(provider: MafProviderConfig): string {
    const base = provider.endpoint.endsWith("/")
      ? provider.endpoint.slice(0, -1)
      : provider.endpoint;
    // Azure OpenAI uses /openai/deployments/{model}/chat/completions?api-version=...
    if (provider.apiVersion) {
      const sep = base.includes("?") ? "&" : "?";
      return `${base}/chat/completions${sep}api-version=${provider.apiVersion}`;
    }
    // OpenAI-compatible: /v1/chat/completions
    return base.includes("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }

  private buildSystemPrompt(
    mode: AgentRequest["mode"],
    role: AgentSessionHandle["role"],
  ): string {
    const roleDescriptions: Record<string, string> = {
      Planner: "You are a read-only planning agent. Analyze the codebase and produce a structured plan. Do not edit files.",
      Worker: "You are an implementation agent. Implement the requested changes in the assigned worktree.",
      Reviewer: "You are an independent code reviewer. Review the changes for correctness, security, and quality.",
      Investigator: "You are a read-only investigation agent. Answer questions about the codebase.",
    };
    const modeDescriptions: Record<string, string> = {
      Ask: "Answer the user's question about the codebase. Do not edit files.",
      Investigate: "Investigate the codebase and report findings. Do not edit files.",
      Plan: "Produce a structured implementation plan as JSON.",
      Implement: "Implement the requested changes.",
      Fix: "Fix the issues identified in the review.",
      Review: "Review the code changes and report findings.",
    };
    return [
      roleDescriptions[role] ?? "You are an AI coding agent.",
      modeDescriptions[mode] ?? "",
      "You are powered by Microsoft Agent Framework.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
}
