import { z } from "zod";

const customPermissionDimensionsSchema = z
  .object({
    readPaths: z.array(z.string().max(4096)).max(200),
    writePaths: z.array(z.string().max(4096)).max(200),
    protectedPaths: z.array(z.string().max(4096)).max(200),
    commands: z.array(z.string().max(500)).max(200),
    network: z.boolean(),
    packageInstall: z.boolean(),
    dependencyChanges: z.boolean(),
    projectFileChanges: z.boolean(),
    externalProcesses: z.boolean(),
    environmentAccess: z.enum(["none", "allowlist"]),
    secretAccess: z.literal(false),
    clipboard: z.boolean(),
    browser: z.boolean(),
    externalDirectories: z.boolean(),
    remoteGit: z.boolean(),
  })
  .strict();

const manualModelSchema = z
  .object({
    adapterId: z.string().min(1).max(100),
    providerId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(300),
    name: z.string().min(1).max(300),
  })
  .strict();

const aiProviderSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    endpoint: z.string().url().max(4096),
    apiKey: z.string().min(1).max(4096),
    model: z.string().min(1).max(300).optional(),
    models: z.array(z.string().min(1).max(300)).max(50).optional(),
    apiVersion: z.string().min(1).max(100).optional(),
  })
  .strict();

export const settingsSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    theme: z.enum(["System", "Dark", "Light"]),
    accent: z.enum(["Blue", "Cyan", "Purple", "Green", "Orange", "System"]),
    locale: z.enum(["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]),
    workerCount: z.number().int().min(1).max(16),
    restoreWorkspace: z.boolean(),
    confirmClose: z.boolean(),
    autoProbe: z.boolean(),
    manualModels: z.array(manualModelSchema).max(100),
    aiProviders: z.array(aiProviderSchema).max(50),
    defaultModelId: z.string().min(1).max(500).optional(),
    recentLimit: z.enum(["5", "10", "20"]),
    defaultProjectDirectory: z.string().max(4096),
    editor: z.enum(["VS Code", "Cursor", "System Default"]),
    density: z.enum(["Comfortable", "Compact"]),
    uiTextSize: z.enum(["Small", "Default", "Large"]),
    codeTextSize: z.enum(["12", "13", "14", "16"]),
    timestampFormat: z.enum(["Relative", "Absolute"]),
    retries: z.enum(["0", "1", "2", "3"]),
    planApproval: z.enum(["Always ask", "Auto-approve low risk"]),
    blockOnFailingValidation: z.boolean(),
    requireIndependentReviewer: z.boolean(),
    integrationPolicy: z.enum(["Manual", "Auto when approved"]),
    concurrencyLimit: z.enum(["1", "2", "3", "4"]),
    allowRiskOverrides: z.boolean(),
    requireApprovalNetwork: z.boolean(),
    requireApprovalPackages: z.boolean(),
    customPermissionDimensions: customPermissionDimensionsSchema,
    pushPolicy: z.enum(["Never", "Manual", "Ask each time"]),
    inAppNotif: z.boolean(),
    systemNotif: z.boolean(),
    soundNotif: z.boolean(),
    notifPlanApproval: z.boolean(),
    notifAgentFailure: z.boolean(),
    notifBlockedTask: z.boolean(),
    notifReviewComplete: z.boolean(),
    notifValidationComplete: z.boolean(),
    notifIntegrationReady: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650),
    reducedMotion: z.boolean(),
    highContrastFocus: z.boolean(),
    screenReaderAnnouncements: z.boolean(),
  })
  .strict();

export type AgentFlowSettings = z.infer<typeof settingsSchema>;

export const defaultSettings: AgentFlowSettings = {
  schemaVersion: 2,
  theme: "System",
  accent: "Blue",
  locale: "en-US",
  workerCount: 2,
  restoreWorkspace: true,
  confirmClose: true,
  autoProbe: true,
  manualModels: [],
  aiProviders: [],
  defaultModelId: undefined,
  recentLimit: "10",
  defaultProjectDirectory: "",
  editor: "VS Code",
  density: "Comfortable",
  uiTextSize: "Default",
  codeTextSize: "13",
  timestampFormat: "Relative",
  retries: "1",
  planApproval: "Always ask",
  blockOnFailingValidation: true,
  requireIndependentReviewer: true,
  integrationPolicy: "Manual",
  concurrencyLimit: "2",
  allowRiskOverrides: false,
  requireApprovalNetwork: true,
  requireApprovalPackages: true,
  customPermissionDimensions: {
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
  },
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
  retentionDays: 30,
  reducedMotion: false,
  highContrastFocus: false,
  screenReaderAnnouncements: true,
};

export function migrateSettings(input: unknown): AgentFlowSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) return defaultSettings;
  const raw = input as Record<string, unknown>;
  // Dropped settings fields: strip them from old persisted data so it still
  // passes the (strict) schema instead of getting discarded wholesale.
  const {
    mafProviders,
    alwaysShowShortcuts: _alwaysShowShortcuts,
    rawAgentEvents: _rawAgentEvents,
    verboseProtocolLogs: _verboseProtocolLogs,
    verboseGitLogs: _verboseGitLogs,
    pseudoLocalization: _pseudoLocalization,
    ...rest
  } = raw;
  const normalized = {
    ...rest,
    aiProviders: raw.aiProviders ?? mafProviders ?? [],
    defaultModelId:
      typeof raw.defaultModelId === "string" && raw.defaultModelId.trim()
        ? raw.defaultModelId.trim().slice(0, 500)
        : undefined,
    schemaVersion: typeof raw.schemaVersion === "number" ? Math.max(raw.schemaVersion, 2) : 2,
  };
  const parsed = settingsSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;
  const partial = settingsSchema.partial().safeParse(normalized);
  return partial.success ? { ...defaultSettings, ...partial.data } : defaultSettings;
}
