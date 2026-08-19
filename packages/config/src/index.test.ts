import { describe, expect, it } from "vitest";
import { defaultSettings, migrateSettings } from "./index.js";

describe("settings migration", () => {
  it("falls back safely for an incompatible version", () =>
    expect(migrateSettings({ schemaVersion: 0 })).toEqual(defaultSettings));
  it("merges legacy core settings with the versioned defaults", () => {
    expect(
      migrateSettings({
        schemaVersion: 1,
        theme: "Light",
        accent: "Blue",
        locale: "zh-CN",
        workerCount: 3,
        requireIndependentReviewer: true,
        requireApprovalNetwork: true,
        requireApprovalPackages: true,
        retentionDays: 45,
      }),
    ).toMatchObject({ theme: "Light", locale: "zh-CN", workerCount: 3, editor: "VS Code" });
  });
  it("accepts the complete UI policy vocabulary", () => {
    expect(
      migrateSettings({
        ...defaultSettings,
        integrationPolicy: "Auto when approved",
        concurrencyLimit: "3",
        pushPolicy: "Manual",
        retentionDays: 3650,
      }),
    ).toMatchObject({
      integrationPolicy: "Auto when approved",
      concurrencyLimit: "3",
      pushPolicy: "Manual",
      retentionDays: 3650,
    });
  });
});
