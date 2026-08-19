/// <reference types="vite/client" />

// AgentFlow's workspace is intentionally kept in the renderer's TypeScript boundary.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  createTauriTransport,
  createTypedBridge,
  replayRuntimeTimeline,
  runtimeEventToTimelineActivity,
} from "@agentflow/desktop-bridge";
import { t } from "@agentflow/localization";
import { lookupModelMeta } from "./modelPresets";
import { PanelRightClose, PanelRightOpen, X, Bell, Pin, Archive } from "lucide-react";
import type {
  WorkflowPayload,
  RuntimeStatus,
  TimelineMessage,
  BridgeApi,
} from "./types";
import {
  modeToRuntimeMode,
  parseSlashCommand,
  permissionOptions,
  settingsSections,
  accentColors,
  btnGhost,
} from "./constants";
import {
  parseEscalationRequest,
  stripEscalationMarker,
  relativeTime,
  runtimeSettingsToUi,
  resolveUiLocale,
  uiSettingsToRuntime,
  localizedStatus,
} from "./utils";
import {
  PlanApprovalCard,
  PermissionRequestCard,
  EscalationRequestCard,
} from "./cards";
import { VirtualTimeline } from "./VirtualTimeline";
import { Composer } from "./Composer";
import { ConversationSidebar } from "./ConversationSidebar";
import { InspectorPanel } from "./InspectorPanel";
import { SettingsPanel } from "./SettingsPanel";
import { defaultUiSettings } from "./defaultUiSettings";

