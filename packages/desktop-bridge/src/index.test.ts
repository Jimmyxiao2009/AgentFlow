import { describe, expect, it } from "vitest";
import {
  createTauriTransport,
  createTypedBridge,
  protocolVersion,
  type NativeDialogCommand,
} from "./index.js";

describe("typed desktop bridge", () => {
  it("maps narrow intents to versioned transport methods", async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const nativeCalls: Array<{ command: NativeDialogCommand; args: unknown }> = [];
    const bridge = createTypedBridge({
      request: async <T>(method: string, payload: unknown) => {
        calls.push({ method, payload });
        return { ok: true } as T;
      },
      command: async <T>(command: NativeDialogCommand, args: unknown) => {
        nativeCalls.push({ command, args });
        return null as T;
      },
      subscribe: () => () => undefined,
    });

    await bridge.runTask("task-1", { adapterId: "codex", profileId: "profile-1" });
    await bridge.resolvePermission("permission-1", "deny-and-stop");
    await bridge.getSettings();
    await bridge.probeProfiles();
    await bridge.readArtifact("artifact-1");
    await bridge.status();
    await bridge.pickRepository("C:\\Projects");
    await bridge.pickDefaultProjectDirectory();
    await bridge.pickContextFiles("C:\\Projects\\AgentFlow");
    await bridge.openProviderLogin("grok-build");
    await bridge.notifyUser("AgentFlow", "Run completed");

    expect(protocolVersion()).toBe(1);
    expect(calls).toEqual([
      {
        method: "task.run",
        payload: { taskId: "task-1", adapterId: "codex", profileId: "profile-1" },
      },
      {
        method: "permission.resolve",
        payload: { requestId: "permission-1", decision: "deny-and-stop" },
      },
      { method: "settings.get", payload: {} },
      { method: "profiles.probe", payload: {} },
      { method: "artifact.read", payload: { artifactId: "artifact-1" } },
      { method: "runtime.status", payload: {} },
    ]);
    expect(nativeCalls).toEqual([
      { command: "pick_repository", args: { defaultPath: "C:\\Projects" } },
      { command: "pick_default_project_directory", args: undefined },
      { command: "pick_context_files", args: { repositoryPath: "C:\\Projects\\AgentFlow" } },
      { command: "open_provider_login", args: { adapterId: "grok-build" } },
      { command: "notify_user", args: { title: "AgentFlow", body: "Run completed" } },
    ]);
  });

  it("ignores duplicate and stale events while preserving aggregate order", async () => {
    let receive: ((event: { payload: unknown }) => void) | undefined;
    const previous = (globalThis as { __TAURI__?: unknown }).__TAURI__;
    (globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      core: { invoke: async () => ({ id: "request-1", ok: true, result: {} }) },
      event: {
        listen: async (_name: string, listener: (event: { payload: unknown }) => void) => {
          receive = listener;
          return () => undefined;
        },
      },
    };
    try {
      const transport = await createTauriTransport();
      const events: Array<{ id: string; sequence: number }> = [];
      transport.subscribe((event) => events.push({ id: event.id, sequence: event.sequence }));
      await Promise.resolve();
      const event = (id: string, sequence: number) => ({
        payload: {
          id,
          protocolVersion: 1,
          schemaVersion: 1,
          aggregateId: "conversation-1",
          sequence,
          timestamp: "2026-08-03T00:00:00.000Z",
          type: "message.delta",
          source: "adapter",
          payload: {},
        },
      });
      receive!(event("event-2", 2));
      receive!(event("event-2", 2));
      receive!(event("event-1", 1));
      receive!(event("event-3", 3));
      expect(events).toEqual([
        { id: "event-2", sequence: 2 },
        { id: "event-3", sequence: 3 },
      ]);
    } finally {
      (globalThis as { __TAURI__?: unknown }).__TAURI__ = previous;
    }
  });
});
