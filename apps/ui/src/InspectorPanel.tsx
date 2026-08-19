import React, { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  GitCommit,
  GitMerge,
  FileDiff,
  AlertTriangle,
  Circle,
  ListTree,
  ClipboardCheck,
} from "lucide-react";
import { t } from "@agentflow/localization";
import type { InspectorPanelProps } from "./types";
import { btnGhost, btnPrimary } from "./constants";
import { Dot, Badge } from "./ui-primitives";
import { permissionProfileLabel, diffFileState, localizedStatus } from "./utils";
import { DiffViewer } from "./DiffViewer";

export const InspectorPanel = React.memo(function InspectorPanel({
  inspectorOpen,
  tabs,
  tab,
  setTab,
  locale,
  bridge,
  runtimeChangeRequestId,
  integrateApproved,
  preparePullRequest,
  workflowPhase,
  workflowProgress,
  completedTaskCount,
  displayTasks,
  displayReviews,
  currentModel,
  effectivePermission,
  currentChangeRequest,
  currentRoutingDecision,
  repositoryStatus,
  runtimeData,
  runReadyTasks,
  runTask,
  displayRuns,
  displayPatchSets,
  artifactContent,
  openArtifact,
  openArtifactId,
  runValidation,
  startReview,
  artifactLoading,
  artifactSearch,
  setArtifactSearch,
  artifactViewMode,
  setArtifactViewMode,
  displayFindings,
  sendFindingsToFixer,
  blockingFindingsCount,
  patchSetsAwaitingReview,
  approvePatchSet,
  rejectPatchSet,
  width,
  onResizeWidth,
  currentProject,
  updateDebugCommand,
  debugRunning,
  startDebug,
  stopDebug,
}: InspectorPanelProps) {
  const [localWidth, setLocalWidth] = useState(width);
  useEffect(() => {
    setLocalWidth(width);
  }, [width]);
  const dragRef = useRef(null);
  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - event.clientX;
      const next = Math.min(560, Math.max(260, dragRef.current.startWidth + delta));
      dragRef.current.current = next;
      setLocalWidth(next);
    };
    const handleUp = () => {
      if (!dragRef.current) return;
      onResizeWidth(dragRef.current.current);
      dragRef.current = null;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [onResizeWidth]);
  const startResize = (event) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: localWidth, current: localWidth };
  };
  const [debugCommandDraft, setDebugCommandDraft] = useState(currentProject?.debugCommand || "");
  useEffect(() => {
    setDebugCommandDraft(currentProject?.debugCommand || "");
  }, [currentProject?.debugCommand, currentProject?.id]);
  if (!inspectorOpen) return null;
  return (
    <div
      className="af-fade-in"
      style={{
        position: "relative",
        width: localWidth,
        flexShrink: 0,
        background: "var(--inspector)",
        borderLeft: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        onMouseDown={startResize}
        style={{
          position: "absolute",
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: "ew-resize",
          zIndex: 5,
        }}
      />
      <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)" }}>
        {tabs.map((tabId) => (
          <div
            key={tabId}
            onClick={() => setTab(tabId)}
            role="tab"
            tabIndex={tab === tabId ? 0 : -1}
            aria-selected={tab === tabId}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setTab(tabId);
              }
            }}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "10px 4px",
              fontSize: 11.5,
              cursor: "pointer",
              color: tab === tabId ? "var(--text-primary)" : "var(--text-muted)",
              borderBottom: tab === tabId ? "2px solid var(--accent)" : "2px solid transparent",
              fontWeight: tab === tabId ? 600 : 400,
            }}
          >
            {t(locale, `Tab.${tabId}`)}
          </div>
        ))}
      </div>

      <div key={tab} className="af-scroll af-fade-in" style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {tab === "Overview" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                {t(locale, "Inspector.WorkflowPhase").toUpperCase()}
              </div>
              <Badge
                tone={
                  workflowPhase === "Completed"
                    ? "success"
                    : workflowPhase === "Failed"
                      ? "danger"
                      : "accent"
                }
              >
                {workflowPhase}
              </Badge>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                {t(locale, "Inspector.Progress").toUpperCase()}
              </div>
              <div
                style={{
                  height: 6,
                  borderRadius: 999,
                  background: "var(--elevated)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${workflowProgress}%`,
                    height: "100%",
                    background: "var(--accent)",
                  }}
                />
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
                {t(locale, "Inspector.TasksComplete", {
                  completed: completedTaskCount,
                  total: displayTasks.length || 0,
                })}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                {t(locale, "Inspector.BlockingIssues").toUpperCase()}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12.5,
                  color: blockingFindingsCount ? "var(--danger)" : "var(--text-muted)",
                  cursor: blockingFindingsCount ? "pointer" : "default",
                }}
                onClick={blockingFindingsCount ? () => setTab("Review") : undefined}
              >
                <AlertTriangle size={13} />{" "}
                {blockingFindingsCount
                  ? t(locale, "Inspector.Finding") + ` · ${blockingFindingsCount}`
                  : t(locale, "Inspector.NoBlockingReviewFindings")}
              </div>
            </div>
            {patchSetsAwaitingReview.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  {t(locale, "Tab.Review").toUpperCase()}
                </div>
                <div
                  onClick={() => setTab("Review")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12.5,
                    color: "var(--accent)",
                    cursor: "pointer",
                  }}
                >
                  <ClipboardCheck size={13} />{" "}
                  {t(locale, "Inspector.PatchSetsAwaitingReview", {
                    count: patchSetsAwaitingReview.length,
                  })}
                </div>
              </div>
            )}
            <div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                {t(locale, "Inspector.EffectiveConfig").toUpperCase()}
              </div>
              <div
                className="af-mono"
                style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.8 }}
              >
                {t(locale, "Inspector.Model")}: {currentModel.label}
                <br />
                {t(locale, "Inspector.Permission")}:{" "}
                {permissionProfileLabel(locale, effectivePermission.label)}
                <br />
                {t(locale, "Inspector.Base")}:{" "}
                {currentChangeRequest?.baseCommit || t(locale, "Inspector.RepositoryHead")}
              </div>
            </div>
            {currentRoutingDecision && (
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  {t(locale, "Navigation.RoutingExplanation").toUpperCase()}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-secondary)",
                    lineHeight: 1.6,
                    background: "var(--elevated)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 7,
                    padding: "8px 10px",
                  }}
                >
                  <div>
                    {t(locale, "Navigation.Rule")}: {currentRoutingDecision.matchedRule || "unavailable"}
                  </div>
                  <div>
                    {t(locale, "Navigation.Reason")}: {currentRoutingDecision.reason || "unavailable"}
                  </div>
                  {currentRoutingDecision.selected && (
                    <div>
                      {t(locale, "Navigation.Selected")}: {currentRoutingDecision.selected.adapterId}
                      {currentRoutingDecision.selected.profileId
                        ? ` · ${currentRoutingDecision.selected.profileId}`
                        : ""}
                    </div>
                  )}
                  {currentRoutingDecision.rejectedCandidates?.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary>{t(locale, "Navigation.RejectedCandidates")}</summary>
                      <div className="af-mono" style={{ marginTop: 4, fontSize: 10.5 }}>
                        {currentRoutingDecision.rejectedCandidates.join("\n")}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            )}
            {repositoryStatus && (
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  {t(locale, "Settings.Git").toUpperCase()}
                </div>
                <div
                  className="af-mono"
                  style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.7 }}
                >
                  {repositoryStatus.branch} · {repositoryStatus.head.slice(0, 12)}
                  <br />
                  {t(locale, "Inspector.ChangedFiles")}: {repositoryStatus.changedFiles.length}
                </div>
                {repositoryStatus.unifiedDiff && (
                  <details style={{ marginTop: 8 }}>
                    <summary>{t(locale, "Action.OpenDiff")}</summary>
                    <pre
                      className="af-mono af-scroll"
                      style={{
                        maxHeight: 220,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        fontSize: 10,
                        color: "var(--text-secondary)",
                      }}
                    >
                      {repositoryStatus.unifiedDiff}
                    </pre>
                  </details>
                )}
              </div>
            )}
            {currentProject && (
              <div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
                  {t(locale, "Inspector.DebugCommand").toUpperCase()}
                </div>
                <input
                  value={debugCommandDraft}
                  onChange={(event) => setDebugCommandDraft(event.target.value)}
                  onBlur={() => {
                    if (debugCommandDraft !== (currentProject.debugCommand || ""))
                      updateDebugCommand(debugCommandDraft);
                  }}
                  placeholder={t(locale, "Inspector.DebugCommandPlaceholder")}
                  disabled={!bridge}
                  className="af-mono"
                  style={{
                    width: "100%",
                    background: "var(--elevated)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 7,
                    padding: "6px 8px",
                    fontSize: 11.5,
                    color: "var(--text-primary)",
                  }}
                />
              </div>
            )}
          </div>
        )}

        {tab === "Tasks" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {runtimeData && displayTasks.some((task) => task.status === "Ready") && (
              <button
                onClick={runReadyTasks}
                style={{
                  ...btnPrimary,
                  alignSelf: "flex-start",
                  padding: "5px 9px",
                  fontSize: 10,
                }}
              >
                {t(locale, "Inspector.RunReadyTasks")}
              </button>
            )}
            {displayTasks.map((task) => (
              <div
                key={task.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 6px",
                  borderRadius: 6,
                }}
              >
                <Dot tone={task.tone} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="af-mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {task.id}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {task.title}
                  </div>
                  <div
                    className="af-mono"
                    style={{
                      fontSize: 10,
                      color: "var(--text-muted)",
                      marginTop: 4,
                      lineHeight: 1.5,
                    }}
                  >
                    {task.dependencies?.length
                      ? t(locale, "Inspector.DependsOn", { tasks: task.dependencies.join(", ") })
                      : t(locale, "Inspector.NoDependencies")}
                    {task.assignedAgent ? ` · ${task.assignedAgent}` : ""}
                    {task.validation
                      ? ` · ${t(locale, "Inspector.ValidationStatus", { status: localizedStatus(locale, task.validation) })}`
                      : ""}
                  </div>
                  {(task.worktree || task.review) && (
                    <div
                      className="af-mono"
                      style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}
                    >
                      {task.worktree || ""}
                      {task.review
                        ? `${task.worktree ? " · " : ""}${t(locale, "Inspector.ReviewStatus", { verdict: localizedStatus(locale, task.review) })}`
                        : ""}
                    </div>
                  )}
                </div>
                {bridge && task.taskId && task.status === "Ready" ? (
                  <button
                    onClick={() => runTask(task.taskId)}
                    style={{ ...btnGhost, padding: "3px 7px", fontSize: 10 }}
                  >
                    {t(locale, "Inspector.Run")}
                  </button>
                ) : (
                  <ChevronRight size={13} color="var(--text-muted)" />
                )}
              </div>
            ))}
          </div>
        )}

        {tab === "Agents" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {displayRuns.map((a, i) => (
              <div
                key={i}
                style={{
                  background: "var(--elevated)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <Dot tone={a.tone} />
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{a.name}</span>
                  {a.time && (
                    <span
                      className="af-mono"
                      style={{ fontSize: 10.5, color: "var(--text-muted)", marginLeft: "auto" }}
                    >
                      {a.time}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  {a.role} · {a.detail}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "Changes" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {displayPatchSets.length ? (
              displayPatchSets.map((patchSet) => (
                <div
                  key={patchSet.id}
                  style={{
                    background: "var(--elevated)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: 8,
                    padding: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                    <GitCommit size={13} color="var(--text-muted)" />{" "}
                    {t(locale, "Inspector.PatchSetSummary", {
                      sequence: patchSet.sequence,
                      count: patchSet.changedFiles.length,
                    })}
                  </div>
                  <div
                    className="af-mono"
                    style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 6 }}
                  >
                    {patchSet.resultCommit.slice(0, 12)} · {patchSet.reviewState}
                  </div>
                  <details style={{ marginTop: 7 }}>
                    <summary
                      style={{
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      {t(locale, "Inspector.ChangedFiles")}
                    </summary>
                    <div
                      className="af-mono"
                      style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 5 }}
                    >
                      {patchSet.changedFiles.map((file) => {
                        const state = diffFileState(artifactContent?.content || "", file);
                        const stateKey =
                          state === "added"
                            ? "Inspector.Added"
                            : state === "deleted"
                              ? "Inspector.Deleted"
                              : state === "renamed"
                                ? "Inspector.Renamed"
                                : state === "binary"
                                  ? "Inspector.Binary"
                                  : "Inspector.Modified";
                        return (
                          <div
                            key={file}
                            style={{
                              padding: "2px 0",
                              display: "flex",
                              alignItems: "center",
                              gap: 4,
                            }}
                          >
                            <FileDiff size={11} />
                            <span style={{ flex: 1 }}>{file}</span>
                            <span
                              style={{
                                color:
                                  state === "deleted"
                                    ? "var(--danger)"
                                    : state === "added"
                                      ? "var(--success)"
                                      : "var(--text-muted)",
                                fontSize: 9.5,
                              }}
                            >
                              {t(locale, stateKey)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    {bridge && patchSet.diffArtifactId && (
                      <button
                        onClick={() => openArtifact(patchSet.diffArtifactId)}
                        style={{ ...btnGhost, padding: "4px 8px", fontSize: 10 }}
                      >
                        {openArtifactId === patchSet.diffArtifactId
                          ? t(locale, "Inspector.CloseDiff")
                          : t(locale, "Action.OpenDiff")}
                      </button>
                    )}
                    {bridge && (
                      <button
                        onClick={() => runValidation(patchSet.id)}
                        style={{ ...btnGhost, padding: "4px 8px", fontSize: 10 }}
                      >
                        {t(locale, "Inspector.Validate")}
                      </button>
                    )}
                    {bridge && (
                      <button
                        onClick={() => startReview(patchSet.id)}
                        style={{ ...btnGhost, padding: "4px 8px", fontSize: 10 }}
                      >
                        {t(locale, "Inspector.Review")}
                      </button>
                    )}
                  </div>
                  {openArtifactId === patchSet.diffArtifactId && (
                    <div
                      style={{
                        marginTop: 8,
                        borderTop: "1px solid var(--border-subtle)",
                        paddingTop: 8,
                      }}
                    >
                      {artifactLoading ? (
                        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                          {t(locale, "Inspector.LoadingDiff")}
                        </div>
                      ) : (
                        <DiffViewer
                          content={artifactContent?.content || ""}
                          search={artifactSearch}
                          onSearch={setArtifactSearch}
                          viewMode={artifactViewMode}
                          onViewMode={setArtifactViewMode}
                          findings={displayFindings}
                          locale={locale}
                        />
                      )}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <GitCommit size={13} color="var(--text-muted)" /> {t(locale, "Inspector.NoPatchSets")}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "Review" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {currentProject?.debugCommand && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "var(--elevated)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 12,
                }}
              >
                {debugRunning ? (
                  <>
                    <Circle size={10} color="var(--success)" />
                    <span style={{ flex: 1, color: "var(--text-secondary)" }}>
                      {t(locale, "Inspector.DebugRunning", { command: currentProject.debugCommand })}
                    </span>
                    <button
                      onClick={stopDebug}
                      disabled={!bridge}
                      style={{ ...btnGhost, padding: "4px 8px", fontSize: 10 }}
                    >
                      {t(locale, "Action.StopRun")}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={startDebug}
                    disabled={!bridge}
                    style={{
                      ...btnPrimary,
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      padding: "6px 8px",
                      fontSize: 11.5,
                    }}
                  >
                    <Circle size={10} /> {t(locale, "Inspector.LaunchDebug")}
                  </button>
                )}
              </div>
            )}
            {patchSetsAwaitingReview.map((patchSet) => (
              <div
                key={patchSet.id}
                style={{
                  background: "var(--elevated)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                  <GitCommit size={13} color="var(--text-muted)" /> PatchSet {patchSet.sequence} ·{" "}
                  {patchSet.changedFiles.length} files
                </div>
                <div
                  className="af-mono"
                  style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 6 }}
                >
                  {patchSet.reviewState}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button
                    onClick={() => approvePatchSet(patchSet.id)}
                    disabled={!bridge}
                    style={{ ...btnPrimary, flex: 1, padding: "4px 8px", fontSize: 10 }}
                  >
                    {t(locale, "Action.ApproveAndRun")}
                  </button>
                  <button
                    onClick={() => rejectPatchSet(patchSet.id)}
                    disabled={!bridge}
                    style={{ ...btnGhost, flex: 1, padding: "4px 8px", fontSize: 10 }}
                  >
                    {t(locale, "Action.RequestChanges")}
                  </button>
                </div>
              </div>
            ))}
            {displayFindings.map((finding) => (
              <div
                key={finding.id}
                style={{
                  background: "var(--elevated)",
                  border: `1px solid ${finding.severity === "Blocking" ? "var(--danger)" : "var(--warning)"}`,
                  borderRadius: 8,
                  padding: 10,
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    color: finding.severity === "Blocking" ? "var(--danger)" : "var(--warning)",
                    fontWeight: 600,
                  }}
                >
                  {finding.severity} · {finding.category}
                </div>
                <div style={{ color: "var(--text-primary)", marginTop: 5 }}>{finding.message}</div>
                {finding.file && (
                  <div className="af-mono" style={{ color: "var(--text-muted)", marginTop: 5 }}>
                    {finding.file}
                    {finding.line ? `:${finding.line}` : ""}
                  </div>
                )}
              </div>
            ))}
            {displayReviews.length ? (
              displayReviews.map((review) => (
                <div
                  key={review.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    color: review.verdict === "Approved" ? "var(--success)" : "var(--warning)",
                  }}
                >
                  <ClipboardCheck size={13} /> {review.verdict} ·{" "}
                  {review.independent ? t(locale, "Inspector.Independent") : t(locale, "Inspector.SameRun")}
                </div>
              ))
            ) : displayFindings.length ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    color: "var(--warning)",
                  }}
                >
                  <AlertTriangle size={13} /> {displayFindings[0]?.severity} ·{" "}
                  {displayFindings[0]?.category}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    color: "var(--text-secondary)",
                  }}
                >
                  <Circle size={13} /> {displayFindings[0]?.message}
                </div>
                {displayFindings[0]?.file && (
                  <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    {displayFindings[0].file}
                  </div>
                )}
                <button onClick={sendFindingsToFixer} style={btnPrimary}>
                  {t(locale, "Action.SendToFixer")}
                </button>
              </>
            ) : (
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {t(locale, "Inspector.NoReviewRound")}
              </div>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          padding: 12,
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          gap: 8,
        }}
      >
        <button
          onClick={integrateApproved}
          disabled={!bridge || !runtimeChangeRequestId}
          style={{
            ...btnGhost,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <GitMerge size={13} /> {t(locale, "Action.Integrate")}
        </button>
        <button
          onClick={preparePullRequest}
          disabled={!bridge || !runtimeChangeRequestId}
          style={{
            ...btnPrimary,
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <ListTree size={13} /> {t(locale, "Action.PreparePR")}
        </button>
      </div>
    </div>
  );
});

