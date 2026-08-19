import type { Locale } from "@agentflow/localization";
import {
  Settings,
  Palette,
  Globe,
  Cpu,
  Workflow,
  Shield,
  GitBranch,
  Lock,
  Bell,
  HardDrive,
  Accessibility,
  Wrench,
  Info,
} from "lucide-react";
import { agentFlowAccentColors } from "@agentflow/design-system";

export const modeOptions = [
  { id: "Explore" },
  { id: "Plan" },
  { id: "Build" },
];

export const modeToRuntimeMode: Record<string, "Ask" | "Plan" | "Implement"> = {
  Explore: "Ask",
  Plan: "Plan",
  Build: "Implement",
};

export type SlashCommand = {
  command: "/plan" | "/build" | "/explore" | "/status" | "/integrate";
  kind: "mode" | "status" | "integrate";
  mode?: "Plan" | "Build" | "Explore";
};

export const slashCommands: SlashCommand[] = [
  { command: "/plan", kind: "mode", mode: "Plan" },
  { command: "/build", kind: "mode", mode: "Build" },
  { command: "/explore", kind: "mode", mode: "Explore" },
  { command: "/status", kind: "status" },
  { command: "/integrate", kind: "integrate" },
];

export function parseSlashCommand(input: string) {
  const trimmed = input.trimStart();
  const [token = "", ...argumentsList] = trimmed.split(/\s+/);
  const command = slashCommands.find((candidate) => candidate.command === token.toLowerCase()) ?? null;
  return {
    command,
    argument: argumentsList.join(" "),
    isSlashCommand: trimmed.startsWith("/"),
    token,
  };
}

export const permissionOptions = [
  { id: "read-only", label: "Read Only" },
  { id: "repo-safe", label: "Repository Safe" },
  { id: "workspace-write", label: "Workspace Write" },
  { id: "elevated", label: "Elevated with Approval" },
  { id: "custom", label: "Custom" },
] as const;

export const settingsSections = [
  { id: "general", key: "Settings.General", icon: Settings },
  { id: "appearance", key: "Settings.Appearance", icon: Palette },
  { id: "language", key: "Settings.Language", icon: Globe },
  { id: "models", key: "Settings.Models", icon: Cpu },
  { id: "workflows", key: "Settings.Workflows", icon: Workflow },
  { id: "permissions", key: "Settings.Permissions", icon: Shield },
  { id: "git", key: "Settings.Git", icon: GitBranch },
  { id: "safety", key: "Settings.Safety", icon: Lock },
  { id: "notifications", key: "Settings.Notifications", icon: Bell },
  { id: "storage", key: "Settings.Storage", icon: HardDrive },
  { id: "accessibility", key: "Settings.Accessibility", icon: Accessibility },
  { id: "advanced", key: "Settings.Advanced", icon: Wrench },
  { id: "about", key: "Settings.About", icon: Info },
];

export const permissionProfiles = [
  { name: "Read Only", descKey: "PermissionReadOnly" },
  { name: "Repository Safe", descKey: "PermissionRepositorySafe" },
  { name: "Workspace Write", descKey: "PermissionWorkspaceWrite", isDefault: true },
  { name: "Elevated with Approval", descKey: "PermissionElevatedWithApproval" },
  { name: "Custom", descKey: "PermissionCustom" },
];

export const safetyLocks = [
  ["SafetyForcePush", "Force push"],
  ["SafetyDeleteUnmergedBranch", "Delete unmerged branch"],
  ["SafetyDirectMainCheckoutWrite", "Direct main-checkout write"],
  ["SafetyAdminRootExecution", "Admin / root execution"],
  ["SafetyGlobalGitConfig", "Global Git configuration change"],
  ["SafetyCredentialFile", "Credential file access"],
];

export const accentColors = agentFlowAccentColors;

export const btnGhost = {
  background: "transparent",
  border: "1px solid var(--border-strong)",
  color: "var(--text-secondary)",
  fontSize: 12,
  padding: "6px 12px",
  borderRadius: 6,
  cursor: "pointer",
};

export const btnPrimary = {
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  color: "var(--on-accent)",
  fontSize: 12,
  fontWeight: 600,
  padding: "6px 12px",
  borderRadius: 6,
  cursor: "pointer",
};

export const btnDanger = {
  background: "transparent",
  border: "1px solid var(--danger)",
  color: "var(--danger)",
  fontSize: 12,
  padding: "6px 12px",
  borderRadius: 6,
  cursor: "pointer",
};
