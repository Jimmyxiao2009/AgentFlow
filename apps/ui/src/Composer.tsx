import React, { useEffect, useState } from "react";
import {
  ChevronDown,
  Sparkles,
  Cpu,
  Shield,
  X,
  Paperclip,
  Send,
  Command,
  CircleAlert,
} from "lucide-react";
import { t } from "@agentflow/localization";
import type { ComposerProps } from "./types";
import {
  btnGhost,
  btnPrimary,
  btnDanger,
  modeOptions,
  permissionOptions,
  parseSlashCommand,
} from "./constants";
import { permissionProfileLabel } from "./utils";
import { Menu, MenuItem } from "./ui-primitives";
import { ModelPicker } from "./ModelPicker";

export const Composer = React.memo(function Composer({
  locale,
  openMenu,
  setOpenMenu,
  mode,
  setMode,
  permission,
  setPermission,
  currentModel,
  model,
  modelGroups,
  hasAuto,
  selectModel,
  contextAttachments,
  setContextAttachments,
  attachContextFiles,
  composerRef,
  composerText,
  setComposerText,
  sendMessage,
  sending,
  stopActiveRun,
  bridge,
  runtimeConversationId,
  runtimeState,
  failedRunId,
  retryFailedRun,
  runtimeData,
}: ComposerProps) {
  const toggleMenu = (name: string) => setOpenMenu(openMenu === name ? null : name);
  const [controlsExpanded, setControlsExpanded] = useState(false);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [composerText, composerRef]);
  const runtimeBlockedReason = !bridge
    ? t(locale, "Runtime.Unavailable")
    : !runtimeConversationId
      ? t(locale, "Runtime.OpenConversationBeforeSend")
      : undefined;
  const sendBlockedReason = runtimeBlockedReason || (!composerText.trim()
    ? t(locale, "Composer.EnterMessageToSend")
    : undefined);
  const sendDisabled = !sending && (!composerText.trim() || Boolean(runtimeBlockedReason));
  const attachDisabled = Boolean(runtimeBlockedReason);
  const slashCommandMatch = parseSlashCommand(composerText);
  const commandPreview = slashCommandMatch.command;
  const commandPreviewDescription = commandPreview
    ? commandPreview.kind === "mode"
      ? t(locale, "Composer.CommandModePreview", { mode: t(locale, `Mode.${commandPreview.mode}`) })
      : commandPreview.kind === "status"
        ? t(locale, "Composer.CommandStatusPreview")
        : t(locale, "Composer.CommandIntegratePreview")
    : t(locale, "Composer.UnknownCommandPreview");
  return (
    <div
      style={{ padding: 14, borderTop: "1px solid var(--border-subtle)" }}
      onClick={(e) => e.stopPropagation()}
    >
      {!controlsExpanded && (
        <button
          onClick={() => setControlsExpanded(true)}
          className="af-fade-in"
          style={{
            ...btnGhost,
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 8,
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {t(locale, `Mode.${mode}`)} · {currentModel.label}
          <ChevronDown size={11} />
        </button>
      )}
      {controlsExpanded && (
      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <button
            onClick={() => toggleMenu("mode")}
            style={{
              ...btnGhost,
              display: "flex",
              alignItems: "center",
              gap: 6,
              borderColor: "var(--accent)",
              color: "var(--accent)",
            }}
          >
            {t(locale, `Mode.${mode}`)} <ChevronDown size={12} />
          </button>
          <Menu open={openMenu === "mode"} width={260} direction="up">
            {modeOptions.map((m) => (
              <MenuItem
                key={m.id}
                active={m.id === mode}
                title={t(locale, `Mode.${m.id}`)}
                sub={t(locale, `Mode.${m.id}Description`)}
                onClick={() => {
                  setMode(m.id);
                  setOpenMenu(null);
                }}
              />
            ))}
          </Menu>
        </div>

        {mode === "Build" && (
          <label
            style={{
              ...btnGhost,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 8px",
              color: "var(--text-secondary)",
            }}
            title={t(locale, "Composer.PermissionProfileDescription")}
          >
            <Shield size={12} aria-hidden="true" />
            <span style={{ fontSize: 11 }}>{t(locale, "Composer.PermissionProfile")}</span>
            <select
              aria-label={t(locale, "Composer.PermissionProfile")}
              value={permission}
              onChange={(event) => setPermission(event.target.value)}
              style={{
                minWidth: 132,
                appearance: "auto",
                background: "transparent",
                border: "none",
                color: "inherit",
                fontSize: 12,
                padding: "6px 0",
              }}
            >
              {permissionOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {permissionProfileLabel(locale, option.label)}
                </option>
              ))}
            </select>
          </label>
        )}

        <div style={{ position: "relative" }}>
          <button
            onClick={() => toggleMenu("model")}
            style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 6 }}
          >
            {currentModel.id === "auto" ? <Sparkles size={12} /> : <Cpu size={12} />}{" "}
            {currentModel.label} <ChevronDown size={12} />
          </button>
          <ModelPicker
            open={openMenu === "model"}
            locale={locale}
            model={model}
            modelGroups={modelGroups}
            hasAuto={hasAuto}
            selectModel={selectModel}
          />
        </div>

        <button
          onClick={() => setControlsExpanded(false)}
          aria-label={t(locale, "Navigation.Close")}
          title={t(locale, "Navigation.Close")}
          style={{ ...btnGhost, border: "none", padding: 2, color: "var(--text-muted)" }}
        >
          <X size={12} />
        </button>
      </div>
      )}

      <div
        style={{
          background: "var(--elevated)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 10,
          padding: 10,
          display: "flex",
          alignItems: "stretch",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {slashCommandMatch.isSlashCommand && (
          <div
            role="status"
            aria-live="polite"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "7px 8px",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6,
              background: "var(--surface)",
              color: commandPreview ? "var(--text-secondary)" : "var(--danger)",
              fontSize: 11.5,
              lineHeight: 1.35,
            }}
          >
            {commandPreview ? <Command size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                <span>{t(locale, "Composer.CommandPreview")}</span>
                <code className="af-mono" style={{ color: "var(--text-primary)", fontSize: 11 }}>
                  {commandPreview?.command ?? slashCommandMatch.token}
                </code>
              </div>
              <div style={{ marginTop: 2 }}>{commandPreviewDescription}</div>
            </div>
          </div>
        )}
        {contextAttachments.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 8,
            }}
            aria-label={t(locale, "Composer.Attachments")}
          >
            {contextAttachments.map((file) => (
              <span
                key={file}
                className="af-mono"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  maxWidth: 320,
                  padding: "4px 7px",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  color: "var(--text-secondary)",
                  fontSize: 10.5,
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{file}</span>
                <button
                  type="button"
                  onClick={() =>
                    setContextAttachments((current) => current.filter((item) => item !== file))
                  }
                  aria-label={`${t(locale, "Action.RemoveAttachment")}: ${file}`}
                  title={t(locale, "Action.RemoveAttachment")}
                  style={{
                    ...btnGhost,
                    border: "none",
                    padding: 0,
                    display: "inline-flex",
                    color: "var(--text-muted)",
                  }}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
          <span title={attachDisabled ? sendBlockedReason : undefined}>
            <button
              type="button"
              onClick={() => void attachContextFiles()}
              disabled={attachDisabled}
              aria-label={t(locale, "Action.AttachContext")}
              title={attachDisabled ? undefined : t(locale, "Action.AttachContext")}
              style={{
                ...btnGhost,
                border: "none",
                padding: 0,
                display: "inline-flex",
                color: "var(--text-muted)",
                opacity: attachDisabled ? 0.5 : 1,
                cursor: attachDisabled ? "not-allowed" : undefined,
              }}
            >
              <Paperclip size={16} />
            </button>
          </span>
          <textarea
            ref={composerRef}
            value={composerText}
            onChange={(event) => {
              const value = event.target.value;
              setComposerText(value);
              // @-mention: when user types @path, add it as a context attachment
              const mentionMatch = value.match(/@([\w./-]+\.[\w]+)\s?$/);
              if (mentionMatch && mentionMatch[1]) {
                const filePath = mentionMatch[1];
                if (!contextAttachments.includes(filePath)) {
                  setContextAttachments((current) => [...current, filePath]);
                }
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendMessage();
              }
            }}
            placeholder={t(locale, "Composer.Placeholder")}
            title={sendBlockedReason}
            aria-describedby={sendBlockedReason ? "composer-unavailable-reason" : undefined}
            rows={1}
            style={{
              flex: 1,
              resize: "none",
              overflowY: "auto",
              maxHeight: 240,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 13.5,
              color: "var(--text-primary)",
              padding: "4px 0",
              lineHeight: 1.4,
              transition: "height 120ms ease",
            }}
          />
          <span title={!sending ? sendBlockedReason : undefined}>
            <button
              onClick={sending ? stopActiveRun : sendMessage}
              disabled={sendDisabled}
              aria-label={sending ? t(locale, "Action.StopRun") : t(locale, "Action.SendMessage")}
              style={{
                ...(sending ? btnDanger : btnPrimary),
                width: 30,
                height: 30,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                opacity: sendDisabled ? 0.5 : 1,
                cursor: sendDisabled ? "not-allowed" : undefined,
              }}
            >
              {sending ? <X size={14} /> : <Send size={14} />}
            </button>
          </span>
        </div>
      </div>
      <div
        id="composer-unavailable-reason"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 8,
          color: "var(--text-muted)",
          fontSize: 10.5,
          marginTop: 6,
        }}
      >
        {sendBlockedReason || runtimeState} · {t(locale, "Composer.KeyboardShortcuts")} {" "}
        {failedRunId && bridge && (
          <>
            <button
              onClick={() => retryFailedRun(false)}
              style={{ ...btnGhost, padding: "2px 7px", fontSize: 10 }}
            >
              {t(locale, "Action.Retry")}
            </button>
            {runtimeData?.resumeAvailableRunIds?.includes(failedRunId) && (
              <button
                onClick={() => retryFailedRun(true)}
                style={{ ...btnGhost, padding: "2px 7px", fontSize: 10 }}
              >
                {t(locale, "Action.Resume")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});
