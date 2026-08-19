# Testing strategy

The default suite is provider-free. `adapter-fake` emits deterministic events, supports cancellation, and can be configured to fail or request approval. Runtime smoke and performance fixtures set `AGENTFLOW_AUTO_PROBE=0` so locally installed CLIs are never invoked accidentally. Unit tests cover domain transitions, path boundaries, permission non-escalation, DAG leases, immutable PatchSets, deterministic validation gates, and reviewer independence.

The automated suite also covers the worker worktree → actual diff → commit → PatchSet path,
parallel ready tasks, settings IPC/persistence, permission pause/deny, structured CLI
normalization, Tauri event deduplication/ordering, project Git status/diff inspection, native
resume capability gating, sidecar crash/restart recovery, and sidecar event/response concurrency
(including stop during an active run), immutable SQLite diff/validation-log artifacts, and
Review/Fix revision semantics. Composer-selected permission profiles are passed through the
typed bridge and low-permission profiles fail closed before a task with write paths starts.
Recovery also reconciles a committed orphan worktree into a PatchSet, while the Git path
guard covers traversal boundaries and symbolic-link escapes.
The generated task contract runs format, lint, typecheck,
tests, build, and the repository secret scan when those npm scripts exist. A manual acceptance pass on a disposable repository
is still required for real-provider send/stream/stop/retry/resume, integration conflicts,
and platform-specific packaging on macOS/Linux. The Windows renderer smoke and timeline
performance pass are recorded in `docs/performance.md`; provider-specific opt-in steps
are in `docs/provider-acceptance.md`.
