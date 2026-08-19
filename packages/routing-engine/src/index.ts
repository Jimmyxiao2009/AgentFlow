import type {
  AgentRole,
  AuthenticationProfile,
  ModelDefinition,
  PermissionProfileName,
  RoutingCandidate,
  RoutingDecision,
  RunConfiguration,
} from "@agentflow/domain";

export interface RoutingContext {
  profiles: AuthenticationProfile[];
  models: ModelDefinition[];
  availableAdapters: string[];
  requestedRole: AgentRole;
}

const rank: Record<RunConfiguration["preset"], string[]> = {
  Balanced: ["maf", "fake"],
  Fast: ["maf", "fake"],
  Quality: ["maf", "fake"],
  Conservative: ["maf", "fake"],
  Parallel: ["maf", "fake"],
  Manual: [],
};

export function route(
  configuration: RunConfiguration,
  context: RoutingContext,
  id: string,
  now = new Date().toISOString(),
): RoutingDecision {
  const candidates: RoutingCandidate[] = [];
  const adapters = configuration.adapterId
    ? [configuration.adapterId]
    : rank[configuration.preset].filter(
        (adapterId) => adapterId !== "fake" || context.availableAdapters.includes("fake"),
      );
  for (const adapterId of adapters) {
    const explicitProfile = configuration.profileId
      ? context.profiles.find((item) => item.id === configuration.profileId)
      : undefined;
    const profile = configuration.profileId
      ? explicitProfile?.adapterId === adapterId && explicitProfile.status === "Ready"
        ? explicitProfile
        : undefined
      : context.profiles.find((item) => item.adapterId === adapterId && item.status === "Ready");
    const model = configuration.modelId
      ? context.models.find(
          (item) => item.id === configuration.modelId && item.adapterId === adapterId,
        )
      : (context.models.find(
          (item) => item.adapterId === adapterId && item.cliDefault && item.verified,
        ) ?? context.models.find((item) => item.adapterId === adapterId && item.verified));
    const rejectedReason = !context.availableAdapters.includes(adapterId)
      ? "Adapter is not installed or probed"
      : configuration.profileId && !profile
        ? "Explicit authentication profile is unavailable for this adapter"
        : !profile
          ? "No configured ready authentication profile"
          : configuration.modelId && !model
            ? "Explicit model is unavailable for this adapter"
            : undefined;
    candidates.push({
      adapterId,
      profileId: profile?.id,
      modelId: model?.id,
      role: context.requestedRole,
      permissionProfile: configuration.permissionProfile,
      score: Math.max(0, 100 - candidates.length * 10),
      eligible: !rejectedReason,
      rejectionReason: rejectedReason,
    });
  }
  const selected = candidates.find((candidate) => candidate.eligible);
  const rejectedCandidates = candidates
    .filter((candidate) => !candidate.eligible)
    .map((candidate) => `${candidate.adapterId}: ${candidate.rejectionReason}`);
  return {
    id,
    input: configuration,
    candidates,
    selected,
    matchedRule: configuration.adapterId ? "explicit-adapter" : `preset:${configuration.preset}`,
    reason: selected
      ? `${selected.adapterId} is the first eligible candidate for ${configuration.preset}`
      : "No eligible candidate is configured",
    fallbackAttempts: candidates.slice(0, -1).map((candidate) => candidate.adapterId),
    rejectedCandidates,
    createdAt: now,
  };
}

export function assertNoSilentEscalation(
  previous: PermissionProfileName,
  next: PermissionProfileName,
): void {
  const order: PermissionProfileName[] = [
    "Read Only",
    "Repository Safe",
    "Workspace Write",
    "Elevated with Approval",
    "Custom",
  ];
  if (order.indexOf(next) > order.indexOf(previous))
    throw new Error(`Auto routing cannot escalate permission: ${previous} -> ${next}`);
}
