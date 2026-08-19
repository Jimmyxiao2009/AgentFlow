# Platform acceptance

The desktop target is configured for Tauri 2 bundle targets. On 2026-08-03, Windows x64
was built locally with the full Tauri bundle flow: the release executable, MSI, and NSIS
installer were produced, and the executable launch smoke passed with process cleanup.
Linux and macOS require their native runners;
the repository now contains `.github/workflows/desktop.yml`, which runs the complete
provider-free test, lint, format, security, and Tauri bundle matrix on all three hosts.

Platform acceptance is complete only after the matrix produces these artifacts without
manual changes:

- Linux: the Tauri AppImage/deb bundle launches and the private sidecar reaches
  `runtime.ready`.
- macOS: the `.app`/dmg bundle launches and the private sidecar reaches `runtime.ready`.
- Windows: MSI and NSIS bundles launch; the release smoke must leave no desktop or
  sidecar process behind.

Real-provider acceptance remains a separate opt-in pass documented in
`docs/provider-acceptance.md`; CI never uses paid provider accounts.
