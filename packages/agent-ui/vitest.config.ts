import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // DOMPurify parses into a real DOM. The sanitizer config here is a
    // security boundary (see markdownSanitize.test.ts), so it gets exercised
    // against the same DOM implementation the webview uses rather than
    // asserted on a string.
    environment: 'happy-dom',
    // Parsing `<iframe src>` / `<link href>` makes happy-dom actually try to
    // fetch them, so the sanitizer tests would hit the network with the
    // attacker-shaped URLs they use as fixtures. Turning resource loading off
    // keeps the suite hermetic (and quiet — the aborted fetches otherwise dump
    // NetworkError stacks into CI output on teardown).
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          disableIframePageLoading: true
        }
      }
    },
    globals: true
  }
});
