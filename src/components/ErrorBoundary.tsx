import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** When this value changes, the error state is cleared (e.g. pass pathname). */
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches React runtime errors and shows a fallback UI instead of a blank page.
 * Also sends error details to the parent frame via postMessage for potential
 * auto-repair by the agent daemon.
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidUpdate(prevProps: Readonly<ErrorBoundaryProps>) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Runtime error caught:", error.message);
    console.error("[ErrorBoundary] Component stack:", errorInfo.componentStack);

    // Send error to parent frame for agent repair pipeline
    if (window !== window.parent) {
      try {
        window.parent.postMessage(
          {
            type: "RUNTIME_ERROR",
            payload: {
              message: error.message,
              componentStack: errorInfo.componentStack || "",
              timestamp: Date.now(),
            },
          },
          "*"
        );
      } catch {
        // postMessage failed — silently ignore
      }
    }
  }

  handleRetry = () => {
    window.location.reload();
  };

  handleFixWithAI = () => {
    const errorMsg = this.state.error?.message || "unknown error";
    if (window !== window.parent) {
      try {
        window.parent.postMessage(
          {
            type: "RUNTIME_ERROR",
            payload: {
              message: errorMsg,
              componentStack: "",
              timestamp: Date.now(),
              userInitiated: true,
            },
          },
          "*"
        );
      } catch {
        // silently ignore
      }
    }
  };

  render() {
    if (this.state.hasError) {
      // Quiet-HMR integration (LPS-327): during an active agent bulk
      // edit the preview is mid-way through writing a self-healing
      // tree. A React error during that window is expected — show a
      // neutral splash instead of the scary "something went wrong"
      // card so the user doesn't think their edit broke the site.
      // ``data-lps-quiet`` is set by ``src/lib/quietHmr.ts`` for the
      // duration of the window.
      const isQuiet =
        typeof document !== "undefined" &&
        document.body?.dataset?.lpsQuiet === "1";
      if (isQuiet) {
        return (
          <div className="min-h-screen flex items-center justify-center bg-background">
            <div className="text-center max-w-sm p-8">
              <div className="mx-auto mb-6 h-10 w-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <h2 className="text-lg font-medium text-foreground mb-1">
                Finishing up your edit…
              </h2>
              <p className="text-sm text-muted-foreground">
                Your preview will refresh automatically in a moment.
              </p>
            </div>
          </div>
        );
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="text-center max-w-md p-8">
            <div className="mx-auto mb-6 h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <svg
                className="h-8 w-8 text-destructive"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-foreground mb-2">
              Something went wrong
            </h2>
            <p className="text-muted-foreground mb-6">
              This section has an error. You can try refreshing,
              or ask the AI to fix it.
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleRetry}
                className="inline-flex items-center justify-center rounded-md bg-secondary px-6 py-3 text-sm font-medium text-secondary-foreground shadow hover:bg-secondary/90 transition-colors"
              >
                Try Again
              </button>
              <button
                onClick={this.handleFixWithAI}
                className="inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
              >
                Fix with AI
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-4">
              If the problem persists, please contact support.
            </p>
            {import.meta.env.VITE_BUILDER_ENVIRONMENT === 'development' && this.state.error && (
              <details className="mt-6 text-left">
                <summary className="text-xs text-muted-foreground cursor-pointer">
                  Error details (dev only)
                </summary>
                <pre className="mt-2 text-xs text-destructive bg-destructive/5 p-3 rounded overflow-auto max-h-40">
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
