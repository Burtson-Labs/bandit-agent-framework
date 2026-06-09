import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const agentUiRoot = path.resolve(__dirname, "../../../packages/agent-ui");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@burtson-labs/agent-ui/styles", replacement: path.join(agentUiRoot, "styles") },
      { find: "@burtson-labs/agent-ui", replacement: path.join(agentUiRoot, "src/index.ts") }
    ]
  },
  build: {
    outDir: "../media/webview",
    emptyOutDir: true,
    assetsDir: ".",
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
      output: {
        entryFileNames: "webview.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css")) {
            return "webview.css";
          }
          return "assets/[name]-[hash][extname]";
        }
      }
    }
  }
});
