import React from "react";
import ReactDOM from "react-dom/client";
import "@burtson-labs/agent-ui/styles/agent-ui.css";
import "./styles.css";
import { App } from "./App";
import { BanditProvider } from "@burtson-labs/agent-ui";

if (typeof window !== "undefined" && typeof acquireVsCodeApi === "function") {
  (window as { vscode?: VsCodeApi }).vscode = acquireVsCodeApi();
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BanditProvider context="vscode">
      <App />
    </BanditProvider>
  </React.StrictMode>
);
