/**
 * Burtson Training Studio — canonical training example (contract v1).
 *
 * OpenAI-style chat with native tool calls: maps 1:1 onto the Qwen3 /
 * Hermes tool templates that Ollama, vLLM and llama.cpp serve, and onto
 * Bandit's own native-tools channel.
 */

export type ExampleSource = 'cli-session' | 'stealth-web' | 'banditbench' | 'mongo-stealth';
export type ExampleStatus = 'completed' | 'failed' | 'blocked' | 'cancelled' | 'unknown';

export interface NativeToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, Record<string, unknown>>; required: string[] };
  };
}

export interface CanonicalToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type CanonicalMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning?: string; tool_calls?: CanonicalToolCall[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export interface ExampleLabels {
  hitLimit: boolean;
  permissionDenials: number;
  retries: number;
  compactions: number;
  toolCalls: number;
  toolErrors: number;
  passed: boolean | null;
  failureReasons?: string[];
  fixtureId?: string;
  /** Prior turns of the same session included as context (prompt + final answer only). */
  historyTurns?: number;
}

export type RedactionKind = 'secret' | 'email' | 'phone' | 'path' | 'client' | 'person' | 'entropy' | 'file';

export interface ScrubInfo {
  version: 'scrub-v1';
  redactions: Record<RedactionKind, number>;
  dropped: boolean;
}

export interface TrainingExample {
  id: string;
  source: ExampleSource;
  sourceRef: string;
  createdAt: string;
  model: string | null;
  status: ExampleStatus;
  labels: ExampleLabels;
  tools: NativeToolSchema[];
  messages: CanonicalMessage[];
  scrub: ScrubInfo;
  split: 'train' | 'eval' | null;
}

export type DropReason =
  | 'email-or-calendar-tools'
  | 'client-document-tools'
  | 'imported-transcript'
  | 'too-many-secrets'
  | 'no-assistant-output'
  | 'unparseable'
  | 'duplicate';

export interface DroppedExample {
  ref: string;
  source: ExampleSource;
  reason: DropReason;
  detail?: string;
}

export function emptyRedactions(): Record<RedactionKind, number> {
  return { secret: 0, email: 0, phone: 0, path: 0, client: 0, person: 0, entropy: 0, file: 0 };
}

export function emptyLabels(): ExampleLabels {
  return { hitLimit: false, permissionDenials: 0, retries: 0, compactions: 0, toolCalls: 0, toolErrors: 0, passed: null };
}
