import { describe, expect, it } from 'vitest';
import { contextWindowProblem, resolveModelRuntime, type RunnerProvider } from '../src/__eval__/runner';

const chat: RunnerProvider['chat'] = async function* () { yield 'x'; };
const provider = (kind: RunnerProvider['kind'], model: string): RunnerProvider =>
  ({ kind, model, settings: {} as RunnerProvider['settings'], chat });

describe('eval runner: the model is driven the way production drives it', () => {
  it('refuses a context window the prompt and tool schemas do not fit', () => {
    // Measured on the 26-fixture run: 12.8k chars of system prompt + 22.6k of tool schemas
    // (8,099 tokens for qwen3) against the 8,192-token fallback window.
    expect(contextWindowProblem(12_781, 22_558, 8192)).toMatch(/about 8835 tokens.*8192-token/);
    expect(contextWindowProblem(12_781, 22_558, 24_576)).toBeNull();
    expect(contextWindowProblem(12_781, 0, 8192)).toBeNull();
    expect(contextWindowProblem(12_781, 22_558, undefined)).toBeNull();
  });

  it('resolves tool channel, window and loop limits from the capability tables', async () => {
    const known = await resolveModelRuntime(provider('ollama', 'qwen3.6:27b'));
    expect(known).toMatchObject({ nativeTools: true, numCtx: 32768, tier: 'large', messageTokenBudget: 24576, maxParallelTools: 6, compactToolBlock: false });
    const medium = await resolveModelRuntime(provider('ollama', 'gemma4:12b-it-qat'));
    expect(medium).toMatchObject({ nativeTools: true, numCtx: 24576, tier: 'medium' });
  });

  it('uses the hosted compaction budget when the window is not ours to set', async () => {
    const hosted = await resolveModelRuntime(provider('bandit', 'bandit-logic'));
    expect(hosted.numCtx).toBeUndefined();
    expect(hosted.messageTokenBudget).toBe(24576);
  });

  it('resolves once per provider', () => {
    const p = provider('ollama', 'qwen3.6:27b');
    expect(resolveModelRuntime(p)).toBe(resolveModelRuntime(p));
  });
});
