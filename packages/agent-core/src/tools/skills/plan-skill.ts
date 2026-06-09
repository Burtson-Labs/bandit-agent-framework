/**
 * Plan skill — auto-activated on complex multi-file tasks.
 *
 * Exposes plan generation as a tool within the tool-use loop.
 * This bridges the plan-based execution path into the agentic loop:
 * the model decides when to plan (complex tasks) vs. act directly (simple tasks).
 */

import type { SkillManifest } from '../skill-types';
import type { AgentTool, ToolResult, ToolExecutionContext } from '../tool-types';

const createPlanTool: AgentTool = {
  name: 'create_plan',
  description: 'Generate a structured execution plan for a complex multi-step task. Use this when the task requires coordinating changes across multiple files or systems. Returns a plan with numbered steps you should follow.',
  parameters: [
    { name: 'goal', description: 'Clear description of what needs to be accomplished', required: true },
    { name: 'context_files', description: 'Comma-separated list of relevant file paths to consider in the plan' }
  ],
  async execute(params, ctx: ToolExecutionContext): Promise<ToolResult> {
    const goal = params.goal?.trim();
    if (!goal) {return { output: 'Error: goal parameter is required', isError: true };}

    // Gather workspace context for the plan
    const contextFiles = params.context_files
      ? params.context_files.split(',').map((f) => f.trim()).filter(Boolean)
      : [];

    // Read each context file to give the plan generator information
    const fileContents: string[] = [];
    for (const file of contextFiles.slice(0, 5)) {
      try {
        const absPath =
          file.startsWith('/') ||
          file.startsWith('~') ||
          /^[A-Za-z]:[\\/]/.test(file) ||
          file.startsWith('\\\\')
            ? file
            : `${ctx.workspaceRoot}/${file}`;
        const content = await ctx.readFile(absPath);
        const lines = content.split('\n').length;
        const preview = content.slice(0, 2000);
        fileContents.push(`--- ${file} (${lines} lines) ---\n${preview}${content.length > 2000 ? '\n[truncated]' : ''}`);
      } catch {
        fileContents.push(`--- ${file} (could not read) ---`);
      }
    }

    // Build a structured plan using heuristic decomposition
    const steps = decomposeGoal(goal);
    const plan = {
      goal,
      steps: steps.map((step, i) => ({
        id: `step-${i + 1}`,
        title: step,
        status: 'pending'
      })),
      contextFiles,
      totalSteps: steps.length
    };

    const output = [
      `## Plan: ${goal}`,
      '',
      `**${plan.totalSteps} steps identified:**`,
      '',
      ...plan.steps.map((s) => `${s.id}. ${s.title}`),
      '',
      fileContents.length > 0 ? '**Context files reviewed:**' : '',
      ...fileContents.slice(0, 3).map((c) => c.split('\n')[0]),
      '',
      'Execute each step in order using the available tools (read_file, write_file, search_code, etc.).',
      'After completing all steps, verify the changes are correct.'
    ].filter(Boolean).join('\n');

    return { output };
  }
};

/**
 * Decompose a goal into actionable steps using simple heuristics.
 * This gives the model a structured starting point within the tool-use loop.
 */
function decomposeGoal(goal: string): string[] {
  const lower = goal.toLowerCase();

  // Check for explicit multi-part goals
  const delimiters = [/ and then /i, / then /i, /;\s*/,  / -> /];
  for (const delimiter of delimiters) {
    if (delimiter.test(goal)) {
      const parts = goal.split(delimiter).map((p) => p.trim()).filter(Boolean);
      if (parts.length > 1) {return parts;}
    }
  }

  // Common task patterns → step templates
  const steps: string[] = [];

  if (/\b(refactor|restructure|extract|split)\b/i.test(lower)) {
    steps.push(
      'Read the target file(s) to understand current structure',
      'Identify the code to extract or restructure',
      'Create new file(s) if needed',
      'Move or refactor the identified code',
      'Update imports and references in dependent files',
      'Verify no broken imports with search_code'
    );
  } else if (/\b(fix|bug|error|broken)\b/i.test(lower)) {
    steps.push(
      'Read the file containing the bug',
      'Search for related error patterns or failing tests',
      'Identify the root cause',
      'Apply the fix',
      'Verify the fix resolves the issue'
    );
  } else if (/\b(add|implement|create|build|feature)\b/i.test(lower)) {
    steps.push(
      'Read existing related files to understand patterns',
      'Create new file(s) for the feature',
      'Implement the core logic',
      'Wire up imports and exports',
      'Add any necessary configuration or setup'
    );
  } else if (/\b(test|spec)\b/i.test(lower)) {
    steps.push(
      'Read the source file to understand what needs testing',
      'Find existing test files for patterns',
      'Write test cases covering main scenarios',
      'Run tests to verify they pass'
    );
  } else {
    // Generic decomposition
    steps.push(
      'Explore relevant files to understand context',
      'Plan the specific changes needed',
      'Implement the changes',
      'Verify the changes are correct'
    );
  }

  return steps;
}

export const planSkill: SkillManifest = {
  id: 'agent/plan',
  name: 'Plan',
  version: '1.0.0',
  description: 'Generate structured execution plans for complex multi-step tasks.',
  instructions: 'For complex tasks that touch multiple files, use create_plan first to break the work into steps. For simple single-file tasks, skip planning and use tools directly.',
  activation: 'auto',
  triggerPatterns: [
    /\brefactor\b/i,
    /\bmulti.?file\b/i,
    /\bmigrat/i,
    /\brestructure\b/i,
    /\barchitect/i,
    /\boverhaul\b/i,
    /\breorganize\b/i
  ],
  tools: [createPlanTool]
};
