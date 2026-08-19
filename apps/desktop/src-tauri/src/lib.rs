use serde_json::Value;
use std::collections::HashMap;
#[cfg(unix)]
use std::io::Error;
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_notification::NotificationExt;

type PendingResponse = mpsc::Sender<Result<Value, String>>;

struct Sidecar {
    runtime_script: Option<PathBuf>,
    node_executable: Option<PathBuf>,
    data_directory: Option<PathBuf>,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    responses: Arc<Mutex<HashMap<String, PendingResponse>>>,
}

struct SidecarState(Mutex<Sidecar>);

impl Drop for Sidecar {
    fn drop(&mut self) {
        let Some(child) = self.child.as_mut() else {
            return;
        };
        let pid = child.id();

        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
        }

        #[cfg(unix)]
        {
            unsafe {
                let _ = libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
            }
            std::thread::sleep(Duration::from_millis(250));
            unsafe {
                let _ = libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
            }
        }

        let _ = child.kill();
        let _ = child.wait();
    }
}

fn allowed_method(method: &str) -> bool {
    matches!(
        method,
        "project.open"
            | "project.status"
            | "project.update"
            | "debug.start"
            | "debug.stop"
            | "conversation.create"
            | "message.send"
            | "plan.approval"
            | "permission.resolve"
            | "run.stop"
            | "task.run"
            | "task.run.ready"
            | "run.retry"
            | "run.resume"
            | "validation.run"
            | "review.start"
            | "integration.apply"
            | "pull-request.project"
            | "settings.get"
            | "settings.save"
            | "profiles.probe"
            | "artifact.read"
            | "runtime.status"
    )
}

fn allowed_navigation(url: &tauri::Url) -> bool {
    let local_asset = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    if local_asset {
        return true;
    }
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(1420)
}

fn navigation_security_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-security")
        .on_navigation(|webview, url| webview.label() == "main" && allowed_navigation(url))
        .build()
}

fn validate_bridge_request(request: &Value) -> Result<&str, String> {
    if request.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported bridge protocol version".to_string());
    }
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing request id".to_string())?;
    if request.get("payload").is_none() {
        return Err("Missing request payload".to_string());
    }
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing request method".to_string())?;
    if !allowed_method(method) {
        return Err("Unknown method rejected by desktop command allowlist".to_string());
    }
    let _ = id;
    Ok(method)
}

fn require_main_window(window: &Window) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Native dialogs are only allowed from the main window".to_string())
    }
}

fn provider_login_command(
    adapter_id: &str,
) -> Result<(&'static str, &'static [&'static str]), String> {
    match adapter_id {
        "codex" => Ok(("codex", &["--login"])),
        "claude" => Ok(("claude", &[])),
        "grok-build" => Ok(("grok", &["login"])),
        "opencode" => Ok(("opencode", &["auth", "login"])),
        _ => Err("Provider login is unavailable for this adapter".to_string()),
    }
}

#[tauri::command]
fn open_provider_login(window: Window, adapter_id: String) -> Result<(), String> {
    require_main_window(&window)?;
    let (executable, args) = provider_login_command(&adapter_id)?;

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;
        let mut command = Command::new("cmd.exe");
        command
            .args(["/d", "/c", executable])
            .args(args)
            .creation_flags(CREATE_NEW_CONSOLE)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .spawn()
            .map_err(|error| format!("Unable to open provider login terminal: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let command_line = std::iter::once(executable)
            .chain(args.iter().copied())
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            command_line.replace('\\', "\\\\").replace('"', "\\\"")
        );
        Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|error| format!("Unable to open provider login terminal: {error}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let terminal_candidates = [
            ("x-terminal-emulator", vec!["-e", executable]),
            ("gnome-terminal", vec!["--", executable]),
            ("konsole", vec!["-e", executable]),
            ("xfce4-terminal", vec!["-e", executable]),
            ("xterm", vec!["-e", executable]),
        ];
        for (terminal, prefix) in terminal_candidates {
            let mut command = Command::new(terminal);
            command.args(prefix).args(args);
            if command.spawn().is_ok() {
                return Ok(());
            }
        }
        return Err("No supported terminal emulator is available".to_string());
    }

    #[allow(unreachable_code)]
    Err("Provider login is unavailable on this platform".to_string())
}

fn notification_text(value: String, field: &str) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err(format!("Notification {field} cannot be empty"));
    }
    if value.as_bytes().contains(&0) {
        return Err(format!(
            "Notification {field} contains an invalid null byte"
        ));
    }
    if value.chars().count() > 512 {
        return Err(format!("Notification {field} is too long"));
    }
    Ok(value)
}

