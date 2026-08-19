# AgentFlow architecture

The React renderer in `apps/ui` is a view and intent dispatcher. Tauri owns the window,
capability boundary, native dialogs/notifications, and sidecar process. The TypeScript sidecar owns domain state,
workflow orchestration, provider processes, Git worktrees, permissions, routing, SQLite,
and event projections.

The sidecar is private stdin/stdout JSONL. The bridge envelope has protocol version `1`; every request is validated before dispatch and every runtime method is explicitly allowlisted. The renderer cannot submit an arbitrary executable, argument vector, filesystem path operation, or environment override.
The Rust shell starts the sidecar in an owned process group and tears down the full tree on application exit; the TypeScript supervisor separately owns provider CLI cancellation and restart reconciliation.

Domain state is canonical in `ChangeRequest`, `Task`, `AgentRun`, `PatchSet`, validation, review, and integration entities. Conversations project those entities. SQLite stores append-only workflow/audit events, current projections, settings, leases, and immutable text artifacts; Git stores code and optional committed specifications/decisions/policies. Diff and validation-log content stays behind the lazy `artifact.read` bridge method.

Startup recovery marks interrupted runs and worktrees explicitly, releases stale leases,
denies pending approvals, and reconciles a committed orphan worktree into a recovered
PatchSet before the sidecar announces `runtime.ready`. Renderer reload only recreates the
event projection; it does not cancel the sidecar's active process tree.

Writing runs receive an owned worktree under AgentFlow's data root. A diff is inspected after the process exits and is the source of truth for a PatchSet. PatchSets are frozen immutable objects; fixes create a new sequence with `supersedes`. Review runs receive a separate worktree rooted at the PatchSet result commit and fail if the reviewer leaves any diff.

Permission profiles are carried through the typed protocol and enforced at both the
application boundary and PatchSet boundary. The Tauri shell exposes only the dialog/core
capabilities, applies a strict local-origin navigation policy, and never forwards generic
shell or environment-control requests. Artifact and native event text is redacted before
it is returned to the renderer or persisted as a log/diff artifact.

## Initial vertical slice

1. `project.open` verifies a repository with Git.
2. `conversation.create` creates a domain conversation.
3. `message.send` in Plan mode produces an immutable specification, routing decision, and task DAG.
4. `plan.approval` moves the change request to Ready or Running.
5. `task.run` leases a task, creates an owned worktree, runs an adapter, inspects the actual diff, and emits an immutable PatchSet.
6. `validation.run` records deterministic checks before `review.start` can approve a PatchSet.
7. `integration.apply` cherry-picks only approved PatchSets into an isolated, durable integration worktree; conflicts abort cleanly and can be retried without recreating the branch. `pull-request.project` creates a copyable projection without pushing.
8. Tauri forwards only validated requests to the private sidecar and relays workflow events to the renderer.

The default suite proves the worker worktree/PatchSet vertical slice with a disposable Git repository; real provider and platform acceptance remain opt-in because they require installed CLIs and OS-specific environments.
