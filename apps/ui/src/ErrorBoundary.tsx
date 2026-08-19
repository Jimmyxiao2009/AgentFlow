import React from "react";
import { t, supportedLocales, type Locale } from "@agentflow/localization";
import { detectSystemLocale } from "./utils";

// The boundary wraps the whole workspace (see main.tsx) specifically so it can
// catch crashes anywhere inside it, which means it can't read locale from
// AgentFlowWorkspace's own state -- that's exactly what may have crashed.
// AgentFlowWorkspace keeps document.documentElement.lang in sync with the
// active locale on every render, so that's the most reliable signal left
// once we're rendering the fallback instead of the app that used to own it.
function currentLocale(): Locale {
  const lang = globalThis.document?.documentElement.lang;
  return (supportedLocales as string[]).includes(lang ?? "")
    ? (lang as Locale)
    : detectSystemLocale();
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("AgentFlow ErrorBoundary caught:", error, info.componentStack);
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  override render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const locale = currentLocale();
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: 16,
            padding: 40,
            background: "var(--window)",
            color: "var(--text-primary)",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {t(locale, "Error.SomethingWentWrong")}
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              maxWidth: 480,
              textAlign: "center",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {this.state.error?.message || t(locale, "Error.UnexpectedRenderError")}
          </div>
          <button
            onClick={this.handleReset}
            style={{
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              color: "var(--on-accent)",
              fontSize: 13,
              fontWeight: 600,
              padding: "8px 16px",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            {t(locale, "Error.ReloadWorkspace")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
