import React, { useState } from "react";
import {
  FolderOpen,
  Check,
  Circle,
  GripVertical,
  Lock,
  RefreshCw,
  Trash2,
  Plus,
  Search,
  Link2,
  SlidersHorizontal,
  Download,
  CheckCircle2,
} from "lucide-react";
import { t } from "@agentflow/localization";
import { MODEL_PRESETS } from "./modelPresets";
import type {
  SettingsContentProps,
  UiSettings,
  SettingsRuntimeData,
  RuntimeAdapterProfile,
  RuntimeModel,
} from "./types";
import {
  btnGhost,
  btnPrimary,
  btnDanger,
  modeOptions,
  permissionOptions,
  settingsSections,
  permissionProfiles,
  safetyLocks,
  accentColors,
} from "./constants";
import {
  Dot,
  Badge,
  Menu,
  MenuItem,
  Toggle,
  Segmented,
  StaticField,
  SettingsRow,
  SettingsGroup,
  PermissionListInput,
} from "./ui-primitives";
import {
  permissionProfileLabel,
  normalizeCustomPermissionDimensions,
  stateTone,
  localizedStatus,
} from "./utils";

export const SettingsContent = React.memo(function SettingsContent({
  section,
  settings,
  set,
  locale = "en-US",
  runtimeData,
  activeProject,
  onProbe,
  onExportDiagnostics,
  onResetLayout,
  onResetSettings,
  onChooseDefaultProjectDirectory,
}: SettingsContentProps) {
  const s = (key) => t(locale, `SettingsText.${key}`);
  const optionLabel = (value) =>
    t(
      locale,
      {
        System: "Option.System",
        SystemDefault: "Option.SystemDefault",
        Default: "Option.Default",
        Dark: "Option.Dark",
        Light: "Option.Light",
        Comfortable: "Option.Comfortable",
        Compact: "Option.Compact",
        Small: "Option.Small",
        Large: "Option.Large",
        Relative: "Option.Relative",
        Absolute: "Option.Absolute",
        "Always ask": "Option.AlwaysAsk",
        "Auto-approve low risk": "Option.AutoApproveLowRisk",
        "Auto when approved": "Option.AutoWhenApproved",
        Never: "Option.Never",
        Manual: "Option.Manual",
        "Ask each time": "Option.AskEachTime",
        "7 days": "Option.SevenDays",
        "30 days": "Option.ThirtyDays",
        "90 days": "Option.NinetyDays",
        Forever: "Option.Forever",
      }[value] || value,
    );
  const availableManualAdapters = (runtimeData?.adapterIds || []).filter((id) => id !== "fake");
  const [manualAdapterId, setManualAdapterId] = useState(availableManualAdapters[0] || "");
  const [manualProviderId, setManualProviderId] = useState("");
  const [manualModelId, setManualModelId] = useState("");
  const [manualModelName, setManualModelName] = useState("");
  const manualModels = Array.isArray(settings.manualModels) ? settings.manualModels : [];
  // Direct Vercel AI SDK provider configuration.
  const aiProviders = Array.isArray(settings.aiProviders) ? settings.aiProviders : [];
  const [providerName, setProviderName] = useState("");
  const [providerEndpoint, setProviderEndpoint] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerModelsInput, setProviderModelsInput] = useState("");
  const [providerApiVersion, setProviderApiVersion] = useState("");
  const [selectedProviderIndex, setSelectedProviderIndex] = useState(0);
  const [providerTab, setProviderTab] = useState<
    "connection" | "models" | "capabilities" | "advanced"
  >("models");
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [newProviderModel, setNewProviderModel] = useState("");
  const applyProviderPreset = (presetId: string) => {
    const preset = MODEL_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setProviderName(preset.name);
    setProviderEndpoint(preset.endpoint);
    setProviderApiVersion(preset.apiVersion ?? "");
    setProviderModelsInput(preset.models.join(", "));
  };
  const addAiProvider = () => {
    const name = providerName.trim();
    const endpoint = providerEndpoint.trim();
    const apiKey = providerApiKey.trim();
    const models = providerModelsInput
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (!name || !endpoint || !apiKey) return;
    const id = `provider-${Date.now().toString(36)}`;
    set("aiProviders", [
      ...aiProviders,
      { id, name, endpoint, apiKey, models, apiVersion: providerApiVersion.trim() || undefined },
    ]);
    setSelectedProviderIndex(aiProviders.length);
    setProviderTab("models");
    setProviderName("");
    setProviderEndpoint("");
    setProviderApiKey("");
    setProviderModelsInput("");
    setProviderApiVersion("");
  };
  const removeAiProvider = (index) => {
    const provider = aiProviders[index];
    set(
      "aiProviders",
      aiProviders.filter((_, providerIndex) => providerIndex !== index),
    );
    if (provider && settings.defaultModelId?.startsWith(`${provider.id}::`)) {
      set("defaultModelId", "");
    }
  };
  const updateAiProvider = (index: number, patch: Partial<UiSettings["aiProviders"][number]>) =>
    set(
      "aiProviders",
      aiProviders.map((provider, providerIndex) =>
        providerIndex === index ? { ...provider, ...patch } : provider,
      ),
    );
  const updateProviderModels = (index: number, models: string[]) => {
    const provider = aiProviders[index];
    const normalized = models
      .map((model) => model.trim())
      .filter(Boolean)
      .slice(0, 50);
    updateAiProvider(index, { models: normalized });
    if (
      provider &&
      settings.defaultModelId?.startsWith(`${provider.id}::`) &&
      !normalized.includes(settings.defaultModelId.slice(provider.id.length + 2))
    ) {
      set("defaultModelId", "");
    }
  };
  const addProviderModel = (index: number) => {
    const model = newProviderModel.trim();
    const provider = aiProviders[index];
    const models = provider?.models || (provider?.model ? [provider.model] : []);
    if (!model || models.includes(model)) return;
    updateProviderModels(index, [...models, model]);
    setNewProviderModel("");
  };
  const addManualModel = () => {
    const adapterId = manualAdapterId || availableManualAdapters[0] || "";
    const providerId = manualProviderId.trim();
    const modelId = manualModelId.trim();
    const name = (manualModelName.trim() || modelId).slice(0, 300);
    if (!adapterId || !providerId || !modelId || !name) return;
    if (manualModels.some((model) => model.adapterId === adapterId && model.modelId === modelId))
      return;
    set("manualModels", [
      ...manualModels,
      { adapterId, providerId, modelId: modelId.slice(0, 300), name },
    ]);
    setManualProviderId("");
    setManualModelId("");
    setManualModelName("");
  };
  const removeManualModel = (index) =>
    set(
      "manualModels",
      manualModels.filter((_model, modelIndex) => modelIndex !== index),
    );
  const adapterNames = {
    "vercel-ai": "Vercel AI SDK",
    fake: "Fake Fixture",
  };
  const runtimeAdapterRows = runtimeData
    ? (runtimeData.adapterIds || [])
        .filter((id) => id !== "fake")
        .map((id) => {
          const profile = (runtimeData.profiles || []).find((item) => item.adapterId === id);
          const state =
            profile?.status === "Ready"
              ? "Ready"
              : profile?.status === "RequiresLogin"
                ? "Requires login"
                : "Unavailable";
          return {
            id,
            name: adapterNames[id] || id,
            version: profile?.version || t(locale, "Status.Unavailable"),
            state,
            diagnostic: profile?.diagnostic,
          };
        })
    : [];
  const runtimeAuthProfiles = runtimeData
    ? (runtimeData.profiles || [])
        .filter((profile) => profile.adapterId !== "fake")
        .map((profile) => ({
          id: profile.id,
          adapterId: profile.adapterId,
          name: profile.name,
          adapter: adapterNames[profile.adapterId] || profile.adapterId,
          diagnostic: profile.diagnostic,
          state:
            profile.status === "Ready"
              ? "Ready"
              : profile.status === "RequiresLogin"
                ? "Requires login"
                : "Unavailable",
        }))
    : [];
  const runtimeModelGroups = runtimeData
    ? Object.entries<Array<{ name: string; tag?: string; state: string }>>(
        (runtimeData.models || []).reduce(
          (groups, model) => {
            const group = groups[model.adapterId] || [];
            group.push({
              name: model.name,
              tag: model.cliDefault
                ? "CLI Default"
                : model.verified
                  ? undefined
                  : t(locale, "Model.ManualUnverified"),
              state: model.verified ? "Available" : "Not installed",
            });
            groups[model.adapterId] = group;
            return groups;
          },
          {} as Record<string, Array<{ name: string; tag?: string; state: string }>>,
        ),
      ).map(([adapterId, models]) => ({
        adapter: adapterNames[adapterId] || adapterId,
        models,
      }))
    : [];
  const routingCandidates = runtimeData
    ? (runtimeData.models || [])
        .filter((model) => model.adapterId !== "fake")
        .map((model) => ({
          id: model.id,
          label: model.name,
          sub: `${model.adapterId} · ${
            model.cliDefault
              ? t(locale, "Model.CliDefault")
              : model.verified
                ? t(locale, "Model.Verified")
                : t(locale, "Model.ManualUnverified")
          }`,
        }))
    : [];
  const runtimeProject = runtimeData?.projects?.find((project) => project.id === activeProject);
  const runtimeDataDirectory = runtimeData?.dataDirectory;
  const runtimePath = (suffix) =>
    runtimeDataDirectory ? `${runtimeDataDirectory}/${suffix}` : t(locale, "Status.Unavailable");

  switch (section) {
    case "general":
      return (
        <>
          <SettingsGroup title={s("Startup")}>
            <SettingsRow title={s("RestoreWorkspace")}>
              <Toggle
                checked={settings.restoreWorkspace}
                onChange={(v) => set("restoreWorkspace", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("ConfirmClose")} desc={s("ConfirmCloseDescription")}>
              <Toggle checked={settings.confirmClose} onChange={(v) => set("confirmClose", v)} />
            </SettingsRow>
            <SettingsRow title={s("AutoProbe")}>
              <Toggle checked={settings.autoProbe} onChange={(v) => set("autoProbe", v)} />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title={s("Projects")}>
            <SettingsRow title={s("RecentProjectLimit")}>
              <Segmented
                options={["5", "10", "20"]}
                labelFor={optionLabel}
                value={settings.recentLimit}
                onChange={(v) => set("recentLimit", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("DefaultProjectDirectory")}>
              <div style={{ display: "flex", gap: 8 }}>
                <StaticField mono>{settings.defaultProjectDirectory || "~/Projects"}</StaticField>
                <button
                  style={btnGhost}
                  onClick={() => void onChooseDefaultProjectDirectory?.()}
                  disabled={!onChooseDefaultProjectDirectory}
                  title={t(locale, "Navigation.OpenProject")}
                  aria-label={t(locale, "Navigation.OpenProject")}
                >
                  <FolderOpen size={13} />
                </button>
              </div>
            </SettingsRow>
            <SettingsRow title={s("ExternalEditor")}>
              <Segmented
                options={["VS Code", "Cursor", "System Default"]}
                labelFor={optionLabel}
                value={settings.editor}
                onChange={(v) => set("editor", v)}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      );

    case "appearance":
      return (
        <>
          <SettingsGroup title={s("Theme")}>
            <SettingsRow title={s("Appearance")}>
              <Segmented
                options={["System", "Dark", "Light"]}
                labelFor={optionLabel}
                value={settings.theme}
                onChange={(v) => set("theme", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("AccentColor")}>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.entries(accentColors).map(([name, hex]) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => set("accent", name)}
                    aria-pressed={settings.accent === name}
                    title={name}
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: "50%",
                      background: hex,
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                      outline:
                        settings.accent === name
                          ? "2px solid var(--text-primary)"
                          : "2px solid transparent",
                      outlineOffset: 2,
                    }}
                  />
                ))}
              </div>
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title={s("Layout")}>
            <SettingsRow title={s("Density")}>
              <Segmented
                options={["Comfortable", "Compact"]}
                labelFor={optionLabel}
                value={settings.density}
                onChange={(v) => set("density", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("UiTextSize")}>
              <Segmented
                options={["Small", "Default", "Large"]}
                labelFor={optionLabel}
                value={settings.uiTextSize}
                onChange={(v) => set("uiTextSize", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("CodeTextSize")}>
              <Segmented
                options={["12", "13", "14", "16"]}
                labelFor={optionLabel}
                value={settings.codeTextSize}
                onChange={(v) => set("codeTextSize", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("TimestampFormat")}>
              <Segmented
                options={["Relative", "Absolute"]}
                labelFor={optionLabel}
                value={settings.timestampFormat}
                onChange={(v) => set("timestampFormat", v)}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      );

    case "language":
      return (
        <SettingsGroup title={t(locale, "Settings.ApplicationLanguage")}>
          {[
            { id: "System default", key: "Settings.SystemDefault" },
            { id: "English (en-US)", label: "English (en-US)" },
            { id: "简体中文 (zh-CN)", label: "简体中文 (zh-CN)" },
            { id: "繁體中文 (zh-TW)", label: "繁體中文 (zh-TW)" },
            { id: "日本語 (ja-JP)", label: "日本語 (ja-JP)" },
            { id: "한국어 (ko-KR)", label: "한국어 (ko-KR)" },
          ].map((l) => (
            <SettingsRow key={l.id} title={l.key ? t(locale, l.key) : l.label}>
              <button
                type="button"
                onClick={() => set("language", l.id)}
                aria-label={l.key ? t(locale, l.key) : l.label}
                style={{ ...btnGhost, padding: 2, border: 0 }}
              >
                {settings.language === l.id ? (
                  <Check size={16} color="var(--accent)" />
                ) : (
                  <Circle size={14} color="var(--border-strong)" />
                )}
              </button>
            </SettingsRow>
          ))}
        </SettingsGroup>
      );

    case "agents":
      return (
        <SettingsGroup title={s("VercelAiSdkProviders")}>
          <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 10 }}>
            {s("VercelAiSdkProvidersDescription")}
          </div>
          {aiProviders.map((provider, index) => (
            <SettingsRow
              key={provider.id}
              title={provider.name}
              desc={`${provider.models?.length ? t(locale, "SettingsText.ModelsCount", { count: provider.models.length }) : (provider.model ?? "")} · ${provider.endpoint.slice(0, 60)}${provider.endpoint.length > 60 ? "..." : ""}`}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Badge tone="accent">{provider.apiVersion ? "Azure" : "OpenAI"}</Badge>
                <button
                  type="button"
                  style={{ ...btnGhost, color: "var(--danger)" }}
                  onClick={() => removeAiProvider(index)}
                  aria-label={s("RemoveProvider")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </SettingsRow>
          ))}
          {!aiProviders.length && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginBottom: 10 }}>
              {s("NoProvidersConfigured")}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <select
              value=""
              onChange={(e) => applyProviderPreset(e.target.value)}
              aria-label={s("Preset")}
              style={{
                background: "var(--window)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 5,
                color: "var(--text-primary)",
                padding: "5px 6px",
                fontSize: 11,
                gridColumn: "1 / -1",
              }}
            >
              <option value="">{s("PresetOptional")}</option>
              {MODEL_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <input
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
              placeholder={s("ProviderNamePlaceholder")}
              aria-label={s("ProviderName")}
              style={{
                background: "var(--window)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 5,
                color: "var(--text-primary)",
                padding: "5px 6px",
                fontSize: 11,
              }}
            />
            <input
              value={providerModelsInput}
              onChange={(e) => setProviderModelsInput(e.target.value)}
              placeholder={s("ModelsExamplePlaceholder")}
              aria-label={s("Models")}
              style={{
                background: "var(--window)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 5,
                color: "var(--text-primary)",
                padding: "5px 6px",
                fontSize: 11,
                gridColumn: "1 / -1",
              }}
            />
            <input
              value={providerEndpoint}
              onChange={(e) => setProviderEndpoint(e.target.value)}
              placeholder={s("EndpointPlaceholder")}
              aria-label={s("EndpointUrl")}
              style={{
                background: "var(--window)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 5,
                color: "var(--text-primary)",
                padding: "5px 6px",
                fontSize: 11,
                gridColumn: "1 / -1",
              }}
            />
            <input
              value={providerApiKey}
              onChange={(e) => setProviderApiKey(e.target.value)}
              type="password"
              placeholder={s("ApiKey")}
              aria-label={s("ApiKey")}
              style={{
                background: "var(--window)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 5,
                color: "var(--text-primary)",
                padding: "5px 6px",
                fontSize: 11,
              }}
            />
            <input
              value={providerApiVersion}
              onChange={(e) => setProviderApiVersion(e.target.value)}
              placeholder={s("ApiVersionPlaceholder")}
              aria-label={s("ApiVersion")}
              style={{
                background: "var(--window)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 5,
                color: "var(--text-primary)",
                padding: "5px 6px",
                fontSize: 11,
              }}
            />
          </div>
          <button
            type="button"
            style={{ ...btnGhost, marginTop: 8 }}
            onClick={addAiProvider}
            disabled={!providerName || !providerEndpoint || !providerApiKey}
          >
            {s("AddProvider")}
          </button>
          {runtimeAdapterRows.length > 0 && (
            <div style={{ marginTop: 16 }}>
              {runtimeAdapterRows.map((a) => (
                <SettingsRow key={a.id} title={a.name} desc={a.version}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Badge tone={stateTone(a.state)}>
                      <span title={a.diagnostic || undefined}>
                        {a.state === "Unavailable"
                          ? t(locale, "Status.Unavailable")
                          : localizedStatus(locale, a.state)}
                      </span>
                    </Badge>
                    <button
                      style={btnGhost}
                      onClick={() => void onProbe?.()}
                      aria-label={`${t(locale, "Action.TestRun")} ${a.name}`}
                    >
                      {t(locale, "Action.TestRun")}
                    </button>
                  </div>
                </SettingsRow>
              ))}
            </div>
          )}
        </SettingsGroup>
      );

    case "models": {
      const selectedProvider = aiProviders[selectedProviderIndex] || aiProviders[0];
      const providerModels =
        selectedProvider?.models || (selectedProvider?.model ? [selectedProvider.model] : []);
      const normalizedProviderSearch = providerSearch.trim().toLowerCase();
      const normalizedModelSearch = modelSearch.trim().toLowerCase();
      const filteredProviders = aiProviders
        .map((provider, index) => ({ provider, index }))
        .filter(
          ({ provider }) =>
            !normalizedProviderSearch ||
            provider.name.toLowerCase().includes(normalizedProviderSearch) ||
            provider.endpoint.toLowerCase().includes(normalizedProviderSearch),
        );
      const filteredModels = providerModels
        .map((model, index) => ({ model, index }))
        .filter(
          ({ model }) =>
            !normalizedModelSearch || model.toLowerCase().includes(normalizedModelSearch),
        );
      const tabItems = [
        { id: "connection" as const, label: s("Connection"), icon: Link2 },
        { id: "models" as const, label: s("Models"), icon: CheckCircle2 },
        { id: "capabilities" as const, label: s("Capabilities"), icon: SlidersHorizontal },
        { id: "advanced" as const, label: s("Advanced"), icon: SlidersHorizontal },
      ];
      const fieldStyle = {
        width: "100%",
        boxSizing: "border-box" as const,
        background: "var(--window)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        color: "var(--text-primary)",
        padding: "8px 10px",
        fontSize: 12,
      };
      const providerState = selectedProvider
        ? (runtimeData?.profiles || []).some(
            (profile) => profile.adapterId === "vercel-ai" && profile.status === "Ready",
          )
          ? "Ready"
          : "Configured"
        : s("ProviderNotConfigured");
      const selectedDefaultModel = settings.defaultModelId || "";
      return (
        <div
          className="af-models-page"
          style={{
            display: "flex",
            minHeight: 560,
            margin: "-8px -12px -20px",
            border: "1px solid var(--border-subtle)",
            borderRadius: 10,
            overflow: "hidden",
            background: "var(--conversation)",
          }}
        >
          <aside
            className="af-models-sidebar"
            style={{
              width: 250,
              flexShrink: 0,
              borderRight: "1px solid var(--border-subtle)",
              background: "var(--sidebar)",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{ padding: "16px 14px 12px", borderBottom: "1px solid var(--border-subtle)" }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 650 }}>{s("Providers")}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>
                    {t(locale, "SettingsText.ConfiguredCount", { count: aiProviders.length })}
                  </div>
                </div>
                <button
                  type="button"
                  style={{
                    ...btnPrimary,
                    padding: "6px 9px",
                    display: "flex",
                    gap: 5,
                    alignItems: "center",
                  }}
                  onClick={() => setShowAddProvider((value) => !value)}
                  aria-label={s("AddProvider")}
                >
                  <Plus size={13} /> {s("AddProvider")}
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  padding: "7px 9px",
                  background: "var(--window)",
                }}
              >
                <Search size={13} color="var(--text-muted)" />
                <input
                  aria-label={s("SearchProviders")}
                  placeholder={s("SearchProviders")}
                  value={providerSearch}
                  onChange={(event) => setProviderSearch(event.target.value)}
                  style={{
                    border: 0,
                    outline: 0,
                    background: "transparent",
                    color: "var(--text-primary)",
                    width: "100%",
                    fontSize: 12,
                  }}
                />
              </div>
            </div>
            {showAddProvider && (
              <div
                style={{
                  padding: 12,
                  borderBottom: "1px solid var(--border-subtle)",
                  background: "var(--elevated)",
                }}
              >
                <select
                  value=""
                  onChange={(event) => applyProviderPreset(event.target.value)}
                  aria-label={s("ProviderPreset")}
                  style={{ ...fieldStyle, marginBottom: 7 }}
                >
                  <option value="">{s("ChoosePreset")}</option>
                  {MODEL_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <input
                  value={providerName}
                  onChange={(event) => setProviderName(event.target.value)}
                  placeholder={s("ProviderName")}
                  aria-label={s("ProviderName")}
                  style={{ ...fieldStyle, marginBottom: 7 }}
                />
                <input
                  value={providerEndpoint}
                  onChange={(event) => setProviderEndpoint(event.target.value)}
                  placeholder={s("EndpointUrl")}
                  aria-label={s("EndpointUrl")}
                  style={{ ...fieldStyle, marginBottom: 7 }}
                />
                <input
                  value={providerApiKey}
                  onChange={(event) => setProviderApiKey(event.target.value)}
                  type="password"
                  placeholder={s("ApiKey")}
                  aria-label={s("ApiKey")}
                  style={{ ...fieldStyle, marginBottom: 7 }}
                />
                <input
                  value={providerModelsInput}
                  onChange={(event) => setProviderModelsInput(event.target.value)}
                  placeholder={s("ModelsPlaceholder")}
                  aria-label={s("Models")}
                  style={{ ...fieldStyle, marginBottom: 7 }}
                />
                <button
                  type="button"
                  style={{ ...btnPrimary, width: "100%" }}
                  onClick={() => {
                    addAiProvider();
                    setShowAddProvider(false);
                  }}
                  disabled={!providerName || !providerEndpoint || !providerApiKey}
                >
                  {s("AddProvider")}
                </button>
              </div>
            )}
            <div className="af-scroll" style={{ flex: 1, overflowY: "auto", padding: 8 }}>
              {filteredProviders.map(({ provider, index }) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => {
                    setSelectedProviderIndex(index);
                    setProviderTab("models");
                  }}
                  aria-pressed={selectedProviderIndex === index}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border:
                      selectedProviderIndex === index
                        ? "1px solid var(--accent)"
                        : "1px solid transparent",
                    borderRadius: 7,
                    background: selectedProviderIndex === index ? "var(--selected)" : "transparent",
                    color: "var(--text-primary)",
                    padding: "10px 9px",
                    marginBottom: 4,
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        background: "var(--success)",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {provider.name}
                    </span>
                  </div>
                  <div style={{ margin: "5px 0 0 16px", color: "var(--text-muted)", fontSize: 11 }}>
                    {t(locale, "SettingsText.ModelsCount", {
                      count: provider.models?.length || (provider.model ? 1 : 0),
                    })} ·{" "}
                    {provider.apiVersion ? "Azure" : "OpenAI"}
                  </div>
                </button>
              ))}
              {!aiProviders.length ? (
                <div
                  style={{
                    padding: "28px 12px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  {s("NoProvidersYet")}
                  <br />
                  {s("UseAddToConnect")}
                </div>
              ) : (
                !filteredProviders.length && (
                  <div
                    style={{
                      padding: "28px 12px",
                      textAlign: "center",
                      color: "var(--text-muted)",
                      fontSize: 12,
                    }}
                  >
                    {s("NoMatchingProviders")}
                  </div>
                )
              )}
            </div>
          </aside>
          <main
            className="af-models-main af-scroll"
            style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "26px 32px" }}
          >
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 16,
                  marginBottom: 22,
                }}
              >
                <div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 5 }}>
                    {s("Provider")} / {selectedProvider?.name || s("ProviderNotConfigured")}
                  </div>
                  <h2 style={{ margin: 0, fontSize: 23, lineHeight: 1.2 }}>
                    {selectedProvider?.name || s("ModelsAndProviders")}
                  </h2>
                  <div style={{ marginTop: 8, color: "var(--text-secondary)", fontSize: 12 }}>
                    {selectedProvider
                      ? `${selectedProvider.endpoint} · ${t(locale, "SettingsText.ModelsCount", { count: providerModels.length })}`
                      : s("ConnectProviderDescription")}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Badge tone={providerState === "Ready" ? "success" : selectedProvider ? "accent" : "muted"}>
                    <Dot tone={providerState === "Ready" ? "success" : selectedProvider ? "accent" : "muted"} />{" "}
                    {providerState === "Ready" ? t(locale, "Status.Ready") : selectedProvider ? s("Configured") : s("ProviderNotConfigured")}
                  </Badge>
                  {selectedProvider && (
                    <button type="button" style={btnGhost} onClick={() => void onProbe?.()}>
                      {t(locale, "Action.TestRun")}
                    </button>
                  )}
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 4,
                  borderBottom: "1px solid var(--border-subtle)",
                  marginBottom: 24,
                }}
              >
                {tabItems.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setProviderTab(id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      border: 0,
                      borderBottom:
                        providerTab === id ? "2px solid var(--accent)" : "2px solid transparent",
                      background: "transparent",
                      color: providerTab === id ? "var(--accent)" : "var(--text-secondary)",
                      padding: "9px 14px",
                      fontSize: 12.5,
                      cursor: "pointer",
                    }}
                  >
                    <Icon size={13} />
                    {label}
                  </button>
                ))}
              </div>
              {providerTab === "models" && (
                <>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 650 }}>
                        {t(locale, "SettingsText.ModelList", { count: providerModels.length })}
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginTop: 4 }}>
                        {s("CatalogDescription")}
                      </div>
                    </div>
                    <button type="button" style={btnGhost} onClick={() => void onProbe?.()}>
                      <Download size={13} /> {s("RefreshModels")}
                    </button>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      border: "1px solid var(--border-subtle)",
                      borderRadius: 7,
                      padding: "9px 11px",
                      marginBottom: 10,
                    }}
                  >
                    <Search size={14} color="var(--text-muted)" />
                    <input
                      aria-label={s("SearchModels")}
                      placeholder={s("SearchModels")}
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      style={{
                        border: 0,
                        outline: 0,
                        background: "transparent",
                        color: "var(--text-primary)",
                        flex: 1,
                        fontSize: 12,
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 7, marginBottom: 14 }}>
                    <input
                      aria-label={s("NewModel")}
                      placeholder={s("AddModelId")}
                      value={newProviderModel}
                      onChange={(event) => setNewProviderModel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") addProviderModel(selectedProviderIndex);
                      }}
                      style={{ ...fieldStyle, flex: 1 }}
                    />
                    <button
                      type="button"
                      style={btnGhost}
                      onClick={() => addProviderModel(selectedProviderIndex)}
                      disabled={!newProviderModel.trim() || providerModels.length >= 50}
                    >
                      <Plus size={13} /> {s("AddModel")}
                    </button>
                  </div>
                  {filteredModels.map(({ model, index }) => (
                    <div
                      key={model}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 7,
                        padding: "12px 13px",
                        marginBottom: 7,
                        background: "var(--elevated)",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="af-mono" style={{ fontSize: 12.5 }}>
                          {model}
                        </div>
                        <div style={{ display: "flex", gap: 6, marginTop: 7, alignItems: "center" }}>
                          <Badge tone="muted">{s("TextChat")}</Badge>
                          <Badge tone="accent">Vercel AI SDK</Badge>
                          {selectedDefaultModel === `${selectedProvider?.id}::${model}` && (
                            <Badge tone="success">{s("AutomaticDefault")}</Badge>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          type="button"
                          style={{
                            ...btnGhost,
                            color:
                              selectedDefaultModel === `${selectedProvider?.id}::${model}`
                                ? "var(--accent)"
                                : "var(--text-secondary)",
                          }}
                          onClick={() =>
                            set(
                              "defaultModelId",
                              selectedDefaultModel === `${selectedProvider?.id}::${model}`
                                ? ""
                                : `${selectedProvider?.id}::${model}`,
                            )
                          }
                          title={
                            selectedDefaultModel === `${selectedProvider?.id}::${model}`
                              ? s("ClearAutomaticDefault")
                              : s("UseAutomaticRouting")
                          }
                          aria-label={
                            selectedDefaultModel === `${selectedProvider?.id}::${model}`
                              ? t(locale, "SettingsText.ClearDefault", { model })
                              : t(locale, "SettingsText.SetAutomaticDefault", { model })
                          }
                        >
                          <Check size={13} />
                        </button>
                        <button
                          type="button"
                          style={btnGhost}
                          onClick={() => {
                            const next = window.prompt(s("ModelNamePrompt"), model)?.trim();
                            if (next && next !== model && !providerModels.includes(next)) {
                              updateProviderModels(
                                selectedProviderIndex,
                                providerModels.map((item, itemIndex) =>
                                  itemIndex === index ? next : item,
                                ),
                              );
                            }
                          }}
                          aria-label={`Edit ${model}`}
                        >
                          {s("Edit")}
                        </button>
                        <button
                          type="button"
                          style={{ ...btnGhost, color: "var(--danger)" }}
                          onClick={() =>
                            updateProviderModels(
                              selectedProviderIndex,
                              providerModels.filter((_item, itemIndex) => itemIndex !== index),
                            )
                          }
                          disabled={providerModels.length <= 1}
                          title={
                            providerModels.length <= 1
                              ? s("ProviderMustKeepModel")
                              : s("RemoveModel")
                          }
                          aria-label={t(locale, "SettingsText.RemoveModel")}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {!providerModels.length && (
                    <div
                      style={{
                        padding: 38,
                        textAlign: "center",
                        border: "1px dashed var(--border-strong)",
                        borderRadius: 8,
                        color: "var(--text-muted)",
                        fontSize: 12,
                      }}
                    >
                      {s("NoModelsConfigured")}
                    </div>
                  )}
                </>
              )}
              {providerTab === "connection" && (
                <SettingsGroup title={s("Connection")}>
                  <SettingsRow
                    title={s("ProviderName")}
                    desc={s("ProviderNameDescription")}
                  >
                    <input
                      aria-label={s("ProviderName")}
                      value={selectedProvider?.name || ""}
                      onChange={(event) =>
                        selectedProvider &&
                        updateAiProvider(selectedProviderIndex, { name: event.target.value })
                      }
                      style={{ ...fieldStyle, width: "min(100%, 420px)" }}
                    />
                  </SettingsRow>
                  <SettingsRow
                    title={s("Endpoint")}
                    desc={s("EndpointDescription")}
                  >
                    <input
                      aria-label={s("Endpoint")}
                      value={selectedProvider?.endpoint || ""}
                      onChange={(event) =>
                        selectedProvider &&
                        updateAiProvider(selectedProviderIndex, { endpoint: event.target.value })
                      }
                      style={{ ...fieldStyle, width: "min(100%, 420px)" }}
                    />
                  </SettingsRow>
                  <SettingsRow
                    title={s("ApiKey")}
                    desc={s("ApiKeyDescription")}
                  >
                    <input
                      aria-label={s("ApiKey")}
                      type="password"
                      value={selectedProvider?.apiKey || ""}
                      onChange={(event) =>
                        selectedProvider &&
                        updateAiProvider(selectedProviderIndex, { apiKey: event.target.value })
                      }
                      style={{ ...fieldStyle, width: "min(100%, 420px)" }}
                    />
                  </SettingsRow>
                  <SettingsRow
                    title={s("ApiVersion")}
                    desc={s("ApiVersionDescription")}
                  >
                    <input
                      aria-label={s("ApiVersion")}
                      value={selectedProvider?.apiVersion || ""}
                      onChange={(event) =>
                        selectedProvider &&
                        updateAiProvider(selectedProviderIndex, {
                          apiVersion: event.target.value || undefined,
                        })
                      }
                      style={{ ...fieldStyle, width: "min(100%, 420px)" }}
                    />
                  </SettingsRow>
                  {selectedProvider && (
                    <div
                      style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}
                    >
                      <Badge tone="success">{s("SavedLocally")}</Badge>
                      <button
                        type="button"
                        style={{ ...btnGhost, color: "var(--danger)" }}
                        onClick={() => {
                          removeAiProvider(selectedProviderIndex);
                          setSelectedProviderIndex(0);
                          setProviderTab("models");
                        }}
                      >
                        <Trash2 size={13} /> {s("RemoveProvider")}
                      </button>
                    </div>
                  )}
                </SettingsGroup>
              )}
              {providerTab === "capabilities" && (
                <SettingsGroup title={s("Capabilities")}>
                  <SettingsRow
                    title={s("AutomaticSelection")}
                    desc={s("AutomaticSelectionDescription")}
                  >
                    <Badge tone="accent">{t(locale, "Option.Default")}</Badge>
                  </SettingsRow>
                  <SettingsRow title={s("ConcurrencyLimit")}>
                    <Segmented
                      options={["1", "2", "3", "4"]}
                      labelFor={optionLabel}
                      value={settings.concurrencyLimit}
                      onChange={(v) => set("concurrencyLimit", v)}
                    />
                  </SettingsRow>
                  <SettingsRow
                    title={s("AllowRiskOverrides")}
                    desc={s("AllowRiskOverridesDescription")}
                  >
                    <Toggle
                      checked={settings.allowRiskOverrides}
                      onChange={(v) => set("allowRiskOverrides", v)}
                    />
                  </SettingsRow>
                </SettingsGroup>
              )}
              {providerTab === "advanced" && (
                <>
                  <SettingsGroup title={s("Advanced")}>
                    <SettingsRow
                      title={s("Authentication")}
                      desc={s("AuthenticationDescription")}
                    >
                      <Badge tone="muted">{s("DirectApi")}</Badge>
                    </SettingsRow>
                    <SettingsRow
                      title={s("ManualModels")}
                      desc={t(locale, "SettingsText.ManualModelsCount", { count: manualModels.length })}
                    >
                      <Badge tone="warning">{s("Advanced")}</Badge>
                    </SettingsRow>
                  </SettingsGroup>
                  <details style={{ marginTop: 18 }}>
                    <summary
                      style={{ cursor: "pointer", color: "var(--text-secondary)", fontSize: 12.5 }}
                    >
                      {s("ManageManualModels")}
                    </summary>
                    <SettingsGroup title={s("ManualModels")}>
                      <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginBottom: 10 }}>
                        {s("ManualModelsDescription")}
                      </div>
                      {manualModels.map((entry, index) => (
                        <SettingsRow
                          key={`${entry.adapterId}:${entry.modelId}`}
                          title={entry.name}
                          desc={`${entry.adapterId} · ${entry.providerId} · ${entry.modelId}`}
                        >
                          <button
                            type="button"
                            style={{ ...btnGhost, color: "var(--danger)" }}
                            onClick={() => removeManualModel(index)}
                            aria-label={s("RemoveModel")}
                          >
                            <Trash2 size={13} />
                          </button>
                        </SettingsRow>
                      ))}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: 7,
                          marginTop: 8,
                        }}
                      >
                        <select
                          value={manualAdapterId || availableManualAdapters[0] || ""}
                          onChange={(event) => setManualAdapterId(event.target.value)}
                          aria-label={s("Adapter")}
                          style={fieldStyle}
                        >
                          {!availableManualAdapters.length && (
                            <option value="">{s("Adapter")}</option>
                          )}
                          {availableManualAdapters.map((adapterId) => (
                            <option key={adapterId} value={adapterId}>
                              {adapterNames[adapterId] || adapterId}
                            </option>
                          ))}
                        </select>
                        <input
                          value={manualProviderId}
                          onChange={(event) => setManualProviderId(event.target.value)}
                          placeholder={s("Provider")}
                          aria-label={s("Provider")}
                          style={fieldStyle}
                        />
                        <input
                          value={manualModelId}
                          onChange={(event) => setManualModelId(event.target.value)}
                          placeholder={s("ModelId")}
                          aria-label={s("ModelId")}
                          style={fieldStyle}
                        />
                        <input
                          value={manualModelName}
                          onChange={(event) => setManualModelName(event.target.value)}
                          placeholder={s("ModelName")}
                          aria-label={s("ModelName")}
                          style={fieldStyle}
                        />
                      </div>
                      <button
                        type="button"
                        style={{ ...btnGhost, marginTop: 8 }}
                        onClick={addManualModel}
                        disabled={
                          !availableManualAdapters.length || !manualProviderId || !manualModelId
                        }
                      >
                        {s("AddModel")}
                      </button>
                    </SettingsGroup>
                  </details>
                </>
              )}
            </div>
          </main>
        </div>
      );
    }

    case "auth":
      return (
        <SettingsGroup title={s("Profiles")}>
          {runtimeAuthProfiles.map((p) => (
            <SettingsRow key={p.name} title={p.name} desc={p.adapter}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Badge tone={stateTone(p.state)}>
                  <span title={p.diagnostic || undefined}>
                    {p.state === "Unavailable"
                      ? t(locale, "Status.Unavailable")
                      : localizedStatus(locale, p.state)}
                  </span>
                </Badge>
                <Badge tone="muted">{s("ApiKey")}</Badge>
              </div>
            </SettingsRow>
          ))}
          <div style={{ marginTop: 12, color: "var(--text-muted)", fontSize: 12 }}>
            {s("DirectApiCredentialsDescription")}
          </div>
        </SettingsGroup>
      );

    case "workflows":
      return (
        <>
          <SettingsGroup title={s("Execution")}>
            <SettingsRow title={s("WorkerCount")} desc={s("WorkerCountDescription")}>
              <Segmented
                options={["1", "2", "3", "4"]}
                labelFor={optionLabel}
                value={settings.workerCount}
                onChange={(v) => set("workerCount", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("RetriesPerTask")}>
              <Segmented
                options={["0", "1", "2", "3"]}
                labelFor={optionLabel}
                value={settings.retries}
                onChange={(v) => set("retries", v)}
              />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title={s("Gates")}>
            <SettingsRow title={s("PlanApprovalPolicy")}>
              <Segmented
                options={["Always ask", "Auto-approve low risk"]}
                labelFor={optionLabel}
                value={settings.planApproval}
                onChange={(v) => set("planApproval", v)}
              />
            </SettingsRow>
            <SettingsRow
              title={s("BlockOnFailingValidation")}
              desc={s("BlockOnFailingValidationDescription")}
            >
              <Toggle
                checked={settings.blockOnFailingValidation}
                onChange={(v) => set("blockOnFailingValidation", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("RequireIndependentReviewer")}>
              <Toggle
                checked={settings.requireIndependentReviewer}
                onChange={(v) => set("requireIndependentReviewer", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("IntegrationPolicy")}>
              <Segmented
                options={["Manual", "Auto when approved"]}
                labelFor={optionLabel}
                value={settings.integrationPolicy}
                onChange={(v) => set("integrationPolicy", v)}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      );

    case "routing":
      return (
        <>
          <SettingsGroup title={s("PreferenceOrder")}>
            {routingCandidates.length ? (
              routingCandidates.map((candidate, index) => (
                <div
                  key={candidate.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 8px",
                    background: "var(--window)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 6,
                    marginBottom: 4,
                  }}
                >
                  <GripVertical size={13} color="var(--text-muted)" />
                  <span className="af-mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {index + 1}
                  </span>
                  <span style={{ fontSize: 12.5 }}>{candidate.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
                    {candidate.sub}
                  </span>
                </div>
              ))
            ) : (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "8px 0" }}>
                {s("NoModelsDiscovered")}
              </div>
            )}
          </SettingsGroup>
          <SettingsGroup title={s("Limits")}>
            <SettingsRow title={s("ConcurrencyLimit")}>
              <Segmented
                options={["1", "2", "3", "4"]}
                labelFor={optionLabel}
                value={settings.concurrencyLimit}
                onChange={(v) => set("concurrencyLimit", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("AllowRiskOverrides")} desc={s("AllowRiskOverridesDescription")}>
              <Toggle
                checked={settings.allowRiskOverrides}
                onChange={(v) => set("allowRiskOverrides", v)}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      );

    case "permissions": {
      const custom = normalizeCustomPermissionDimensions(settings.customPermissionDimensions);
      const updateCustom = (key, value) =>
        set("customPermissionDimensions", { ...custom, [key]: value });
      return (
        <>
          <SettingsGroup title={s("Profiles")}>
            {permissionProfiles.map((p) => (
              <SettingsRow
                key={p.name}
                title={permissionProfileLabel(locale, p.name)}
                desc={s(p.descKey)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {p.isDefault && <Badge tone="accent">{t(locale, "SettingsText.Default")}</Badge>}
                </div>
              </SettingsRow>
            ))}
          </SettingsGroup>
          <SettingsGroup title={s("CustomProfileDimensions")}>
            <PermissionListInput
              title={s("ReadablePaths")}
              value={custom.readPaths}
              onChange={(value) => updateCustom("readPaths", value)}
              locale={locale}
            />
            <PermissionListInput
              title={s("WritablePaths")}
              value={custom.writePaths}
              onChange={(value) => updateCustom("writePaths", value)}
              locale={locale}
            />
            <PermissionListInput
              title={s("AllowedCommands")}
              value={custom.commands}
              onChange={(value) => updateCustom("commands", value)}
              locale={locale}
            />
            <PermissionListInput
              title={s("ProtectedPaths")}
              value={custom.protectedPaths}
              onChange={(value) => updateCustom("protectedPaths", value)}
              locale={locale}
            />
            {[
              ["network", s("NetworkAccess")],
              ["packageInstall", s("PackageInstallation")],
              ["dependencyChanges", s("DependencyChanges")],
              ["projectFileChanges", s("ProjectFileChanges")],
              ["externalProcesses", s("ExternalProcesses")],
              ["clipboard", s("ClipboardAccess")],
              ["browser", s("BrowserAccess")],
              ["externalDirectories", s("ExternalDirectories")],
              ["remoteGit", s("RemoteGitOperations")],
            ].map(([key, label]) => (
              <SettingsRow key={key} title={label}>
                <Toggle
                  checked={Boolean(custom[key])}
                  onChange={(value) => updateCustom(key, value)}
                />
              </SettingsRow>
            ))}
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8 }}>
              {s("SecretAccessDenied")}
            </div>
          </SettingsGroup>
          <SettingsGroup title={s("ApprovalRequirements")}>
            <SettingsRow title={s("RequireApprovalNetwork")}>
              <Toggle
                checked={settings.requireApprovalNetwork}
                onChange={(v) => set("requireApprovalNetwork", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("RequireApprovalPackages")}>
              <Toggle
                checked={settings.requireApprovalPackages}
                onChange={(v) => set("requireApprovalPackages", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("ProtectedPaths")}>
              <StaticField mono>.env, secrets/, .agentflow/policies/</StaticField>
            </SettingsRow>
          </SettingsGroup>
        </>
      );
    }

    case "git":
      return (
        <SettingsGroup title={s("Repository")}>
          <SettingsRow title={s("GitExecutable")}>
            <StaticField mono>git</StaticField>
          </SettingsRow>
          <SettingsRow title={s("TargetBranch")}>
            <StaticField mono>
              {runtimeProject?.defaultBranch || t(locale, "Status.Unavailable")}
            </StaticField>
          </SettingsRow>
          <SettingsRow title={s("WorktreeRoot")}>
            <StaticField mono>{runtimePath("worktrees")}</StaticField>
          </SettingsRow>
          <SettingsRow title={s("BranchTemplate")}>
            <StaticField mono>
              agentflow/{"{cr}"}/{"{task}"}
            </StaticField>
          </SettingsRow>
          <SettingsRow title={s("CommitTemplate")}>
            <StaticField mono>
              [{"{task}"}] {"{summary}"}
            </StaticField>
          </SettingsRow>
          <SettingsRow title={s("PushPolicy")}>
            <Segmented
              options={["Never", "Manual", "Ask each time"]}
              labelFor={optionLabel}
              value={settings.pushPolicy}
              onChange={(v) => set("pushPolicy", v)}
            />
          </SettingsRow>
        </SettingsGroup>
      );

    case "safety":
      return (
        <SettingsGroup title={s("AlwaysRequiresApproval")}>
          {safetyLocks.map(([key, label]) => (
            <SettingsRow key={label} title={s(key)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Lock size={13} color="var(--text-muted)" />
                <Badge tone="danger">{t(locale, "SettingsText.Locked")}</Badge>
              </div>
            </SettingsRow>
          ))}
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 10 }}>
            {s("SafetyDescription")}
          </div>
        </SettingsGroup>
      );

    case "notifications":
      return (
        <>
          <SettingsGroup title={s("Channels")}>
            <SettingsRow title={s("InAppNotifications")}>
              <Toggle checked={settings.inAppNotif} onChange={(v) => set("inAppNotif", v)} />
            </SettingsRow>
            <SettingsRow title={s("SystemNotifications")}>
              <Toggle checked={settings.systemNotif} onChange={(v) => set("systemNotif", v)} />
            </SettingsRow>
            <SettingsRow title={s("Sound")}>
              <Toggle checked={settings.soundNotif} onChange={(v) => set("soundNotif", v)} />
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title={s("Events")}>
            <SettingsRow title={s("PlanAwaitingApproval")}>
              <Toggle
                checked={settings.notifPlanApproval}
                onChange={(v) => set("notifPlanApproval", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("AgentFailure")}>
              <Toggle
                checked={settings.notifAgentFailure}
                onChange={(v) => set("notifAgentFailure", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("TaskBlocked")}>
              <Toggle
                checked={settings.notifBlockedTask}
                onChange={(v) => set("notifBlockedTask", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("ReviewComplete")}>
              <Toggle
                checked={settings.notifReviewComplete}
                onChange={(v) => set("notifReviewComplete", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("ValidationComplete")}>
              <Toggle
                checked={settings.notifValidationComplete}
                onChange={(v) => set("notifValidationComplete", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("IntegrationReady")}>
              <Toggle
                checked={settings.notifIntegrationReady}
                onChange={(v) => set("notifIntegrationReady", v)}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      );

    case "storage":
      return (
        <>
          <SettingsGroup title={s("Locations")}>
            <SettingsRow title={s("Database")}>
              <StaticField mono>{runtimePath("agentflow.db")}</StaticField>
            </SettingsRow>
            <SettingsRow title={s("Artifacts")}>
              <StaticField mono>{runtimePath("artifacts")}</StaticField>
            </SettingsRow>
            <SettingsRow title={s("Worktrees")}>
              <StaticField mono>{runtimePath("worktrees")}</StaticField>
            </SettingsRow>
          </SettingsGroup>
          <SettingsGroup title={s("Usage")}>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 10 }}>
              {runtimeDataDirectory
                ? `${runtimeDataDirectory} · ${t(locale, "SettingsText.UsageMeasuredOnDemand")}`
                : t(locale, "Status.Unavailable")}
            </div>
            <SettingsRow title={s("ArtifactRetention")}>
              <Segmented
                options={["7 days", "30 days", "90 days", "Forever"]}
                labelFor={optionLabel}
                value={settings.retention}
                onChange={(v) => set("retention", v)}
              />
            </SettingsRow>
            <SettingsRow title={s("Diagnostics")}>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={btnGhost} onClick={onExportDiagnostics}>
                  {t(locale, "Action.ExportDiagnostics")}
                </button>
                <button style={btnGhost} disabled title={t(locale, "Action.UnavailableInBuild")}>
                  {t(locale, "Action.ClearCache")}
                </button>
              </div>
            </SettingsRow>
          </SettingsGroup>
        </>
      );

    case "accessibility":
      return (
        <SettingsGroup title={s("Accessibility")}>
          <SettingsRow title={s("ReducedMotion")}>
            <Toggle checked={settings.reducedMotion} onChange={(v) => set("reducedMotion", v)} />
          </SettingsRow>
          <SettingsRow title={s("HighContrastFocus")}>
            <Toggle
              checked={settings.highContrastFocus}
              onChange={(v) => set("highContrastFocus", v)}
            />
          </SettingsRow>
          <SettingsRow title={s("ScreenReaderAnnouncements")}>
            <Toggle
              checked={settings.screenReaderAnnouncements}
              onChange={(v) => set("screenReaderAnnouncements", v)}
            />
          </SettingsRow>
        </SettingsGroup>
      );

    case "advanced":
      return (
        <>
          <SettingsGroup title={s("Reset")}>
            <SettingsRow title={s("ResetLayout")}>
              <button style={btnGhost} onClick={onResetLayout}>
                <RefreshCw size={13} />
              </button>
            </SettingsRow>
            <SettingsRow title={s("ExportSupportBundle")}>
              <button style={btnGhost} onClick={onExportDiagnostics}>
                {t(locale, "Action.Export")}
              </button>
            </SettingsRow>
            <SettingsRow title={s("ResetAllSettings")} desc={s("ResetAllSettingsDescription")}>
              <button style={btnDanger} onClick={onResetSettings}>
                <Trash2 size={13} />
              </button>
            </SettingsRow>
          </SettingsGroup>
        </>
      );

    case "about":
      return (
        <SettingsGroup title={s("AgentFlow")}>
          <SettingsRow title={s("Version")}>
            <span className="af-mono" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {import.meta.env.VITE_APP_VERSION || "0.1.0"}
            </span>
          </SettingsRow>
          <SettingsRow title={s("Updates")}>
            <button style={btnGhost} disabled title={t(locale, "Action.UnavailableInBuild")}>
              {t(locale, "Action.CheckForUpdates")}
            </button>
          </SettingsRow>
          <SettingsRow title={s("License")}>
            <span style={{ fontSize: 12.5, color: "var(--accent)", cursor: "pointer" }}>
              {s("ViewLicense")}
            </span>
          </SettingsRow>
          <SettingsRow title={s("ThirdPartyNotices")}>
            <span style={{ fontSize: 12.5, color: "var(--accent)", cursor: "pointer" }}>
              {s("ViewNotices")}
            </span>
          </SettingsRow>
        </SettingsGroup>
      );

    default:
      return null;
  }
});

/* ---------------------------- main workspace ---------------------------- */