export default function AgentFlowWorkspace() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [tab, setTab] = useState("Overview");
  const [mode, setMode] = useState("Explore");
  const [model, setModel] = useState(() => {
    try {
      const stored = globalThis.localStorage?.getItem("agentflow.selected-model.v1");
      return stored || "auto";
    } catch {
      return "auto";
    }
  });
  const [permission, setPermission] = useState("workspace-write");
  const [activeProject, setActiveProject] = useState(null);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversationFilter, setConversationFilter] = useState("recent");
  const [pinnedConversationIds, setPinnedConversationIds] = useState(() => {
    try {
      const stored = globalThis.localStorage?.getItem("agentflow.pinned-conversations.v1");
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const [openMenu, setOpenMenu] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("general");
  const [settingsSearch, setSettingsSearch] = useState("");
  const [composerText, setComposerText] = useState("");
  const [contextAttachments, setContextAttachments] = useState([]);
  const initialTimelineMessages = ((): TimelineMessage[] => {
    const benchmarkFlag =
      typeof window !== "undefined" &&
      new window.URLSearchParams(window.location.search).get("benchmark");
    if (benchmarkFlag === "timeline")
      return Array.from({ length: 10_000 }, (_, index) => ({
        id: `benchmark-message-${index}`,
        role: index % 3 === 0 ? "user" : "agent",
        text: `Synthetic timeline event ${index}: virtualized renderer benchmark payload.`,
        streaming: false,
      }));
    if (benchmarkFlag === "activity")
      return [
        { id: "u1", role: "user", text: "Please refactor the auth module", streaming: false },
        {
          id: "a1",
          kind: "activity",
          role: "agent",
          text: "Tool started",
          streaming: false,
          activity: { category: "tool", status: "started", title: "Tool started · read_file", detail: "auth.ts" },
        },
        {
          id: "a2",
          kind: "activity",
          role: "agent",
          text: "Tool completed",
          streaming: false,
          activity: { category: "tool", status: "completed", title: "Tool completed · read_file", detail: "auth.ts (240 lines)" },
        },
        {
          id: "a3",
          kind: "activity",
          role: "agent",
          text: "Command started",
          streaming: false,
          activity: { category: "command", status: "started", title: "Command started", detail: "npm test" },
        },
        {
          id: "a4",
          kind: "activity",
          role: "agent",
          text: "Command completed",
          streaming: false,
          activity: { category: "command", status: "completed", title: "Command completed", detail: "exit code 0" },
        },
        {
          id: "a5",
          kind: "activity",
          role: "agent",
          text: "File changes detected",
          streaming: false,
          activity: { category: "workflow", status: "info", title: "File changes detected", detail: "auth.ts" },
        },
        {
          id: "ag1",
          role: "agent",
          text: "I refactored the auth module and all tests pass.",
          streaming: false,
        },
      ];
    return [];
  })();
  const [timelineMessages, setTimelineMessages] = useState<TimelineMessage[]>(
    /** @type {Array<{id: string, role: string, text: string, streaming?: boolean}>} */ initialTimelineMessages,
  );
  const [sending, setSending] = useState(false);
  const [runtimeState, setRuntimeState] = useState<string>(() => t("en-US", "Runtime.Unavailable"));
  const [inAppNotifications, setInAppNotifications] = useState([]);
  const [runtimeData, setRuntimeData] = useState(null);
  const [repositoryStatus, setRepositoryStatus] = useState(null);
  const [bridge, setBridge] = useState<BridgeApi | null>(null);
  const [runtimeConversationId, setRuntimeConversationId] = useState(null);
  const [runtimeChangeRequestId, setRuntimeChangeRequestId] = useState(null);
  const [activeRunId, setActiveRunId] = useState(null);
  const [failedRunId, setFailedRunId] = useState(null);
  const [debugRunning, setDebugRunning] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState(null);
  const [openArtifactId, setOpenArtifactId] = useState(null);
  const [artifactContent, setArtifactContent] = useState(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactSearch, setArtifactSearch] = useState("");
  const [artifactViewMode, setArtifactViewMode] = useState("unified");
  const composerRef = useRef(null);
  const conversationSearchRef = useRef(null);
  const streamMessageRef = useRef(null);
  const runtimeStreamSeenRef = useRef(false);
  const lastUserTextRef = useRef("");
  const [pendingEscalation, setPendingEscalation] = useState(null);
  const runtimeConversationRef = useRef(null);
  const settingsHydratedRef = useRef(false);
  const settingsEditedRef = useRef(false);
  const settingsRef = useRef(null);
  const bridgeRef = useRef<BridgeApi | null>(null);
  const blockedTaskIdsRef = useRef(null);
  const runtimeStateKeyRef = useRef<{
    key: string;
    parameters?: Record<string, string | number>;
  } | null>({ key: "Runtime.Unavailable" });

  const [settings, setSettings] = useState(() => ({ ...defaultUiSettings }));
  const setSetting = (key, value) => {
    settingsEditedRef.current = true;
    settingsHydratedRef.current = true;
    setSettings((s) => ({ ...s, [key]: value }));
    if (
      key === "systemNotif" &&
      value &&
      !bridgeRef.current &&
      typeof globalThis.Notification === "function" &&
      globalThis.Notification.permission === "default"
    ) {
      void globalThis.Notification.requestPermission();
    }
  };
  const locale = resolveUiLocale(settings.language);
  const labels = {
    newConversation: t(locale, "Navigation.NewConversation"),
    searchConversations: t(locale, "Navigation.SearchConversations"),
    pinned: t(locale, "Navigation.Pinned"),
    recent: t(locale, "Navigation.Recent"),
    archived: t(locale, "Navigation.Archived"),
    pin: t(locale, "Navigation.Pin"),
    unpin: t(locale, "Navigation.Unpin"),
    openProject: t(locale, "Navigation.OpenProject"),
    settings: t(locale, "Navigation.Settings"),
    openPlan: t(locale, "Action.OpenPlan"),
    requestChanges: t(locale, "Action.RequestChanges"),
    approveAndRun: t(locale, "Action.ApproveAndRun"),
    copy: t(locale, "Action.Copy"),
    jumpToLatest: t(locale, "Action.JumpToLatest"),
    timeline: t(locale, "Navigation.ConversationTimeline"),
    inspector: t(locale, "Navigation.Inspector"),
    planReady: t(locale, "Plan.ImplementationReady"),
    requirements: t(locale, "Plan.Requirements"),
    tasks: t(locale, "Plan.Tasks"),
    structureChanges: t(locale, "Plan.StructureChanges"),
    yes: t(locale, "Plan.Yes"),
    no: t(locale, "Plan.No"),
    risk: t(locale, "Plan.Risk"),
  };

  const setLocalizedRuntimeState = useCallback(
    (key: string, parameters?: Record<string, string | number>) => {
      runtimeStateKeyRef.current = { key, parameters };
      const currentSettings = settingsRef.current || settings;
      setRuntimeState(t(resolveUiLocale(currentSettings.language), key, parameters));
    },
    [],
  );

  useEffect(() => {
    globalThis.document.documentElement.lang = locale;
    if (runtimeStateKeyRef.current) {
      setRuntimeState(
        t(locale, runtimeStateKeyRef.current.key, runtimeStateKeyRef.current.parameters),
      );
    }
  }, [locale]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const pushRuntimeNotification = (rule, eventType) => {
    const currentSettings = settingsRef.current || settings;
    if (
      (!currentSettings.inAppNotif && !currentSettings.systemNotif) ||
      !currentSettings[rule.setting]
    )
      return;
    const notificationLocale = resolveUiLocale(currentSettings.language);
    const title = t(notificationLocale, rule.titleKey);
    const body = t(notificationLocale, "Notification.EventReceived", { event: eventType });
    const id = `${eventType}-${Date.now()}`;
    if (currentSettings.inAppNotif) {
      setInAppNotifications((current) => [...current.slice(-3), { id, title, body }]);
      globalThis.setTimeout(() => {
        setInAppNotifications((current) => current.filter((item) => item.id !== id));
      }, 6500);
    }

    if (currentSettings.systemNotif) {
      const nativeBridge = bridgeRef.current;
      if (nativeBridge) {
        void nativeBridge.notifyUser(title, body).catch(() => undefined);
      } else if (
        typeof globalThis.Notification === "function" &&
        globalThis.Notification.permission === "granted"
      ) {
        new globalThis.Notification(title, { body });
      }
    }
    if (currentSettings.soundNotif) {
      try {
        const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (AudioContext) {
          const audioContext = new AudioContext();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.frequency.value = 740;
          gain.gain.setValueAtTime(0.035, audioContext.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.12);
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start();
          oscillator.stop(audioContext.currentTime + 0.12);
          globalThis.setTimeout(() => void audioContext.close(), 180);
        }
      } catch {
        // Browsers can block audio until the user interacts with the window.
      }
    }
  };

  useEffect(() => {
    runtimeConversationRef.current = runtimeConversationId;
  }, [runtimeConversationId]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    const run = async () => {
    try {
      const transport = await createTauriTransport();
      if (cancelled) return;
      const typedBridge = createTypedBridge(transport);
      setBridge(typedBridge);
      bridgeRef.current = typedBridge;
      const applyRuntimeStatus = (status) => {
        setRuntimeData(status);
        setModel((current) =>
          current === "auto" || status.models?.some((candidate) => candidate.id === current)
            ? current
            : "auto",
        );
        if (status.settings && !settingsHydratedRef.current && !settingsEditedRef.current) {
          setSettings((current) => ({ ...current, ...runtimeSettingsToUi(status.settings) }));
          settingsHydratedRef.current = true;
        }
        const currentSettings = settingsRef.current || settings;
        const blockedTaskIds = new Set(
          (status.tasks || []).filter((task) => task.state === "Blocked").map((task) => task.id),
        );
        if (blockedTaskIdsRef.current) {
          for (const taskId of blockedTaskIds) {
            if (!blockedTaskIdsRef.current.has(taskId))
              pushRuntimeNotification(
                { setting: "notifBlockedTask", titleKey: "SettingsText.TaskBlocked" },
                "task.blocked",
              );
          }
        }
        blockedTaskIdsRef.current = blockedTaskIds;
        const conversationLimit = Number.parseInt(currentSettings.recentLimit, 10) || 10;
        const recentConversations = (status.conversations || []).slice(-conversationLimit);
        const selectedConversationId = currentSettings.restoreWorkspace
          ? recentConversations.some(
              (conversation) => conversation.id === runtimeConversationRef.current,
            )
            ? runtimeConversationRef.current
            : recentConversations.at(-1)?.id || null
          : null;
        const retryableRun = status.runs
          ?.filter(
            (run) =>
              run.conversationId === selectedConversationId &&
              ["Failed", "Cancelled", "Completed"].includes(run.state),
          )
          .at(-1);
        setFailedRunId(retryableRun?.id || null);
        setTimelineMessages(
          replayRuntimeTimeline(
            status.events?.filter((event) => event.conversationId === selectedConversationId),
          ),
        );
        setActiveProject((current) =>
          status.projects?.some((project) => project.id === current)
            ? current
            : status.projects?.at(-1)?.id || current,
        );
        setRuntimeConversationId(selectedConversationId);
        setPermissionRequest(
          status.permissions?.find((request) => request.status === "Pending") || null,
        );
      };
      unsubscribe = typedBridge.subscribe((event) => {
        const workflowEvent = event;
        const payload: WorkflowPayload =
          workflowEvent.payload && typeof workflowEvent.payload === "object"
            ? (workflowEvent.payload as WorkflowPayload)
            : {};
        setLocalizedRuntimeState("Runtime.Event", { event: workflowEvent.type });
        const notificationRules = {
          "specification.produced": {
            setting: "notifPlanApproval",
            titleKey: "SettingsText.PlanAwaitingApproval",
          },
          "run.failed": { setting: "notifAgentFailure", titleKey: "SettingsText.AgentFailure" },
          "review.completed": {
            setting: "notifReviewComplete",
            titleKey: "SettingsText.ReviewComplete",
          },
          "validation.completed": {
            setting: "notifValidationComplete",
            titleKey: "SettingsText.ValidationComplete",
          },
          "integration.completed": {
            setting: "notifIntegrationReady",
            titleKey: "SettingsText.IntegrationReady",
          },
        };
        const notificationRule = notificationRules[workflowEvent.type];
        if (notificationRule) pushRuntimeNotification(notificationRule, workflowEvent.type);
        const activity = runtimeEventToTimelineActivity({
          id: workflowEvent.id,
          type: workflowEvent.type,
          role: workflowEvent.role,
          runId: workflowEvent.runId,
          sequence: workflowEvent.sequence,
          payload: payload && typeof payload === "object" ? payload : {},
        });
        if (activity)
          setTimelineMessages((messages) =>
            messages.some((message) => message.id === activity.id)
              ? messages
              : [...messages, activity],
          );
        if (workflowEvent.changeRequestId) setRuntimeChangeRequestId(workflowEvent.changeRequestId);
        if (workflowEvent.type === "approval.requested")
          setPermissionRequest(payload.permissionRequest || payload);
        if (workflowEvent.type === "approval.resolved") setPermissionRequest(null);
        if (workflowEvent.type === "run.started") {
          setSending(true);
          setActiveRunId(workflowEvent.runId);
          setFailedRunId(null);
        }
        if (workflowEvent.type === "run.completed" || workflowEvent.type === "run.cancelled") {
          setSending(false);
          setActiveRunId(null);
          setFailedRunId(workflowEvent.runId);
        }
        if (workflowEvent.type === "run.failed") {
          setSending(false);
          setActiveRunId(null);
          setFailedRunId(workflowEvent.runId);
        }
        if (workflowEvent.type === "debug.started") setDebugRunning(true);
        if (workflowEvent.type === "debug.stopped" || workflowEvent.type === "debug.exited")
          setDebugRunning(false);
        if (workflowEvent.type === "message.delta") {
          runtimeStreamSeenRef.current = true;
          const messageId = streamMessageRef.current || `runtime-agent-${Date.now()}`;
          streamMessageRef.current = messageId;
          setTimelineMessages((messages) =>
            messages.some((message) => message.id === messageId)
              ? messages.map((message) =>
                  message.id === messageId
                    ? { ...message, text: `${message.text}${payload.text || ""}`, streaming: true }
                    : message,
                )
              : [
                  ...messages,
                  { id: messageId, role: "agent", text: payload.text || "", streaming: true },
                ],
          );
        }
        if (workflowEvent.type === "message.completed") {
          const messageId = streamMessageRef.current;
          const escalation = parseEscalationRequest(payload.text);
          const finalText = escalation ? stripEscalationMarker(payload.text) : payload.text;
          if (messageId)
            setTimelineMessages((messages) =>
              messages.map((message) =>
                message.id === messageId
                  ? { ...message, text: finalText || message.text, streaming: false }
                  : message,
              ),
            );
          streamMessageRef.current = null;
          if (escalation) setPendingEscalation(escalation);
        }
        if (
          [
            "specification.produced",
            "patchset.created",
            "validation.completed",
            "review.completed",
            "integration.completed",
            "run.completed",
            "run.failed",
            "run.cancelled",
            "run.retried",
            "session.resumed",
          ].includes(workflowEvent.type)
        ) {
          void typedBridge
            .status()
            .then(applyRuntimeStatus)
            .catch(() => undefined);
        }
      });
      typedBridge
        .status()
        .then((status) => {
          const runtimeStatus = status as RuntimeStatus;
          applyRuntimeStatus(runtimeStatus);
          setPermissionRequest(
            runtimeStatus.permissions?.find((request) => request.status === "Pending") || null,
          );
          setLocalizedRuntimeState("Runtime.Connected");
        })
        .catch(() => setLocalizedRuntimeState("Runtime.Unavailable"));
    } catch {
      setLocalizedRuntimeState("Runtime.Unavailable");
    }
    };
    void run();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        composerRef.current?.focus();
      }
      if (modifier && event.key.toLowerCase() === "i") {
        event.preventDefault();
        setInspectorOpen((open) => !open);
      }
      if (modifier && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      }
      if (modifier && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void newConversation();
      }
      if (modifier && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setSidebarOpen(true);
        window.requestAnimationFrame(() => conversationSearchRef.current?.focus());
      }
      if (modifier && /^[1-5]$/.test(event.key)) {
        event.preventDefault();
        setTab(["Overview", "Tasks", "Agents", "Changes", "Review"][Number(event.key) - 1]);
      }
      if (modifier && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        if (commandPaletteOpen) setCommandPaletteOpen(false);
        else if (sending) void stopActiveRun();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandPaletteOpen, sending]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("agentflow.settings.v1");
      if (stored) setSettings((current) => ({ ...current, ...JSON.parse(stored) }));
    } catch {
      /* corrupted renderer settings fall back to safe defaults */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("agentflow.settings.v1", JSON.stringify(settings));
    } catch {
      /* storage is optional */
    }
  }, [settings]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "agentflow.pinned-conversations.v1",
        JSON.stringify(pinnedConversationIds),
      );
    } catch {
      /* pinning is optional renderer state */
    }
  }, [pinnedConversationIds]);

  useEffect(() => {
    if (!bridge || !settingsHydratedRef.current) return;
    let cancelled = false;
    void bridge
      .saveSettings(uiSettingsToRuntime(settings))
      .then(() => bridge.status())
      .then((status) => {
        if (!cancelled) setRuntimeData(status);
      })
      .catch((error) => {
        if (!cancelled) {
          setLocalizedRuntimeState("Runtime.RequestFailed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, settings]);

  useEffect(() => {
    if (!bridge || !activeProject) {
      setRepositoryStatus(null);
      return undefined;
    }
    let cancelled = false;
    void bridge
      .projectStatus(activeProject)
      .then((status) => {
        if (!cancelled) setRepositoryStatus(status);
      })
      .catch(() => {
        if (!cancelled) setRepositoryStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, activeProject]);

  const probeProfiles = async () => {
    if (!bridge) {
      setLocalizedRuntimeState("Runtime.Unavailable");
      return;
    }
    setLocalizedRuntimeState("Runtime.ProbingAdapters");
    try {
      await bridge.probeProfiles();
      setRuntimeData(await bridge.status());
      setLocalizedRuntimeState("Runtime.AdaptersProbed");
    } catch (error) {
      setLocalizedRuntimeState("Runtime.AdapterProbeFailed", { error: error.message });
    }
  };

  const exportDiagnostics = () => {
    const snapshot = {
      exportedAt: new Date().toISOString(),
      runtimeState,
      settings: uiSettingsToRuntime(settings),
      runtime: runtimeData,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `agentflow-diagnostics-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const resetLayout = () => {
    setInspectorOpen(true);
    setTab("Overview");
    setSettingsSection("general");
    setSettingsSearch("");
    setSetting("inspectorWidth", defaultUiSettings.inspectorWidth);
  };

  const resetAllSettings = () => {
    if (
      globalThis.confirm &&
      !globalThis.confirm(t(locale, "SettingsText.ResetAllSettingsConfirmation"))
    )
      return;
    setSettings({ ...defaultUiSettings });
  };

  const sendMessage = () => {
    const text = composerText.trim();
    if (!text || sending) return;
    if (text.startsWith("/") && executeSlashCommand(text)) return;
    if (!bridge || !runtimeConversationId) {
      setLocalizedRuntimeState("Runtime.OpenConversationBeforeSend");
      return;
    }
    const submittedText = contextAttachments.length
      ? `${text}\n\n${t(locale, "Composer.ContextFiles")}:\n${contextAttachments.map((file) => `- ${file}`).join("\n")}`
      : text;
    const userId = `local-user-${Date.now()}`;
    setTimelineMessages((messages) => [
      ...messages,
      { id: userId, role: "user", text: submittedText },
    ]);
    setComposerText("");
    setContextAttachments([]);
    setSending(true);
    streamMessageRef.current = null;
    runtimeStreamSeenRef.current = false;
    lastUserTextRef.current = text;
    bridge
      .sendMessage(runtimeConversationId, submittedText, modeToRuntimeMode[mode] || "Ask", {
        ...selectedAdapter,
        intent: mode === "Build" ? "build" : undefined,
        permissionProfile: effectivePermissionProfile,
      })
      .then((rawResult) => {
        const result = rawResult as { changeRequestId?: string; text?: string };
        if (result?.changeRequestId) setRuntimeChangeRequestId(result.changeRequestId);
        if (result?.text && !runtimeStreamSeenRef.current) {
          const escalation = parseEscalationRequest(result.text);
          setTimelineMessages((messages) => [
            ...messages,
            {
              id: `runtime-result-${Date.now()}`,
              role: "agent",
              text: escalation ? stripEscalationMarker(result.text) : result.text,
              streaming: false,
            },
          ]);
          if (escalation) setPendingEscalation(escalation);
        }
        setSending(false);
      })
      .catch((error) => {
        setLocalizedRuntimeState("Runtime.RequestFailed", { error: error.message });
        setSending(false);
      });
  };

  const resolveEscalation = (approve) => {
    const request = pendingEscalation;
    setPendingEscalation(null);
    if (!approve || !request || !bridge || !runtimeConversationId) return;
    const nextMode = request.capability === "workers" ? "Plan" : "Build";
    setSending(true);
    streamMessageRef.current = null;
    runtimeStreamSeenRef.current = false;
    bridge
      .sendMessage(
        runtimeConversationId,
        lastUserTextRef.current,
        modeToRuntimeMode[nextMode] || "Implement",
        {
          ...selectedAdapter,
          intent: nextMode === "Build" ? "build" : undefined,
          permissionProfile: "Workspace Write",
        },
      )
      .then((rawResult) => {
        const result = rawResult as { changeRequestId?: string; text?: string };
        if (result?.changeRequestId) setRuntimeChangeRequestId(result.changeRequestId);
        if (result?.text && !runtimeStreamSeenRef.current)
          setTimelineMessages((messages) => [
            ...messages,
            {
              id: `runtime-result-${Date.now()}`,
              role: "agent",
              text: result.text,
              streaming: false,
            },
          ]);
        setSending(false);
      })
      .catch((error) => {
        setLocalizedRuntimeState("Runtime.RequestFailed", { error: error.message });
        setSending(false);
      });
  };

  const attachContextFiles = async () => {
    const project = runtimeData?.projects?.find((item) => item.id === activeProject);
    if (!project || !bridge) {
      setRuntimeState(t(locale, "Composer.NoRepositoryForAttachment"));
      return;
    }
    let selected;
    try {
      selected = await bridge.pickContextFiles(project.repositoryPath);
    } catch {
      setRuntimeState(t(locale, "Composer.AttachmentSelectionFailed"));
      return;
    }
    const paths = Array.isArray(selected) ? selected : [];
    const root = String(project.repositoryPath || "")
      .replaceAll("\\", "/")
      .replace(/\/+$/, "");
    const windowsPath = globalThis.navigator?.userAgent.toLowerCase().includes("windows");
    const comparableRoot = windowsPath ? root.toLowerCase() : root;
    const relativePaths = paths
      .map((candidate) => String(candidate).replaceAll("\\", "/"))
      .filter((candidate) => {
        const comparable = windowsPath ? candidate.toLowerCase() : candidate;
        return comparable.startsWith(`${comparableRoot}/`);
      })
      .map((candidate) => candidate.slice(root.length + 1))
      .filter(Boolean);
    if (relativePaths.length !== paths.length) {
      setRuntimeState(t(locale, "Composer.AttachmentOutsideRepository"));
    }
    setContextAttachments((current) => [...new Set([...current, ...relativePaths])]);
  };

  const openProject = async () => {
    if (!bridge) {
      setLocalizedRuntimeState("Runtime.CannotOpenRepository");
      return;
    }
    try {
      const selected = await bridge.pickRepository(settings.defaultProjectDirectory || undefined);
      const repositoryPath = typeof selected === "string" ? selected : null;
      if (!repositoryPath) return;
      const opened = (await bridge.openProject(repositoryPath)) as { id: string; name: string };
      const conversation = (await bridge.createConversation(
        opened.id,
        `${labels.newConversation} · AgentFlow`,
        modeToRuntimeMode[mode] || "Ask",
      )) as { id: string };
      setActiveProject(opened.id);
      setRuntimeConversationId(conversation.id);
      const status = await bridge.status();
      setRuntimeData(status);
      setLocalizedRuntimeState("Runtime.OpenedProject", { project: opened.name });
    } catch (error) {
      setLocalizedRuntimeState("Runtime.OpenProjectFailed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const chooseDefaultProjectDirectory = async () => {
    if (!bridge) return;
    try {
      const selected = await bridge.pickDefaultProjectDirectory();
      if (typeof selected === "string") {
        setSetting("defaultProjectDirectory", selected);
        setLocalizedRuntimeState("Runtime.DefaultProjectDirectorySet", { path: selected });
      }
    } catch (error) {
      setLocalizedRuntimeState("Runtime.DefaultProjectDirectoryFailed", { error: error.message });
    }
  };

  const executeSlashCommand = (input) => {
    const { command, argument } = parseSlashCommand(input);
    if (!command) return false;
    if (command.kind === "mode" && command.mode) {
      setMode(command.mode);
      setComposerText(argument);
      setLocalizedRuntimeState("Runtime.ModeSet", { mode: command.mode });
      return true;
    }
    if (command.kind === "status") {
      setTab("Overview");
      setComposerText("");
      if (bridge && activeProject) {
        void bridge
          .projectStatus(activeProject)
          .then(setRepositoryStatus)
          .then(() => setLocalizedRuntimeState("Runtime.RepositoryStatusRefreshed"))
          .catch((error) =>
            setLocalizedRuntimeState("Runtime.RepositoryStatusFailed", { error: error.message }),
          );
      } else setLocalizedRuntimeState("Runtime.RepositoryStatusUnavailable");
      return true;
    }
    if (command.kind === "integrate") {
      setTab("Changes");
      setComposerText("");
      setLocalizedRuntimeState("Runtime.IntegrationAvailable");
      return true;
    }
    return false;
  };

  const newConversation = async () => {
    setTimelineMessages([]);
    setContextAttachments([]);
    setRuntimeChangeRequestId(null);
    if (
      bridge &&
      activeProject &&
      runtimeData?.projects?.some((item) => item.id === activeProject)
    ) {
      try {
        const conversation = (await bridge.createConversation(
          activeProject,
          `${labels.newConversation} · AgentFlow`,
          modeToRuntimeMode[mode] || "Ask",
        )) as { id: string };
        setRuntimeConversationId(conversation.id);
        setLocalizedRuntimeState("Runtime.NewConversationReady");
      } catch (error) {
        setLocalizedRuntimeState("Runtime.NewConversationFailed", { error: error.message });
      }
    } else setLocalizedRuntimeState("Runtime.OpenRepositoryBeforeNewConversation");
  };

  const resolvePermission = async (decision) => {
    const activeRequest =
      permissionRequest ||
      runtimeData?.permissions?.find((request) => request.status === "Pending");
    if (bridge && activeRequest?.id) {
      try {
        await bridge.resolvePermission(activeRequest.id, decision);
        setPermissionRequest(null);
        setLocalizedRuntimeState("Runtime.PermissionResolved", {
          decision: decision.replaceAll("-", " "),
        });
      } catch (error) {
        setLocalizedRuntimeState("Runtime.PermissionResolutionFailed", { error: error.message });
      }
      return;
    }
    setLocalizedRuntimeState("Runtime.NoPendingPermission");
  };
  const stopActiveRun = async () => {
    if (bridge && activeRunId) {
      try {
        await bridge.stopRun(activeRunId);
        setLocalizedRuntimeState("Runtime.RunStopRequested");
      } catch (error) {
        setLocalizedRuntimeState("Runtime.RunStopFailed", { error: error.message });
      }
    } else {
      setLocalizedRuntimeState("Runtime.NoActiveRun");
    }
    // Stop must always hand control back to the composer, even if the
    // matching run.cancelled/run.completed event never arrives (dropped
    // event, already-finished run, backend abort race). Otherwise the
    // send button stays stuck showing Stop with no way to type again.
    setSending(false);
    setActiveRunId(null);
  };
  const retryFailedRun = async (resume) => {
    if (!bridge || !failedRunId) return;
    try {
      setSending(true);
      setFailedRunId(null);
      const rawResult = resume
        ? await bridge.resumeRun(failedRunId)
        : await bridge.retryRun(failedRunId);
      const result = rawResult as { text?: string };
      if (result?.text && !runtimeStreamSeenRef.current)
        setTimelineMessages((messages) => [
          ...messages,
          { id: `retry-result-${Date.now()}`, role: "agent", text: result.text, streaming: false },
        ]);
    } catch (error) {
      setLocalizedRuntimeState("Runtime.RetryFailed", { error: error.message });
      setSending(false);
    }
  };
  const approvePlan = async (action) => {
    if (bridge && runtimeChangeRequestId) {
      try {
        const changeRequest = (await bridge.approvePlan(runtimeChangeRequestId, action)) as {
          state?: string;
        };
        if (action === "approve-and-run") {
          setLocalizedRuntimeState("Runtime.PlanApproved");
          await bridge.runReadyTasks(runtimeChangeRequestId, {
            ...selectedAdapter,
            permissionProfile: effectivePermissionProfile,
          });
        }
        const status = await bridge.status();
        setRuntimeData(status);
        setLocalizedRuntimeState("Runtime.PlanState", { state: changeRequest.state });
        return;
      } catch (error) {
        setLocalizedRuntimeState("Runtime.PlanApprovalFailed", { error: error.message });
        return;
      }
    }
    setLocalizedRuntimeState("Runtime.PlanActionUnavailable");
  };

  const toggleMenu = (name) => setOpenMenu(openMenu === name ? null : name);

  const projectList = runtimeData
    ? runtimeData.projects.map((item) => ({
        id: item.id,
        name: item.name,
        branch: item.defaultBranch,
        convCount: runtimeData.conversations.filter(
          (conversation) => conversation.projectId === item.id,
        ).length,
      }))
    : [];
  const project = projectList.find((item) => item.id === activeProject) || projectList[0];
  const conversationRows = runtimeData
    ? runtimeData.conversations
        .filter((conversation) => conversation.projectId === activeProject)
        .map((conversation) => {
          const runs = runtimeData.runs.filter((run) => run.conversationId === conversation.id);
          const activeRuns = runs.filter((run) =>
            ["Queued", "Running", "WaitingApproval"].includes(run.state),
          );
          const latestRun = runs.at(-1);
          const changeRequest = runtimeData.changeRequests.find(
            (candidate) => candidate.conversationId === conversation.id,
          );
          const status = activeRuns.length
            ? t(
                locale,
                activeRuns.length === 1 ? "Status.AgentRunningOne" : "Status.AgentsRunningMany",
                { count: activeRuns.length },
              )
            : localizedStatus(locale, changeRequest?.state || latestRun?.state || "Idle");
          const statusTone = activeRuns.length
            ? "accent"
            : ["Failed", "Cancelled"].includes(latestRun?.state)
              ? "danger"
              : ["Completed", "IntegrationReady"].includes(changeRequest?.state)
                ? "success"
                : changeRequest
                  ? "warning"
                  : "muted";
          return {
            id: conversation.id,
            project: conversation.projectId,
            title: conversation.title,
            archived: Boolean(conversation.archivedAt),
            pinned: pinnedConversationIds.includes(conversation.id),
            status,
            statusTone,
            time: relativeTime(locale, conversation.updatedAt),
          };
        })
    : [];
  const normalizedConversationQuery = conversationQuery.trim().toLowerCase();
  const visibleConversations = conversationRows
    .filter((conversation) =>
      conversationFilter === "archived"
        ? conversation.archived
        : conversationFilter === "pinned"
          ? conversation.pinned && !conversation.archived
          : !conversation.archived,
    )
    .filter(
      (conversation) =>
        !normalizedConversationQuery ||
        conversation.title.toLowerCase().includes(normalizedConversationQuery),
    )
    .sort((left, right) => Number(right.pinned) - Number(left.pinned));
  const togglePinnedConversation = (conversationId) => {
    setPinnedConversationIds((ids) =>
      ids.includes(conversationId)
        ? ids.filter((id) => id !== conversationId)
        : [...ids, conversationId],
    );
  };
  const selectConversation = (conversationId) => {
    setRuntimeConversationId(conversationId);
    setContextAttachments([]);
    setRuntimeChangeRequestId(
      runtimeData?.changeRequests.find(
        (changeRequest) => changeRequest.conversationId === conversationId,
      )?.id || null,
    );
    setTimelineMessages(
      replayRuntimeTimeline(
        runtimeData?.events?.filter((event) => event.conversationId === conversationId),
      ),
    );
    setLocalizedRuntimeState("Runtime.ConversationSelected", { conversation: conversationId });
  };
  const selectProject = async (projectId) => {
    if (projectId === activeProject && runtimeConversationId) {
      setOpenMenu(null);
      return;
    }
    const conversation = runtimeData?.conversations
      .filter((item) => item.projectId === projectId)
      .at(-1);
    setActiveProject(projectId);
    setContextAttachments([]);
    setRuntimeChangeRequestId(null);
    setOpenMenu(null);
    if (conversation) {
      selectConversation(conversation.id);
      return;
    }
    if (!bridge) {
      setRuntimeConversationId(null);
      setTimelineMessages([]);
      setLocalizedRuntimeState("Runtime.OpenConversationBeforeSend");
      return;
    }
    try {
      const created = (await bridge.createConversation(
        projectId,
        `${labels.newConversation} · AgentFlow`,
        modeToRuntimeMode[mode] || "Ask",
      )) as { id: string };
      setRuntimeConversationId(created.id);
      setRuntimeData(await bridge.status());
      setLocalizedRuntimeState("Runtime.NewConversationReady");
    } catch (error) {
      setRuntimeConversationId(null);
      setTimelineMessages([]);
      setLocalizedRuntimeState("Runtime.NewConversationFailed", { error: error.message });
    }
  };
  const discoveredModels = (runtimeData?.models || []).filter((item) => item.adapterId !== "fake");
  const modelAdapterNames = {
    codex: "Codex CLI",
    claude: "Claude Code",
    "grok-build": "Grok Build",
    opencode: "OpenCode",
  };
  const modelProviderLabel = (item) => {
    const adapterLabel = modelAdapterNames[item.adapterId] || item.adapterId;
    return item.providerId && item.providerId !== item.adapterId
      ? `${adapterLabel} · ${item.providerId}`
      : adapterLabel;
  };
  const modelStatusLabel = (item) =>
    item.cliDefault
      ? t(locale, "Model.CliDefault")
      : item.verified
        ? t(locale, "Model.Verified")
        : t(locale, "Model.ManualUnverified");
  const modelOptions = [
    {
      id: "auto",
      label: t(locale, "Model.AutoBalanced"),
      sub: t(locale, "Model.RoutesVerified"),
    },
    ...discoveredModels.map((item) => {
      const meta = lookupModelMeta(item.providerModelId ?? item.id);
      return {
        id: item.id,
        label: meta?.label ?? item.name,
        sub: `${modelProviderLabel(item)} · ${modelStatusLabel(item)}`,
        vision: Boolean(meta?.vision),
        model: item,
      };
    }),
  ];
  const modelGroups = Object.entries(
    modelOptions
      .filter((item) => item.id !== "auto")
      .reduce<
        Record<string, { id: string; label: string; models: Array<(typeof modelOptions)[number]> }>
      >((groups, item) => {
        const groupId = `${item.model.adapterId}:${item.model.providerId || item.model.adapterId}`;
        const group = groups[groupId] || {
          id: groupId,
          label: modelProviderLabel(item.model),
          models: [],
        };
        group.models.push(item);
        groups[groupId] = group;
        return groups;
      }, {}),
  ).map(([, group]) => group);
  const currentModel = modelOptions.find((item) => item.id === model) || modelOptions[0];
  const currentPermission =
    permissionOptions.find((p) => p.id === permission) || permissionOptions[0];
  const readOnlyMode = ["Explore", "Plan"].includes(mode);
  const effectivePermission = readOnlyMode ? permissionOptions[0] : currentPermission;
  const effectivePermissionProfile = effectivePermission.label;
  const selectedModel = currentModel.model;
  const selectedProfile = selectedModel
    ? runtimeData?.profiles.find((profile) => profile.adapterId === selectedModel.adapterId)
    : undefined;
  const selectedAdapter = selectedModel
    ? {
        adapterId: selectedModel.adapterId,
        profileId: selectedProfile?.id,
        modelId: selectedModel.id,
      }
    : undefined;
  const selectModel = (modelId) => {
    setModel(modelId);
    setOpenMenu(null);
    try {
      if (modelId === "auto") {
        globalThis.localStorage?.removeItem("agentflow.selected-model.v1");
      } else {
        globalThis.localStorage?.setItem("agentflow.selected-model.v1", modelId);
      }
    } catch {
      // Local storage is optional in embedded/browser preview contexts.
    }
  };
  const displayTasks = runtimeData
    ? runtimeData.tasks.map((task) => ({
        taskId: task.id,
        id: task.key,
        title: task.title,
        dependencies: task.dependencyIds,
        assignedAgent: runtimeData.runs.find((run) => run.taskId === task.id)?.role,
        worktree: runtimeData.workspaces?.find((workspace) => workspace.taskId === task.id)?.path,
        validation: runtimeData.validations?.find((validation) => validation.taskId === task.id)
          ?.status,
        review: runtimeData.reviews?.find((review) => review.taskId === task.id)?.verdict,
        status: task.state,
        tone: ["Completed", "Approved", "Integrated", "PatchProduced"].includes(task.state)
          ? "success"
          : ["Failed", "Cancelled", "ValidationFailed"].includes(task.state)
            ? "danger"
            : ["Running", "Leased", "ReviewRequested"].includes(task.state)
              ? "accent"
              : "muted",
      }))
    : [];
  const displayRuns = runtimeData
    ? runtimeData.runs.map((run) => ({
        name: `${run.role} · ${run.id.slice(-8)}`,
        role: run.taskId || run.role,
        detail: run.state,
        time: run.completedAt ? "done" : "live",
        tone: ["Completed"].includes(run.state)
          ? "success"
          : ["Failed", "Cancelled"].includes(run.state)
            ? "danger"
            : "accent",
      }))
    : [];
  const displayPatchSets = runtimeData ? runtimeData.patchSets : [];
  const displayReviews = runtimeData ? runtimeData.reviews : [];
  const displayFindings = runtimeData ? runtimeData.findings || [] : [];
  const blockingFindingsCount = displayFindings.filter(
    (finding) => finding.severity === "Blocking",
  ).length;
  const patchSetsAwaitingReview = displayPatchSets.filter(
    (patchSet) => patchSet.reviewState === "Pending" || patchSet.reviewState === "ChangesRequested",
  );
  const currentProject = runtimeData?.projects?.find((item) => item.id === activeProject);
  const tabs = [
    "Overview",
    ...(displayTasks.length ? ["Tasks"] : []),
    ...(displayRuns.length ? ["Agents"] : []),
    ...(displayPatchSets.length ? ["Changes"] : []),
    ...(displayFindings.length || displayReviews.length || currentProject?.debugCommand
      ? ["Review"]
      : []),
  ];
  useEffect(() => {
    if (!tabs.includes(tab)) setTab("Overview");
  }, [tabs.join("|"), tab]);
  const currentChangeRequest = runtimeData?.changeRequests.find(
    (item) => item.id === runtimeChangeRequestId,
  );
  const updateDebugCommand = async (debugCommand) => {
    if (!bridge || !currentProject) return;
    try {
      await bridge.updateProject(currentProject.id, { debugCommand });
      setRuntimeData(await bridge.status());
    } catch (error) {
      setLocalizedRuntimeState("Runtime.RequestFailed", { error: error.message });
    }
  };
  const startDebug = async () => {
    if (!bridge || !currentProject) return;
    try {
      await bridge.startDebugProcess(currentProject.id);
    } catch (error) {
      setLocalizedRuntimeState("Runtime.RequestFailed", { error: error.message });
    }
  };
  const stopDebug = async () => {
    if (!bridge || !currentProject) return;
    try {
      await bridge.stopDebugProcess(currentProject.id);
    } catch (error) {
      setLocalizedRuntimeState("Runtime.RequestFailed", { error: error.message });
    }
  };
  const currentSpecification = currentChangeRequest?.specificationRevisionId
    ? runtimeData?.specifications.find(
        (item) => item.id === currentChangeRequest.specificationRevisionId,
      )
    : undefined;
  const currentPlanTasks = currentChangeRequest
    ? runtimeData?.tasks.filter((task) => task.changeRequestId === currentChangeRequest.id) || []
    : [];
  const currentRoutingDecision = runtimeData?.events
    ?.filter(
      (event) =>
        event.type === "routing.decided" &&
        (!runtimeChangeRequestId || event.changeRequestId === runtimeChangeRequestId),
    )
    .at(-1)?.payload;
  const workflowPhase =
    currentChangeRequest?.state
      ? localizedStatus(locale, currentChangeRequest.state)
      : t(locale, "Inspector.NoActiveChangeRequest");
  const completedTaskCount = displayTasks.filter((task) =>
    ["Completed", "Approved", "Integrated"].includes(task.status),
  ).length;
  const workflowProgress = displayTasks.length
    ? Math.round((completedTaskCount / displayTasks.length) * 100)
    : 0;
  const runTask = async (taskId) => {
    if (!bridge) return;
    try {
      setLocalizedRuntimeState("Runtime.StartingTaskWorktree");
      await bridge.runTask(taskId, {
        ...selectedAdapter,
        permissionProfile: effectivePermissionProfile,
      });
      setRuntimeData(await bridge.status());
    } catch (error) {
      setLocalizedRuntimeState("Runtime.TaskFailed", { error: error.message });
    }
  };
  const runReadyTasks = async () => {
    if (!bridge || !runtimeChangeRequestId) return;
    try {
      setLocalizedRuntimeState("Runtime.StartingReadyTasks");
      await bridge.runReadyTasks(runtimeChangeRequestId, {
        ...selectedAdapter,
        permissionProfile: effectivePermissionProfile,
      });
      setRuntimeData(await bridge.status());
    } catch (error) {
      setLocalizedRuntimeState("Runtime.ParallelTaskFailed", { error: error.message });
    }
  };
  const runValidation = async (patchSetId) => {
    if (!bridge) return;
    try {
      setLocalizedRuntimeState("Runtime.RunningValidation");
      await bridge.runValidation(patchSetId);
      setRuntimeData(await bridge.status());
    } catch (error) {
      setLocalizedRuntimeState("Runtime.ValidationFailed", { error: error.message });
    }
  };
  const startReview = async (patchSetId) => {
    if (!bridge) return;
    try {
      setLocalizedRuntimeState("Runtime.StartingReview");
      await bridge.startReview(patchSetId, selectedAdapter);
      setRuntimeData(await bridge.status());
    } catch (error) {
      setLocalizedRuntimeState("Runtime.ReviewFailed", { error: error.message });
    }
  };
  const sendFindingsToFixer = () => {
    const finding =
      displayFindings.find((item) => item.status !== "Resolved") || displayFindings[0];
    if (!finding) {
      setLocalizedRuntimeState("Runtime.NoReviewFinding");
      return;
    }
    setMode("Build");
    setTab("Overview");
    setComposerText(`Address review finding: ${finding.message}`);
    setLocalizedRuntimeState("Runtime.FixPromptPrepared");
  };
  const openArtifact = async (artifactId) => {
    if (!bridge || !artifactId) return;
    if (openArtifactId === artifactId) {
      setOpenArtifactId(null);
      setArtifactContent(null);
      return;
    }
    setOpenArtifactId(artifactId);
    setArtifactContent(null);
    setArtifactSearch("");
    setArtifactViewMode("unified");
    setArtifactLoading(true);
    try {
      const artifact = await bridge.readArtifact(artifactId);
      setArtifactContent(artifact);
    } catch (error) {
      setLocalizedRuntimeState("Runtime.ArtifactUnavailable", { error: error.message });
    } finally {
      setArtifactLoading(false);
    }
  };
  const copyMessage = useCallback(
    async (text) => {
      try {
        await globalThis.navigator.clipboard.writeText(text);
        setLocalizedRuntimeState("Runtime.MessageCopied");
      } catch {
        setLocalizedRuntimeState("Runtime.ClipboardUnavailable");
      }
    },
    [setLocalizedRuntimeState],
  );
  const integrateApproved = async () => {
    if (!bridge || !runtimeChangeRequestId) return;
    const approvedPatchSets = displayPatchSets
      .filter((patchSet) => patchSet.reviewState === "Approved")
      .map((patchSet) => patchSet.id);
    if (!approvedPatchSets.length) {
      setLocalizedRuntimeState("Runtime.NoPatchSetForIntegration");
      return;
    }
    try {
      setLocalizedRuntimeState("Runtime.ApplyingPatchSets");
      await bridge.integrate(runtimeChangeRequestId, approvedPatchSets);
      setRuntimeData(await bridge.status());
    } catch (error) {
      setLocalizedRuntimeState("Runtime.IntegrationFailed", { error: error.message });
    }
  };
  const approvePatchSet = async (patchSetId) => {
    if (!bridge || !runtimeChangeRequestId) return;
    try {
      setLocalizedRuntimeState("Runtime.ApplyingPatchSets");
      await bridge.integrate(runtimeChangeRequestId, [patchSetId]);
      setRuntimeData(await bridge.status());
    } catch (error) {
      setLocalizedRuntimeState("Runtime.IntegrationFailed", { error: error.message });
    }
  };
  const rejectPatchSet = (patchSetId) => {
    const finding =
      displayFindings.find(
        (item) => item.status !== "Resolved" && (!item.patchSetId || item.patchSetId === patchSetId),
      ) || displayFindings[0];
    setMode("Build");
    setTab("Overview");
    setComposerText(
      finding
        ? `Address review finding: ${finding.message}`
        : `Request changes on PatchSet ${patchSetId}`,
    );
    setLocalizedRuntimeState("Runtime.FixPromptPrepared");
  };
  const preparePullRequest = async () => {
    if (!bridge || !runtimeChangeRequestId) return;
    try {
      const projection = (await bridge.projectPullRequest(runtimeChangeRequestId)) as {
        commits: unknown[];
      };
      setTimelineMessages((messages) => [
        ...messages,
        {
          id: `pr-${Date.now()}`,
          role: "system",
          text: t(locale, "Runtime.PullRequestSummary", { commits: projection.commits.length }),
          streaming: false,
        },
      ]);
      setLocalizedRuntimeState("Runtime.PullRequestReady");
    } catch (error) {
      setLocalizedRuntimeState("Runtime.PullRequestFailed", { error: error.message });
    }
  };
  const selectedAccent = accentColors[settings.accent] || accentColors.Blue;
  const uiFontSize = { Small: 13, Default: 14, Large: 15 }[settings.uiTextSize] || 14;
  const themeVars = {};
  themeVars["--accent"] = selectedAccent;
  themeVars["--accent-dim"] = `${selectedAccent}33`;

  const sectionLabel = (section) => t(locale, section.key);
  const filteredSections = settingsSections.filter((s) =>
    sectionLabel(s).toLowerCase().includes(settingsSearch.toLowerCase()),
  );
  const activeSectionMeta = settingsSections.find((s) => s.id === settingsSection);
  const conversationFilters: Array<
    [string, string, React.ComponentType<Record<string, unknown>> | null]
  > = [
    ["pinned", labels.pinned, Pin],
    ["recent", labels.recent, null],
    ["archived", labels.archived, Archive],
  ];

  return (
    <div
      className={`af ${settings.theme === "System" ? "af-system" : ""} ${
        settings.theme === "Light" ? "af-light" : ""
      } ${settings.reducedMotion ? "af-reduced-motion" : ""} ${settings.highContrastFocus ? "af-high-contrast" : ""}`}
      style={{
        ...themeVars,
        height: "100vh",
        display: "flex",
        overflow: "hidden",
        fontSize: uiFontSize,
      }}
      onClick={() => openMenu && setOpenMenu(null)}
    >
      {settings.screenReaderAnnouncements && (
        <div
          aria-live="polite"
          aria-atomic="true"
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            margin: -1,
            overflow: "hidden",
            clip: "rect(0, 0, 0, 0)",
            whiteSpace: "nowrap",
            border: 0,
          }}
        >
          {runtimeState}
        </div>
      )}

      {settings.inAppNotif && inAppNotifications.length > 0 && (
        <div
          aria-label={t(locale, "SettingsText.InAppNotifications")}
          style={{
            position: "fixed",
            top: 14,
            right: 14,
            zIndex: 20,
            display: "grid",
            gap: 8,
            width: 300,
          }}
        >
          {inAppNotifications.map((notification) => (
            <div
              key={notification.id}
              role="status"
              style={{
                background: "var(--elevated)",
                border: "1px solid var(--border-strong)",
                borderLeft: "3px solid var(--accent)",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
                padding: "10px 12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <Bell size={14} color="var(--accent)" style={{ marginTop: 2, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{notification.title}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3 }}>
                    {notification.body}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t(locale, "Notification.Dismiss")}
                  onClick={() =>
                    setInAppNotifications((current) =>
                      current.filter((item) => item.id !== notification.id),
                    )
                  }
                  style={{ ...btnGhost, border: "none", padding: 2 }}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConversationSidebar
        sidebarOpen={sidebarOpen}
        locale={locale}
        labels={labels}
        openMenu={openMenu}
        toggleMenu={toggleMenu}
        setOpenMenu={setOpenMenu}
        project={project}
        projectList={projectList}
        activeProject={activeProject}
        setActiveProject={selectProject}
        openProject={openProject}
        canOpenProject={Boolean(bridge)}
        openProjectUnavailableReason={
          bridge ? undefined : t(locale, "Runtime.CannotOpenRepository")
        }
        conversationSearchRef={conversationSearchRef}
        conversationQuery={conversationQuery}
        setConversationQuery={setConversationQuery}
        newConversation={newConversation}
        conversationFilters={conversationFilters}
        conversationFilter={conversationFilter}
        setConversationFilter={setConversationFilter}
        visibleConversations={visibleConversations}
        runtimeConversationId={runtimeConversationId}
        selectConversation={selectConversation}
        togglePinnedConversation={togglePinnedConversation}
        setSettingsOpen={setSettingsOpen}
      />

      {/* CENTER: conversation */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          background: "var(--conversation)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "12px 20px",
            borderBottom: "1px solid var(--border-subtle)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              {currentChangeRequest?.title ||
                (runtimeConversationId
                  ? t(locale, "Navigation.AgentFlowConversation")
                  : t(locale, "Navigation.NoConversationSelected"))}
            </div>
            <div
              className="af-mono"
              style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}
            >
              {currentChangeRequest
                ? `${currentChangeRequest.id} · ${currentChangeRequest.integrationBranch || t(locale, "Runtime.IntegrationBranchPending")}`
                : runtimeConversationId
                  ? t(locale, "Runtime.ConversationId", { conversation: runtimeConversationId })
                  : t(locale, "Navigation.OpenRepositoryToBegin")}
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setInspectorOpen(!inspectorOpen);
            }}
            style={{ ...btnGhost, display: "flex", alignItems: "center", gap: 6 }}
          >
            {inspectorOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}{" "}
            {labels.inspector}
          </button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 18,
          }}
        >
          {!runtimeData && (
            <div style={{ color: "var(--text-muted)", fontSize: 13.5, padding: "24px 14px" }}>
              {t(locale, "Navigation.OpenRepositoryToLoad")}
            </div>
          )}
          {runtimeData && !timelineMessages.length && (
            <div style={{ color: "var(--text-muted)", fontSize: 13.5, padding: "24px 14px" }}>
              {t(locale, "Navigation.NoMessages")}
            </div>
          )}
          <VirtualTimeline
            messages={timelineMessages}
            onCopy={copyMessage}
            copyLabel={labels.copy}
            jumpLabel={labels.jumpToLatest}
            timelineLabel={labels.timeline}
            locale={locale}
          />
          {currentChangeRequest?.state === "AwaitingSpecApproval" && currentSpecification && (
            <PlanApprovalCard
              labels={labels}
              locale={locale}
              onApprove={() => approvePlan("approve-and-run")}
              onRequestChanges={() => approvePlan("request-changes")}
              onOpenPlan={() => {
                setInspectorOpen(true);
                setTab("Tasks");
              }}
              specification={currentSpecification}
              tasks={currentPlanTasks}
            />
          )}
          {(permissionRequest ||
            runtimeData?.permissions?.find((request) => request.status === "Pending")) && (
            <PermissionRequestCard
              onResolve={resolvePermission}
              locale={locale}
              request={
                permissionRequest ||
                runtimeData.permissions.find((request) => request.status === "Pending")
              }
            />
          )}
          {pendingEscalation && (
            <EscalationRequestCard
              request={pendingEscalation}
              onResolve={resolveEscalation}
              locale={locale}
            />
          )}
        </div>

        <Composer
          locale={locale}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          mode={mode}
          setMode={setMode}
          permission={permission}
          setPermission={setPermission}
          currentModel={currentModel}
          model={model}
          modelGroups={modelGroups}
          hasAuto={modelOptions.some((item) => item.id === "auto")}
          selectModel={selectModel}
          contextAttachments={contextAttachments}
          setContextAttachments={setContextAttachments}
          attachContextFiles={attachContextFiles}
          composerRef={composerRef}
          composerText={composerText}
          setComposerText={setComposerText}
          sendMessage={sendMessage}
          sending={sending}
          stopActiveRun={stopActiveRun}
          bridge={bridge}
          runtimeConversationId={runtimeConversationId}
          runtimeState={runtimeState}
          failedRunId={failedRunId}
          retryFailedRun={retryFailedRun}
          runtimeData={runtimeData}
        />
      </div>

      <InspectorPanel
        inspectorOpen={inspectorOpen}
        tabs={tabs}
        tab={tab}
        setTab={setTab}
        locale={locale}
        bridge={bridge}
        runtimeChangeRequestId={runtimeChangeRequestId}
        integrateApproved={integrateApproved}
        preparePullRequest={preparePullRequest}
        workflowPhase={workflowPhase}
        workflowProgress={workflowProgress}
        completedTaskCount={completedTaskCount}
        displayTasks={displayTasks}
        displayReviews={displayReviews}
        currentModel={currentModel}
        effectivePermission={effectivePermission}
        currentChangeRequest={currentChangeRequest}
        currentRoutingDecision={currentRoutingDecision}
        repositoryStatus={repositoryStatus}
        runtimeData={runtimeData}
        runReadyTasks={runReadyTasks}
        runTask={runTask}
        displayRuns={displayRuns}
        displayPatchSets={displayPatchSets}
        artifactContent={artifactContent}
        openArtifact={openArtifact}
        openArtifactId={openArtifactId}
        runValidation={runValidation}
        startReview={startReview}
        artifactLoading={artifactLoading}
        artifactSearch={artifactSearch}
        setArtifactSearch={setArtifactSearch}
        artifactViewMode={artifactViewMode}
        setArtifactViewMode={setArtifactViewMode}
        displayFindings={displayFindings}
        sendFindingsToFixer={sendFindingsToFixer}
        blockingFindingsCount={blockingFindingsCount}
        patchSetsAwaitingReview={patchSetsAwaitingReview}
        approvePatchSet={approvePatchSet}
        rejectPatchSet={rejectPatchSet}
        width={settings.inspectorWidth}
        onResizeWidth={(value) => setSetting("inspectorWidth", value)}
        currentProject={currentProject}
        updateDebugCommand={updateDebugCommand}
        debugRunning={debugRunning}
        startDebug={startDebug}
        stopDebug={stopDebug}
      />

      {/* SETTINGS overlay */}
      {commandPaletteOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t(locale, "Navigation.CommandPalette")}
          onClick={() => setCommandPaletteOpen(false)}
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 70,
            background: "var(--overlay-scrim)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            paddingTop: 88,
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 440,
              maxWidth: "calc(100vw - 32px)",
              background: "var(--elevated)",
              border: "1px solid var(--border-strong)",
              borderRadius: 10,
              boxShadow: "0 20px 70px var(--shadow-color)",
              padding: 8,
            }}
          >
            <div style={{ padding: "10px 12px", color: "var(--text-muted)", fontSize: 11 }}>
              {t(locale, "CommandPalette.Title")} · Ctrl/Cmd+Shift+P
            </div>
            {[
              {
                label: t(locale, "CommandPalette.FocusComposer"),
                run: () => composerRef.current?.focus(),
              },
              {
                label: labels.newConversation,
                run: newConversation,
              },
              {
                label: t(locale, "CommandPalette.ToggleInspector"),
                run: () => setInspectorOpen((open) => !open),
              },
              {
                label: t(locale, "CommandPalette.OpenSettings"),
                run: () => setSettingsOpen(true),
              },
              {
                label: t(locale, "CommandPalette.OpenProject"),
                run: openProject,
              },
              ...(activeRunId
                ? [
                    {
                      label: t(locale, "CommandPalette.StopActiveRun"),
                      run: stopActiveRun,
                    },
                  ]
                : []),
            ].map((command) => (
              <button
                key={command.label}
                onClick={() => {
                  setCommandPaletteOpen(false);
                  void command.run();
                }}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  border: "none",
                  borderRadius: 7,
                  background: "transparent",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: 13,
                }}
                onMouseEnter={(event) => (event.currentTarget.style.background = "var(--hover)")}
                onMouseLeave={(event) => (event.currentTarget.style.background = "transparent")}
              >
                {command.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <SettingsPanel
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        labels={labels}
        locale={locale}
        settingsSearch={settingsSearch}
        setSettingsSearch={setSettingsSearch}
        filteredSections={filteredSections}
        settingsSection={settingsSection}
        setSettingsSection={setSettingsSection}
        sectionLabel={sectionLabel}
        activeSectionMeta={activeSectionMeta}
        settings={settings}
        setSetting={setSetting}
        runtimeData={runtimeData}
        activeProject={activeProject}
        probeProfiles={probeProfiles}
        exportDiagnostics={exportDiagnostics}
        resetLayout={resetLayout}
        resetAllSettings={resetAllSettings}
        bridge={bridge}
        chooseDefaultProjectDirectory={chooseDefaultProjectDirectory}
      />
    </div>
  );
}
