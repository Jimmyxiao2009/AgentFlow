import type {
  PermissionDimensions,
  PermissionProfile,
  PermissionProfileName,
  PermissionRequest,
} from "@agentflow/domain";

const allCommands = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git worktree",
  "git branch",
  "npm test",
  "npm run test",
  "npm run build",
  "cargo test",
  "cargo check",
];
const base = (name: PermissionProfileName): PermissionProfile => ({
  id: name.toLowerCase().replaceAll(" ", "-"),
  name,
  dimensions: {
    readPaths: ["**/*"],
    writePaths: [],
    protectedPaths: [".git", ".env", ".ssh", "main", "master"],
    commands: [],
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
});

export function builtInPermissionProfiles(
  customDimensions?: PermissionDimensions,
): PermissionProfile[] {
  const readOnly = base("Read Only");
  readOnly.dimensions.commands = ["git status", "git diff", "git log", "git show"];
  const repoSafe = base("Repository Safe");
  repoSafe.dimensions.commands = [...allCommands];
  const workspaceWrite = base("Workspace Write");
  workspaceWrite.dimensions.writePaths = ["<assigned-worktree>/**/*"];
  workspaceWrite.dimensions.commands = [...allCommands];
  const elevated = base("Elevated with Approval");
  elevated.dimensions.writePaths = ["<assigned-worktree>/**/*"];
  elevated.dimensions.commands = [...allCommands, "approved-command"];
  elevated.dimensions.network = true;
  elevated.dimensions.packageInstall = true;
  elevated.dimensions.dependencyChanges = true;
  elevated.dimensions.projectFileChanges = true;
  elevated.dimensions.externalProcesses = true;
  const custom = base("Custom");
  if (customDimensions) {
    custom.dimensions = {
      ...custom.dimensions,
      ...customDimensions,
      protectedPaths: [
        ...new Set([...custom.dimensions.protectedPaths, ...customDimensions.protectedPaths]),
      ],
      // Credential/secret access is a permanent v1 hard limit.
      secretAccess: false,
    };
  }
  return [readOnly, repoSafe, workspaceWrite, elevated, custom];
}

// Every path in this permission model is a glob evaluated against worktree-relative
// diff paths (see workflow-engine's pathMatches). A candidate that looks like an
// absolute filesystem path (a drive letter, a leading "/", or a UNC "\\\\" prefix)
// can never legitimately match those relative paths, and treating it as "covered"
// just because the upper bound grants blanket worktree access would let an
// out-of-scope Custom path silently pass the exceeds-effective-permissions check.
const isWorktreeRelativePattern = (value: string): boolean =>
  !/^[a-zA-Z]:[\\/]/.test(value) && !value.startsWith("/") && !value.startsWith("\\");

export function effectivePermissions(
  upper: PermissionDimensions,
  lower: Partial<PermissionDimensions>,
): PermissionDimensions {
  const bool = (key: keyof PermissionDimensions) => lower[key] === true && upper[key] === true;
  return {
    ...upper,
    readPaths: (lower.readPaths ?? upper.readPaths).filter(
      (p) =>
        upper.readPaths.includes(p) ||
        (upper.readPaths.includes("**/*") && isWorktreeRelativePattern(p)),
    ),
    writePaths: (lower.writePaths ?? upper.writePaths).filter(
      (p) =>
        upper.writePaths.includes(p) ||
        (upper.writePaths.includes("<assigned-worktree>/**/*") && isWorktreeRelativePattern(p)),
    ),
    protectedPaths: [...new Set([...upper.protectedPaths, ...(lower.protectedPaths ?? [])])],
    commands: (lower.commands ?? upper.commands).filter((c) => upper.commands.includes(c)),
    network: bool("network"),
    packageInstall: bool("packageInstall"),
    dependencyChanges: bool("dependencyChanges"),
    projectFileChanges: bool("projectFileChanges"),
    externalProcesses: bool("externalProcesses"),
    environmentAccess:
      upper.environmentAccess === "allowlist" && lower.environmentAccess === "allowlist"
        ? "allowlist"
        : "none",
    secretAccess: bool("secretAccess"),
    clipboard: bool("clipboard"),
    browser: bool("browser"),
    externalDirectories: bool("externalDirectories"),
    remoteGit: bool("remoteGit"),
  };
}

export function isPermanentlyDenied(
  request: Partial<PermissionDimensions> & { command?: string; path?: string },
): string | undefined {
  if (request.secretAccess) return "Credential and secret access is permanently denied in v1";
  // Catch every force-push spelling, not just the literal "push --force":
  // `git push -f`, `git push --force-with-lease`, `git push --force-with-lease=...`,
  // and a trailing `--force`/`-f` after a remote/branch. The previous literal
  // substring check let the short flag and the lease variant through the
  // permanent-deny layer that overrides a human "allow".
  if (request.remoteGit && /\bgit\s+push\b.*(\s-f\b|\s--force(\b|-with-lease))/i.test(request.command ?? ""))
    return "Automatic force-push is permanently denied in v1";
  // Credential files: match the literal name followed by end, slash, OR a dot
  // so that ".env.local", ".env.production", ".env.dev" — common real secret
  // files — are also permanently denied. The previous terminator only accepted
  // end-of-string or a slash, so ".env.local" slipped through.
  if (request.path && /(^|[\\/])(?:\.env|\.ssh|id_rsa|\.npmrc|\.pypirc|\.aws|credentials|\.netrc|\.gitconfig)(?:$|[\\/.])/i.test(request.path))
    return "Credential file access is permanently denied in v1";
  return undefined;
}

export function validatePermissionRequest(
  request: PermissionRequest,
  upperBound: PermissionDimensions,
): { allowed: boolean; reason?: string; effective: PermissionDimensions } {
  const permanent = isPermanentlyDenied({
    ...request.requested,
    command: request.command,
    path: request.workingDirectory,
  });
  const effective = effectivePermissions(upperBound, request.requested);
  if (permanent) return { allowed: false, reason: permanent, effective };
  const deniedDimension = Object.entries(request.requested).find(
    ([key, value]) => value === true && effective[key as keyof PermissionDimensions] !== true,
  );
  if (deniedDimension)
    return {
      allowed: false,
      reason: `Requested permission exceeds the upper bound: ${deniedDimension[0]}`,
      effective,
    };
  return { allowed: true, effective };
}

export function commandAllowed(
  command: string,
  profile: PermissionProfile,
  workingDirectory: string,
  assignedWorktree: string,
): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (/[;&|`$<>\n\r]/.test(normalized)) return false;
  if (normalized.startsWith("git push") || normalized.startsWith("git merge")) return false;
  if (normalized.includes("..")) return false;
  const insideWorktree =
    workingDirectory === assignedWorktree ||
    workingDirectory.startsWith(`${assignedWorktree}/`) ||
    workingDirectory.startsWith(`${assignedWorktree}\\`);
  return (
    insideWorktree &&
    profile.dimensions.commands.some(
      (allowed) => normalized === allowed || normalized.startsWith(`${allowed} `),
    )
  );
}
