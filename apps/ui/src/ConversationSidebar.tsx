import React from "react";
import { FolderGit2, ChevronDown, Search, Plus, Pin, Settings } from "lucide-react";
import { t } from "@agentflow/localization";
import type { ConversationSidebarProps } from "./types";
import { btnGhost, btnPrimary } from "./constants";
import { Dot, Menu, MenuItem } from "./ui-primitives";

export const ConversationSidebar = React.memo(function ConversationSidebar({
  sidebarOpen,
  locale,
  labels,
  openMenu,
  toggleMenu,
  setOpenMenu,
  project,
  projectList,
  activeProject,
  setActiveProject,
  openProject,
  canOpenProject,
  openProjectUnavailableReason,
  conversationSearchRef,
  conversationQuery,
  setConversationQuery,
  newConversation,
  conversationFilters,
  conversationFilter,
  setConversationFilter,
  visibleConversations,
  runtimeConversationId,
  selectConversation,
  togglePinnedConversation,
  setSettingsOpen,
}: ConversationSidebarProps) {
  return (
    <div
      style={{
        width: sidebarOpen ? 260 : 0,
        flexShrink: 0,
        background: "var(--sidebar)",
        borderRight: sidebarOpen ? "1px solid var(--border-subtle)" : "none",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        transition: "width 180ms ease, border-color 180ms ease",
      }}
    >
      <div
        style={{ minWidth: 260, display: "flex", flexDirection: "column", flex: 1 }}
      >
      <div
        style={{ position: "relative", borderBottom: "1px solid var(--border-subtle)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          onClick={() => toggleMenu("project")}
          style={{
            padding: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              fontWeight: 600,
              minWidth: 0,
            }}
          >
            <FolderGit2 size={14} color="var(--accent)" />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {project?.name || t(locale, "Status.NoProject")}
            </span>
          </div>
          <ChevronDown size={14} color="var(--text-muted)" />
        </div>
        <Menu open={openMenu === "project"} width={244}>
          <div style={{ fontSize: 10.5, color: "var(--text-muted)", padding: "6px 10px 2px" }}>
            {t(locale, "Navigation.Projects").toUpperCase()}
          </div>
          {projectList.map((p) => (
            <MenuItem
              key={p.id}
              active={p.id === activeProject}
              onClick={() => {
                setActiveProject(p.id);
                setOpenMenu(null);
              }}
              title={p.name}
              sub={`${p.branch} · ${t(locale, "Navigation.ConversationCount", { count: p.convCount })}`}
            />
          ))}
          <div style={{ borderTop: "1px solid var(--border-subtle)", margin: "4px 2px" }} />
          <span title={!canOpenProject ? openProjectUnavailableReason : undefined}>
            <button
              type="button"
              onClick={() => void openProject()}
              disabled={!canOpenProject}
              className="af-menu-item"
              style={{
                ...btnGhost,
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 6,
                color: "var(--accent)",
                fontSize: 12.5,
                opacity: canOpenProject ? 1 : 0.5,
                cursor: canOpenProject ? "pointer" : "not-allowed",
              }}
            >
              <Plus size={13} /> {labels.openProject}
            </button>
          </span>
        </Menu>
      </div>

      <div style={{ padding: 12, display: "flex", gap: 8 }}>
        <div
          style={{
            flex: 1,
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
            ref={conversationSearchRef}
            value={conversationQuery}
            onChange={(event) => setConversationQuery(event.target.value)}
            placeholder={labels.searchConversations}
            aria-label={labels.searchConversations}
            style={{
              width: "100%",
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text-primary)",
              fontSize: 12.5,
            }}
          />
        </div>
        <button
          onClick={() => void newConversation()}
          aria-label={labels.newConversation}
          style={{
            ...btnPrimary,
            padding: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, padding: "0 8px 6px" }}>
        {conversationFilters.map(([filter, label, Icon]) => (
          <button
            key={filter}
            onClick={() => setConversationFilter(filter)}
            aria-pressed={conversationFilter === filter}
            style={{
              ...btnGhost,
              flex: 1,
              padding: "4px 5px",
              fontSize: 10.5,
              color: conversationFilter === filter ? "var(--text-primary)" : "var(--text-muted)",
              background: conversationFilter === filter ? "var(--selected)" : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
            }}
          >
            {Icon && <Icon size={11} />}
            {label}
          </button>
        ))}
      </div>
      <div className="af-scroll" style={{ flex: 1, overflowY: "auto", padding: "4px 8px" }}>
        {visibleConversations.map((c) => (
          <div
            key={c.id}
            onClick={() => selectConversation(c.id)}
            data-testid="conversation-row"
            style={{
              padding: "10px 10px",
              borderRadius: 8,
              marginBottom: 2,
              cursor: "pointer",
              background: c.id === runtimeConversationId ? "var(--selected)" : "transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <div
                style={{
                  minWidth: 0,
                  flex: 1,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--text-primary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {c.title}
              </div>
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  togglePinnedConversation(c.id);
                }}
                aria-label={`${c.pinned ? labels.unpin : labels.pin} ${c.title}`}
                aria-pressed={c.pinned}
                style={{
                  ...btnGhost,
                  padding: 2,
                  color: c.pinned ? "var(--accent)" : "var(--text-muted)",
                  border: "none",
                }}
              >
                <Pin size={11} />
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Dot tone={c.statusTone} />
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{c.status}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
                {c.time}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div
        onClick={(e) => {
          e.stopPropagation();
          setSettingsOpen(true);
        }}
        style={{
          padding: 12,
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--text-secondary)",
          fontSize: 12.5,
          cursor: "pointer",
        }}
      >
        <Settings size={14} /> {labels.settings}
      </div>
      </div>
    </div>
  );
});