#[tauri::command]
fn notify_user(app: AppHandle, window: Window, title: String, body: String) -> Result<(), String> {
    require_main_window(&window)?;
    let title = notification_text(title, "title")?;
    let body = notification_text(body, "body")?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("Unable to show native notification: {error}"))
}

fn optional_dialog_directory(value: Option<String>) -> Result<Option<PathBuf>, String> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.as_bytes().contains(&0) {
        return Err("Dialog directory contains an invalid null byte".to_string());
    }
    if value.len() > 4096 {
        return Err("Dialog directory is too long".to_string());
    }
    Ok(Some(PathBuf::from(value)))
}

fn file_path_to_string(path: FilePath) -> Result<String, String> {
    path.into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("Unable to resolve native dialog path: {error}"))
}

fn canonical_repository_path(repository_path: String) -> Result<PathBuf, String> {
    if repository_path.is_empty() || repository_path.as_bytes().contains(&0) {
        return Err("Repository path is invalid".to_string());
    }
    let path = PathBuf::from(repository_path);
    if !path.is_dir() {
        return Err("Repository directory is unavailable".to_string());
    }
    path.canonicalize()
        .map_err(|error| format!("Unable to resolve repository directory: {error}"))
}

fn path_is_inside_repository(repository_path: &PathBuf, selected_path: &PathBuf) -> bool {
    let Ok(canonical_selected) = selected_path.canonicalize() else {
        return false;
    };
    canonical_selected != *repository_path
        && canonical_selected.strip_prefix(repository_path).is_ok()
}

#[tauri::command(async)]
fn pick_repository(
    app: AppHandle,
    window: Window,
    default_path: Option<String>,
) -> Result<Option<String>, String> {
    require_main_window(&window)?;
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Open repository");
    if let Some(directory) = optional_dialog_directory(default_path)? {
        dialog = dialog.set_directory(directory);
    }
    dialog
        .blocking_pick_folder()
        .map(file_path_to_string)
        .transpose()
}

#[tauri::command(async)]
fn pick_default_project_directory(
    app: AppHandle,
    window: Window,
) -> Result<Option<String>, String> {
    require_main_window(&window)?;
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose default project directory")
        .blocking_pick_folder()
        .map(file_path_to_string)
        .transpose()
}

#[tauri::command(async)]
fn pick_context_files(
    app: AppHandle,
    window: Window,
    repository_path: String,
) -> Result<Vec<String>, String> {
    require_main_window(&window)?;
    let repository_path = canonical_repository_path(repository_path)?;
    let selected = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_directory(&repository_path)
        .set_title("Attach context files")
        .blocking_pick_files()
        .unwrap_or_default();
    selected
        .into_iter()
        .map(file_path_to_string)
        .collect::<Result<Vec<_>, _>>()
        .and_then(|paths| {
            let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
            if paths
                .iter()
                .all(|path| path_is_inside_repository(&repository_path, path))
            {
                Ok(paths
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect())
            } else {
                Err("Context files must stay inside the active repository".to_string())
            }
        })
}

