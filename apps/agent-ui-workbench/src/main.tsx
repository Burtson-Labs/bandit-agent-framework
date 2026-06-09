import React from "react";
import ReactDOM from "react-dom/client";
import "@burtson-labs/agent-ui/styles/agent-ui.css";
// Mount the actual extension's stylesheet so the Bandit panel inside
// the workbench renders with the same tokens, button styles, and
// toolbar/composer chrome the shipped extension uses. Imported AFTER
// agent-ui.css so the extension's tokens (which alias VS Code theme
// vars with branded fallbacks) win on conflict.
import "../../bandit-stealth/webview/src/styles.css";
// Dark+ theme tokens for highlight.js — colors the EditorPane's
// sample TypeScript file and any future syntax-highlighted previews.
import "highlight.js/styles/vs2015.css";
import App from "./App";
import "./index.css";
import { BanditProvider } from "@burtson-labs/agent-ui";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BanditProvider context="web">
      <App />
    </BanditProvider>
  </React.StrictMode>
);
