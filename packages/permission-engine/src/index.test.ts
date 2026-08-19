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
  it("permanently denies credential access", () =>
    expect(isPermanentlyDenied({ secretAccess: true })).toBeTruthy());
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