fn read_sidecar_output(
    stdout: BufReader<ChildStdout>,
    app: AppHandle,
    responses: Arc<Mutex<HashMap<String, PendingResponse>>>,
) {
    let mut stdout = stdout;
    let mut line = String::new();
    let failure = |message: String, responses: &Arc<Mutex<HashMap<String, PendingResponse>>>| {
        if let Ok(mut pending) = responses.lock() {
            let waiting = std::mem::take(&mut *pending);
            for sender in waiting.into_values() {
                let _ = sender.send(Err(message.clone()));
            }
        }
    };

    loop {
        line.clear();
        let bytes = match stdout.read_line(&mut line) {
            Ok(bytes) => bytes,
            Err(error) => {
                failure(
                    format!("Unable to read sidecar output: {error}"),
                    &responses,
                );
                return;
            }
        };
        if bytes == 0 {
            failure(
                "Sidecar exited without completing pending requests".to_string(),
                &responses,
            );
            return;
        }
        let message: Value = match serde_json::from_str(line.trim()) {
            Ok(message) => message,
            Err(_) => {
                // A single malformed line must not terminate the reader for the
                // whole session. The sidecar emits one JSON value per line; a
                // stray partial line, a non-JSON debug string, or a transient
                // parse hiccup should be skipped, not fatal. Previously this
                // returned, killing the reader while the child stayed alive,
                // so every subsequent bridge_request hung forever (recv() with
                // no timeout) and froze the UI.
                continue;
            }
        };
        if message.get("kind").and_then(Value::as_str) == Some("event") {
            if let Some(event) = message.get("event") {
                let _ = app.emit("agentflow.event", event);
            }
            continue;
        }
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            continue;
        };
        if let Ok(mut pending) = responses.lock() {
            if let Some(sender) = pending.remove(id) {
                let _ = sender.send(Ok(message));
            }
        }
    }
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    match path.to_str() {
        Some(text) => match text.strip_prefix(r"\\?\") {
            Some(rest) => PathBuf::from(rest),
            None => path,
        },
        None => path,
    }
}

