import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentTool, ToolResult } from '@burtson-labs/agent-core';
import { resolveGatewayToken } from '../artifacts';

export interface GenerateImageToolOptions {
  token: string;
  antonBaseUrl?: string;
  authBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

type ImageState = { phase?: string; lastError?: string | null };
type ImageJob = {
  id: string;
  status: string;
  error?: string | null;
  expiresAt?: string;
  images?: Array<{ url: string; seed: number; expiresAt?: string }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function workspacePath(root: string, requested: string): string {
  const absolute = path.resolve(root, requested);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path must stay inside the workspace: ${requested}`);
  }
  return absolute;
}

function contentType(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.png': return 'image/png';
    default: throw new Error(`unsupported reference image type: ${path.extname(filename) || '(none)'}`);
  }
}

async function jsonRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = body?.message ?? body?.detail ?? `HTTP ${response.status}`;
    throw new Error(String(detail));
  }
  return body as T;
}

async function uploadReference(
  fetchImpl: typeof fetch,
  base: string,
  token: string,
  filename: string,
  kind: 'reference' | 'mask',
): Promise<string> {
  const bytes = await fs.readFile(filename);
  if (bytes.byteLength > 12 * 1024 * 1024) throw new Error(`${kind} image exceeds 12 MiB`);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType(filename) }), path.basename(filename));
  form.append('kind', kind);
  const response = await fetchImpl(`${base}/image/references`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, body: form,
  });
  const payload = await response.json().catch(() => null) as { id?: string; message?: string; detail?: string } | null;
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message ?? payload?.detail ?? `reference upload failed: HTTP ${response.status}`);
  }
  return payload.id;
}

async function waitForImageReady(fetchImpl: typeof fetch, base: string, token: string): Promise<void> {
  const deadline = Date.now() + 300_000;
  let lastClaim = Date.now();
  while (Date.now() < deadline) {
    const state = await jsonRequest<ImageState>(fetchImpl, `${base}/image`, token);
    if (state.phase === 'ready') return;
    if (state.phase === 'failed') throw new Error(state.lastError || 'image worker failed to start');
    if (state.phase === 'idle' && Date.now() - lastClaim > 15_000) {
      // A transition already holding Anton's gate (say, the auto-release from a
      // previous job) can outlast our claim's queue window; ask again rather
      // than polling a phase that will never move on its own.
      await jsonRequest(fetchImpl, `${base}/image/claim`, token, { method: 'POST' }).catch(() => undefined);
      lastClaim = Date.now();
    }
    await sleep(2_000);
  }
  throw new Error('image worker did not become ready in time');
}

async function waitForOllama(fetchImpl: typeof fetch, base: string, token: string): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const status = await jsonRequest<{ ollama?: { ready?: boolean } }>(fetchImpl, `${base}/status`, token);
      if (status.ollama?.ready) return true;
    } catch { /* keep waiting; release reconciliation may briefly restart Anton's dependencies */ }
    await sleep(2_000);
  }
  return false;
}

export function buildGenerateImageTool(options: GenerateImageToolOptions): AgentTool {
  return {
    name: 'generate_image',
    description: 'Generate or edit an image on the Burtson Labs GPU and save the PNG inside the current repository. For edits, pass reference_path; optionally pass a black-and-white mask_path. This tool safely parks local Ollama, completes the image job, releases the GPU, and waits for local inference to recover before returning.',
    parameters: [
      { name: 'prompt', description: 'Detailed description of the image to create or the changes to make.', required: true },
      { name: 'output_path', description: 'PNG output path inside the workspace, for example assets/hero.png.', required: true },
      { name: 'reference_path', description: 'Optional PNG/JPEG/WebP path inside the workspace to edit.' },
      { name: 'mask_path', description: 'Optional black-and-white PNG/JPEG/WebP mask; white areas are edited. Requires reference_path.' },
      { name: 'width', description: 'Output width: 256-1536 and divisible by 64. Default 1024 for generation; edits follow the reference image unless set.' },
      { name: 'height', description: 'Output height: 256-1536 and divisible by 64. Default 1024 for generation; edits follow the reference image unless set.' },
      { name: 'strength', description: 'Edit strength from 0.05 to 1.0. Lower preserves more of the reference. Default 0.68.' },
    ],
    async execute(params, ctx): Promise<ToolResult> {
      const prompt = params.prompt?.trim();
      const requestedOutput = params.output_path?.trim();
      if (!prompt || !requestedOutput) return { output: 'Error: prompt and output_path are required', isError: true };
      // For edits, leave omitted dimensions to the image API: it sizes the
      // canvas from the reference's aspect ratio, and stretching a non-square
      // reference onto a mismatched canvas is what mangles logos.
      const isEdit = Boolean(params.reference_path);
      const width = params.width ? Number(params.width) : isEdit ? undefined : 1024;
      const height = params.height ? Number(params.height) : isEdit ? undefined : 1024;
      const strength = Number(params.strength || 0.68);
      if (![width, height].every((value) => value === undefined
        || (Number.isInteger(value) && value >= 256 && value <= 1536 && value % 64 === 0))) {
        return { output: 'Error: width and height must be 256-1536 and divisible by 64', isError: true };
      }
      if (!Number.isFinite(strength) || strength < 0.05 || strength > 1) {
        return { output: 'Error: strength must be between 0.05 and 1.0', isError: true };
      }
      if (params.mask_path && !params.reference_path) {
        return { output: 'Error: mask_path requires reference_path', isError: true };
      }

      const fetchImpl = options.fetchImpl ?? fetch;
      const base = (options.antonBaseUrl ?? process.env.BANDIT_ANTON_URL ?? 'https://anton.burtson.ai').replace(/\/$/, '');
      let token: string;
      try {
        token = await resolveGatewayToken(options.token, { authBaseUrl: options.authBaseUrl, fetchImpl });
      } catch (error) {
        return { output: `Image generation sign-in failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }

      let claimed = false;
      try {
        const outputPath = workspacePath(ctx.workspaceRoot, requestedOutput);
        const referenceId = params.reference_path
          ? await uploadReference(fetchImpl, base, token, workspacePath(ctx.workspaceRoot, params.reference_path), 'reference')
          : undefined;
        const maskId = params.mask_path
          ? await uploadReference(fetchImpl, base, token, workspacePath(ctx.workspaceRoot, params.mask_path), 'mask')
          : undefined;

        const state = await jsonRequest<ImageState>(fetchImpl, `${base}/image`, token);
        if (state.phase !== 'ready') {
          await jsonRequest(fetchImpl, `${base}/image/claim`, token, { method: 'POST' });
          claimed = true;
          await waitForImageReady(fetchImpl, base, token);
        }

        let job = await jsonRequest<ImageJob>(fetchImpl, `${base}/image/generations`, token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt, width, height, model: 'flux-schnell', steps: 4,
            referenceId, maskId, strength: referenceId ? strength : undefined,
          }),
        });
        const deadline = Date.now() + 360_000;
        while (['queued', 'running'].includes(job.status) && Date.now() < deadline) {
          await sleep(2_000);
          job = await jsonRequest<ImageJob>(fetchImpl, `${base}/image/jobs/${encodeURIComponent(job.id)}`, token);
        }
        if (job.status !== 'completed' || !job.images?.[0]) {
          throw new Error(job.error || `image job ended with status ${job.status}`);
        }
        const assetUrl = job.images[0].url.startsWith('/') ? job.images[0].url : `/${job.images[0].url}`;
        const response = await fetchImpl(`${base}${assetUrl}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`could not download generated image: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, bytes);
        const relativeOutput = path.relative(ctx.workspaceRoot, outputPath) || path.basename(outputPath);
        return {
          output: `Saved ${referenceId ? 'edited' : 'generated'} image to ${relativeOutput} (${bytes.byteLength} bytes, seed ${job.images[0].seed}). Temporary server copy expires ${job.images[0].expiresAt ?? job.expiresAt ?? 'automatically'}; the workspace file is permanent.`,
        };
      } catch (error) {
        return { output: `Image generation failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      } finally {
        if (claimed) {
          await jsonRequest(fetchImpl, `${base}/image/release`, token, { method: 'POST' }).catch(() => undefined);
          await waitForOllama(fetchImpl, base, token);
        }
      }
    },
  };
}
