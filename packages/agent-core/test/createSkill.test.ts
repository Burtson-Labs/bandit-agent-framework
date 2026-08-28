/**
 * `create_skill` makes skill authoring a first-class, discoverable capability.
 *
 * Models — bandit-core-2 especially — kept answering "I can't create a skill /
 * I don't have a tool for that" when asked to build one, because they equate
 * "no tool named X" with "can't do X". A real tool ends the debate: the answer
 * to "do you have a write-skill tool?" is now yes.
 *
 * These pin the file it writes (valid frontmatter the loader can read back) and
 * the id/trigger handling.
 */
import { describe, it, expect } from 'vitest';
import { createSkillTool, toSkillId, buildSkillMarkdown, createCoreToolRegistry } from '../src/tools/core-tools';
import { parseMarkdownSkill } from '../src/tools/skill-loader';
import type { ToolExecutionContext } from '../src/tools/tool-types';

function buildCtx(files: Map<string, string>): ToolExecutionContext {
  return {
    workspaceRoot: '/ws',
    async readFile(p) { return files.get(p) ?? ''; },
    async writeFile(p, content) { files.set(p, content); },
    async listFiles() { return []; },
    async searchCode() { return ''; },
    async runCommand() { return { stdout: '', stderr: '', exitCode: 0 }; },
  };
}

describe('create_skill tool is registered', () => {
  it('is part of the core tool registry so the model always has it', () => {
    const names = createCoreToolRegistry().getAll().map((t) => t.name);
    expect(names).toContain('create_skill');
  });
});

describe('toSkillId', () => {
  it('kebab-cases a human name', () => {
    expect(toSkillId('PDF Generator')).toBe('pdf-generator');
    expect(toSkillId('  Weird__Name!! ')).toBe('weird-name');
    expect(toSkillId('already-kebab')).toBe('already-kebab');
  });
  it('never returns empty', () => {
    expect(toSkillId('!!!')).toBe('skill');
    expect(toSkillId('')).toBe('skill');
  });
});

describe('buildSkillMarkdown', () => {
  it('produces frontmatter the skill loader can parse back', () => {
    const md = buildSkillMarkdown({
      id: 'pdf-generator',
      name: 'PDF Generator',
      description: 'Use when the user wants a PDF or Word document',
      instructions: 'Write an fpdf2 script and run it with run_command.',
      triggers: ['pdf', 'word doc', 'export'],
      activation: 'auto',
    });
    // Round-trips through the real loader — the strongest guarantee it's valid.
    const parsed = parseMarkdownSkill(md, 'pdf-generator.md');
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe('pdf-generator');
    expect(parsed!.name).toBe('PDF Generator');
    expect(parsed!.activation).toBe('auto');
    // Multi-word triggers are quoted so the YAML list stays valid.
    expect(md).toContain('triggers: [pdf, "word doc", export]');
  });

  it('adds a heading only when the body lacks one', () => {
    const withOwn = buildSkillMarkdown({ id: 'x', name: 'X', description: 'd', instructions: '# Mine\n\nbody' });
    expect(withOwn).toContain('# Mine');
    expect(withOwn).not.toContain('# X\n');

    const without = buildSkillMarkdown({ id: 'x', name: 'X', description: 'd', instructions: 'just body' });
    expect(without).toContain('# X');
  });

  it('omits the triggers line when there are none', () => {
    const md = buildSkillMarkdown({ id: 'x', name: 'X', description: 'd', instructions: 'b' });
    expect(md).not.toContain('triggers:');
  });
});

describe('createSkillTool.execute', () => {
  it('writes a valid skill to .bandit/skills/<id>.md', async () => {
    const files = new Map<string, string>();
    const result = await createSkillTool.execute(
      {
        name: 'PDF Generator',
        description: 'Use when the user wants a PDF',
        instructions: 'Write an fpdf2 script; run it with run_command.',
        triggers: 'pdf, word doc',
      },
      buildCtx(files),
    );
    expect(result.isError).toBeFalsy();
    const written = files.get('/ws/.bandit/skills/pdf-generator.md');
    expect(written).toBeDefined();
    expect(parseMarkdownSkill(written!, 'pdf-generator.md')!.name).toBe('PDF Generator');
    // The result tells the user how to activate it.
    expect(result.output).toMatch(/\/skill reload/);
    expect(result.output).toContain('pdf-generator.md');
  });

  it('honors an explicit id and activation', async () => {
    const files = new Map<string, string>();
    await createSkillTool.execute(
      { name: 'My Thing', id: 'custom-id', activation: 'on-demand', description: 'd', instructions: 'b' },
      buildCtx(files),
    );
    expect(files.has('/ws/.bandit/skills/custom-id.md')).toBe(true);
    expect(files.get('/ws/.bandit/skills/custom-id.md')).toContain('activation: on-demand');
  });

  it('rejects missing required fields with a clear message', async () => {
    const ctx = buildCtx(new Map());
    expect((await createSkillTool.execute({ description: 'd', instructions: 'b' }, ctx)).isError).toBe(true);
    expect((await createSkillTool.execute({ name: 'n', instructions: 'b' }, ctx)).isError).toBe(true);
    const noBody = await createSkillTool.execute({ name: 'n', description: 'd' }, ctx);
    expect(noBody.isError).toBe(true);
    expect(noBody.output).toMatch(/playbook/i);
  });
});
