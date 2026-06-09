import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const agentUiRoot = path.resolve(__dirname, '../../../packages/agent-ui');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the production webview's Vite aliases so workspace packages
    // resolve to source the same way they do in `pnpm run build` — tests
    // see the same module graph the bundle ships with.
    alias: [
      { find: '@burtson-labs/agent-ui/styles', replacement: path.join(agentUiRoot, 'styles') },
      { find: '@burtson-labs/agent-ui', replacement: path.join(agentUiRoot, 'src/index.ts') }
    ]
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // happy-dom is faster than jsdom and covers everything the webview
    // touches (localStorage, document.getElementById, dispatchEvent, the
    // `message` event from the extension host). Switch to jsdom if a
    // future test trips on a missing DOM API.
    environment: 'happy-dom',
    globals: true
  }
});
