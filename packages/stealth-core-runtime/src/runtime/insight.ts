import type { InferredGoal } from '../internalTypes';
import type { EmbeddingSearchHit } from '../internalTypes';

export interface GoalContextDeps {
  loadWorkspaceIndex(): Promise<string[]>;
  searchEmbeddingCandidates(goal: string): Promise<EmbeddingSearchHit[]>;
  runGoalInference(goal: string, workspaceIndex: string[]): Promise<InferredGoal | undefined>;
  mergeInsightWithEmbeddings(
    insight: InferredGoal | undefined,
    hits: EmbeddingSearchHit[]
  ): InferredGoal | undefined;
}

export interface GoalContextResult {
  workspaceIndex: string[];
  embeddingHits: EmbeddingSearchHit[];
  goalInsight: InferredGoal | undefined;
  enrichedInsight: InferredGoal | undefined;
}

export async function collectGoalContext(
  deps: GoalContextDeps,
  goal: string
): Promise<GoalContextResult> {
  const workspaceIndex = await deps.loadWorkspaceIndex();
  const embeddingHits = await deps.searchEmbeddingCandidates(goal);
  const goalInsight = await deps.runGoalInference(goal, workspaceIndex);
  const enrichedInsight = deps.mergeInsightWithEmbeddings(goalInsight, embeddingHits);
  return { workspaceIndex, embeddingHits, goalInsight, enrichedInsight };
}
