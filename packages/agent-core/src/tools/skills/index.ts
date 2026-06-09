export { coreSkill } from './core-skill';
export { gitSkill } from './git-skill';
export { codeReviewSkill } from './code-review-skill';
export { testGenSkill } from './test-gen-skill';
export { planSkill } from './plan-skill';
export { semanticSearchSkill, configureSemanticSearchOllamaUrl, resetSemanticIndex } from './semantic-search-skill';
export { mailSearchSkill } from './mail-search-skill';
// Host-opt-in only (not in createDefaultSkillRegistry — see interaction-skill).
export { interactionSkill } from './interaction-skill';

import { SkillRegistry } from '../skill-registry';
import { coreSkill } from './core-skill';
import { gitSkill } from './git-skill';
import { codeReviewSkill } from './code-review-skill';
import { testGenSkill } from './test-gen-skill';
import { planSkill } from './plan-skill';
import { semanticSearchSkill } from './semantic-search-skill';
import { mailSearchSkill } from './mail-search-skill';

/**
 * Returns a SkillRegistry pre-loaded with all built-in skills.
 * Core and git skills are 'always' active. Review, test, plan,
 * semantic search, and mail-search skills auto-activate based on
 * prompt patterns.
 */
export function createDefaultSkillRegistry(): SkillRegistry {
  return new SkillRegistry().registerAll([
    coreSkill,
    gitSkill,
    codeReviewSkill,
    testGenSkill,
    planSkill,
    semanticSearchSkill,
    mailSearchSkill
  ]);
}
