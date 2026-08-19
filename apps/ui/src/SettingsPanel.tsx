import React from "react";
import { X, Search } from "lucide-react";
import { t } from "@agentflow/localization";
import type { SettingsPanelProps } from "./types";
import { btnGhost } from "./constants";
import { SettingsContent } from "./SettingsContent";

export const SettingsPanel = React.memo(function SettingsPanel({
  settingsOpen,
  setSettingsOpen,
  labels,
  locale,
  settingsSearch,
  setSettingsSearch,
  filteredSections,
  settingsSection,
  setSettingsSection,
  sectionLabel,
  activeSectionMeta,
  settings,
  setSetting,
  runtimeData,
  activeProject,
  probeProfiles,
  exportDiagnostics,
  resetLayout,
  resetAllSettings,
  bridge,
  chooseDefaultProjectDirectory,
}: SettingsPanelProps) {
  if (!settingsOpen) return null;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "var(--window)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          padding: "14px 20px",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600 }}>{labels.settings}</div>
        <button
          onClick={() => setSettingsOpen(false)}
          style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 6 }}
        >
          <X size={13} /> {t(locale, "Navigation.Close")}
        </button>
      </div>
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div
          style={{
            width: 240,
            flexShrink: 0,
            borderRight: "1px solid var(--border-subtle)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ padding: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "var(--elevated)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                padding: "6px 10px",
              }}
            >
              <Search size={13} color="var(--text-muted)" />
              <input
                value={settingsSearch}
                onChange={(e) => setSettingsSearch(e.target.value)}
                placeholder={t(locale, "Navigation.SearchSettings")}
                style={{
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  fontSize: 12.5,
                  color: "var(--text-primary)",
                  width: "100%",
                }}
              />
            </div>
          </div>
          <div className="af-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 8px" }}>
            {filteredSections.map((s) => {
              const Icon = s.icon;
              const active = s.id === settingsSection;
              return (
                <div
                  key={s.id}
                  className="af-nav-item"
                  onClick={() => setSettingsSection(s.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "pointer",
                    marginBottom: 1,
                    background: active ? "var(--selected)" : "transparent",
                    color: active ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                >
                  <Icon size={14} color={active ? "var(--accent)" : "var(--text-muted)"} />
                  <span style={{ fontSize: 12.5, fontWeight: active ? 600 : 400 }}>
                    {sectionLabel(s)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="af-settings-content af-scroll"
          style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "28px 32px" }}
        >
          <div className="af-settings-content-inner" style={{ maxWidth: 1120, margin: "0 auto" }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 18 }}>
              {activeSectionMeta ? sectionLabel(activeSectionMeta) : undefined}
            </div>
            <SettingsContent
              section={settingsSection}
              settings={settings}
              set={setSetting}
              locale={locale}
              runtimeData={runtimeData}
              activeProject={activeProject}
              onProbe={probeProfiles}
              onExportDiagnostics={exportDiagnostics}
              onResetLayout={resetLayout}
              onResetSettings={resetAllSettings}
              onChooseDefaultProjectDirectory={bridge ? chooseDefaultProjectDirectory : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
});
