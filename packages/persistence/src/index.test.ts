import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "./index.js";

describe("sqlite event store", () => {
  it("deduplicates event ingestion and replays in sequence order", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-store-"));
    const store = new SqliteEventStore(join(root, "runtime.db"));
    const event = {
      id: "event-1",
      schemaVersion: 1,
      type: "message.created",
      aggregateId: "conversation-1",
      conversationId: "conversation-1",
      sequence: 0,
      timestamp: "2025-01-01T00:00:00.000Z",
      source: "runtime" as const,
      payload: { text: "hello" },
    };
    expect(store.append(event)).toBe(true);
    expect(store.append(event)).toBe(false);
    expect(
      store.append({
        ...event,
        id: "event-3",
        sequence: 2,
        payload: { text: "third" },
      }),
    ).toBe(true);
    expect(
      store.append({
        ...event,
        id: "event-2",
        sequence: 1,
        payload: { text: "second" },
      }),
    ).toBe(true);
    expect(store.eventsFor("conversation-1").map((item) => item.sequence)).toEqual([0, 1, 2]);
    expect(store.eventsFor("conversation-1")).toHaveLength(3);
    expect(store.eventsForConversation("conversation-1").map((item) => item.sequence)).toEqual([
      0, 1, 2,
    ]);
    expect(store.lastSequence("conversation-1")).toBe(2);
    store.saveTaskLease({
      id: "lease-1",
      taskId: "task-1",
      runId: "run-1",
      expiresAt: "2025-01-01T00:10:00.000Z",
      acquiredAt: "2025-01-01T00:00:00.000Z",
    });
    expect(store.taskLeases()[0]?.taskId).toBe("task-1");
    store.deleteTaskLease("task-1");
    expect(store.taskLeases()).toHaveLength(0);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("persists diff and validation artifacts independently from workflow events", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-artifacts-"));
    const databasePath = join(root, "runtime.db");
    const store = new SqliteEventStore(databasePath);
    const artifact = {
      id: "artifact-1",
      kind: "diff" as const,
      content: "@@ -0,0 +1 @@\n+hello",
      contentType: "text/x-diff",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    store.saveArtifact(artifact);
    store.saveArtifact({ ...artifact, content: "should remain immutable" });
    expect(store.readArtifact(artifact.id)).toEqual(artifact);
    expect(store.artifactCount()).toBe(1);
    store.close();

    const reopened = new SqliteEventStore(databasePath);
    expect(reopened.readArtifact(artifact.id)?.content).toContain("hello");
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("never prunes an artifact still referenced by a live PatchSet/ValidationRun", () => {
    const root = mkdtempSync(join(tmpdir(), "agentflow-prune-referenced-"));
    const store = new SqliteEventStore(join(root, "runtime.db"));
    const old = "2020-01-01T00:00:00.000Z";
    // A referenced diff artifact well past any retention window.
    const referenced = {
      id: "diff-referenced",
      kind: "diff" as const,
      content: "referenced diff",
      contentType: "text/x-diff",
      createdAt: old,
    };
    store.saveArtifact(referenced);
    // Add enough unreferenced old diff artifacts to exceed the "keep newest 50
    // per kind" floor, so the referenced one would normally be pruned by age
    // and only survives because it is referenced.
    for (let index = 0; index < 55; index += 1)
      store.saveArtifact({
        id: `diff-old-${index}`,
        kind: "diff",
        content: `old ${index}`,
        contentType: "text/x-diff",
        createdAt: old,
      });
    // retentionDays = 1, but keep the referenced id.
    const deleted = store.pruneArtifacts(1, new Set([referenced.id]));
    expect(deleted).toBeGreaterThan(0);
    expect(store.readArtifact(referenced.id)?.content).toBe("referenced diff");
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
});
