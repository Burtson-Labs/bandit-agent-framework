/**
 * `eval --trace-out <dir>`: one file per run holding the full transcript in the
 * Training Studio canonical format (training/types.ts). Fixtures are synthetic, so
 * these traces are PII-free verifiable-reward data: `labels.passed` and
 * `labels.failureReasons` come straight from the fixture assertions.
 * `bandit train collect` picks them up from ~/.bandit/training/banditbench-traces.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ToolLoopMessage } from '@burtson-labs/agent-core';
import { convertTranscript } from '../training/protocol';
import { exampleId } from '../training/build';
import { emptyLabels, emptyRedactions, type NativeToolSchema, type TrainingExample } from '../training/types';

export interface RunTraceInput {
  fixtureId: string;
  runNumber: number;
  model: string;
  systemPrompt: string;
  tools: NativeToolSchema[];
  messages: ToolLoopMessage[];
  hitLimit: boolean;
  passed: boolean;
  failureReasons: string[];
  /** The run's sandbox directory. Replaced by a stable project path in the trace so the
   *  training data doesn't teach the model throwaway temp-dir names. */
  workspaceRoot?: string;
}

/** Stable stand-in for the eval sandbox in training traces. */
export const TRACE_WORKSPACE = '~/projects/app';

function normalizeWorkspace<T>(value: T, root: string | undefined): T {
  if (!root) return value;
  const variants = [root, root.replace(/^\/private(?=\/)/, ''), `/private${root}`];
  const swap = (text: string): string => variants.reduce((acc, v) => acc.split(v).join(TRACE_WORKSPACE), text);
  return JSON.parse(swap(JSON.stringify(value))) as T;
}

export function buildRunTrace(input: RunTraceInput, now = new Date()): TrainingExample {
  const { messages, stats } = convertTranscript(normalizeWorkspace(input.messages.filter(m => m.role !== 'system'), input.workspaceRoot));
  const labels = emptyLabels();
  labels.hitLimit = input.hitLimit;
  labels.toolCalls = stats.toolCalls;
  labels.toolErrors = stats.toolErrors;
  labels.passed = input.passed;
  labels.failureReasons = input.failureReasons;
  labels.fixtureId = input.fixtureId;
  const canonical = [{ role: 'system' as const, content: normalizeWorkspace(input.systemPrompt, input.workspaceRoot) }, ...messages];
  return {
    id: exampleId(canonical),
    source: 'banditbench',
    sourceRef: `banditbench/${input.fixtureId}#${input.runNumber}`,
    createdAt: now.toISOString(),
    model: input.model,
    status: input.hitLimit ? 'failed' : 'completed',
    labels,
    tools: input.tools,
    messages: canonical,
    scrub: { version: 'scrub-v1', redactions: emptyRedactions(), dropped: false },
    split: null
  };
}

export async function writeRunTrace(dir: string, input: RunTraceInput): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true });
  const trace = buildRunTrace(input);
  const safeModel = input.model.replace(/[^A-Za-z0-9._-]+/g, '_');
  const file = path.join(dir, `${input.fixtureId}-${safeModel}-run${input.runNumber}-${Date.now()}.json`);
  await fs.promises.writeFile(file, JSON.stringify(trace), 'utf8');
  return file;
}
