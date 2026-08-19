import { describe, expect, it } from "vitest";
import { FakeAdapter } from "./index.js";

describe("fake adapter", () => {
  it("streams deterministic events without provider credentials", async () => {
    const adapter = new FakeAdapter({ delayMs: 0 });
    const controller = new AbortController();
    const session = await adapter.startSession(
      {
        sessionId: "s1",
        conversationId: "c1",
        role: "Planner",
        profile: { id: "p", name: "fixture", adapterId: "fake", status: "Ready" },
        permissionProfile: "Read Only",
      },
      controller.signal,
    );
    const events = [];
    for await (const event of adapter.run(
      session,
      { prompt: "hello", mode: "Ask" },
      controller.signal,
    ))
      events.push(event);
    expect(events[0]?.kind).toBe("text.delta");
    expect(events.at(-1)?.kind).toBe("run.completed");
  });

  it("can emit structured reviewer findings for workflow tests", async () => {
    const adapter = new FakeAdapter({
      delayMs: 0,
      reviewFindings: [
        {
          severity: "Blocking",
          category: "security",
          file: "src/app.ts",
          line: 3,
          message: "Fixture finding",
        },
      ],
    });
    const controller = new AbortController();
    const session = await adapter.startSession(
      {
        sessionId: "review-session",
        conversationId: "c1",
        role: "Reviewer",
        profile: { id: "p", name: "fixture", adapterId: "fake", status: "Ready" },
        permissionProfile: "Read Only",
      },
      controller.signal,
    );
    const events = [];
    for await (const event of adapter.run(
      session,
      { prompt: "review", mode: "Review", permissionProfile: "Read Only" },
      controller.signal,
    ))
      events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ kind: "review.finding" }));
  });

  it("refuses fixture writes outside a writable permission profile", async () => {
    const adapter = new FakeAdapter({
      delayMs: 0,
      writeFiles: [{ path: "permission-test.txt", content: "must not be written" }],
    });
    const controller = new AbortController();
    const session = await adapter.startSession(
      {
        sessionId: "permission-session",
        conversationId: "c1",
        role: "Worker",
        profile: { id: "p", name: "fixture", adapterId: "fake", status: "Ready" },
        workspacePath: process.cwd(),
        permissionProfile: "Read Only",
      },
      controller.signal,
    );
    await expect(
      (async () => {
        for await (const _event of adapter.run(
          session,
          { prompt: "write", mode: "Implement", permissionProfile: "Read Only" },
          controller.signal,
        )) {
          // exhaust the generator
        }
      })(),
    ).rejects.toThrow("refused writes");
  });
});
