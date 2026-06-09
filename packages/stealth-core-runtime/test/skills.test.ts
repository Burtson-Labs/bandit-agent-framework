import { describe, expect, it } from 'vitest';
import {
  SkillRegistry,
  createDefaultSkillRegistry,
  coreSkill,
  gitSkill,
  codeReviewSkill,
  testGenSkill,
  planSkill,
  semanticSearchSkill
} from '@burtson-labs/agent-core';

describe('SkillRegistry', () => {
  it('registers and retrieves skills by id', () => {
    const registry = new SkillRegistry();
    registry.register(coreSkill);
    expect(registry.has('core/filesystem')).toBe(true);
    expect(registry.get('core/filesystem')?.name).toBe('Filesystem & Shell');
    expect(registry.size).toBe(1);
  });

  it('registerAll adds multiple skills', () => {
    const registry = new SkillRegistry();
    registry.registerAll([coreSkill, gitSkill]);
    expect(registry.size).toBe(2);
    expect(registry.has('core/filesystem')).toBe(true);
    expect(registry.has('core/git')).toBe(true);
  });

  it('getAll returns all registered skills', () => {
    const registry = new SkillRegistry();
    registry.registerAll([coreSkill, gitSkill]);
    const all = registry.getAll();
    expect(all).toHaveLength(2);
  });
});

describe('resolveActiveSkills', () => {
  it('always includes skills with activation: always', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('hello world');
    const ids = active.map((s) => s.id);
    expect(ids).toContain('core/filesystem');
    expect(ids).toContain('core/git');
  });

  it('auto-activates code review skill on "review" keyword', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('review my changes');
    const ids = active.map((s) => s.id);
    expect(ids).toContain('review/code-review');
  });

  it('auto-activates test skill on "test" keyword', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('write tests for the auth module');
    const ids = active.map((s) => s.id);
    expect(ids).toContain('testing/test-gen');
  });

  it('auto-activates plan skill on "refactor" keyword', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('refactor the authentication system');
    const ids = active.map((s) => s.id);
    expect(ids).toContain('agent/plan');
  });

  it('auto-activates semantic search on "how does" keyword', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('how is authentication implemented in this codebase?');
    const ids = active.map((s) => s.id);
    expect(ids).toContain('search/semantic');
  });

  it('does not activate auto skills when keywords are absent', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('add a button to the header');
    const ids = active.map((s) => s.id);
    expect(ids).not.toContain('review/code-review');
    expect(ids).not.toContain('testing/test-gen');
    expect(ids).not.toContain('agent/plan');
  });

  it('includes explicitly requested skills via include array', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('hello', ['review/code-review']);
    const ids = active.map((s) => s.id);
    expect(ids).toContain('review/code-review');
  });
});

describe('buildToolRegistry', () => {
  it('creates a ToolRegistry from active skills', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('hello');
    const toolRegistry = registry.buildToolRegistry(active);
    expect(toolRegistry.has('read_file')).toBe(true);
    expect(toolRegistry.has('write_file')).toBe(true);
    expect(toolRegistry.has('git_status')).toBe(true);
    expect(toolRegistry.has('git_diff')).toBe(true);
    expect(toolRegistry.size).toBeGreaterThanOrEqual(9);
  });

  it('includes review tools when code review skill is active', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('review my code');
    const toolRegistry = registry.buildToolRegistry(active);
    expect(toolRegistry.has('review_changes')).toBe(true);
  });

  it('includes test tools when test skill is active', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('write unit tests');
    const toolRegistry = registry.buildToolRegistry(active);
    expect(toolRegistry.has('run_tests')).toBe(true);
    expect(toolRegistry.has('list_test_files')).toBe(true);
  });

  it('includes plan tools when plan skill is active', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('refactor the database layer');
    const toolRegistry = registry.buildToolRegistry(active);
    expect(toolRegistry.has('create_plan')).toBe(true);
  });
});

describe('buildSkillPromptBlock', () => {
  it('generates a non-empty prompt block', () => {
    const registry = createDefaultSkillRegistry();
    const active = registry.resolveActiveSkills('review my code');
    const block = registry.buildSkillPromptBlock(active);
    expect(block).toContain('Active Skills');
    expect(block).toContain('Filesystem & Shell');
    expect(block).toContain('Git');
    expect(block).toContain('Code Review');
    expect(block).toContain('Available Tools');
  });

  it('returns empty string for no active skills', () => {
    const registry = new SkillRegistry();
    const block = registry.buildSkillPromptBlock([]);
    expect(block).toBe('');
  });
});

describe('built-in skills', () => {
  it('core skill has 11 tools including apply_edit, replace_range, apply_patch, watch_command, find_directory', () => {
    // read_file, write_file, apply_edit, replace_range, apply_patch,
    // list_files, ls, find_directory, search_code, run_command, watch_command.
    // apply_edit was added in v1.5.42 after a pburg-bowl trace showed
    // the extension system prompt advertised apply_edit while the
    // skill manifest omitted it — every call came back tool-not-found.
    // watch_command was added in . apply_patch was added in
    // (multi-file edit envelope). find_directory was added in
    // so the agent can locate sibling repos without asking the
    // user where they live. The assertion below is the guard: if
    // someone trims any of them from the skill, this fails BEFORE the
    // bug reaches production.
    expect(coreSkill.tools).toHaveLength(11);
    expect(coreSkill.activation).toBe('always');
    const names = coreSkill.tools.map(t => t.name);
    expect(names).toContain('ls');
    expect(names).toContain('apply_edit');
    expect(names).toContain('replace_range');
    expect(names).toContain('apply_patch');
    expect(names).toContain('watch_command');
    expect(names).toContain('find_directory');
  });

  it('git skill exposes the full toolset (v1.7.239 expanded from 4 → 9)', () => {
    expect(gitSkill.tools).toHaveLength(9);
    expect(gitSkill.activation).toBe('always');
    const names = gitSkill.tools.map((t) => t.name);
    // Original four.
    expect(names).toContain('git_status');
    expect(names).toContain('git_diff');
    expect(names).toContain('git_log');
    expect(names).toContain('git_commit');
    // Added in .
    expect(names).toContain('git_branch');
    expect(names).toContain('git_checkout');
    expect(names).toContain('git_stash');
    expect(names).toContain('git_pull');
    expect(names).toContain('git_push');
  });

  it('code review skill has 1 tool', () => {
    expect(codeReviewSkill.tools).toHaveLength(1);
    expect(codeReviewSkill.activation).toBe('auto');
    expect(codeReviewSkill.tools[0].name).toBe('review_changes');
  });

  it('test gen skill has 2 tools', () => {
    expect(testGenSkill.tools).toHaveLength(2);
    expect(testGenSkill.activation).toBe('auto');
  });

  it('plan skill has 1 tool', () => {
    expect(planSkill.tools).toHaveLength(1);
    expect(planSkill.activation).toBe('auto');
    expect(planSkill.tools[0].name).toBe('create_plan');
  });

  it('semantic search skill has 2 tools', () => {
    expect(semanticSearchSkill.tools).toHaveLength(2);
    expect(semanticSearchSkill.activation).toBe('auto');
  });

  it('all skills have required manifest fields', () => {
    const all = [coreSkill, gitSkill, codeReviewSkill, testGenSkill, planSkill, semanticSearchSkill];
    for (const skill of all) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(skill.description).toBeTruthy();
      expect(Array.isArray(skill.tools)).toBe(true);
      expect(skill.tools.length).toBeGreaterThan(0);
    }
  });
});
