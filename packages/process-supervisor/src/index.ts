import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

export type LogSink = (entry: LogEntry) => void;

/** Lightweight structured logger.  Writes JSON lines to stderr by default, or to a custom sink. */
export class Logger {
  private static minLevel: LogLevel = "info";
  private static sink: LogSink = (entry) =>
    process.stderr.write(`${JSON.stringify(entry)}\n`);

  static setLevel(level: LogLevel): void {
    Logger.minLevel = level;
  }

  static setSink(sink: LogSink): void {
    Logger.sink = sink;
  }

  private static log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const order: LogLevel[] = ["debug", "info", "warn", "error"];
    if (order.indexOf(level) < order.indexOf(Logger.minLevel)) return;
    Logger.sink({ level, message, timestamp: new Date().toISOString(), ...context });
  }

  static debug(message: string, context?: Record<string, unknown>): void {
    Logger.log("debug", message, context);
  }
  static info(message: string, context?: Record<string, unknown>): void {
    Logger.log("info", message, context);
  }
  static warn(message: string, context?: Record<string, unknown>): void {
    Logger.log("warn", message, context);
  }
  static error(message: string, context?: Record<string, unknown>): void {
    Logger.log("error", message, context);
  }
}

export interface ProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}
export interface ProcessResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /(sk-[A-Za-z0-9_-]{12,}|(?:token|api[_-]?key|password|secret)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:token|api[_-]?key|password|secret|authorization|cookie|credential)["']?\s*[:=]\s*["']?)([^"'\s,;}]+)(["']?)/gi,
      "$1[REDACTED]$3",
    );
}

const sensitiveKey = /(?:token|api[_-]?key|password|secret|authorization|cookie|credential)/i;

export function redactStructured(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactStructured(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactStructured(entryValue, entryKey),
    ]),
  );
}
function safeEnvironment(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    ComSpec: process.env.ComSpec,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    // Provider CLIs (codex, claude, grok, opencode) talk to the network on
    // their own; without the user's proxy configuration forwarded through,
    // they silently try a direct connection, fail, and only surface a
    // generic error after their own internal retry/timeout budget expires.
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    no_proxy: process.env.no_proxy,
    ...extra,
  };
}

export class ProcessSupervisor {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  spawn(id: string, spec: ProcessSpec): ChildProcessWithoutNullStreams {
    if (this.processes.has(id)) throw new Error(`Process id is already running: ${id}`);
    if (spec.args.some((arg) => arg.includes("\0"))) throw new Error("Invalid process argument");
    const isWindowsBatch = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(spec.executable);
    const executable = isWindowsBatch ? (process.env.ComSpec ?? "cmd.exe") : spec.executable;
    const args = isWindowsBatch ? ["/d", "/c", spec.executable, ...spec.args] : spec.args;
    const child = spawn(executable, args, {
      cwd: spec.cwd,
      env: safeEnvironment(spec.env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.processes.set(id, child);
    child.once("close", () => this.processes.delete(id));
    return child;
  }
  async run(
    id: string,
    spec: ProcessSpec,
    input?: string,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const started = Date.now();
    const child = this.spawn(id, spec);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += redactSecrets(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += redactSecrets(chunk.toString());
    });
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else child.stdin.end();
    const timeout = spec.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          this.cancel(id);
        }, spec.timeoutMs)
      : undefined;
    const abort = () => this.cancel(id);
    signal?.addEventListener("abort", abort, { once: true });
    const [code, exitSignal, startupError] = await new Promise<
      [number | null, NodeJS.Signals | null, string | undefined]
    >((resolve) => {
      let settled = false;
      const finish = (exitCode: number | null, killedBy: NodeJS.Signals | null, error?: string) => {
        if (settled) return;
        settled = true;
        resolve([exitCode, killedBy, error]);
      };
      child.once("error", (error: Error) => finish(-1, null, error.message));
      child.once("close", (exitCode: number | null, killedBy: NodeJS.Signals | null) =>
        finish(exitCode, killedBy),
      );
    });
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    return {
      exitCode: code,
      signal: exitSignal ?? undefined,
      stdout,
      stderr: startupError ? `${stderr}${redactSecrets(startupError)}` : stderr,
      durationMs: Date.now() - started,
      timedOut,
    };
  }
  cancel(id: string): void {
    const child = this.processes.get(id);
    if (!child) return;
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode !== null) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* the process may have exited between the checks */
      }
    }, 2_000).unref();
  }
  stopAll(): void {
    for (const id of this.processes.keys()) this.cancel(id);
  }
}

export async function* lines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  const reader = createInterface({ input: stream });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
  }
}
