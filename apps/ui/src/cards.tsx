import { ClipboardCheck, Shield } from "lucide-react";
import { t, type Locale } from "@agentflow/localization";
import type { PlanApprovalCardProps, PermissionRequestCardProps } from "./types";
import { btnGhost, btnPrimary } from "./constants";

export function PlanApprovalCard({
  onApprove,
  onRequestChanges,
  onOpenPlan,
  labels,
  locale = "en-US",
  specification,
  tasks,
}: PlanApprovalCardProps) {
  const taskCount = tasks.length;
  const parallelGroups = new Set(
    tasks.map((task) => (task.dependencyIds?.length ? task.dependencyIds.join(",") : task.id)),
  ).size;
  return (
    <div
      className="af-fade-in"
      style={{
        background: "var(--elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 10,
        padding: 14,
        maxWidth: 560,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <ClipboardCheck size={14} color="var(--accent)" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{labels.planReady}</span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "6px 16px",
          fontSize: 12.5,
          color: "var(--text-secondary)",
          marginBottom: 12,
        }}
      >
        <span>{labels.requirements}</span>
        <span className="af-mono" style={{ color: "var(--text-primary)" }}>
          {specification.requirements.length}
        </span>
        <span>{labels.tasks}</span>
        <span className="af-mono" style={{ color: "var(--text-primary)" }}>
          {taskCount} · {t(locale, "Plan.ParallelGroups", { count: parallelGroups })}
        </span>
        <span>{labels.structureChanges}</span>
        <span style={{ color: "var(--warning)" }}>
          {specification.structureChanges.length ? labels.yes : labels.no}
        </span>
        <span>{labels.risk}</span>
        <span style={{ color: "var(--warning)" }}>{specification.risk}</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onOpenPlan} style={btnGhost}>
          {labels.openPlan}
        </button>
        <button onClick={onRequestChanges} style={btnGhost}>
          {labels.requestChanges}
        </button>
        <button onClick={onApprove} style={btnPrimary}>
          {labels.approveAndRun}
        </button>
      </div>
    </div>
  );
}

export function PermissionRequestCard({
  onResolve,
  request,
  locale = "en-US",
}: PermissionRequestCardProps) {
  const permission = request?.permission || {};
  const detail = request?.permissionRequest || request || {};
  const requested = permission.requested || detail.requestedProfile || "Elevated with Approval";
  return (
    <div
      className="af-fade-in"
      style={{
        background: "var(--elevated)",
        border: "1px solid var(--warning)",
        borderRadius: 10,
        padding: 14,
        maxWidth: 560,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Shield size={14} color="var(--warning)" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {t(locale, "Permission.AgentRequests")}
        </span>
      </div>
      <div
        className="af-mono"
        style={{
          fontSize: 12,
          color: "var(--text-secondary)",
          background: "var(--window)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          padding: 10,
          marginBottom: 10,
        }}
      >
        {detail.command ||
          (typeof requested === "string" ? requested : t(locale, "Permission.Unspecified"))}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 12 }}>
        {t(locale, "Permission.WorkingDirectory")}:{" "}
        {detail.workingDirectory || t(locale, "Status.Unavailable")} ·{" "}
        {t(locale, "Permission.Reason")}: {detail.reason || t(locale, "Permission.Unspecified")}.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => onResolve("allow-once")} style={btnGhost}>
          {t(locale, "Action.AllowOnce")}
        </button>
        <button onClick={() => onResolve("allow-task")} style={btnGhost}>
          {t(locale, "Action.AllowTask")}
        </button>
        <button onClick={() => onResolve("allow-conversation")} style={btnGhost}>
          {t(locale, "Action.AllowConversation")}
        </button>
        <button onClick={() => onResolve("add-project-rule")} style={btnGhost}>
          {t(locale, "Action.AddProjectRule")}
        </button>
        <button onClick={() => onResolve("deny")} style={{ ...btnGhost, color: "var(--danger)" }}>
          {t(locale, "Action.Deny")}
        </button>
        <button
          onClick={() => onResolve("deny-and-stop")}
          style={{ ...btnGhost, color: "var(--danger)" }}
        >
          {t(locale, "Action.DenyAndStop")}
        </button>
      </div>
    </div>
  );
}

export function EscalationRequestCard({ request, onResolve, locale = "en-US" as Locale }: { request: { capability?: string; reason?: string }; onResolve: (approved: boolean) => void; locale?: Locale }) {
  const title =
    request.capability === "workers"
      ? t(locale, "Escalation.WorkersRequested")
      : t(locale, "Escalation.WriteRequested");
  return (
    <div
      className="af-fade-in"
      style={{
        background: "var(--elevated)",
        border: "1px solid var(--warning)",
        borderRadius: 10,
        padding: 14,
        maxWidth: 560,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Shield size={14} color="var(--warning)" />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      </div>
      {request.reason && (
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 12 }}>
          {t(locale, "Escalation.Reason")}: {request.reason}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => onResolve(true)} style={btnPrimary}>
          {t(locale, "Action.ApproveAndContinue")}
        </button>
        <button onClick={() => onResolve(false)} style={{ ...btnGhost, color: "var(--danger)" }}>
          {t(locale, "Action.Deny")}
        </button>
      </div>
    </div>
  );
}
