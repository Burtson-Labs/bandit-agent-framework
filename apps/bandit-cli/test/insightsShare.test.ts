/**
 * `/insights --share` publishes the written report as a Bandit Artifact and
 * returns the shareable URL (via the host-provided ctx.shareArtifact capability,
 * which does the bai_→JWT exchange + S3Api upload). When the user isn't signed
 * in to Bandit cloud the capability is absent, and the command falls back to a
 * clear hint while still leaving the report on disk.
 *
 * HOME is redirected to a temp dir so computeInsights sees no real sessions and
 * the default report path stays inside the sandbox.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { slashCommands } from '../src/slashCommands';

const insights = slashCommands.find((cmd) => cmd.name === 'insights')!;
type Ctx = Parameters<typeof insights.run>[1];

describe('/insights --share', () => {
  const origHome = process.env.HOME;
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-insights-'));
    process.env.HOME = cwd;
    fs.mkdirSync(path.join(cwd, '.bandit'), { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = origHome;
  });

  it('publishes the report and returns the shareable URL when signed in', async () => {
    let sharedPath: string | undefined;
    const ctx = {
      cwd,
      providerKind: 'ollama',
      model: { current: 'local' },
      shareArtifact: async (p: string) => {
        sharedPath = p;
        return 'https://s3.burtson.ai/api/artifact/team-x/abc.html';
      }
    } as unknown as Ctx;

    const out = await insights.run('--share --no-ai', ctx);
    expect(out).toContain('https://s3.burtson.ai/api/artifact/team-x/abc.html');
    expect(out).toMatch(/published/i);
    // shareArtifact received the actual written report path (an .html on disk).
    expect(sharedPath).toBeTruthy();
    expect(sharedPath!.endsWith('.html')).toBe(true);
    expect(fs.existsSync(sharedPath!)).toBe(true);
  });

  it('falls back to a cloud hint (report still written) when not signed in', async () => {
    const ctx = {
      cwd,
      providerKind: 'ollama',
      model: { current: 'local' }
      // no shareArtifact capability → not signed in to Bandit cloud
    } as unknown as Ctx;

    const out = await insights.run('--share --no-ai', ctx);
    expect(out).toMatch(/--share needs Bandit cloud/);
    expect(out).toMatch(/insights written to/);
  });
});
