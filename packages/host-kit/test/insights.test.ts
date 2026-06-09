import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(tmpdir(), 'bandit-insights-home-'));
  tmpCwd = mkdtempSync(path.join(tmpdir(), 'bandit-insights-cwd-'));
  vi.stubEnv('HOME', tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpCwd, { recursive: true, force: true });
});

describe('insights', () => {
  it('loads global turn logs and synthesizes cross-repo wins', async () => {
    const turnsDir = path.join(tmpHome, '.bandit', 'turns');
    mkdirSync(turnsDir, { recursive: true });
    const servicePath = path.join(tmpHome, 'Documents', 'GitHub', 'my-service', 'src', 'server.ts');
    const appPath = path.join(tmpHome, 'Documents', 'GitHub', 'my-app', 'src', 'App.tsx');

    writeFileSync(path.join(turnsDir, 'turn-2026-05-25T20-58-33-159Z-mcp.jsonl'), [
      JSON.stringify({ t: '2026-05-25T20:58:33.159Z', type: 'user-prompt', prompt: 'build an MCP connector and post the results to slack' }),
      JSON.stringify({ t: '2026-05-25T20:58:35.000Z', type: 'tool-execute', name: 'write_file', params: { path: servicePath } }),
      JSON.stringify({ t: '2026-05-25T20:58:36.000Z', type: 'tool-execute', name: 'slack.post_message', params: { channel: 'general' } }),
      JSON.stringify({ t: '2026-05-25T20:59:00.000Z', type: 'final-response', finalPreview: 'Done. Built the MCP connector and posted the results to Slack.' })
    ].join('\n'));

    writeFileSync(path.join(turnsDir, 'turn-2026-05-24T19-25-29-920Z-sub.jsonl'), [
      JSON.stringify({ t: '2026-05-24T19:25:29.920Z', type: 'user-prompt', prompt: 'add a subagent to research the codebase' }),
      JSON.stringify({ t: '2026-05-24T19:25:31.000Z', type: 'tool-execute', name: 'apply_edit', params: { path: appPath } }),
      JSON.stringify({ t: '2026-05-24T19:26:00.000Z', type: 'final-response', finalPreview: 'Added the subagent and researched the codebase.' })
    ].join('\n'));

    const { computeInsights } = await import('../src/insights');
    const data = computeInsights(tmpCwd);

    expect(data.turnFiles).toHaveLength(2);
    expect(data.work.themes.some((theme) => theme.title === 'MCP/connectors' && theme.externalActions === 1)).toBe(true);
    expect(data.work.themes.some((theme) => theme.title === 'Subagents/background work' && theme.editsAndWrites === 1)).toBe(true);
    expect(data.localStory.join(' ').length).toBeGreaterThan(0);
  });
});
