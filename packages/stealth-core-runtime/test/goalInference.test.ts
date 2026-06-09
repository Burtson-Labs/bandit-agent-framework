import { describe, expect, it } from 'vitest';
import { inferGoal } from '../src/goalInference';

describe('goalInference task synthesis', () => {
  it('keeps single-sentence goals as one primary task instead of splitting on plain "and"', async () => {
    const prompt = [
      'add a comment to the top of app.tsx for the core runtime that explains what the file does and pays homage to a legendary developer J',
      'Relevant files: apps/agent-ui-workbench/src/App.tsx, packages/stealth-core-runtime/src/runtime/additionalWrites.ts'
    ].join('\n');
    const workspaceIndex = [
      'apps/agent-ui-workbench/src/App.tsx',
      'packages/stealth-core-runtime/src/runtime/additionalWrites.ts',
      'apps/bandit-stealth-web/src/runtime/webRuntimeContext.tsx'
    ];

    const inferred = await inferGoal({ prompt, workspaceIndex });
    const tasks = inferred.tasks ?? [];
    const authoredTasks = tasks.filter((task) => task.title !== 'Review and validate changes');

    expect(authoredTasks).toHaveLength(1);
    expect(authoredTasks[0]?.title).toContain('Add a comment to the top of app.tsx');
    expect(authoredTasks[0]?.title.toLowerCase()).not.toContain('relevant files');
    expect(tasks.some((task) => task.title === 'Review and validate changes')).toBe(true);
  });

  it('preserves checklist prompts as distinct task suggestions', async () => {
    const prompt = [
      'Implement this feature:',
      '- add telemetry event counters',
      '- expose metrics in the UI',
      '- add validation for malformed event payloads'
    ].join('\n');

    const inferred = await inferGoal({
      prompt,
      workspaceIndex: ['apps/bandit-stealth/webview-v2/src/App.tsx']
    });

    const tasks = (inferred.tasks ?? []).filter((task) => task.title !== 'Review and validate changes');
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks.map((task) => task.title)).toEqual(
      expect.arrayContaining([
        'Add telemetry event counters',
        'Expose metrics in the UI',
        'Add validation for malformed event payloads'
      ])
    );
  });
});
