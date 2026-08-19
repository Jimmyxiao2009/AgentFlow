import React from "react";
import { t, type Locale } from "@agentflow/localization";
import type { AgentFlowSettings } from "@agentflow/config";
import type { PermissionDimensionsInput, TimelineMessage, UiSettings } from "./types";

export const defaultCustomPermissionDimensions = {
  readPaths: ["**/*"],
  writePaths: [],
  protectedPaths: [".git", ".env", ".ssh", "main", "master"],
  commands: ["git status", "git diff", "git log", "git show"],
  network: false,
  packageInstall: false,
  dependencyChanges: false,
  projectFileChanges: false,
  externalProcesses: false,
  environmentAccess: "none",
  secretAccess: false,
  clipboard: false,
  browser: false,
  externalDirectories: false,
  remoteGit: false,
};

export function normalizeCustomPermissionDimensions(value: unknown = {}) {
  const input: PermissionDimensionsInput =
    value && typeof value === "object" ? (value as PermissionDimensionsInput) : {};
  const list = (candidate: unknown, fallback: readonly string[]): string[] =>
    Array.isArray(candidate)
      ? candidate.filter((item) => typeof item === "string").slice(0, 200)
      : [...fallback];
  return {
    ...defaultCustomPermissionDimensions,
    ...input,
    readPaths: list(input.readPaths, defaultCustomPermissionDimensions.readPaths),
    writePaths: list(input.writePaths, defaultCustomPermissionDimensions.writePaths),
    protectedPaths: list(input.protectedPaths, defaultCustomPermissionDimensions.protectedPaths),
    commands: list(input.commands, defaultCustomPermissionDimensions.commands),
    environmentAccess: input.environmentAccess === "allowlist" ? "allowlist" : "none",
    secretAccess: false,
  };
}

const escalationMarkerPattern = /^AGENTFLOW_ESCALATE:\s*(\{.*\})\s*$/m;

export function parseEscalationRequest(text: string) {
  const match = typeof text === "string" ? escalationMarkerPattern.exec(text) : null;
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && (parsed.capability === "write" || parsed.capability === "workers"))
      return {
        capability: parsed.capability,
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
  } catch {
    /* malformed marker from the model; ignore and show the text as-is */
  }
  return null;
}

export function stripEscalationMarker(text: string) {
  return typeof text === "string" ? text.replace(escalationMarkerPattern, "").trimEnd() : text;
}

