import { describe, expect, it } from "vitest";
import { assertNoSilentEscalation, route } from "./index.js";

describe("explainable auto routing", () => {
  it("selects the first eligible candidate and records rejected fallbacks", () => {
    const decision = route(
      {
        preset: "Balanced",
        role: "Worker",
        permissionProfile: "Workspace Write",
        workerCount: 2,
        executionStrategy: "Parallel",
      },
      {
        profiles: [{ id: "maf-profile", name: "MAF", adapterId: "maf", status: "Ready" }],
        models: [],
        availableAdapters: ["fake", "maf"],
        requestedRole: "Worker",
      },
      "routing-1",
      "2026-08-03T00:00:00.000Z",
    );

    expect(decision.selected).toMatchObject({
      adapterId: "maf",
      profileId: "maf-profile",
      eligible: true,
    });
    expect(decision.matchedRule).toBe("preset:Balanced");
    expect(decision.rejectedCandidates).toContain(
      "fake: No configured ready authentication profile",
    );
    expect(decision.reason).toContain("maf is the first eligible candidate");
    // fallbackAttempts lists the adapters tried (and rejected) BEFORE the
    // selected one — here vercel-ai (no profile) was tried before maf was
    // selected. The previous slice(0,-1) implementation misreported this.
    expect(decision.fallbackAttempts).toEqual(["vercel-ai"]);
  });

  it("fails closed when no configured candidate is eligible", () => {
    const decision = route(
      {
        preset: "Manual",
        adapterId: "maf",
        role: "Investigator",
        permissionProfile: "Read Only",
        workerCount: 1,
        executionStrategy: "Serial",
      },
      { profiles: [], models: [], availableAdapters: [], requestedRole: "Investigator" },
      "routing-2",
    );

    expect(decision.selected).toBeUndefined();
    expect(decision.rejectedCandidates).toEqual(["maf: Adapter is not installed or probed"]);
    expect(decision.reason).toBe("No eligible candidate is configured");
  });

  it("routes to vercel-ai by default, matching what the desktop runtime actually registers", () => {
    // apps/runtime/src/main.ts only ever registers the "vercel-ai" adapter
    // (plus "fake" in test builds) -- never "maf". A preset route that
    // didn't consider "vercel-ai" would find zero eligible candidates for
    // every default ("Auto") run.
    const decision = route(
      {
        preset: "Balanced",
        role: "Worker",
        permissionProfile: "Workspace Write",
        workerCount: 1,
        executionStrategy: "Serial",
      },
      {
        profiles: [
          {
            id: "profile-vercel-ai",
            name: "Vercel AI SDK",
            adapterId: "vercel-ai",
            status: "Ready",
          },
        ],
        models: [],
        availableAdapters: ["vercel-ai"],
        requestedRole: "Worker",
      },
      "routing-vercel-ai",
    );

    expect(decision.selected).toMatchObject({
      adapterId: "vercel-ai",
      profileId: "profile-vercel-ai",
      eligible: true,
    });
  });

  it("rejects automatic permission escalation", () => {
    expect(() => assertNoSilentEscalation("Read Only", "Workspace Write")).toThrow(
      "cannot escalate permission",
    );
    expect(() => assertNoSilentEscalation("Workspace Write", "Read Only")).not.toThrow();
  });

  it("does not replace an explicit unavailable profile or model", () => {
    const profileDecision = route(
      {
        preset: "Balanced",
        profileId: "missing-profile",
        role: "Worker",
        permissionProfile: "Workspace Write",
        workerCount: 1,
        executionStrategy: "Serial",
      },
      {
        profiles: [{ id: "ready", name: "Ready", adapterId: "maf", status: "Ready" }],
        models: [],
        availableAdapters: ["maf"],
        requestedRole: "Worker",
      },
      "routing-profile",
    );
    expect(profileDecision.selected).toBeUndefined();
    expect(profileDecision.rejectedCandidates).toContainEqual(
      expect.stringContaining("Explicit authentication profile"),
    );

    const modelDecision = route(
      {
        preset: "Manual",
        adapterId: "maf",
        modelId: "missing-model",
        role: "Worker",
        permissionProfile: "Workspace Write",
        workerCount: 1,
        executionStrategy: "Serial",
      },
      {
        profiles: [{ id: "ready", name: "Ready", adapterId: "maf", status: "Ready" }],
        models: [],
        availableAdapters: ["maf"],
        requestedRole: "Worker",
      },
      "routing-model",
    );
    expect(modelDecision.selected).toBeUndefined();
    expect(modelDecision.rejectedCandidates[0]).toContain("Explicit model");
  });

  it("allows an explicitly selected manual model without treating it as verified", () => {
    const decision = route(
      {
        preset: "Manual",
        adapterId: "maf",
        modelId: "manual-maf-local",
        role: "Worker",
        permissionProfile: "Workspace Write",
        workerCount: 1,
        executionStrategy: "Serial",
      },
      {
        profiles: [{ id: "ready", name: "Ready", adapterId: "maf", status: "Ready" }],
        models: [
          {
            id: "manual-maf-local",
            adapterId: "maf",
            providerId: "azure",
            providerModelId: "local-model",
            name: "Local model",
            verified: false,
            cliDefault: false,
            capabilities: ["text-stream"],
          },
        ],
        availableAdapters: ["maf"],
        requestedRole: "Worker",
      },
      "routing-manual-model",
    );
    expect(decision.selected).toMatchObject({
      adapterId: "maf",
      modelId: "manual-maf-local",
      eligible: true,
    });
  });

  it("uses the first verified discovered model when a provider has no CLI Default entry", () => {
    const decision = route(
      {
        preset: "Fast",
        adapterId: "maf",
        role: "Worker",
        permissionProfile: "Read Only",
        workerCount: 1,
        executionStrategy: "Serial",
      },
      {
        profiles: [{ id: "maf-ready", name: "MAF", adapterId: "maf", status: "Ready" }],
        models: [
          {
            id: "maf-discovered",
            adapterId: "maf",
            providerId: "azure",
            providerModelId: "gpt-4o",
            name: "gpt-4o",
            verified: true,
            cliDefault: false,
            capabilities: ["structured-events"],
          },
          {
            id: "maf-manual",
            adapterId: "maf",
            providerId: "azure",
            providerModelId: "manual-model",
            name: "Manual model",
            verified: false,
            cliDefault: false,
            capabilities: ["structured-events"],
          },
        ],
        availableAdapters: ["maf"],
        requestedRole: "Worker",
      },
      "routing-discovered-model",
    );
    expect(decision.selected).toMatchObject({
      adapterId: "maf",
      modelId: "maf-discovered",
      eligible: true,
    });
  });
});
