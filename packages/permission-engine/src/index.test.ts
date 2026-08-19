import { describe, expect, it } from "vitest";
import {
  builtInPermissionProfiles,
  commandAllowed,
  effectivePermissions,
  isPermanentlyDenied,
  validatePermissionRequest,
} from "./index.js";

describe("permission engine", () => {
  it("keeps workspace writes scoped to the assigned worktree", () => {
    const profile = builtInPermissionProfiles().find((item) => item.name === "Workspace Write")!;
    expect(commandAllowed("npm test", profile, "C:/repo/worktree", "C:/repo/worktree")).toBe(true);
    expect(commandAllowed("npm test", profile, "C:/repo", "C:/repo/worktree")).toBe(false);
  });
  it("rejects path/option injection that escapes an allowed command prefix", () => {
    const profile = builtInPermissionProfiles().find((item) => item.name === "Workspace Write")!;
    // A vetted "npm test" must not be allowed to redirect via --prefix to an
    // unrelated path, nor accept absolute/relative path arguments.
    expect(
      commandAllowed("npm test --prefix C:/evil", profile, "C:/repo/worktree", "C:/repo/worktree"),
    ).toBe(false);
    expect(
      commandAllowed("npm run build /etc/passwd", profile, "C:/repo/worktree", "C:/repo/worktree"),
    ).toBe(false);
    expect(
      commandAllowed(
        "git show --output=../escape",
        profile,
        "C:/repo/worktree",
        "C:/repo/worktree",
      ),
    ).toBe(false);
    // A plain allowed command still passes.
    expect(commandAllowed("npm test", profile, "C:/repo/worktree", "C:/repo/worktree")).toBe(true);
  });
  it("permanently denies credential access", () =>
    expect(isPermanentlyDenied({ secretAccess: true })).toBeTruthy());
  it("permanently denies .env.local and other .env.* credential variants", () => {
    expect(isPermanentlyDenied({ path: ".env.local" })).toBeTruthy();
    expect(isPermanentlyDenied({ path: ".env.production" })).toBeTruthy();
    expect(isPermanentlyDenied({ path: "server/.env.local" })).toBeTruthy();
    expect(isPermanentlyDenied({ path: ".env" })).toBeTruthy();
    // A non-credential file that merely starts with ".env" must not be denied.
    expect(isPermanentlyDenied({ path: ".environment-config.json" })).toBeFalsy();
  });
  it("permanently denies force-push in every spelling, including the short flag", () => {
    expect(isPermanentlyDenied({ remoteGit: true, command: "git push --force" })).toBeTruthy();
    expect(isPermanentlyDenied({ remoteGit: true, command: "git push -f" })).toBeTruthy();
    expect(
      isPermanentlyDenied({ remoteGit: true, command: "git push --force-with-lease" }),
    ).toBeTruthy();
    expect(
      isPermanentlyDenied({ remoteGit: true, command: "git push origin main --force" }),
    ).toBeTruthy();
    // A normal push is not a force-push and is governed elsewhere, not here.
    expect(isPermanentlyDenied({ remoteGit: true, command: "git push origin main" })).toBeFalsy();
  });
  it("does not allow an elevated request under a read-only upper bound", () => {
    const profiles = builtInPermissionProfiles();
    const readOnly = profiles.find((item) => item.name === "Read Only")!;
    const elevated = profiles.find((item) => item.name === "Elevated with Approval")!;
    const result = validatePermissionRequest(
      {
        id: "permission-1",
        runId: "run-1",
        reason: "fixture",
        requested: elevated.dimensions,
        effective: readOnly.dimensions,
        status: "Pending",
        createdAt: "2026-08-03T00:00:00.000Z",
      },
      readOnly.dimensions,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("upper bound");
  });

  it("keeps custom dimensions explicit while retaining hard limits", () => {
    const custom = builtInPermissionProfiles({
      readPaths: ["src/**/*"],
      writePaths: ["<assigned-worktree>/**/*"],
      protectedPaths: ["secrets"],
      commands: ["npm test"],
      network: true,
      packageInstall: false,
      dependencyChanges: false,
      projectFileChanges: false,
      externalProcesses: false,
      environmentAccess: "none",
      secretAccess: true,
      clipboard: false,
      browser: false,
      externalDirectories: false,
      remoteGit: false,
    }).find((item) => item.name === "Custom")!;
    expect(custom.dimensions.writePaths).toEqual(["<assigned-worktree>/**/*"]);
    expect(custom.dimensions.commands).toEqual(["npm test"]);
    expect(custom.dimensions.secretAccess).toBe(false);
    expect(custom.dimensions.protectedPaths).toContain(".env");
  });

  it("does not let a Custom writePaths escalation escape the assigned worktree under a broad upper bound", () => {
    const profiles = builtInPermissionProfiles({
      readPaths: ["**/*"],
      writePaths: ["C:/Windows/System32/**"],
      protectedPaths: [],
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
    });
    const workspaceWrite = profiles.find((item) => item.name === "Workspace Write")!;
    const custom = profiles.find((item) => item.name === "Custom")!;
    const effective = effectivePermissions(workspaceWrite.dimensions, custom.dimensions);
    expect(effective.writePaths).not.toContain("C:/Windows/System32/**");
  });

  it("still allows worktree-relative writePaths under a broad upper bound", () => {
    const profiles = builtInPermissionProfiles({
      readPaths: ["**/*"],
      writePaths: ["src/**"],
      protectedPaths: [],
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
    });
    const workspaceWrite = profiles.find((item) => item.name === "Workspace Write")!;
    const custom = profiles.find((item) => item.name === "Custom")!;
    const effective = effectivePermissions(workspaceWrite.dimensions, custom.dimensions);
    expect(effective.writePaths).toContain("src/**");
  });
});