export function relativeTime(locale: Locale, value: string) {
  if (!value) return "";
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t(locale, "Time.JustNow");
  if (minutes < 60) return t(locale, "Time.MinutesShort", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(locale, "Time.HoursShort", { count: hours });
  return t(locale, "Time.DaysShort", { count: Math.floor(hours / 24) });
}

export function permissionProfileLabel(locale: Locale, profileName: string) {
  const keys: Record<string, string> = {
    "Read Only": "PermissionProfile.ReadOnly",
    "Repository Safe": "PermissionProfile.RepositorySafe",
    "Workspace Write": "PermissionProfile.WorkspaceWrite",
    "Elevated with Approval": "PermissionProfile.ElevatedWithApproval",
    Custom: "PermissionProfile.Custom",
  };
  return t(locale, keys[profileName] || profileName);
}

export function runtimeSettingsToUi(settings: Partial<AgentFlowSettings> | null | undefined) {
  if (!settings) return {};
  const localeLabels: Record<string, string> = {
    "en-US": "English (en-US)",
    "zh-CN": "简体中文 (zh-CN)",
    "zh-TW": "繁體中文 (zh-TW)",
    "ja-JP": "日本語 (ja-JP)",
    "ko-KR": "한국어 (ko-KR)",
  };
  return {
    theme: settings.theme,
    accent: settings.accent,
    language: localeLabels[settings.locale] || "English (en-US)",
    workerCount: String(settings.workerCount),
    restoreWorkspace: settings.restoreWorkspace,
    confirmClose: settings.confirmClose,
    autoProbe: settings.autoProbe,
    manualModels: Array.isArray(settings.manualModels)
      ? settings.manualModels.filter(
          (model) =>
            model &&
            typeof model.adapterId === "string" &&
            typeof model.providerId === "string" &&
            typeof model.modelId === "string" &&
            typeof model.name === "string",
        )
      : [],
    aiProviders: Array.isArray(settings.aiProviders)
      ? settings.aiProviders.filter(
          (p) =>
            p &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            typeof p.endpoint === "string" &&
            typeof p.apiKey === "string",
        )
      : [],
    defaultModelId: typeof settings.defaultModelId === "string" ? settings.defaultModelId : "",
    recentLimit: settings.recentLimit,
    defaultProjectDirectory: settings.defaultProjectDirectory,
    editor: settings.editor,
    density: settings.density,
    uiTextSize: settings.uiTextSize,
    codeTextSize: settings.codeTextSize,
    timestampFormat: settings.timestampFormat,
    retries: settings.retries,
    planApproval: settings.planApproval,
    blockOnFailingValidation: settings.blockOnFailingValidation,
    requireIndependentReviewer: settings.requireIndependentReviewer,
    integrationPolicy: settings.integrationPolicy,
    concurrencyLimit: settings.concurrencyLimit,
    allowRiskOverrides: settings.allowRiskOverrides,
    requireApprovalNetwork: settings.requireApprovalNetwork,
    requireApprovalPackages: settings.requireApprovalPackages,
    customPermissionDimensions: normalizeCustomPermissionDimensions(
      settings.customPermissionDimensions,
    ),
    pushPolicy: settings.pushPolicy,
    inAppNotif: settings.inAppNotif,
    systemNotif: settings.systemNotif,
    soundNotif: settings.soundNotif,
    notifPlanApproval: settings.notifPlanApproval,
    notifAgentFailure: settings.notifAgentFailure,
    notifBlockedTask: settings.notifBlockedTask,
    notifReviewComplete: settings.notifReviewComplete,
    notifValidationComplete: settings.notifValidationComplete,
    notifIntegrationReady: settings.notifIntegrationReady,
    retention: settings.retentionDays >= 3650 ? "Forever" : `${settings.retentionDays} days`,
    reducedMotion: settings.reducedMotion,
    highContrastFocus: settings.highContrastFocus,
    screenReaderAnnouncements: settings.screenReaderAnnouncements,
  };
}

export function detectSystemLocale(): Locale {
  const language = globalThis.navigator?.language?.toLowerCase() || "en-us";
  if (language.startsWith("zh-tw") || language.startsWith("zh-hk")) return "zh-TW";
  if (language.startsWith("zh")) return "zh-CN";
  if (language.startsWith("ja")) return "ja-JP";
  if (language.startsWith("ko")) return "ko-KR";
  return "en-US";
}

export function resolveUiLocale(language: string): Locale {
  if (language === "System default") return detectSystemLocale();
  const localeByLanguage: Record<string, Locale> = {
    "English (en-US)": "en-US",
    "简体中文 (zh-CN)": "zh-CN",
    "繁體中文 (zh-TW)": "zh-TW",
    "日本語 (ja-JP)": "ja-JP",
    "한국어 (ko-KR)": "ko-KR",
  };
  return localeByLanguage[language] || "en-US";
}

export function uiSettingsToRuntime(settings: UiSettings) {
  const localeByLabel: Record<string, string> = {
    "English (en-US)": "en-US",
    "简体中文 (zh-CN)": "zh-CN",
    "繁體中文 (zh-TW)": "zh-TW",
    "日本語 (ja-JP)": "ja-JP",
    "한국어 (ko-KR)": "ko-KR",
  };
  const parsedRetention =
    settings.retention === "Forever" ? 3650 : Number.parseInt(String(settings.retention), 10);
  const select = (values: string[], value: string, fallback: string) =>
    values.includes(value) ? value : fallback;
  return {
    schemaVersion: 2,
    theme: ["System", "Dark", "Light"].includes(settings.theme) ? settings.theme : "System",
    accent: ["Blue", "Cyan", "Purple", "Green", "Orange", "System"].includes(settings.accent)
      ? settings.accent
      : "Blue",
    locale:
      settings.language === "System default"
        ? detectSystemLocale()
        : localeByLabel[settings.language] || "en-US",
    workerCount: Math.min(16, Math.max(1, Number.parseInt(settings.workerCount, 10) || 2)),
    restoreWorkspace: Boolean(settings.restoreWorkspace),
    confirmClose: Boolean(settings.confirmClose),
    autoProbe: Boolean(settings.autoProbe),
    manualModels: Array.isArray(settings.manualModels)
      ? settings.manualModels
          .filter(
            (model) =>
              model &&
              typeof model.adapterId === "string" &&
              typeof model.providerId === "string" &&
              typeof model.modelId === "string" &&
              typeof model.name === "string",
          )
          .slice(0, 100)
          .map((model) => ({
            adapterId: model.adapterId.trim().slice(0, 100),
            providerId: model.providerId.trim().slice(0, 100),
            modelId: model.modelId.trim().slice(0, 300),
            name: model.name.trim().slice(0, 300),
          }))
          .filter(
            (model) =>
              model.adapterId && model.providerId && model.modelId && model.name,
          )
      : [],
    aiProviders: Array.isArray(settings.aiProviders)
      ? settings.aiProviders
          .filter(
            (p) =>
              p &&
              typeof p.id === "string" &&
              typeof p.name === "string" &&
              typeof p.endpoint === "string" &&
              typeof p.apiKey === "string",
          )
          .slice(0, 50)
          .map((p) => ({
            id: p.id.slice(0, 100),
            name: p.name.trim().slice(0, 200),
            endpoint: p.endpoint.trim().slice(0, 4096),
            apiKey: p.apiKey.slice(0, 4096),
            model: typeof p.model === "string" ? p.model.trim().slice(0, 300) : undefined,
            models: Array.isArray(p.models)
              ? p.models
                  .filter((m: unknown) => typeof m === "string")
                  .slice(0, 50)
                  .map((m: string) => m.trim().slice(0, 300))
              : undefined,
            apiVersion: typeof p.apiVersion === "string" ? p.apiVersion.trim().slice(0, 100) : undefined,
          }))
      : [],
    defaultModelId:
      typeof settings.defaultModelId === "string" && settings.defaultModelId.trim()
        ? settings.defaultModelId.trim().slice(0, 500)
        : undefined,
    recentLimit: select(["5", "10", "20"], settings.recentLimit, "10"),
    defaultProjectDirectory:
      typeof settings.defaultProjectDirectory === "string"
        ? settings.defaultProjectDirectory.slice(0, 4096)
        : "",
    editor: select(["VS Code", "Cursor", "System Default"], settings.editor, "VS Code"),
    density: select(["Comfortable", "Compact"], settings.density, "Comfortable"),
    uiTextSize: select(["Small", "Default", "Large"], settings.uiTextSize, "Default"),
    codeTextSize: select(["12", "13", "14", "16"], settings.codeTextSize, "13"),
    timestampFormat: select(["Relative", "Absolute"], settings.timestampFormat, "Relative"),
    retries: select(["0", "1", "2", "3"], settings.retries, "1"),
    planApproval: select(
      ["Always ask", "Auto-approve low risk"],
      settings.planApproval,
      "Always ask",
    ),
    blockOnFailingValidation: Boolean(settings.blockOnFailingValidation),
    requireIndependentReviewer: Boolean(settings.requireIndependentReviewer),
    integrationPolicy: select(
      ["Manual", "Auto when approved"],
      settings.integrationPolicy,
      "Manual",
    ),
    concurrencyLimit: select(["1", "2", "3", "4"], settings.concurrencyLimit, "2"),
    allowRiskOverrides: Boolean(settings.allowRiskOverrides),
    requireApprovalNetwork: Boolean(settings.requireApprovalNetwork),
    requireApprovalPackages: Boolean(settings.requireApprovalPackages),
    customPermissionDimensions: normalizeCustomPermissionDimensions(
      settings.customPermissionDimensions,
    ),
    pushPolicy: select(["Never", "Manual", "Ask each time"], settings.pushPolicy, "Ask each time"),
    inAppNotif: Boolean(settings.inAppNotif),
    systemNotif: Boolean(settings.systemNotif),
    soundNotif: Boolean(settings.soundNotif),
    notifPlanApproval: Boolean(settings.notifPlanApproval),
    notifAgentFailure: Boolean(settings.notifAgentFailure),
    notifBlockedTask: Boolean(settings.notifBlockedTask),
    notifReviewComplete: Boolean(settings.notifReviewComplete),
    notifValidationComplete: Boolean(settings.notifValidationComplete),
    notifIntegrationReady: Boolean(settings.notifIntegrationReady),
    retentionDays: Math.min(
      3650,
      Math.max(1, Number.isFinite(parsedRetention) ? parsedRetention : 30),
    ),
    reducedMotion: Boolean(settings.reducedMotion),
    highContrastFocus: Boolean(settings.highContrastFocus),
    screenReaderAnnouncements: Boolean(settings.screenReaderAnnouncements),
  };
}

export function diffFileState(content: string, file: string) {
  if (!content) return "modified";
  const section = content
    .split(/^diff --git /m)
    .find((chunk) => chunk.includes(`a/${file}`) || chunk.includes(`b/${file}`));
  if (!section) return "modified";
  if (/^Binary files /m.test(section)) return "binary";
  if (/^new file mode /m.test(section)) return "added";
  if (/^deleted file mode /m.test(section)) return "deleted";
  if (/^similarity index /m.test(section) || /^rename from /m.test(section)) return "renamed";
  return "modified";
}

export function diffLanguage(file: string) {
  const extension = file.split(".").at(-1)?.toLowerCase();
  return (
    (
      {
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        json: "json",
        css: "css",
        html: "html",
        md: "markdown",
        py: "python",
        rs: "rust",
        java: "java",
        go: "go",
      } as Record<string, string>
    )[extension || ""] || "text"
  );
}

export function renderSyntaxHighlightedCode(code: string) {
  const tokenPattern =
    /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b(?:const|let|var|function|return|if|else|for|while|import|from|export|class|async|await|new|true|false|null|undefined)\b)/g;
  const pieces: React.ReactNode[] = [];
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(code)) !== null) {
    if (match.index > cursor) pieces.push(code.slice(cursor, match.index));
    const token = match[0];
    const color =
      token.startsWith("//") || token.startsWith("#") || token.startsWith("/*")
        ? "var(--text-muted)"
        : token.startsWith('"') || token.startsWith("'") || token.startsWith("`")
          ? "var(--warning)"
          : "var(--accent)";
    pieces.push(
      <span key={`${match.index}-${token}`} style={{ color }}>
        {token}
      </span>,
    );
    cursor = match.index + token.length;
  }
  if (cursor < code.length) pieces.push(code.slice(cursor));
  return pieces;
}

