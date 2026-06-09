/**
 * Skill types for the Bandit agent framework.
 *
 * A skill is a named, versioned group of tools with activation logic.
 * Skills compose naturally with the existing ToolRegistry and ToolUseLoop —
 * they're the unit of extensibility for the agent.
 */

import type { AgentTool } from './tool-types';

export interface SkillManifest {
  /** Unique skill identifier (e.g. "core/filesystem", "git/basics"). */
  id: string;
  /** Human-readable name for UI display. */
  name: string;
  /** Semver version string. */
  version: string;
  /** One-line description shown in the system prompt when the skill is active. */
  description: string;
  /**
   * Extended instructions injected into the system prompt when the skill is active.
   * Use this to give the model guidance on when and how to use this skill's tools.
   */
  instructions?: string;
  /** Tools this skill provides. */
  tools: AgentTool[];
  /**
   * When to activate this skill:
   * - 'always': Active in every conversation (core tools, git).
   * - 'auto': Activated when triggerPatterns match the user prompt.
   * - 'on-demand': Only activated when explicitly requested.
   */
  activation: 'always' | 'auto' | 'on-demand';
  /**
   * Regex patterns matched against the user prompt for auto-activation.
   * Only used when activation is 'auto'. Any match activates the skill.
   */
  triggerPatterns?: RegExp[];
}
