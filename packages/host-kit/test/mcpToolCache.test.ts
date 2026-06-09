/**
 * Tests for the MCP tool-list disk cache. The cache is what stops
 * the trust prompt from firing on every first message in a session
 * (the pool can answer "what tools does X expose?" from disk instead
 * of spawning the child process to introspect).
 *
 * Tests use a tmp HOME so the real ~/.bandit/mcp-tool-cache.json is
 * never touched.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadMcpToolCache,
  saveMcpToolEntry,
  pruneMcpToolCache,
  mcpToolCachePath
} from '../src/mcpToolCache';

let prevHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'host-kit-mcpcache-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('loadMcpToolCache', () => {
  it('returns empty map when the cache file does not exist', async () => {
    const map = await loadMcpToolCache();
    expect(map.size).toBe(0);
  });

  it('returns empty map when the file is malformed JSON', async () => {
    fs.mkdirSync(path.join(tmpHome, '.bandit'));
    fs.writeFileSync(mcpToolCachePath(), '{ not json');
    const map = await loadMcpToolCache();
    expect(map.size).toBe(0);
  });

  it('returns empty map when version mismatches', async () => {
    fs.mkdirSync(path.join(tmpHome, '.bandit'));
    fs.writeFileSync(mcpToolCachePath(), JSON.stringify({ version: 2, entries: [] }));
    const map = await loadMcpToolCache();
    expect(map.size).toBe(0);
  });

  it('parses valid entries and yields a fingerprint-keyed map', async () => {
    fs.mkdirSync(path.join(tmpHome, '.bandit'));
    fs.writeFileSync(mcpToolCachePath(), JSON.stringify({
      version: 1,
      entries: [
        {
          name: 'slack',
          fingerprint: 'fp-slack',
          tools: [{ name: 'post_message', description: 'post' }],
          updatedAt: '2026-05-27T00:00:00Z'
        }
      ]
    }));
    const map = await loadMcpToolCache();
    expect(map.size).toBe(1);
    expect(map.get('fp-slack')).toHaveLength(1);
    expect(map.get('fp-slack')?.[0].name).toBe('post_message');
  });

  it('filters out entries missing a fingerprint or tools array', async () => {
    fs.mkdirSync(path.join(tmpHome, '.bandit'));
    fs.writeFileSync(mcpToolCachePath(), JSON.stringify({
      version: 1,
      entries: [
        { name: 'good', fingerprint: 'fp-good', tools: [{ name: 'x' }] },
        { name: 'no-fp', tools: [] },                   // dropped
        { name: 'no-tools', fingerprint: 'fp-x' },      // dropped
        'bogus'                                         // dropped
      ]
    }));
    const map = await loadMcpToolCache();
    expect([...map.keys()]).toEqual(['fp-good']);
  });
});

describe('saveMcpToolEntry', () => {
  it('creates the file on first save', async () => {
    await saveMcpToolEntry('slack', 'fp-1', [{ name: 'post' }]);
    const raw = fs.readFileSync(mcpToolCachePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].fingerprint).toBe('fp-1');
    expect(parsed.entries[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('replaces an existing entry with the same fingerprint (refresh)', async () => {
    await saveMcpToolEntry('slack', 'fp-1', [{ name: 'old' }]);
    await saveMcpToolEntry('slack', 'fp-1', [{ name: 'new1' }, { name: 'new2' }]);
    const map = await loadMcpToolCache();
    expect(map.get('fp-1')).toHaveLength(2);
    expect(map.get('fp-1')?.[0].name).toBe('new1');
  });

  it('keeps unrelated fingerprints when adding a new one', async () => {
    await saveMcpToolEntry('slack', 'fp-slack', [{ name: 'post' }]);
    await saveMcpToolEntry('gmail', 'fp-gmail', [{ name: 'send' }]);
    const map = await loadMcpToolCache();
    expect(map.size).toBe(2);
    expect(map.has('fp-slack')).toBe(true);
    expect(map.has('fp-gmail')).toBe(true);
  });
});

describe('pruneMcpToolCache', () => {
  it('drops entries whose fingerprints are not in the active set', async () => {
    await saveMcpToolEntry('slack', 'fp-keep', [{ name: 'x' }]);
    await saveMcpToolEntry('old', 'fp-stale', [{ name: 'y' }]);
    await pruneMcpToolCache(new Set(['fp-keep']));
    const map = await loadMcpToolCache();
    expect([...map.keys()]).toEqual(['fp-keep']);
  });

  it('is a no-op when every entry is already active', async () => {
    await saveMcpToolEntry('a', 'fp-a', [{ name: 'x' }]);
    await saveMcpToolEntry('b', 'fp-b', [{ name: 'y' }]);
    const before = fs.statSync(mcpToolCachePath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    await pruneMcpToolCache(new Set(['fp-a', 'fp-b']));
    const after = fs.statSync(mcpToolCachePath()).mtimeMs;
    expect(after).toBe(before);
  });

  it('does not crash when the cache file does not exist', async () => {
    await expect(pruneMcpToolCache(new Set(['anything']))).resolves.toBeUndefined();
  });
});
