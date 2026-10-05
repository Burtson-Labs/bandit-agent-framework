/**
 * semantic_search must embed through the Ollama server the session is configured for,
 * and must not answer from another workspace's index.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureSemanticSearchOllamaUrl,
  resetSemanticIndex,
  semanticSearchSkill,
  type ToolExecutionContext
} from '@burtson-labs/agent-core';
import { semanticSearchOllamaUrl } from '../src/agent/semanticSearchUrl';

const semanticSearch = semanticSearchSkill.tools!.find((tool) => tool.name === 'semantic_search')!;

function workspace(root: string, files: Record<string, string>): ToolExecutionContext {
  return {
    workspaceRoot: root,
    async readFile(p: string) { return files[p.replace(`${root}/`, '')] ?? ''; },
    async writeFile() { return; },
    async listFiles() { return Object.keys(files); },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; }
  };
}

/** An embeddings endpoint that records where it was called. */
function stubEmbeddings(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200 });
  }));
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  configureSemanticSearchOllamaUrl(undefined);
  resetSemanticIndex();
});

describe('semanticSearchOllamaUrl', () => {
  it('follows the chat provider: node URL first, then the primary URL', () => {
    expect(semanticSearchOllamaUrl({ ollamaUrl: 'http://gpu-box:11434' })).toBe('http://gpu-box:11434');
    expect(semanticSearchOllamaUrl({ ollamaUrl: 'http://localhost:11434', ollamaNodeUrl: ' http://node:11434 ' })).toBe('http://node:11434');
    expect(semanticSearchOllamaUrl({})).toBeUndefined();
  });
});

describe('semantic_search', () => {
  it('embeds through the configured server, not localhost:11434', async () => {
    const urls = stubEmbeddings();
    configureSemanticSearchOllamaUrl(semanticSearchOllamaUrl({ ollamaUrl: 'http://gpu-box:11455/' }));
    const result = await semanticSearch.execute({ query: 'scoring weights' }, workspace('/work/a', { 'src/scoring.ts': 'export const weights = [1, 2];' }));
    expect(result.isError).toBeFalsy();
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(['http://gpu-box:11455/api/embeddings']));
  });

  it('falls back to the default server when nothing is configured', async () => {
    const urls = stubEmbeddings();
    configureSemanticSearchOllamaUrl(semanticSearchOllamaUrl({}));
    await semanticSearch.execute({ query: 'anything' }, workspace('/work/a', { 'a.ts': 'const a = 1;' }));
    expect(new Set(urls)).toEqual(new Set(['http://localhost:11434/api/embeddings']));
  });

  it('does not return another workspace\'s files', async () => {
    stubEmbeddings();
    const first = await semanticSearch.execute({ query: 'x' }, workspace('/work/a', { 'only-in-a.ts': 'const a = 1;' }));
    expect(first.output).toContain('only-in-a.ts');
    const second = await semanticSearch.execute({ query: 'x' }, workspace('/work/b', { 'only-in-b.ts': 'const b = 2;' }));
    expect(second.output).toContain('only-in-b.ts');
    expect(second.output).not.toContain('only-in-a.ts');
  });
});
