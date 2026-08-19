import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { Workspace } from "@agentflow/domain";

const execFileAsync = promisify(execFile);

export function canonicalPath(input: string): string {
  return path.resolve(input);
}
export function isWithin(parent: string, child: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const p = normalize(canonicalPath(parent));
  const c = normalize(canonicalPath(child));
  return c === p || c.startsWith(`${p}${path.sep}`);
}
/**
 * Initializes a Git repository in-place (and creates an initial empty commit
 * so HEAD resolves) if the given directory isn't already inside one. Uses a
 * local, commit-scoped identity so this works even when the user has no
 * global git user.name/user.email configured.
 */
export async function ensureGitRepository(repositoryPath: string): Promise<void> {
  const check = await git(repositoryPath, ["rev-parse", "--is-inside-work-tree"]);
  if (check.exitCode !== 0 || check.stdout.trim() !== "true") {
    const init = await git(repositoryPath, ["init"]);
    if (init.exitCode !== 0)
      throw new Error(`Unable to initialize Git repository: ${init.stderr}`);
  }
  const head = await git(repositoryPath, ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) {
    const commit = await git(repositoryPath, [
      "-c",
      "user.name=AgentFlow",
      "-c",
      "user.email=agentflow@local",
      "commit",
      "--allow-empty",
      "-m",
      "Initial commit (AgentFlow)",
    ]);
    if (commit.exitCode !== 0)
      throw new Error(`Unable to create initial commit: ${commit.stderr}`);
  }
}

export async function verifyRepository(
  repositoryPath: string,
): Promise<{ root: string; head: string; branch: string }> {
  const rootResult = await git(repositoryPath, ["rev-parse", "--show-toplevel"]);
  if (rootResult.exitCode !== 0) throw new Error(`Not a Git repository: ${rootResult.stderr}`);
  const root = rootResult.stdout.trim();
  const headResult = await git(root, ["rev-parse", "HEAD"]);
  if (headResult.exitCode !== 0)
    throw new Error(`Unable to resolve repository HEAD: ${headResult.stderr}`);
  const branchResult = await git(root, ["branch", "--show-current"]);
  if (branchResult.exitCode !== 0)
    throw new Error(`Unable to resolve repository branch: ${branchResult.stderr}`);
  const head = headResult.stdout.trim();
  const branch = branchResult.stdout.trim();
  return { root: await realpath(root), head, branch };
}

export async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("Invalid git argument");
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "git failed",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

export interface WorktreeManagerOptions {
  dataRoot: string;
}

function worktreeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (normalized.length <= 24 && normalized !== "." && normalized !== "..")
    return normalized || "_";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${normalized.slice(0, 13)}-${digest}`;
}

export class WorktreeManager {
  constructor(private readonly options: WorktreeManagerOptions) {}

  worktreePath(projectId: string, changeRequestId: string, taskKey: string, runId: string): string {
    const safe = [projectId, changeRequestId, taskKey, runId].map(worktreeSegment);
    return path.join(this.options.dataRoot, "worktrees", ...safe);
  }

  async create(
    repositoryPath: string,
    workspace: Pick<
      Workspace,
      "id" | "projectId" | "changeRequestId" | "taskId" | "branch" | "baseCommit"
    > & { taskKey: string; runId: string },
  ): Promise<Workspace> {
    const location = this.worktreePath(
      workspace.projectId,
      workspace.changeRequestId,
      workspace.taskKey,
      workspace.runId,
    );
    if (!isWithin(path.join(this.options.dataRoot, "worktrees"), location))
      throw new Error("Worktree escaped AgentFlow data root");
    const result = await git(repositoryPath, [
      "worktree",
      "add",
      "-b",
      workspace.branch,
      location,
      workspace.baseCommit,
    ]);
    if (result.exitCode !== 0)
      throw new Error(`Unable to create isolated worktree: ${result.stderr}`);
    return { ...workspace, path: location, ownerRunId: workspace.runId, status: "Ready" };
  }

  async diff(workspacePath: string): Promise<{ files: string[]; unified: string }> {
    const canonicalWorkspacePath = await realpath(workspacePath);
    const stat = await git(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const diff = await git(workspacePath, ["diff", "--no-ext-diff", "--binary", "HEAD"]);
    const tracked = await git(workspacePath, ["diff", "--name-only", "--no-ext-diff", "HEAD"]);
    const untrackedFiles = stat.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    const untrackedDiffs = await Promise.all(
      untrackedFiles.map(async (file) => {
        const absolutePath = path.resolve(canonicalWorkspacePath, file);
        let canonicalFilePath = absolutePath;
        try {
          canonicalFilePath = await realpath(absolutePath);
        } catch {
          canonicalFilePath = path.join(
            await realpath(path.dirname(absolutePath)),
            path.basename(absolutePath),
          );
        }
        if (!isWithin(canonicalWorkspacePath, canonicalFilePath))
          throw new Error("Untracked path escaped worktree");
        const result = await git(workspacePath, [
          "diff",
          "--no-index",
          "--binary",
          "--",
          "/dev/null",
          file,
        ]);
        return result.stdout;
      }),
    );
    return {
      files: [
        ...tracked.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        ...untrackedFiles,
      ],
      unified: [diff.stdout, ...untrackedDiffs].filter(Boolean).join("\n"),
    };
  }

  async commit(workspacePath: string, changedFiles: string[], message: string): Promise<string> {
    if (!changedFiles.length) throw new Error("Cannot create an empty PatchSet");
    const safeFiles = changedFiles.map((file) => {
      const normalized = file.replaceAll("\\", "/");
      if (
        !normalized ||
        normalized.startsWith("/") ||
        normalized.split("/").includes("..") ||
        normalized.startsWith(".git/")
      )
        throw new Error(`Unsafe changed path: ${file}`);
      return normalized;
    });
    for (const file of safeFiles) {
      try {
        if ((await lstat(path.join(workspacePath, file))).isSymbolicLink())
          throw new Error(`Symbolic-link changes are not allowed in PatchSets: ${file}`);
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith("Symbolic-link changes"))
          throw error;
        // Deleted paths no longer have a filesystem entry and remain valid Git changes.
      }
    }
    const add = await git(workspacePath, ["add", "--", ...safeFiles]);
    if (add.exitCode !== 0) throw new Error(`Unable to stage PatchSet files: ${add.stderr}`);
    const commit = await git(workspacePath, ["commit", "--no-verify", "-m", message]);
    if (commit.exitCode !== 0) throw new Error(`Unable to commit PatchSet: ${commit.stderr}`);
    const head = await git(workspacePath, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0) throw new Error(`Unable to resolve PatchSet commit: ${head.stderr}`);
    return head.stdout.trim();
  }

  async remove(repositoryPath: string, workspacePath: string): Promise<void> {
    const root = path.join(this.options.dataRoot, "worktrees");
    if (!isWithin(root, workspacePath))
      throw new Error("Refusing to remove a worktree outside AgentFlow data root");
    const result = await git(repositoryPath, ["worktree", "remove", "--force", workspacePath]);
    if (result.exitCode !== 0) throw new Error(`Unable to remove worktree: ${result.stderr}`);
  }
}