export function renderDiffLine(line: string) {
  const prefix = /^[+\- ]/.test(line) ? line[0] : " ";
  const code = /^[+\- ]/.test(line) ? line.slice(1) : line;
  return (
    <>
      <span style={{ color: "var(--text-muted)", userSelect: "none" }}>{prefix}</span>
      {renderSyntaxHighlightedCode(code)}
    </>
  );
}

export function parseSideBySideDiff(content: string) {
  const lines = (content || "").split("\n");
  const rows: Array<{ left: string; right: string; index: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      rows.push({ left: line, right: "", index });
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("--- ") && lines[index + 1]?.startsWith("+")) {
      rows.push({ left: line, right: lines[index + 1], index });
      index += 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      rows.push({ left: "", right: line, index });
      continue;
    }
    rows.push({ left: line, right: line, index });
  }
  return rows;
}

export function summarizeActivityGroup(items: TimelineMessage[], locale: Locale) {
  const finished = (item: TimelineMessage) =>
    item.activity?.status === "completed" || item.activity?.status === "failed";
  const toolCount = items.filter(
    (item) => item.activity?.category === "tool" && finished(item),
  ).length;
  const commandCount = items.filter(
    (item) => item.activity?.category === "command" && finished(item),
  ).length;
  const otherCount = items.filter((item) => item.activity?.category === "workflow").length;
  const parts: string[] = [];
  if (commandCount) parts.push(t(locale, "Activity.RanCommands", { count: commandCount }));
  if (toolCount) parts.push(t(locale, "Activity.UsedTools", { count: toolCount }));
  if (!parts.length && otherCount)
    parts.push(t(locale, "Activity.OtherEvents", { count: otherCount }));
  return parts.length ? parts.join(" · ") : items[0]?.activity?.title || items[0]?.text || "";
}

