import { describe, expect, it } from "vitest";
import { ProcessSupervisor, redactSecrets, redactStructured } from "./index.js";

describe("process supervisor", () => {
  it("captures output and redacts credential-shaped values", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.run("output", {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('token=secret-value')"],
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("token=[REDACTED]");
    expect(redactSecrets("sk-123456789012345")).toContain("[REDACTED]");
    expect(redactSecrets('{"apiKey":"secret-value"}')).toBe('{"apiKey":"[REDACTED]"}');
  });

  it("returns a failed result when an executable cannot be started", async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.run("missing", {
      executable: "agentflow-command-that-does-not-exist",
      args: [],
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("redacts sensitive fields in structured native events", () => {
    expect(
      redactStructured({ token: "secret-token", nested: { password: "secret-password" } }),
    ).toEqual({ token: "[REDACTED]", nested: { password: "[REDACTED]" } });
  });
});