fn ensure_sidecar(state: &mut Sidecar, app: &AppHandle) -> Result<(), String> {
    let exited = match state.child.as_mut() {
        Some(child) => child
            .try_wait()
            .map_err(|error| format!("Unable to inspect runtime sidecar: {error}"))?
            .is_some(),
        None => false,
    };
    if exited {
        state.child = None;
        state.stdin = None;
    }
    if state.child.is_some() {
        return Ok(());
    }
    // CARGO_MANIFEST_DIR is baked in at compile time as the absolute path to
    // apps/desktop/src-tauri, so these dev fallbacks resolve correctly regardless
    // of the process's actual current directory (which, depending on how the
    // Tauri CLI launches `cargo run`, is not reliably the repo root).
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let development_script = repo_root.join("apps/runtime/dist/main.js");
    let script = state
        .runtime_script
        .clone()
        .filter(|path| path.exists())
        .unwrap_or(development_script);
    let data_directory = state
        .data_directory
        .clone()
        .unwrap_or_else(|| PathBuf::from(".agentflow-data"));
    let development_node = repo_root.join(if cfg!(target_os = "windows") {
        "apps/runtime/dist/agentflow-node.exe"
    } else {
        "apps/runtime/dist/agentflow-node"
    });
    let node = state
        .node_executable
        .clone()
        .filter(|path| path.exists())
        .or_else(|| development_node.exists().then_some(development_node))
        .unwrap_or_else(|| {
            PathBuf::from(if cfg!(target_os = "windows") {
                "node.exe"
            } else {
                "node"
            })
        });
    // Windows `resource_dir()` returns `\\?\`-prefixed verbatim paths. Node's own
    // module resolution mishandles that prefix (it can misresolve the main script
    // path down to the bare drive letter, e.g. "E:", and crash with EISDIR), so
    // strip it before handing paths to the sidecar process.
    let node = strip_verbatim_prefix(node);
    let script = strip_verbatim_prefix(script);
    let mut command = Command::new(node);
    #[cfg(unix)]
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == -1 {
                return Err(Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .arg(script)
        .env("AGENTFLOW_DATA_DIR", data_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("Unable to start AgentFlow runtime sidecar: {error}"))?;
    state.stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .map(BufReader::new)
        .ok_or_else(|| "AgentFlow runtime stdout unavailable".to_string())?;
    let responses = Arc::clone(&state.responses);
    let reader_app = app.clone();
    std::thread::Builder::new()
        .name("agentflow-sidecar-reader".to_string())
        .spawn(move || read_sidecar_output(stdout, reader_app, responses))
        .map_err(|error| format!("Unable to start sidecar reader: {error}"))?;
    state.child = Some(child);
    Ok(())
}

#[tauri::command]
async fn bridge_request(
    app: AppHandle,
    window: Window,
    state: State<'_, SidecarState>,
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Bridge requests are only allowed from the main window".to_string());
    }
    validate_bridge_request(&request)?;
    // Scoped so the (non-Send) MutexGuard is structurally dropped at the end
    // of this block, well before the await point below.
    let receiver = {
        let mut sidecar = state
            .0
            .lock()
            .map_err(|_| "Sidecar state lock poisoned".to_string())?;
        ensure_sidecar(&mut sidecar, &app)?;
        let (sender, receiver) = mpsc::channel();
        let request_id = request
            .get("id")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let line = serde_json::to_string(&request).map_err(|error| error.to_string())?;
        sidecar
            .responses
            .lock()
            .map_err(|_| "Sidecar response map lock poisoned".to_string())?
            .insert(request_id.clone(), sender);
        let write_result = sidecar
            .stdin
            .as_mut()
            .ok_or_else(|| "Sidecar stdin unavailable".to_string())
            .and_then(|stdin| {
                stdin
                    .write_all(format!("{line}\n").as_bytes())
                    .map_err(|error| error.to_string())
            })
            .and_then(|_| {
                sidecar
                    .stdin
                    .as_mut()
                    .ok_or_else(|| "Sidecar stdin unavailable".to_string())?
                    .flush()
                    .map_err(|error| error.to_string())
            });
        if let Err(error) = write_result {
            if let Ok(mut pending) = sidecar.responses.lock() {
                pending.remove(&request_id);
            }
            return Err(error.to_string());
        }
        receiver
    };
    // bridge_request is a synchronous-looking command, but a naive blocking
    // recv() here would run on Tauri's main thread (non-async commands are
    // dispatched there) and freeze the entire window's message pump for as
    // long as the agent takes to respond. Move the wait onto a blocking-pool
    // thread and await it instead, so the UI stays responsive.
    //
    // Use a bounded recv_timeout rather than an unbounded recv: if the reader
    // thread has died (or a response is lost) the sender never fires, and a
    // plain recv() would block this command forever, permanently freezing the
    // UI on that request. A 60s ceiling returns an error the renderer can
    // surface instead of hanging; long-running streaming work is delivered as
    // events, not as a single blocking response, so 60s only bounds the
    // request/acknowledgment round-trip.
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(60)))
        .await
        .map_err(|error| format!("Bridge request task failed: {error}"))?
        .map_err(|error| format!("Bridge request timed out or the sidecar did not respond: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(navigation_security_plugin())
        .manage(SidecarState(Mutex::new(Sidecar {
            runtime_script: None,
            node_executable: None,
            data_directory: None,
            child: None,
            stdin: None,
            responses: Arc::new(Mutex::new(HashMap::new())),
        })))
        .invoke_handler(tauri::generate_handler![
            bridge_request,
            pick_repository,
            pick_default_project_directory,
            pick_context_files,
            open_provider_login,
            notify_user
        ])
        .setup(|app| {
            if let Ok(resource_dir) = app.path().resource_dir() {
                let state = app.state::<SidecarState>();
                if let Ok(mut sidecar) = state.0.lock() {
                    // Only resolve the bundled sidecar from resource_dir() in release
                    // builds. In dev, resource_dir() can point at a target/debug
                    // directory that happens to contain a stale copy of the runtime
                    // from a previous production build/bundle, which would get picked
                    // up here instead of the live apps/runtime/dist sources.
                    if !cfg!(debug_assertions) {
                        let runtime_directory = resource_dir.join("runtime");
                        sidecar.runtime_script = Some(runtime_directory.join("main.js"));
                        sidecar.node_executable =
                            Some(runtime_directory.join(if cfg!(target_os = "windows") {
                                "agentflow-node.exe"
                            } else {
                                "agentflow-node"
                            }));
                    }
                    sidecar.data_directory = Some(
                        app.path()
                            .app_data_dir()
                            .map_err(|error| error.to_string())?,
                    );
                };
            }
            let _ = app.get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AgentFlow");
}

#[cfg(test)]
mod tests {
    use super::{
        allowed_method, allowed_navigation, canonical_repository_path, notification_text,
        path_is_inside_repository, provider_login_command, validate_bridge_request,
    };
    use serde_json::json;
    use std::path::PathBuf;
    use tauri::Url;

    #[test]
    fn desktop_allowlist_accepts_only_narrow_runtime_intents() {
        assert!(allowed_method("runtime.status"));
        assert!(allowed_method("project.status"));
        assert!(allowed_method("settings.get"));
        assert!(allowed_method("settings.save"));
        assert!(allowed_method("profiles.probe"));
        assert!(allowed_method("artifact.read"));
        assert!(allowed_method("run.stop"));
        assert!(allowed_method("permission.resolve"));
        assert!(!allowed_method("execute_anything"));
        assert!(!allowed_method("shell.exec"));
        assert!(!allowed_method("fs.write"));
    }

    #[test]
    fn bridge_requests_require_the_versioned_envelope() {
        let valid = json!({
            "id": "request-1",
            "protocolVersion": 1,
            "method": "runtime.status",
            "payload": {}
        });
        assert_eq!(validate_bridge_request(&valid), Ok("runtime.status"));
        assert!(validate_bridge_request(&json!({
            "id": "request-1",
            "protocolVersion": 2,
            "method": "runtime.status",
            "payload": {}
        }))
        .is_err());
        assert!(validate_bridge_request(&json!({
            "id": "request-1",
            "protocolVersion": 1,
            "method": "runtime.status"
        }))
        .is_err());
    }

    #[test]
    fn navigation_policy_rejects_remote_and_unexpected_dev_origins() {
        assert!(allowed_navigation(
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(allowed_navigation(
            &Url::parse("https://tauri.localhost/index.html").unwrap()
        ));
        assert!(!allowed_navigation(
            &Url::parse("https://example.com").unwrap()
        ));
        assert!(!allowed_navigation(
            &Url::parse("https://evil.tauri.localhost").unwrap()
        ));
        assert!(!allowed_navigation(
            &Url::parse("http://127.0.0.1:1421/").unwrap()
        ));
        assert!(allowed_navigation(
            &Url::parse("http://127.0.0.1:1420/").unwrap()
        ));
    }

    #[test]
    fn context_file_scope_stays_inside_the_repository() {
        let repository = canonical_repository_path(env!("CARGO_MANIFEST_DIR").to_string()).unwrap();
        assert!(path_is_inside_repository(
            &repository,
            &repository.join("src").join("lib.rs")
        ));
        let outside = repository.parent().map(PathBuf::from).unwrap();
        assert!(!path_is_inside_repository(&repository, &outside));
    }

    #[test]
    fn provider_login_is_a_fixed_allowlist() {
        assert_eq!(provider_login_command("codex").unwrap().0, "codex");
        assert_eq!(provider_login_command("grok-build").unwrap().1, &["login"]);
        assert!(provider_login_command("shell").is_err());
    }

    #[test]
    fn native_notification_text_is_bounded_and_sanitized() {
        assert_eq!(
            notification_text("AgentFlow".to_string(), "title").unwrap(),
            "AgentFlow"
        );
        assert!(notification_text("".to_string(), "title").is_err());
        assert!(notification_text("bad\0text".to_string(), "body").is_err());
        assert!(notification_text("x".repeat(513), "body").is_err());
    }
}
