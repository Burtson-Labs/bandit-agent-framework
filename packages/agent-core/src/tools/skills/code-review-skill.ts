/**
 * Code review skill — auto-activated when the user mentions reviewing, auditing, or checking code.
 *
 * Provides a review_changes tool that reads git diff and file contents together,
 * giving the model structured context for code review.
 */

import type { SkillManifest } from '../skill-types';
import type { AgentTool, ToolResult, ToolExecutionContext } from '../tool-types';

const reviewChangesTool: AgentTool = {
  name: 'review_changes',
  description: 'Review current git changes. Returns the diff along with the full content of each changed file for context.',
  parameters: [
    { name: 'staged', description: 'If "true", review staged changes. Otherwise reviews unstaged changes.' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const args = ['diff', '--stat', '--patch', '-U5'];
    if (params.staged === 'true') {
      args.push('--staged');
    }

    const diffResult = await ctx.runCommand('git', args, ctx.workspaceRoot);
    if (diffResult.exitCode !== 0) {
      return { output: diffResult.stderr || 'git diff failed.', isError: true };
    }

    const diff = diffResult.stdout.trim();
    if (!diff) {
      return { output: '(no changes to review)' };
    }

    // Extract changed file paths from the diff stat
    const nameResult = await ctx.runCommand(
      'git',
      ['diff', '--name-only', ...(params.staged === 'true' ? ['--staged'] : [])],
      ctx.workspaceRoot
    );
    const changedFiles = nameResult.stdout.trim().split('\n').filter(Boolean);

    // Read full content of each changed file (up to 5 files to stay within budget)
    const fileContents: string[] = [];
    for (const file of changedFiles.slice(0, 5)) {
      try {
        const absPath = `${ctx.workspaceRoot}/${file}`;
        const content = await ctx.readFile(absPath);
        const lines = content.split('\n');
        const numbered = lines.map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`).join('\n');
        fileContents.push(`--- ${file} (${lines.length} lines) ---\n${numbered}`);
      } catch {
        fileContents.push(`--- ${file} (could not read) ---`);
      }
    }

    const output = [
      '## Diff',
      diff,
      '',
      '## Changed Files (full content)',
      ...fileContents
    ].join('\n\n');

    return { output: output.slice(0, 80_000) };
  }
};

export const codeReviewSkill: SkillManifest = {
  id: 'review/code-review',
  name: 'Code Review',
  version: '1.0.0',
  description: 'Review git changes with full file context for thorough code review.',
  instructions: 'When reviewing code, use review_changes to see the diff alongside full file content. Look for bugs, security issues, style problems, and missing edge cases.',
  activation: 'auto',
  triggerPatterns: [/\breview\b/i, /\baudit\b/i, /\bcheck\s+(my|the|this)\s+(code|changes|diff)\b/i],
  tools: [reviewChangesTool]
};
