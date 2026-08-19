import React, { useState } from "react";
import { Search, ChevronRight, Sparkles, Check } from "lucide-react";
import { t, type Locale } from "@agentflow/localization";
import type { ComposerProps } from "./types";
import { Badge } from "./ui-primitives";

type ModelGroup = ComposerProps["modelGroups"][number];
type ModelEntry = ModelGroup["models"][number];
type VisibleModel = ModelEntry & { groupLabel?: string };

interface ModelPickerProps {
  open: boolean;
  locale: Locale;
  model: string;
  modelGroups: ModelGroup[];
  hasAuto: boolean;
  selectModel: (modelId: string) => void;
}

/**
 * Two-pane model picker (provider groups on the left, models on the right),
 * mirroring the Kun-style flyout. Search filters across all groups; an empty
 * query shows the active group's models.
 */
export function ModelPicker({
  open,
  locale,
  model,
  modelGroups,
  hasAuto,
  selectModel,
}: ModelPickerProps) {
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  if (!open) return null;

  const activeGroup = modelGroups.find((group) => group.id === activeGroupId) ?? modelGroups[0];
  const normalized = search.trim().toLowerCase();

  const visibleModels: VisibleModel[] = normalized
    ? modelGroups.flatMap((group) =>
        group.models
          .filter((entry) =>
            [entry.label, entry.id, entry.model.providerModelId]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(normalized)),
          )
          .map((entry) => ({ ...entry, groupLabel: group.label })),
      )
    : (activeGroup?.models ?? []);

  const rowStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 10px",
    borderRadius: 6,
    cursor: "pointer",
    background: active ? "var(--selected)" : "transparent",
    color: active ? "var(--text-primary)" : "var(--text-secondary)",
    fontSize: 12,
  });

  return (
    <div
      className="af-fade-in"
      onClick={(event) => event.stopPropagation()}
      style={{
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        width: 480,
        zIndex: 30,
        background: "var(--elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: 8,
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
        display: "flex",
        overflow: "hidden",
      }}
    >
      <div
        className="af-scroll"
        style={{
          width: 176,
          flexShrink: 0,
          borderRight: "1px solid var(--border-subtle)",
          padding: 4,
          maxHeight: 320,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            padding: "6px 10px 4px",
            fontSize: 10,
            fontWeight: 600,
            color: "var(--text-muted)",
            letterSpacing: "0.02em",
          }}
        >
          {t(locale, "Model.Providers")}
        </div>
        {modelGroups.map((group) => (
          <div
            key={group.id}
            className="af-menu-item"
            onClick={() => setActiveGroupId(group.id)}
            style={rowStyle(activeGroup?.id === group.id)}
          >
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {group.label}
            </span>
            <span className="af-mono" style={{ fontSize: 9.5, color: "var(--text-muted)" }}>
              {group.models.length}
            </span>
            <ChevronRight size={12} color="var(--text-muted)" />
          </div>
        ))}
        {!modelGroups.length && (
          <div style={{ padding: 10, color: "var(--text-muted)", fontSize: 11 }}>
            {t(locale, "SettingsText.NoModelsDiscovered")}
          </div>
        )}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 9px",
            margin: "4px 6px",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            background: "var(--surface)",
          }}
        >
          <Search size={12} color="var(--text-muted)" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t(locale, "Model.Filter")}
            aria-label={t(locale, "Model.Filter")}
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 11,
            }}
          />
        </div>
        <div className="af-scroll" style={{ flex: 1, overflowY: "auto", padding: "0 4px 4px" }}>
          {hasAuto && !normalized && (
            <div
              className="af-menu-item"
              onClick={() => selectModel("auto")}
              style={rowStyle(model === "auto")}
            >
              <Sparkles size={12} color="var(--accent)" />
              <span style={{ flex: 1 }}>{t(locale, "Model.AutoBalanced")}</span>
              {model === "auto" && <Check size={12} color="var(--accent)" />}
            </div>
          )}
          {visibleModels.map((entry) => (
            <div
              key={entry.id}
              className="af-menu-item"
              onClick={() => selectModel(entry.id)}
              style={rowStyle(entry.id === model)}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {entry.label}
              </span>
              {entry.groupLabel && (
                <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{entry.groupLabel}</span>
              )}
              <Badge tone={entry.vision ? "success" : "muted"}>
                {entry.vision ? t(locale, "Model.Vision") : t(locale, "Model.Text")}
              </Badge>
              {entry.id === model && <Check size={12} color="var(--accent)" />}
            </div>
          ))}
          {!visibleModels.length && (
            <div style={{ padding: 10, color: "var(--text-muted)", fontSize: 11 }}>
              {t(locale, "SettingsText.NoModelsDiscovered")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
