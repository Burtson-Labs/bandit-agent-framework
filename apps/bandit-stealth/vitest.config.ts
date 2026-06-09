import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  ssr: {
    noExternal: ['@burtson-labs/stealth-core-runtime']
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: true
  }
});
