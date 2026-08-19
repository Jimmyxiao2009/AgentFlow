# Performance measurement log

The following Windows baseline was measured on 2026-08-03 with Node v24.14.1, a disposable
Git repository, the bundled runtime, and the deterministic fake adapter. Run
`npm run perf:measure` to repeat it; it intentionally does not invoke paid providers.

| Metric              | Method                                           | Baseline      | Target             | Latest measurement                         |
| ------------------- | ------------------------------------------------ | ------------- | ------------------ | ------------------------------------------ |
| Cold launch         | Vite renderer navigation to interactive timeline | 653.4 ms      | record per OS      | 653.4 ms (Windows, Playwright 1.59)        |
| Sidecar startup     | process start to `runtime.ready`                 | 92.5 ms       | record per OS      | 104.1 ms (Windows, 2026-08-03)             |
| Conversation switch | intent to projected timeline visible             | 58.7 ms       | record at p50/p95  | 58.7 ms (Windows, Playwright 1.59)         |
| Stream latency      | request to first fake adapter delta              | 31.1 ms       | record at p50/p95  | 25.1 ms (Windows, 2026-08-03)              |
| Large-thread scroll | 10k synthetic events, scroll settle              | 108.6 ms      | virtualized        | 108.6 ms settle (Windows, Playwright 1.59) |
| Large diff load     | 5MB unified diff over `artifact.read`            | 41.8 ms       | lazy artifact load | 42.9 ms / 5.10 MB (Windows, 2026-08-03)    |
| Idle/active memory  | Sidecar OS process working set                   | 51.7/53.3 MiB | record per OS      | 51.4 MiB idle / 53.0 MiB active (Windows)  |

The implementation uses a bounded SQLite conversation query, a virtualized timeline,
append-only events, and keeps artifact/diff content out of the primary projection. The
large-diff and memory rows are sidecar/IPC baselines. Renderer measurements were taken
against the local Vite renderer with the explicit 10,000-message benchmark query
(`?benchmark=timeline`); the benchmark payload is never used by normal runtime paths and
is not a substitute for a signed Tauri
bundle profile on each target OS. Renderer reload reconstruction is covered by the
`packages/desktop-bridge/src/replay.test.ts` contract test; a native-run persistence
check still belongs in the manual acceptance pass.
