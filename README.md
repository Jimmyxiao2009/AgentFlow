# AgentFlow

AgentFlow is an independent, local-first Tauri 2 desktop application for coordinating coding-agent CLIs through a Plan → Implement → Validate → Review → Integrate workflow.

The current repository contains a runnable local-first workflow slice spanning planning through integration:

- React/Vite conversation workspace with collapsible inspector, plan approval, permissions, settings, themes, semantic localization keys, and a virtualized timeline.
- Typed versioned bridge envelopes with a narrow allowlist; malformed and unknown methods fail closed.
- TypeScript sidecar with SQLite append-only events, current-state projections, deterministic fake adapter, plan creation/approval, task execution, validation, review, integration, and restart-safe persistence primitives.
- AgentAdapter SDK, fake adapter, local CLI process supervision, Codex/Claude/Grok Build/OpenCode adapter boundaries, routing and permission engines.
- Git worktree boundary and immutable PatchSet/review/validation invariants.
- Tauri 2 shell with a minimal capability file and no generic renderer shell command.

## Development

```powershell
npm install
npm run dev:ui
npm run dev:sidecar
npm run dev:tauri
npm run build:tauri
npm test
npm run typecheck
npm run lint
```

`npm run dev` starts the Vite UI and sidecar together. `npm run build` bundles the sidecar and copies the build machine's same-platform Node executable into the runtime resources, so the packaged desktop app does not require a system Node installation. Run `npm run build` before packaging.

The sidecar communicates over private stdin/stdout JSON lines. It does not open a LAN socket and never reads provider credential files. Real CLI adapters reuse the CLI's existing login state by launching the executable; the fake adapter is used by default tests.

## Layout

The React renderer lives in `apps/ui/src/` with `main.tsx` as its entry and
`AgentFlowWorkspace.tsx` as the workspace component; `src/main.tsx` remains a thin Vite
compatibility entry for the desktop shell.

See [docs/architecture.md](docs/architecture.md), [docs/references/adoption-matrix.md](docs/references/adoption-matrix.md), [docs/provider-acceptance.md](docs/provider-acceptance.md), and [docs/performance.md](docs/performance.md) for the boundary decisions, opt-in provider checks, and measurement log.
