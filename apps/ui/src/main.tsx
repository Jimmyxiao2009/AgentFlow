import React from "react";
import { createRoot } from "react-dom/client";
import AgentFlowWorkspace from "./AgentFlowWorkspace";
import { ErrorBoundary } from "./ErrorBoundary";
import { defaultSettings } from "@agentflow/config";
import { agentFlowTokens } from "@agentflow/design-system";
import { supportedLocales } from "@agentflow/localization";
import "./global.css";

document.documentElement.lang = defaultSettings.locale;
document.documentElement.dataset.agentflowLocales = supportedLocales.join(",");
document.documentElement.style.setProperty("--agentflow-accent", agentFlowTokens.colors.accent);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AgentFlowWorkspace />
    </ErrorBoundary>
  </React.StrictMode>,
);
