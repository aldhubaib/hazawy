import React from "react";

// Global error capture + a copy/paste error dialog.
//
// Anything that goes wrong in the live app — a React render crash, an uncaught
// exception, an unhandled promise rejection, or a failed API call — is funneled
// here and shown to the user in a dialog with a one-click "Copy report" button so
// they can paste the full details back to us.

// --- tiny event bus ---------------------------------------------------------
const listeners = new Set();
let pending = []; // errors captured before the dialog mounts

function normalize(err, info = {}) {
  let name = "Error";
  let message = "";
  let stack = "";

  if (err instanceof Error) {
    name = err.name || "Error";
    message = err.message || String(err);
    stack = err.stack || "";
  } else if (typeof err === "string") {
    message = err;
  } else if (err && typeof err === "object") {
    message = err.message || (() => {
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    })();
    stack = err.stack || "";
  } else {
    message = String(err);
  }

  // Errors thrown by api.js carry request metadata (see api.js).
  const http = err && typeof err === "object" && err.httpInfo ? err.httpInfo : null;

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: new Date().toISOString(),
    name,
    message,
    stack,
    source: info.source || "runtime",
    componentStack: info.componentStack || "",
    http,
    extra: info.extra || null,
  };
}

export function reportError(err, info = {}) {
  const entry = normalize(err, info);
  // Always leave a console breadcrumb for devtools.
  // eslint-disable-next-line no-console
  console.error("[hazawy] captured error:", err, info);
  if (listeners.size === 0) {
    pending.push(entry);
  } else {
    for (const fn of listeners) fn(entry);
  }
  return entry;
}

function subscribe(fn) {
  listeners.add(fn);
  if (pending.length) {
    const queued = pending;
    pending = [];
    // Deliver the most recent queued error so the dialog shows immediately.
    fn(queued[queued.length - 1]);
  }
  return () => listeners.delete(fn);
}

let installed = false;
export function installGlobalErrorHandlers() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    // Ignore noisy resource-load errors (e.g. a broken <img>) that carry no Error.
    if (!event.error && !event.message) return;
    reportError(event.error || event.message, {
      source: "window.onerror",
      extra: { filename: event.filename, lineno: event.lineno, colno: event.colno },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason ?? "Unhandled promise rejection", {
      source: "unhandledrejection",
    });
  });
}

// --- report formatting ------------------------------------------------------
function buildReportText(entry) {
  const lines = [
    "HAZAWY — ERROR REPORT",
    `Time:    ${entry.time}`,
    `Source:  ${entry.source}`,
    `Error:   ${entry.name}: ${entry.message}`,
  ];
  if (entry.http) {
    lines.push(
      `Request: ${entry.http.method || "GET"} ${entry.http.url || ""}`,
      `Status:  ${entry.http.status ?? "?"}${entry.http.statusText ? " " + entry.http.statusText : ""}`
    );
    if (entry.http.body) lines.push(`Body:    ${entry.http.body}`);
  }
  if (typeof window !== "undefined") {
    lines.push(`Page:    ${window.location.href}`);
    lines.push(`Browser: ${navigator.userAgent}`);
  }
  if (entry.extra) {
    try {
      lines.push(`Extra:   ${JSON.stringify(entry.extra)}`);
    } catch {
      /* ignore */
    }
  }
  if (entry.stack) {
    lines.push("", "Stack trace:", entry.stack);
  }
  if (entry.componentStack) {
    lines.push("", "Component stack:", entry.componentStack.trim());
  }
  return lines.join("\n");
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// --- dialog -----------------------------------------------------------------
// Inline styles on purpose: the error dialog must render even if the app's CSS
// failed to load or is the source of the problem.
const S = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(6, 7, 10, 0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 2147483647,
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  card: {
    width: "min(680px, 100%)",
    maxHeight: "85vh",
    display: "flex",
    flexDirection: "column",
    background: "#15171f",
    color: "#e7e9ee",
    border: "1px solid #272b38",
    borderRadius: 14,
    boxShadow: "0 24px 70px rgba(0,0,0,0.55)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "16px 18px",
    borderBottom: "1px solid #272b38",
  },
  dot: { width: 10, height: 10, borderRadius: "50%", background: "#fb7185", flex: "0 0 auto" },
  title: { fontSize: 15, fontWeight: 600, margin: 0 },
  body: { padding: "14px 18px", overflow: "auto" },
  msg: {
    margin: "0 0 12px",
    fontSize: 14,
    lineHeight: 1.5,
    color: "#fca5a5",
    wordBreak: "break-word",
  },
  pre: {
    margin: 0,
    padding: 12,
    background: "#0c0d12",
    border: "1px solid #272b38",
    borderRadius: 10,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.5,
    color: "#c7cad3",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: "40vh",
    overflow: "auto",
  },
  footer: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
    padding: "14px 18px",
    borderTop: "1px solid #272b38",
  },
  btn: {
    appearance: "none",
    border: "1px solid #272b38",
    background: "#1c1f2a",
    color: "#e7e9ee",
    padding: "9px 14px",
    borderRadius: 9,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  },
  btnPrimary: {
    border: "1px solid transparent",
    background: "#c084fc",
    color: "#1a1024",
    fontWeight: 600,
  },
};

export function ErrorDialog() {
  const [entry, setEntry] = React.useState(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => subscribe(setEntry), []);

  if (!entry) return null;

  const report = buildReportText(entry);

  const onCopy = async () => {
    const ok = await copyText(report);
    setCopied(ok ? "copied" : "failed");
    setTimeout(() => setCopied(false), 2000);
  };

  const close = () => {
    setEntry(null);
    setCopied(false);
  };

  return (
    <div style={S.overlay} role="alertdialog" aria-modal="true" aria-label="Error">
      <div style={S.card}>
        <div style={S.header}>
          <span style={S.dot} />
          <h2 style={S.title}>Something went wrong</h2>
        </div>
        <div style={S.body}>
          <p style={S.msg}>
            {entry.name}: {entry.message}
          </p>
          <p style={{ margin: "0 0 8px", fontSize: 12.5, color: "#9aa0ad" }}>
            Copy the report below and send it to support so we can fix it.
          </p>
          <pre style={S.pre}>{report}</pre>
        </div>
        <div style={S.footer}>
          <button type="button" style={S.btn} onClick={() => window.location.reload()}>
            Reload app
          </button>
          <button type="button" style={S.btn} onClick={close}>
            Dismiss
          </button>
          <button
            type="button"
            style={{ ...S.btn, ...S.btnPrimary }}
            onClick={onCopy}
          >
            {copied === "copied"
              ? "Copied!"
              : copied === "failed"
              ? "Copy failed — select & copy"
              : "Copy report"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- boundary ---------------------------------------------------------------
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error, info) {
    reportError(error, { source: "react-render", componentStack: info?.componentStack });
  }

  render() {
    if (this.state.crashed) {
      // The ErrorDialog (mounted as a sibling, outside this boundary) shows the
      // copy/paste report. Keep the fallback minimal so the page isn't blank.
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: "#9aa0ad",
            fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
          }}
        >
          <div style={{ fontSize: 15, color: "#e7e9ee" }}>The app hit an error.</div>
          <button
            type="button"
            style={{ ...S.btn, ...S.btnPrimary }}
            onClick={() => window.location.reload()}
          >
            Reload app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
