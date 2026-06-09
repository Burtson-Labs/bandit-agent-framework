/**
 * Ollama integration test — runs a fixed prompt against a real local Ollama
 * model and asserts the agent uses expected tool(s). Gated on reachability:
 * if Ollama isn't running at OLLAMA_URL, the test exits 0 with a skip message.
 *
 * Run locally:
 *   OLLAMA_URL=http://localhost:11434 BANDIT_INTEGRATION_MODEL=qwen2.5:0.5b \
 *     npm run integration
 *
 * In CI — wire via workflow_dispatch or scheduled cron so we don't hit Ollama
 * on every PR. The pipeline.yaml `test` job does NOT call this.
 *
 * Fixture design principles:
 *   - One fixture per "user intent". Keep them short; small models struggle
 *     with multi-turn reasoning.
 *   - Assertions run against the agent's event stream, NOT the final prose
 *     (which varies between models). We check which tools fired.
 *   - Workspace is a tempdir seeded with deterministic files so outcomes
 *     are reproducible.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createDefaultSkillRegistry,
  createDefaultLanguageAdapters,
  createToolUseLoop,
  type ToolLoopMessage
} from '@burtson-labs/agent-core';
import { createProvider } from '@burtson-labs/stealth-core-runtime';
import { CliToolExecutionContext } from '../cliToolContext';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.BANDIT_INTEGRATION_MODEL ?? 'qwen2.5:0.5b';
const TIMEOUT_MS = 90_000;

interface Fixture {
  name: string;
  prompt: string;
  seed: Record<string, string>;  // files to create in the temp workspace
  expectTools: string[];          // tools that must have fired at least once
  expectNoTools?: string[];       // tools that must NOT have fired
}

const FIXTURES: Fixture[] = [
  {
    name: 'reads a file when asked to summarize',
    prompt: 'Read hello.txt and tell me what it says.',
    seed: { 'hello.txt': 'the quick brown fox jumps over the lazy dog' },
    expectTools: ['read_file']
  },
  {
    name: 'lists files when asked to enumerate',
    prompt: 'List the files in this workspace.',
    seed: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' },
    expectTools: ['list_files']
  }
];

async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function hasModel(model: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json() as { models?: { name: string }[] };
    return (data.models ?? []).some(m => m.name.startsWith(model));
  } catch {
    return false;
  }
}

async function runFixture(fx: Fixture): Promise<{ ok: boolean; toolsFired: Set<string>; error?: string }> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bandit-int-'));
  const toolsFired = new Set<string>();
  try {
    for (const [rel, content] of Object.entries(fx.seed)) {
      await fs.promises.writeFile(path.join(tmp, rel), content);
    }

    const toolCtx = new CliToolExecutionContext(tmp, createDefaultLanguageAdapters());
    const skillRegistry = createDefaultSkillRegistry();
    const activeSkills = skillRegistry.resolveActiveSkills(fx.prompt);
    const { registry } = skillRegistry.buildToolRegistryWithMap(activeSkills);

    const provider = await createProvider({ kind: 'ollama', ollamaUrl: OLLAMA_URL, ollamaModel: MODEL });
    const chat = async function* (messages: ToolLoopMessage[]) {
      for await (const chunk of provider.chat({
        model: MODEL,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        temperature: 0
      })) {
        const text = chunk.message?.content ?? '';
        if (text) yield text;
        if (chunk.done) break;
      }
    };

    const loop = createToolUseLoop(registry, toolCtx, {
      maxIterations: 4,
      emitEvent: (type, payload) => {
        if (type === 'tool_loop:tool_execute') {
          const p = payload as { name?: string };
          if (p?.name) toolsFired.add(p.name);
        }
      }
    });

    await Promise.race([
      loop.run(fx.prompt, chat, 'You are a terse test agent. Use tools when needed and keep responses under 30 words.'),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS))
    ]);

    const missing = fx.expectTools.filter(t => !toolsFired.has(t));
    const unexpected = (fx.expectNoTools ?? []).filter(t => toolsFired.has(t));
    const ok = missing.length === 0 && unexpected.length === 0;
    const error = ok ? undefined : [
      missing.length ? `missing: ${missing.join(', ')}` : '',
      unexpected.length ? `unexpected: ${unexpected.join(', ')}` : ''
    ].filter(Boolean).join('; ');
    return { ok, toolsFired, error };
  } catch (err) {
    return { ok: false, toolsFired, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!(await isOllamaReachable())) {
    process.stdout.write(`⊘ integration test skipped — Ollama not reachable at ${OLLAMA_URL}\n`);
    process.exit(0);
  }
  if (!(await hasModel(MODEL))) {
    process.stdout.write(`⊘ integration test skipped — model ${MODEL} not pulled (run: ollama pull ${MODEL})\n`);
    process.exit(0);
  }

  process.stdout.write(`▸ running ${FIXTURES.length} integration fixture(s) against ${MODEL}…\n`);

  let failed = 0;
  for (const fx of FIXTURES) {
    process.stdout.write(`  · ${fx.name} `);
    const r = await runFixture(fx);
    if (r.ok) {
      process.stdout.write(`✓ (${[...r.toolsFired].join(', ') || 'no tools'})\n`);
    } else {
      failed++;
      process.stdout.write(`✗ ${r.error ?? 'unknown failure'} — fired: ${[...r.toolsFired].join(', ') || 'none'}\n`);
    }
  }

  if (failed > 0) {
    process.stderr.write(`\n${failed}/${FIXTURES.length} fixture(s) failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\n✓ all ${FIXTURES.length} integration fixture(s) passed\n`);
}

main().catch((err) => {
  process.stderr.write(`integration test crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
