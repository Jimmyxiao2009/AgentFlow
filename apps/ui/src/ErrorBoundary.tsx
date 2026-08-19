import React from "react";

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
          <div style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</div>
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
            {this.state.error?.message || "An unexpected error occurred while rendering the workspace."}
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
            Reload workspace
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