export const defaultUiSettings = {
  inspectorWidth: 320,
  restoreWorkspace: true,
  confirmClose: true,
  autoProbe: true,
  manualModels: [] as Array<{
    adapterId: string;
    providerId: string;
    modelId: string;
    name: string;
  }>,
    aiProviders: [] as Array<{
    id: string;
    name: string;
    endpoint: string;
    apiKey: string;
    model?: string;
    models?: string[];
    apiVersion?: string;
  }>,
  recentLimit: "10",
  editor: "VS Code",
  theme: "Dark",
  accent: "Blue",
  density: "Comfortable",
  uiTextSize: "Default",
  codeTextSize: "13",
  timestampFormat: "Relative",
  language: "English (en-US)",
  workerCount: "2",
  retries: "1",
  planApproval: "Always ask",
  blockOnFailingValidation: true,
  requireIndependentReviewer: true,
  integrationPolicy: "Manual",
  concurrencyLimit: "2",
  allowRiskOverrides: false,
  requireApprovalNetwork: true,
  requireApprovalPackages: true,
  customPermissionDimensions: normalizeCustomPermissionDimensions(),
  pushPolicy: "Ask each time",
  inAppNotif: true,
  systemNotif: true,
  soundNotif: false,
  notifPlanApproval: true,
  notifAgentFailure: true,
  notifBlockedTask: true,
  notifReviewComplete: true,
  notifValidationComplete: false,
  notifIntegrationReady: true,
  retention: "30 days",
  reducedMotion: false,
  highContrastFocus: false,
  screenReaderAnnouncements: true,
  defaultProjectDirectory: "",
};

