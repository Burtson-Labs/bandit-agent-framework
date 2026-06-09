/**
 * `composeAgentSystemPrompt` — build the system prompt that the
 * tool-use loop hands to the model (and that subagents inherit
 * verbatim via `parentPromptHolder`).
 *
 * Three layers concatenated in order:
 *
 *  1. **`baseSystemPrompt`** — the model/provider-aware identity,
 *     tool-format, and Working Style block. Resolved via the layered
 *     `buildSystemPrompt` helper which factors in the model id,
 *     provider kind, user goal, and the gathered workspace context
 *     (file tree, recent edits, anything the ContextBuilder surfaces).
 *  2. **`memoryBlock`** — the project memory bundle wrapped in a
 *     `## Project Memory` heading when non-empty. Omitted entirely
 *     when memory is empty so we don't emit a bare header.
 *  3. **`skillInstructions`** — active skill descriptions formatted
 *     as `### {skill.name}\n{skill.instructions}`, joined with blank
 *     lines, wrapped in `## Active Skills`. Skill authoring is gated
 *     by the userGoal heuristic in the runtime builder, so the
 *     block only inflates the prompt when a skill match fires.
 *
 * Why this lives in its own helper: the assembly used to inline ~24
 * lines of string-template + filter+map into performToolUseCompletion.
 * Two readers consume it (the parent loop's `systemPrompt` arg to
 * `loop.runWithMessages`, and the subagent spawn through
 * `parentPromptHolder.current`). Extracting puts the layering rules
 * in one place so a future change (e.g. moving operational hints
 * back inline) lands in one file instead of three.
 *
 * The `buildContextBlock` callback flows in instead of being imported
 * because the provider's implementation needs access to the workspace's
 * ContextBuilder + recent-edits state — neither lives on
 * ProviderContext yet. The catch-and-return-undefined behavior matches
 * the original inline call: a context-build failure (transient disk
 * IO, malformed file) should not abort the turn, just degrade the
 * prompt by omitting the workspace context block.
 */
import type * as vscode from 'vscode';
import type { ProviderKind } from '@burtson-labs/stealth-core-runtime';
import { buildSystemPrompt } from '../helpers/systemPrompt';

interface SkillLike {
  name: string;
  instructions?: string;
}

interface MemoryBundleLike {
  content: string;
}

export interface AgentSystemPromptDeps {
  userGoal: string;
  configuration: vscode.WorkspaceConfiguration;
  providerKind: ProviderKind;
  model: string;
  activeSkills: readonly SkillLike[];
  memoryBundle: MemoryBundleLike;
  buildContextBlock: (
    prompt: string,
    configuration: vscode.WorkspaceConfiguration
  ) => Promise<{ formatted?: string } | undefined>;
}

export async function composeAgentSystemPrompt(deps: AgentSystemPromptDeps): Promise<string> {
  const { userGoal, configuration, providerKind, model, activeSkills, memoryBundle, buildContextBlock } = deps;

  const contextResult = await buildContextBlock(userGoal, configuration).catch(() => undefined);
  const baseSystemPrompt = buildSystemPrompt({
    providerKind,
    configuration,
    contextBlock: contextResult?.formatted,
    modelIdOverride: model,
    userGoal
  });

  const skillInstructions = activeSkills
    .filter((s) => s.instructions)
    .map((s) => `### ${s.name}\n${s.instructions}`)
    .join('\n\n');
  const memoryBlock = memoryBundle.content
    ? `\n\n## Project Memory\n\n${memoryBundle.content}`
    : '';

  return skillInstructions
    ? `${baseSystemPrompt}${memoryBlock}\n\n## Active Skills\n\n${skillInstructions}`
    : `${baseSystemPrompt}${memoryBlock}`;
}
