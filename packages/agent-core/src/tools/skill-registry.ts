/**
 * SkillRegistry — manages skill discovery, activation, and tool assembly.
 *
 * Builds on top of ToolRegistry. Skills are the unit of extensibility;
 * ToolRegistry remains the unit of execution (what ToolUseLoop consumes).
 */

import type { SkillManifest } from './skill-types';
import { ToolRegistry } from './tool-registry';

export class SkillRegistry {
  private readonly skills = new Map<string, SkillManifest>();

  register(skill: SkillManifest): this {
    if (this.skills.has(skill.id)) {
      console.warn(`[SkillRegistry] Overwriting existing skill "${skill.id}"`);
    }
    this.skills.set(skill.id, skill);
    return this;
  }

  registerAll(skills: SkillManifest[]): this {
    for (const skill of skills) {
      this.register(skill);
    }
    return this;
  }

  get(id: string): SkillManifest | undefined {
    return this.skills.get(id);
  }

  getAll(): SkillManifest[] {
    return [...this.skills.values()];
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  get size(): number {
    return this.skills.size;
  }

  /**
   * Resolve which skills should be active for a given user prompt.
   *
   * Returns all 'always' skills plus any 'auto' skills whose triggerPatterns
   * match the prompt. 'on-demand' skills are excluded unless explicitly listed
   * in the `include` array.
   */
  resolveActiveSkills(prompt: string, include?: string[]): SkillManifest[] {
    const includeSet = new Set(include ?? []);
    const active: SkillManifest[] = [];

    for (const skill of this.skills.values()) {
      if (skill.activation === 'always') {
        active.push(skill);
        continue;
      }
      if (includeSet.has(skill.id)) {
        active.push(skill);
        continue;
      }
      if (skill.activation === 'auto' && skill.triggerPatterns?.length) {
        const matches = skill.triggerPatterns.some((pattern) => pattern.test(prompt));
        if (matches) {
          active.push(skill);
        }
      }
    }

    return active;
  }

  /**
   * Build a ToolRegistry containing all tools from the given active skills.
   * Logs a warning on tool name collisions (last skill wins).
   */
  buildToolRegistry(activeSkills: SkillManifest[]): ToolRegistry {
    return this.buildToolRegistryWithMap(activeSkills).registry;
  }

  /**
   * Build a ToolRegistry plus a map of tool name → owning skill id so callers
   * can surface skill-level context (e.g. "using skill: Linter") when a tool runs.
   */
  buildToolRegistryWithMap(activeSkills: SkillManifest[]): {
    registry: ToolRegistry;
    toolToSkill: Map<string, string>;
  } {
    const registry = new ToolRegistry();
    const toolToSkill = new Map<string, string>();

    for (const skill of activeSkills) {
      for (const tool of skill.tools) {
        const existing = toolToSkill.get(tool.name);
        if (existing) {
          console.warn(
            `[SkillRegistry] Tool "${tool.name}" from skill "${skill.id}" ` +
            `overwrites same-named tool from "${existing}"`
          );
        }
        registry.register(tool);
        toolToSkill.set(tool.name, skill.id);
      }
    }

    return { registry, toolToSkill };
  }

  /**
   * Build system prompt section describing active skills and their tools.
   * Includes skill instructions and delegates tool definitions to ToolRegistry.
   */
  buildSkillPromptBlock(activeSkills: SkillManifest[]): string {
    if (activeSkills.length === 0) {return '';}

    const skillDescriptions = activeSkills.map((skill) => {
      const header = `- **${skill.name}** (v${skill.version}): ${skill.description}`;
      return skill.instructions ? `${header}\n  ${skill.instructions}` : header;
    }).join('\n');

    const registry = this.buildToolRegistry(activeSkills);
    const toolBlock = registry.buildSystemPromptBlock();

    return [
      '## Active Skills',
      '',
      skillDescriptions,
      '',
      toolBlock
    ].join('\n');
  }
}
