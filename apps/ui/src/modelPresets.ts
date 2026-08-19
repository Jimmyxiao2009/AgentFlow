/**
 * Curated MAF provider presets.
 *
 * Presets are one-click fill templates for Settings → Agents: they carry the
 * OpenAI-compatible endpoint, optional api-version, and the wire model ids a
 * subscription exposes. The user still supplies their own API key. Model data
 * was researched from public provider documentation (OpenCode Go model list,
 * OpenAI Codex model list) and is intentionally static — capabilities badges
 * (text/vision) are curated because OpenAI-compatible endpoints do not expose
 * them reliably.
 */

export interface PresetModelMeta {
  /** Human-readable label shown in the model picker. */
  label?: string;
  /** Model supports image input. */
  vision?: boolean;
}

export interface ModelPreset {
  id: string;
  name: string;
  endpoint: string;
  apiVersion?: string;
  /** Wire model ids sent in the `model` field of chat-completions. */
  models: string[];
  modelMeta: Record<string, PresetModelMeta>;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "opencode-go",
    name: "OpenCode Go",
    // OpenAI-compatible base URL for the OpenCode Go subscription.
    endpoint: "https://opencode.ai/zen/go/v1",
    models: [
      "glm-5.1",
      "glm-5",
      "kimi-k2.6",
      "kimi-k2.5",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "qwen3.6-plus",
      "qwen3.5-plus",
      "minimax-m2.7",
      "minimax-m2.5",
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ],
    modelMeta: {
      "glm-5.1": { label: "GLM-5.1" },
      "glm-5": { label: "GLM-5" },
      "kimi-k2.6": { label: "Kimi K2.6" },
      "kimi-k2.5": { label: "Kimi K2.5" },
      "deepseek-v4-pro": { label: "DeepSeek V4 Pro" },
      "deepseek-v4-flash": { label: "DeepSeek V4 Flash" },
      "qwen3.6-plus": { label: "Qwen3.6 Plus" },
      "qwen3.5-plus": { label: "Qwen3.5 Plus" },
      "minimax-m2.7": { label: "MiniMax M2.7" },
      "minimax-m2.5": { label: "MiniMax M2.5" },
      "mimo-v2.5-pro": { label: "MiMo-V2.5-Pro" },
      "mimo-v2.5": { label: "MiMo-V2.5" },
    },
  },
  {
    id: "openai-codex",
    name: "OpenAI (Codex)",
    endpoint: "https://api.openai.com/v1",
    models: [
      "gpt-5.2-codex",
      "gpt-5.1-codex",
      "gpt-5-codex",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
    ],
    modelMeta: {
      "gpt-5.2-codex": { label: "GPT-5.2-Codex" },
      "gpt-5.1-codex": { label: "GPT-5.1-Codex" },
      "gpt-5-codex": { label: "GPT-5-Codex" },
      "gpt-5.5": { label: "GPT-5.5", vision: true },
      "gpt-5.4": { label: "GPT-5.4", vision: true },
      "gpt-5.4-mini": { label: "GPT-5.4 mini", vision: true },
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    modelMeta: {
      "deepseek-chat": { label: "DeepSeek-V3 (chat)" },
      "deepseek-reasoner": { label: "DeepSeek-R1 (reasoner)" },
    },
  },
];

/** Look up curated display metadata for a wire model id across all presets. */
export function lookupModelMeta(modelId: string): PresetModelMeta | undefined {
  for (const preset of MODEL_PRESETS) {
    const meta = preset.modelMeta[modelId];
    if (meta) return meta;
  }
  return undefined;
}
