import { describe, expect, it } from 'vitest';
import { createRewriteGenerator } from '../src/runtime/rewriteGenerator';
import { parseStructuredFileOutputs } from '../src/runtime/rewritePayload';

describe('parseStructuredFileOutputs', () => {
  it('normalizes wrapped FILE paths', () => {
    const parsed = parseStructuredFileOutputs([
      '```files',
      'FILE: `apps/bandit-stealth/webview-v2/src/App.tsx`,',
      'export default function App() {',
      '  return null;',
      '}',
      '```'
    ].join('\n'));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.path).toBe('apps/bandit-stealth/webview-v2/src/App.tsx');
  });
});

describe('rewriteGenerator primary path reconciliation', () => {
  const createGenerator = (responseBuilder: () => string) =>
    createRewriteGenerator({
      getConfiguration: () => ({
        get: <T>(_: string, defaultValue: T): T => defaultValue
      }),
      getProviderKind: () => 'ollama',
      getModel: () => 'test-model',
      buildProviderSettings: () => ({ kind: 'ollama' }),
      getTopP: () => undefined,
      fetchApiKey: async () => undefined,
      createProvider: async () => ({
        chat: async function* () {
          yield {
            message: {
              role: 'assistant',
              content: responseBuilder()
            },
            done: true
          };
        }
      }),
      diffManager: {
        isReviewModeEnabled: () => false,
        postDiffStream: async () => undefined
      },
      buildHydrationBlocks: () => [],
      normalizeRelativePath: (value: string): string | undefined => {
        if (typeof value !== 'string') {
          return undefined;
        }
        const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
        if (!normalized || normalized.startsWith('/') || normalized.startsWith('..')) {
          return undefined;
        }
        return normalized;
      },
      isCancelled: () => false,
      fileOpsMarkers: { start: '/*FILE_OPS_START*/', end: '/*FILE_OPS_END*/' }
    });

  it('accepts shorthand FILE path when there is a single unambiguous primary file', async () => {
    const generator = createGenerator(() =>
      [
        '```files',
        'FILE: App.tsx',
        '// updated by model',
        'export default function App() {',
        '  return null;',
        '}',
        '```'
      ].join('\n')
    );

    const result = await generator.generateRewrite(
      'Add a short comment at the top of App.tsx',
      'apps/bandit-stealth/webview-v2/src/App.tsx',
      'export default function App() {\n  return null;\n}\n',
      'Test summary',
      'Return ONLY a ```files code block with FILE entries for every updated file. Do not include any other text.'
    );

    expect(result.ok).toBe(true);
    const data = result.data as { content: string; additionalWrites: Array<{ path: string; content: string }> };
    expect(data.content).toContain('// updated by model');
    expect(data.additionalWrites).toHaveLength(0);
  });

  it('reconciles stale required FILE entry to the resolved primary path', async () => {
    const generator = createGenerator(() =>
      [
        '```files',
        'FILE: apps/bandit-stealth/webview-v2/src/App.tsx',
        '// generated content',
        'export default function App() {',
        '  return null;',
        '}',
        '```'
      ].join('\n')
    );

    const result = await generator.generateRewrite(
      'Add a short comment at the top of App.tsx',
      'apps/bandit-stealth/webview-v2/src/App.tsx',
      'export default function App() {\n  return null;\n}\n',
      'Test summary',
      [
        'Return ONLY a ```files code block with FILE entries for every updated file. Do not include any other text.',
        '```files',
        'FILE: apps/agent-ui-workbench/src/App.tsx',
        '<entire updated file>',
        '```'
      ].join('\n')
    );

    expect(result.ok).toBe(true);
    const data = result.data as { content: string; additionalWrites: Array<{ path: string; content: string }> };
    expect(data.content).toContain('// generated content');
    expect(data.additionalWrites).toHaveLength(0);
  });
});
