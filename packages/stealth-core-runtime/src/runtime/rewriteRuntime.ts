import { createRewriteServices, type RewriteServicesDeps } from './rewriteServices';
import { createHealingServices, type HealingServicesDeps } from './healingServices';

export interface RewriteRuntimeDeps {
  rewrite: RewriteServicesDeps;
  healing: Omit<HealingServicesDeps, 'rewriteEngine' | 'generateRewrite'>;
}

export interface RewriteRuntimeResult {
  rewriteGenerator: ReturnType<typeof createRewriteServices>['rewriteGenerator'];
  rewriteEngine: ReturnType<typeof createRewriteServices>['rewriteEngine'];
  healingEngine: ReturnType<typeof createHealingServices>['healingEngine'];
}

export function createRewriteRuntimeServices(deps: RewriteRuntimeDeps): RewriteRuntimeResult {
  const rewriteServices = createRewriteServices(deps.rewrite);

  const healingServices = createHealingServices({
    ...deps.healing,
    rewriteEngine: {
      createMissingHelperFiles: (goal, files) =>
        rewriteServices.rewriteEngine.createMissingHelperFiles(goal, files)
    },
    generateRewrite: (goal, relativePath, currentContent, projectSummary, instructions) =>
      rewriteServices.rewriteGenerator.generateRewrite(
        goal,
        relativePath,
        currentContent,
        projectSummary,
        instructions
      )
  });

  return {
    rewriteGenerator: rewriteServices.rewriteGenerator,
    rewriteEngine: rewriteServices.rewriteEngine,
    healingEngine: healingServices.healingEngine
  };
}
