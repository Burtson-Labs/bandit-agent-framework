/**
 * Bandit-completion utilities extracted from extension.ts.
 *
 * Why: extension.ts crossed 9k lines and bandit's self-evaluation
 * flagged it as monolithic. The completion subgraph had a layered
 * shape: a few class-bound methods at the top (`runBanditCompletion`
 * needs `this.context.secrets` to fetch the Ollama auth token) wrapped
 * around several genuinely pure helpers (`collectCompletionResult`,
 * `extractJsonObject`, `truncateForFeedback`) plus the prompt
 * builders for the two completions-fallback flows.
 *
 * The pure helpers come out wholesale; the stateful orchestrators
 * (`runBanditCompletion`, `requestIntentViaCompletions`,
 * `submitFeedbackViaCompletions`) stay on the class but shrink
 * substantially once they delegate the prompt building + JSON parsing
 * + truncation here.
 */
import type { AIChatRequest, ProviderKind } from '@burtson-labs/stealth-core-runtime';
import type { ModeKind } from '../services/conversationTypes';
import type { FeedbackRequest } from '../agentTypes';

/**
 * Iterate a streaming chat provider response and return the fully
 * aggregated content. Stops at the first chunk with `done: true` so
 * the caller doesn't pay for trailing keepalives. Returns the
 * concatenated content trimmed of leading/trailing whitespace.
 */
export async function collectCompletionResult<T extends { chat: (request: AIChatRequest) => AsyncIterable<{ message?: { content?: string }; done?: boolean } | undefined> }>(
  provider: T,
  request: AIChatRequest
): Promise<string> {
  let buffer = '';
  for await (const chunk of provider.chat(request)) {
    if (!chunk) {
      continue;
    }
    const content = typeof chunk.message?.content === 'string' ? chunk.message.content : '';
    if (content) {
      buffer += content;
    }
    if (chunk.done) {
      break;
    }
  }
  return buffer.trim();
}

/**
 * Best-effort JSON object extraction from arbitrary model output.
 * Tries (in order): a ```json fenced block, any ``` fenced block,
 * the substring between the first `{` and last `}`, and finally the
 * raw text. Returns the first candidate that parses as a non-null
 * object. Used for parsing the JSON-only responses we ask intent and
 * feedback fallbacks for.
 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) {
    return undefined;
  }

  const candidates: string[] = [];
  const fencedJson = normalized.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) {
    candidates.push(fencedJson[1]);
  }
  const genericFence = normalized.match(/```\s*([\s\S]*?)```/);
  if (genericFence?.[1]) {
    candidates.push(genericFence[1]);
  }
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(normalized);

  for (const candidate of Array.from(new Set(candidates))) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore parse errors and continue trying other candidates
    }
  }

  return undefined;
}

/**
 * Trim a free-form string for inclusion in a feedback / context
 * snippet — empty in / out is OK, otherwise cap at `maxLength` with
 * a trailing ellipsis. Distinct from generic `truncate` because the
 * default cap (1800) is calibrated for feedback payloads, not chat
 * snippets.
 */
export function truncateForFeedback(text: string, maxLength = 1800): string {
  const normalized = typeof text === 'string' ? text.trim() : '';
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export interface IntentClassificationContext {
  mode: ModeKind;
  filePath?: string;
  languageId?: string;
  selection?: string;
  workspace?: string;
}

/**
 * Build the system+user message pair sent to the bandit cloud
 * completions endpoint when the dedicated `/intent` route is
 * unavailable. Output schema is documented inline so the model
 * always produces parseable JSON.
 */
export function buildIntentClassificationMessages(
  prompt: string,
  context: IntentClassificationContext
): AIChatRequest['messages'] {
  const selectionSnippet = context.selection ? truncateForFeedback(context.selection, 600) : undefined;
  const contextParts = [
    `Mode: ${context.mode}`,
    context.workspace ? `Workspace: ${context.workspace}` : undefined,
    context.filePath ? `File path: ${context.filePath}` : undefined,
    context.languageId ? `Language: ${context.languageId}` : undefined,
    selectionSnippet ? `Selected text:\n${selectionSnippet}` : undefined
  ].filter((value): value is string => Boolean(value));

  return [
    {
      role: 'system',
      content: [
        'You are an intent classification module for the Bandit Stealth VS Code extension.',
        'Analyze the user prompt and output a JSON object describing the intent.',
        'Output schema:',
        '{',
        '  "action": string,         // required action label such as "explain_code", "update_file", or "general_assist"',
        '  "target": string|null,    // optional target file, component, or concept',
        '  "intent": string|null,    // optional natural language paraphrase of the user goal',
        '  "summary": string|null,   // optional short summary for UI display',
        '  "confidence": number,     // confidence between 0 and 1',
        '  "rationale": string|null  // optional reasoning for the classification',
        '}',
        'Always include the "action" key and clamp confidence to the 0–1 range.',
        'Respond with JSON only. Do not include prose or code fences.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `User prompt:\n${prompt}`,
        contextParts.length > 0 ? `Context:\n${contextParts.join('\n')}` : undefined,
        'Return the JSON object now.'
      ].filter((value): value is string => Boolean(value)).join('\n\n')
    }
  ];
}

/**
 * Build the system+user message pair sent to the bandit cloud
 * completions endpoint when the dedicated `/feedback` route is
 * unavailable. The model triages the feedback into a short JSON
 * summary we can later forward to a human.
 */
export function buildFeedbackTriageMessages(payload: FeedbackRequest): AIChatRequest['messages'] {
  return [
    {
      role: 'system',
      content: [
        'You triage feedback for the Bandit Stealth VS Code assistant.',
        'Summarize the provided feedback into JSON for later review.',
        'Output schema:',
        '{',
        '  "summary": string,',
        '  "category": string,',
        '  "priority": string,',
        '  "actionItems": string[]',
        '}',
        'Respond with JSON only. Do not include explanations or code fences.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        'Feedback payload:',
        JSON.stringify(payload, null, 2),
        'Summarize and categorize this feedback.'
      ].join('\n\n')
    }
  ];
}

// Re-export ProviderKind so callers using these helpers don't have
// to add a separate import line.
export type { ProviderKind };
