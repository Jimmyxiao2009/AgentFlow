import { describe, expect, it } from "vitest";
import { bridgeEventSchema, bridgeRequestSchema, parseMethodPayload } from "./index.js";

describe("bridge protocol", () => {
  it("rejects malformed envelopes and validates narrow payloads", () => {
    expect(
      bridgeRequestSchema.safeParse({
        id: "x",
        protocolVersion: 2,
        method: "runtime.status",
        payload: {},
      }).success,
    ).toBe(false);
    expect(parseMethodPayload("runtime.status", {})).toEqual({});
    expect(parseMethodPayload("artifact.read", { artifactId: "artifact-1" })).toEqual({
      artifactId: "artifact-1",
    });
    expect(() => parseMethodPayload("project.open", { repositoryPath: "" })).toThrow();
    expect(
      bridgeEventSchema.parse({
        id: "e",
        protocolVersion: 1,
        schemaVersion: 1,
        aggregateId: "cr",
        sequence: 0,
        timestamp: "2025-01-01T00:00:00.000Z",
        type: "task.ready",
        payload: {},
      }).aggregateId,
    ).toBe("cr");
    // Runtime-emitted events always carry `source`; a strict schema that omits
    // it would silently drop every real-time event at the renderer boundary.
    expect(
      bridgeEventSchema.safeParse({
        id: "e2",
        protocolVersion: 1,
        schemaVersion: 1,
        aggregateId: "conversation-1",
        conversationId: "conversation-1",
        sequence: 1,
        timestamp: "2025-01-01T00:00:00.000Z",
        type: "message.delta",
        source: "adapter",
        role: "Worker",
        payload: {},
      }).success,
    ).toBe(true);
  });
});
