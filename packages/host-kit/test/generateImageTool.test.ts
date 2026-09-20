import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGenerateImageTool } from '../src/tools/generateImageTool';
import { testCtx } from './_helpers';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('generate_image', () => {
  it('claims the GPU, saves the image, releases it, and waits for Ollama', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-image-tool-'));
    roots.push(root);
    const calls: string[] = [];
    let stateChecks = 0;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/image') && (init?.method ?? 'GET') === 'GET') {
        stateChecks += 1;
        return json({ phase: stateChecks === 1 ? 'dormant' : 'ready' });
      }
      if (url.endsWith('/image/claim')) return json({ phase: 'starting' }, 202);
      if (url.endsWith('/image/generations')) {
        return json({
          id: 'job-1', status: 'completed', expiresAt: '2026-09-21T12:00:00Z',
          images: [{ url: '/image/jobs/job-1/assets/0', seed: 42, expiresAt: '2026-09-21T12:00:00Z' }],
        }, 202);
      }
      if (url.endsWith('/image/jobs/job-1/assets/0')) {
        return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (url.endsWith('/image/release')) return json({ phase: 'stopping' }, 202);
      if (url.endsWith('/status')) return json({ ollama: { ready: true } });
      return json({ message: `unexpected request ${url}` }, 500);
    };
    const tool = buildGenerateImageTool({
      token: 'header.payload.signature', antonBaseUrl: 'https://anton.test', fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await tool.execute(
      { prompt: 'a friendly robot', output_path: 'assets/robot.png' },
      { ...testCtx, workspaceRoot: root },
    );

    expect(result.isError).not.toBe(true);
    expect(fs.readFileSync(path.join(root, 'assets/robot.png'))).toEqual(Buffer.from([137, 80, 78, 71]));
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/image/claim'))).toBe(true);
    expect(calls.some((call) => call.startsWith('POST ') && call.endsWith('/image/release'))).toBe(true);
    expect(calls.at(-1)).toBe('GET https://anton.test/status');
  });

  it('rejects output paths outside the workspace before claiming the GPU', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-image-tool-'));
    roots.push(root);
    const calls: string[] = [];
    const tool = buildGenerateImageTool({
      token: 'header.payload.signature',
      fetchImpl: (async (input: string | URL | Request) => {
        calls.push(String(input));
        return json({});
      }) as typeof fetch,
    });

    const result = await tool.execute(
      { prompt: 'nope', output_path: '../escaped.png' },
      { ...testCtx, workspaceRoot: root },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('inside the workspace');
    expect(calls).toEqual([]);
  });
});
