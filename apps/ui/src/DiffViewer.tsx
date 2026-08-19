import { t } from "@agentflow/localization";
import type { DiffViewerProps } from "./types";
import { btnGhost } from "./constants";
import { renderDiffLine, parseSideBySideDiff, diffLanguage } from "./utils";

export function DiffViewer({
  content,
  search,
  onSearch,
  viewMode,
  onViewMode,
  findings,
  locale,
}: DiffViewerProps) {
  const diffText = content || "";
  const lines = diffText ? diffText.split("\n") : [t(locale, "Inspector.NoUnifiedDiff")];
  const needle = search.toLowerCase();
  const findingLines = new Set(
    findings.filter((finding) => Number.isInteger(finding.line)).map((finding) => finding.line),
  );
  const filteredLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !needle || line.toLowerCase().includes(needle));
  const sideBySideRows = parseSideBySideDiff(diffText).filter(
    ({ left, right }) => !needle || `${left}\n${right}`.toLowerCase().includes(needle),
  );
  const isBinary = /^Binary files /m.test(diffText);
  const toggleStyle = (active) => ({
    ...btnGhost,
    padding: "3px 7px",
    fontSize: 10,
    background: active ? "var(--accent-soft)" : "transparent",
    color: active ? "var(--accent)" : "var(--text-secondary)",
  });
  const renderCell = (line, index) => {
    const hasFinding = findingLines.has(index + 1);
    return (
      <div
        style={{
          display: "flex",
          minHeight: 18,
          whiteSpace: "pre-wrap",
          background: hasFinding
            ? "color-mix(in srgb, var(--warning) 12%, transparent)"
            : undefined,
        }}
        title={hasFinding ? t(locale, "Inspector.Finding") : undefined}
      >
        <span
          style={{
            width: 34,
            flex: "0 0 34px",
            color: hasFinding ? "var(--warning)" : "var(--text-muted)",
            userSelect: "none",
          }}
        >
          {hasFinding ? "!" : String(index + 1).padStart(4, " ")}
        </span>
        <span style={{ flex: 1 }}>{renderDiffLine(line)}</span>
      </div>
    );
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={t(locale, "Navigation.SearchDiff")}
          aria-label={t(locale, "Navigation.SearchDiff")}
          style={{
            flex: 1,
            minWidth: 0,
            boxSizing: "border-box",
            background: "var(--window)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 5,
            color: "var(--text-primary)",
            padding: "4px 6px",
            fontSize: 10.5,
          }}
        />
        <button
          type="button"
          onClick={() => onViewMode("unified")}
          aria-pressed={viewMode === "unified"}
          style={toggleStyle(viewMode === "unified")}
        >
          {t(locale, "Inspector.Unified")}
        </button>
        <button
          type="button"
          onClick={() => onViewMode("side-by-side")}
          aria-pressed={viewMode === "side-by-side"}
          style={toggleStyle(viewMode === "side-by-side")}
        >
          {t(locale, "Inspector.SideBySide")}
        </button>
      </div>
      {isBinary ? (
        <div className="af-mono" style={{ color: "var(--warning)", fontSize: 10.5 }}>
          {t(locale, "Inspector.Binary")}
        </div>
      ) : (
        <div
          className="af-mono"
          data-language={diffLanguage(
            lines
              .find((line) => line.startsWith("+++ "))
              ?.slice(4)
              .split("\t")[0] || "",
          )}
          style={{
            maxHeight: 260,
            overflow: "auto",
            color: "var(--text-secondary)",
            fontSize: 10.5,
            lineHeight: 1.5,
          }}
        >
          {viewMode === "unified"
            ? filteredLines.map(({ line, index }) => (
                <div key={`${index}-${line}`}>{renderCell(line, index)}</div>
              ))
            : sideBySideRows.map((row) => (
                <div
                  key={`${row.index}-${row.left}-${row.right}`}
                  style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
                >
                  {renderCell(row.left, row.index)}
                  {renderCell(row.right, row.index)}
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
