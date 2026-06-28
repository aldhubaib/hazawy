import React from "react";
import ReactDOM from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App.jsx";
import {
  ErrorBoundary,
  ErrorDialog,
  installGlobalErrorHandlers,
} from "./ErrorReporter.jsx";
import "./index.css";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// Catch uncaught errors + unhandled promise rejections anywhere in the app.
installGlobalErrorHandlers();

const root = ReactDOM.createRoot(document.getElementById("root"));

// With a Clerk key: gate the app behind sign-in. Without one: run open (no login,
// everyone is treated as an admin) so the tool still works with zero setup.
//
// Everything is wrapped in an ErrorBoundary, and <ErrorDialog/> is a sibling so
// it can surface a copy/paste error report even if the app subtree crashes.
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      {PUBLISHABLE_KEY ? (
        <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/">
          <App />
        </ClerkProvider>
      ) : (
        <App authDisabled />
      )}
    </ErrorBoundary>
    <ErrorDialog />
  </React.StrictMode>
);
