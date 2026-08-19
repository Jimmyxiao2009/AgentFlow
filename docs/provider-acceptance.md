# Provider acceptance

AgentFlow launches the installed provider executable and never reads its credential files.
The executable probe runs the provider's version command; for adapters that expose an
official model-list command, the runtime may then run that read-only discovery command.
A successful probe means “installed and launchable”, not “subscription authenticated”.
Authentication remains inside the provider CLI.

The fixed login commands follow the providers' documented CLI entry points: [Codex CLI
login](https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt),
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [Grok CLI
reference](https://docs.x.ai/build/cli/reference), and [OpenCode CLI](https://dev.opencode.ai/docs/cli/).

The Authentication Profiles settings section exposes a fixed, provider-specific “Open CLI”
action. It starts the provider's own interactive login surface (`codex --login`, `claude`,
`grok login`, or `opencode auth login`) in a terminal. AgentFlow passes no credentials and
does not inspect the resulting provider state; probe the profiles again after the CLI exits.

The current Windows workspace verification on 2026-08-03 produced the following results. The
recorded checks below are version probes; they did not send a prompt or start a provider
session. Normal auto-probe also attempts `grok models` and `opencode models` when those
executables are ready, using the CLI Default fallback if discovery returns no usable models:

| Adapter     | Executable probe     | Current result                                    | Capability note                                                                   |
| ----------- | -------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| Codex CLI   | `codex --version`    | Unavailable: WindowsApps executable access denied | Structured stream, approvals, native resume capability advertised                 |
| Claude Code | `claude --version`   | `2.1.220 (Claude Code)` / Ready                   | Structured stream, approvals, and native resume                                   |
| Grok Build  | `grok --version`     | `grok 0.2.118` / Ready                            | Structured stream; provider does not advertise approval callbacks or resume       |
| OpenCode    | `opencode --version` | Unavailable: executable not found                 | Structured stream only; no native read-only sandbox, approval callback, or resume |

The same read-only runtime probe returned `Claude CLI Default` and `grok-4.5` from the
available official discovery paths. It returned no model for Codex or OpenCode because
those executables were unavailable in this Windows environment; the runtime therefore
keeps those providers unavailable instead of inventing verified models.

Discovered models retain their provider-native model ID and the adapter passes that ID to
the provider CLI when a run is explicitly routed to the model. The Models & Providers
settings section also accepts a manually entered adapter/provider/model ID. Manual entries
are persisted, shown as unverified, and are never selected by Auto routing; an explicit
manual selection is required.

The default automated suite does not invoke a paid provider. For an opt-in disposable
repository acceptance pass, launch the sidecar with `AGENTFLOW_AUTO_PROBE=1`, open the
repository in the desktop app, and verify the following in order:

1. Send an Ask request with the selected provider and confirm the first streamed delta.
2. Stop the run and verify the process tree is terminated and the run is Cancelled.
3. Retry the finished run; use Resume only when the adapter advertises native resume.
4. Use Plan → approval → Implement, then inspect the generated worktree and PatchSet.
5. Run deterministic validation, request Review, send a finding to Fix, and confirm a new PatchSet.

Do not use a production checkout for this pass. Provider send/stream checks are deliberately
manual and opt-in because they use the user's existing CLI subscription and can execute
provider-side operations. OpenCode read-only runs fail closed until its CLI exposes a native
read-only/approval bridge; AgentFlow never compensates by enabling its broad auto-approve flag.
