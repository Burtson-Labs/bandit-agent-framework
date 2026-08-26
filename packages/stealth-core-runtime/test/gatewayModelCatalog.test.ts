/**
 * Regression tests for the capability-drift bug.
 *
 * Hosted model ids are aliases. The gateway repointed `bandit-core-2` at a
 * different backend and correctly advertised `Tools: true`; the client's
 * hardcoded `supportsToolCalling: false` won anyway, forced every turn onto the
 * text-tools path, and left the model unable to call tools it could see listed
 * in its own system prompt.
 *
 * Two invariants protect against a repeat: the shipped table must be right
 * today, and the catalog must be able to correct it tomorrow without a release.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getModelCapabilities,
  registerModelCapabilities,
  clearDiscoveredCapabilities,
  resolvePreferredToolProtocol
} from '../src/runtime/modelCapabilities';
import { syncGatewayModelCapabilities, catalogEntryToCapabilities } from '../src/runtime/gatewayModelCatalog';

beforeEach(() => clearDiscoveredCapabilities());

describe('shipped capability table', () => {
  // The exact regression: this resolved to text-tools and broke tool calling.
  it('hosted frontier models resolve to native tools', () => {
    for (const id of ['bandit-core-1', 'bandit-core-2', 'bandit-logic', 'bandit-logic-2']) {
      expect(getModelCapabilities(id).supportsToolCalling, id).toBe(true);
      expect(resolvePreferredToolProtocol(id), id).toBe('native-tools');
    }
  });

  it('bandit-logic-2 gets its own profile instead of inheriting bandit-logic', () => {
    // The matcher returns the FIRST array match, not the longest, so ordering
    // is load-bearing — a later-declared `bandit-logic-2` would be masked.
    expect(getModelCapabilities('bandit-logic-2').label).toBe('Bandit Logic 2');
    expect(getModelCapabilities('bandit-logic').label).toBe('Bandit Logic');
  });

  it('labels do not name the backing model', () => {
    // These aliases get repointed; a label naming a backend is both a leak and
    // a future lie.
    for (const id of ['bandit-core-2', 'bandit-logic', 'bandit-logic-2']) {
      const label = getModelCapabilities(id).label ?? '';
      expect(label, id).not.toMatch(/kimi|qwen|runpod|llama|gpt|claude/i);
    }
  });
});

describe('catalogEntryToCapabilities', () => {
  it('maps a catalog row onto a capability profile', () => {
    const entry = catalogEntryToCapabilities({
      id: 'bandit-core-2',
      displayName: 'Bandit Core 2',
      contextWindow: 262144,
      tier: 'large',
      vision: true,
      tools: true,
      available: true,
      recommendedMaxIterations: 40
    });
    expect(entry).not.toBeNull();
    expect(entry!.caps).toMatchObject({
      contextWindow: 262144,
      supportsToolCalling: true,
      supportsVision: true,
      tier: 'large',
      label: 'Bandit Core 2'
    });
    expect(entry!.recommendedMaxIterations).toBe(40);
  });

  // A false positive here sends native schemas to a model that can't parse
  // them, which breaks the turn outright — worse than the bug being fixed.
  it('only an explicit true enables tools or vision', () => {
    const entry = catalogEntryToCapabilities({ id: 'x', contextWindow: 8192 });
    expect(entry!.caps.supportsToolCalling).toBe(false);
    expect(entry!.caps.supportsVision).toBe(false);
  });

  it('derives a tier when the catalog omits one', () => {
    expect(catalogEntryToCapabilities({ id: 'a', contextWindow: 262144 })!.caps.tier).toBe('large');
    expect(catalogEntryToCapabilities({ id: 'b', contextWindow: 32768 })!.caps.tier).toBe('medium');
    expect(catalogEntryToCapabilities({ id: 'c', contextWindow: 8192 })!.caps.tier).toBe('small');
  });

  it('rejects a row with no id', () => {
    expect(catalogEntryToCapabilities({ contextWindow: 1000 })).toBeNull();
  });
});

describe('authoritative capabilities beat the built-in table', () => {
  const catalogResponse = (models: unknown) => async () =>
    ({ ok: true, json: async () => models }) as unknown as Response;

  it('a gateway repoint takes effect without a client release', () => {
    // Simulate the table being stale in the OTHER direction: catalog says a
    // hosted model no longer supports tools.
    expect(getModelCapabilities('bandit-core-2').supportsToolCalling).toBe(true);
    registerModelCapabilities(
      'bandit-core-2',
      { ...getModelCapabilities('bandit-core-2'), supportsToolCalling: false },
      { authoritative: true }
    );
    expect(getModelCapabilities('bandit-core-2').supportsToolCalling).toBe(false);
    expect(resolvePreferredToolProtocol('bandit-core-2')).toBe('text-tools');
  });

  // The inverse must stay true: probe-based discovery guesses, and letting it
  // win previously downgraded known-good models at boot.
  it('non-authoritative discovery still loses to the built-in table', () => {
    registerModelCapabilities('bandit-core-2', {
      ...getModelCapabilities('bandit-core-2'),
      supportsToolCalling: false
    });
    expect(getModelCapabilities('bandit-core-2').supportsToolCalling).toBe(true);
  });

  it('syncs a catalog response into authoritative capabilities', async () => {
    const entries = await syncGatewayModelCapabilities({
      gatewayUrl: 'https://gw.example',
      apiKey: 'k',
      fetchImpl: catalogResponse([
        { id: 'bandit-core-2', displayName: 'Bandit Core 2', contextWindow: 262144, tools: true, vision: true, available: true }
      ]) as unknown as typeof fetch
    });
    expect(entries).toHaveLength(1);
    expect(getModelCapabilities('bandit-core-2').label).toBe('Bandit Core 2');
  });

  it('accepts a {models:[…]} envelope as well as a bare array', async () => {
    const entries = await syncGatewayModelCapabilities({
      gatewayUrl: 'https://gw.example',
      fetchImpl: catalogResponse({ models: [{ id: 'm1', contextWindow: 1000, tools: true }] }) as unknown as typeof fetch
    });
    expect(entries.map(e => e.id)).toEqual(['m1']);
  });
});

describe('failure is always soft', () => {
  const cases: Array<[string, typeof fetch]> = [
    ['network error', (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch],
    ['non-ok response', (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch],
    ['malformed body', (async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })) as unknown as typeof fetch],
    ['unexpected shape', (async () => ({ ok: true, json: async () => ({ nope: 1 }) })) as unknown as typeof fetch]
  ];

  for (const [label, fetchImpl] of cases) {
    it(`${label} leaves the built-in table intact`, async () => {
      const entries = await syncGatewayModelCapabilities({ gatewayUrl: 'https://gw.example', fetchImpl });
      expect(entries).toEqual([]);
      // Still the shipped profile — never degraded to the 8K default.
      expect(getModelCapabilities('bandit-core-2').supportsToolCalling).toBe(true);
    });
  }

  it('no gateway url is a no-op', async () => {
    expect(await syncGatewayModelCapabilities({ gatewayUrl: '' })).toEqual([]);
  });
});
