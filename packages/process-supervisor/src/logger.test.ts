import { describe, expect, it } from "vitest";
import { Logger, redactSecrets, redactStructured } from "./index.js";

describe("structured logger", () => {
  it("captures log entries via a custom sink", () => {
    const entries: Array<{ level: string; message: string; [key: string]: unknown }> = [];
    Logger.setSink((entry) => entries.push(entry));
    Logger.setLevel("debug");
    Logger.info("test message", { context: "value" });
    Logger.debug("debug entry");
    Logger.error("error occurred", { code: 500 });
    expect(entries).toHaveLength(3);
    expect(entries[0]!.level).toBe("info");
    expect(entries[0]!.message).toBe("test message");
    expect(entries[0]!.context).toBe("value");
    expect(entries[2]!.level).toBe("error");
    expect(entries[2]!.code).toBe(500);
  });

  it("respects log level filtering", () => {
    const entries: unknown[] = [];
    Logger.setSink((entry) => entries.push(entry));
    Logger.setLevel("warn");
    Logger.info("should be filtered");
    Logger.warn("should appear");
    expect(entries).toHaveLength(1);
  });

  it("redacts API keys from secrets", () => {
    Logger.setSink(() => {});
    Logger.setLevel("info");
    const redacted = redactSecrets("api_key=sk-1234567890abcdef");
    expect(redacted).not.toContain("sk-1234567890abcdef");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts structured credential values", () => {
    const result = redactStructured({
      name: "test",
      api_key: "secret-value",
      nested: { token: "hidden" },
    });
    expect(result).toEqual({
      name: "test",
      api_key: "[REDACTED]",
      nested: { token: "[REDACTED]" },
    });
  });
});