export function stateTone(state: string) {
  if (state === "Ready" || state === "Available") return "success";
  if (state === "Requires login") return "warning";
  return "muted";
}

export function localizedStatus(locale: Locale, state: string) {
  const keys: Record<string, string> = {
    Ready: "Status.Ready",
    Available: "Status.Available",
    "Requires login": "Status.RequiresLogin",
    "Not installed": "Status.NotInstalled",
    // ChangeRequestState
    Draft: "Status.Draft",
    Planning: "Status.Planning",
    AwaitingSpecApproval: "Status.AwaitingSpecApproval",
    Running: "Status.Running",
    Validating: "Status.Validating",
    Reviewing: "Status.Reviewing",
    IntegrationReady: "Status.IntegrationReady",
    Completed: "Status.Completed",
    Rejected: "Status.Rejected",
    Cancelled: "Status.Cancelled",
    Failed: "Status.Failed",
    // TaskState (adds to the above)
    Pending: "Status.Pending",
    Blocked: "Status.Blocked",
    Leased: "Status.Leased",
    PatchProduced: "Status.PatchProduced",
    ValidationFailed: "Status.ValidationFailed",
    ReviewRequested: "Status.ReviewRequested",
    ChangesRequested: "Status.ChangesRequested",
    Approved: "Status.Approved",
    Integrated: "Status.Integrated",
    // AgentRun state (adds to the above)
    Queued: "Status.Queued",
    WaitingApproval: "Status.WaitingApproval",
    // ValidationRun status (adds to the above)
    Passed: "Status.Passed",
    Skipped: "Status.Skipped",
    // ReviewVerdict spells "changes requested" differently than TaskState's
    // ChangesRequested, but it's the same concept -- same key.
    "Changes requested": "Status.ChangesRequested",
    Idle: "Status.Idle",
  };
  return t(locale, keys[state] || state);
}
