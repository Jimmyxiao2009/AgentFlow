# Security model

- Provider authentication remains inside each provider CLI. AgentFlow stores only profile metadata and optional isolated configuration-directory references; it never reads credential files or returns tokens to the renderer.
- The renderer receives only narrow Tauri commands. There is no `execute_anything` capability, shell plugin, unrestricted filesystem plugin, or arbitrary sidecar argument passthrough.
- System notifications are emitted by the Rust shell through a bounded `notify_user` command and Tauri's native notification plugin; the renderer cannot invoke the plugin directly or pass arbitrary notification payloads.
- Paths are resolved and checked against the repository allowlist/worktree root before Git operations. Protected paths include `.git`, credential files, default branches, and unrelated directories.
- Permission resolution can only reduce the application/project/workflow upper bound. Auto routing never changes a manual model, enables network, selects an unconfigured profile, turns read-only work into writes, or escalates permissions.
- Adapter capability gaps fail closed: OpenCode is not used for read-only conversation runs until its CLI exposes a native read-only/approval bridge; AgentFlow never turns on OpenCode's broad auto-approve flag to simulate one.
- Process supervision uses `shell: false`, explicit working directories, bounded output, redaction, timeout, cancellation, and exit-code capture.
- Diff, validation, and transcript artifacts remain in SQLite for audit history; the `artifact.read` renderer boundary redacts credential-shaped text before returning content to the WebView.
- Tauri capabilities are limited to the main window and `core:default`; native dialogs
  and notifications are exposed only through individually validated Rust commands. The
  application CSP disallows remote privileged content.
