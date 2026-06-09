import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

const agentUiRoot = path.resolve(__dirname, "../../packages/agent-ui");

// Resolve the VSIX bundle next to the extension manifest so the
// workbench's Extensions panel can quote real size + last-built
// timestamps. Falls back to nulls when the artifact hasn't been
// produced yet (fresh clone, first dev run before `pnpm -F
// bandit-stealth package`).
const vsixPath = path.resolve(__dirname, "../bandit-stealth/bandit-stealth.vsix");
const vsixStat = fs.existsSync(vsixPath) ? fs.statSync(vsixPath) : null;

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src") },
      { find: "@burtson-labs/agent-ui/styles", replacement: path.join(agentUiRoot, "styles") },
      { find: "@burtson-labs/agent-ui", replacement: path.join(agentUiRoot, "src/index.ts") }
    ]
  },
  define: {
    __BANDIT_VSIX_SIZE_BYTES__: JSON.stringify(vsixStat?.size ?? null),
    __BANDIT_VSIX_MTIME__: JSON.stringify(vsixStat?.mtime.toISOString() ?? null)
  },
  server: {
    port: 4173
  },
  optimizeDeps: {
    include: [],
    force: true
  },
  build: {
    commonjsOptions: {
      include: [/packages\/agent-ui\/.*/, /node_modules/]
    }
  }
});
