import { describe, expect, it } from "vitest";
import { transitionChangeRequest, transitionTask } from "./index.js";

describe("domain state machines", () => {
  it("accepts the planning path", () => {
    expect(transitionChangeRequest("Draft", "Planning")).toBe("Planning");
    expect(transitionChangeRequest("Planning", "AwaitingSpecApproval")).toBe(
      "AwaitingSpecApproval",
    );
  });
  it("rejects illegal transitions", () => {
    expect(() => transitionChangeRequest("Draft", "Running")).toThrow();
    expect(() => transitionTask("Running", "Integrated")).toThrow();
  });
});
