/**
 * list_artifacts + delete_artifact agent tools. Properties: list renders the
 * user's artifacts and honors a scope filter; delete requires a URL (guarded with
 * no network) and DELETEs the resolved key; both surface errors as tool errors.
 */
import { describe, it, expect } from 'vitest';
import { buildListArtifactsTool } from '../src/tools/listArtifactsTool';
import { buildDeleteArtifactTool } from '../src/tools/deleteArtifactTool';

const base = { token: 'jwt', s3ApiBaseUrl: 'https://s3' };

const listResponse = {
  artifacts: [
    { key: 'owner-1/g-a.html', url: 'https://s3/api/artifact/owner-1/g-a.html', size: 2048, lastModified: '2026-09-05T10:00:00Z', scope: 'private' },
    { key: 'team-9/g-b.html', url: 'https://s3/api/artifact/team-9/g-b.html', size: 4096, lastModified: '2026-09-05T11:00:00Z', scope: 'team' },
  ],
};

describe('buildListArtifactsTool', () => {
  it('lists artifacts with name, scope, and url', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => listResponse } as Response)) as unknown as typeof fetch;
    const tool = buildListArtifactsTool({ ...base, fetchImpl });
    const res = await tool.execute({}, {} as never);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain('g-a.html');
    expect(res.output).toContain('g-b.html');
    expect(res.output).toContain('[team]');
  });

  it('honors a scope filter', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => listResponse } as Response)) as unknown as typeof fetch;
    const tool = buildListArtifactsTool({ ...base, fetchImpl });
    const res = await tool.execute({ scope: 'team' }, {} as never);
    expect(res.output).toContain('g-b.html');
    expect(res.output).not.toContain('g-a.html');
  });
});

describe('buildDeleteArtifactTool', () => {
  it('errors (no network) when url is missing', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } as Response; }) as unknown as typeof fetch;
    const tool = buildDeleteArtifactTool({ ...base, fetchImpl });
    const res = await tool.execute({}, {} as never);
    expect(res.isError).toBe(true);
    expect(called).toBe(false);
  });

  it('DELETEs the resolved key', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: string, init?: { method?: string }) => { calls.push({ url, method: init?.method }); return { ok: true, status: 200, json: async () => ({}) } as Response; }) as unknown as typeof fetch;
    const tool = buildDeleteArtifactTool({ ...base, fetchImpl });
    const res = await tool.execute({ url: 'https://s3/api/artifact/owner-1/g-a.html' }, {} as never);
    expect(res.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ url: 'https://s3/api/artifact/owner-1/g-a.html', method: 'DELETE' });
  });
});
