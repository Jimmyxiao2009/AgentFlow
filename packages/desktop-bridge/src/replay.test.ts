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
});
