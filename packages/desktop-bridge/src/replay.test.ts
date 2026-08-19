import { describe, expect, it } from "vitest";
import { replayRuntimeTimeline } from "./replay.js";

describe("renderer timeline replay", () => {
  it("rebuilds durable messages after reload and ignores duplicate events", () => {
    const messages = replayRuntimeTimeline([
      {
        id: "delta-2",
        type: "message.delta",
        runId: "run-1",
        sequence: 3,
        payload: { text: "world" },
      },
      {
        id: "user-1",
        type: "message.created",
        sequence: 1,
        payload: { id: "message-1", role: "user", text: "Hello" },
      },
      {
        id: "delta-1",
        type: "message.delta",
        runId: "run-1",
        sequence: 2,
        payload: { text: "Hello " },
      },
      {
        id: "delta-1",
        type: "message.delta",
        runId: "run-1",
        sequence: 2,
        payload: { text: "Hello " },
      },
      {
        id: "complete-1",
        type: "message.completed",
        runId: "run-1",
        sequence: 4,
        payload: {},
      },
    ]);

    expect(messages).toEqual([
      { id: "message-1", role: "user", text: "Hello", streaming: false },
      { id: "replayed-agent-run-1", role: "agent", text: "Hello world", streaming: false },
    ]);
  });

  it("replays structured tool activity alongside messages", () => {
    const messages = replayRuntimeTimeline([
      {
        id: "tool-started",
        type: "adapter.tool.started",
        runId: "run-2",
        sequence: 1,
        payload: { tool: { name: "git diff", input: { path: "src/index.ts" } } },
      },
      {
        id: "tool-completed",
        type: "adapter.tool.completed",
        runId: "run-2",
        sequence: 2,
        payload: { tool: { name: "git diff", output: "2 files changed" } },
      },
    ]);

    expect(messages.map((message) => message.activity?.title)).toEqual([
      "Tool started · git diff",
      "Tool completed · git diff",
    ]);
    expect(messages[1]?.activity?.detail).toBe("2 files changed");
  });

  it("orders mixed-aggregate events by timestamp, not per-aggregate sequence", () => {
    // Two aggregates: a conversation (message.created, sequence 5, earlier in
    // time) and a task aggregate (task.started, sequence 0, later in time).
    // Sorting by sequence would put task.started first and scramble the order.
    const messages = replayRuntimeTimeline([
      {
        id: "task-started",
        type: "task.started",
        runId: "run-3",
        sequence: 0,
        timestamp: "2026-08-20T10:00:02.000Z",
        payload: { taskId: "task-3" },
      },
      {
        id: "user-message",
        type: "message.created",
        sequence: 5,
        timestamp: "2026-08-20T10:00:01.000Z",
        payload: { id: "msg-3", role: "user", text: "earlier" },
      },
    ]);
    // The user message (earlier timestamp) must precede the task activity.
    expect(messages[0]?.id).toBe("msg-3");
    expect(messages[1]?.activity?.title).toBe("Task started");
  });
});
