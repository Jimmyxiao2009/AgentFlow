import { describe, expect, it } from "vitest";
import path from "node:path";
import { isWithin, WorktreeManager } from "./index.js";

describe("git path boundaries", () => {
  it("accepts descendants and rejects sibling prefixes", () => {
    expect(isWithin("C:/data/worktrees", "C:/data/worktrees/project/task")).toBe(true);
    expect(isWithin("C:/data/worktrees", "C:/data/worktrees-old/task")).toBe(false);
  });

  it("keeps UUID-sized identifiers within a Windows-friendly path length", () => {
    const manager = new WorktreeManager({
      dataRoot: "C:/Users/AgentFlow/AppData/Local/Temp/agentflow",
    });
    const worktree = manager.worktreePath(
      "project-1234567890abcdef1234567890abcdef",
      "cr-1234567890abcdef1234567890abcdef",
      "TASK-001",
      "run-1234567890abcdef1234567890abcdef",
    );
    expect(worktree.length).toBeLessThan(220);
    expect(isWithin("C:/Users/AgentFlow/AppData/Local/Temp/agentflow/worktrees", worktree)).toBe(
      true,
    );
  });

  it("uses the host path separator for POSIX-style roots as well", () => {
    const parent = path.resolve("agentflow-cross-platform-root", "worktrees");
    expect(isWithin(parent, path.join(parent, "project", "task"))).toBe(true);
    expect(isWithin(parent, `${parent}-old${path.sep}task`)).toBe(false);
  });

  it("uses case sensitivity appropriate for the host filesystem", () => {
    if (process.platform === "win32") {
      expect(isWithin("C:/AgentFlow", "c:/agentflow/worktrees")).toBe(true);
    } else {
      expect(isWithin("/tmp/AgentFlow", "/tmp/agentflow/worktrees")).toBe(false);
    }
  });
});
