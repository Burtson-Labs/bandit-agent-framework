import type { CompletedChangeEntry } from "./diffStorage";

export interface CandidatePriority {
  value: string;
  basename: string;
  index: number;
}

export const normalizePriorityPath = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();

export const buildCandidatePriorities = (files: string[]): CandidatePriority[] =>
  files
    .map((file) => normalizePriorityPath(file))
    .filter((value) => value.length > 0)
    .map((value, index) => ({
      value,
      basename: value.split("/").pop() ?? value,
      index
    }));

export const computeDiffPriority = (path: string, candidates: CandidatePriority[]): number => {
  if (!candidates.length) {
    return Number.POSITIVE_INFINITY;
  }
  const normalized = normalizePriorityPath(path);
  for (const candidate of candidates) {
    if (normalized === candidate.value) {
      return candidate.index;
    }
  }
  for (const candidate of candidates) {
    if (
      normalized.endsWith(`/${candidate.basename}`) ||
      normalized === candidate.basename ||
      normalized.endsWith(candidate.value)
    ) {
      return candidates.length + candidate.index;
    }
  }
  return candidates.length * 2 + 1;
};

export const sortEntriesByCandidates = (
  entries: CompletedChangeEntry[],
  candidates: CandidatePriority[]
): CompletedChangeEntry[] => {
  if (!candidates.length || entries.length === 0) {
    return entries;
  }
  return entries
    .map((entry, index) => ({
      entry,
      index,
      score: computeDiffPriority(entry.path, candidates)
    }))
    .sort((a, b) => {
      if (a.score === b.score) {
        return a.index - b.index;
      }
      return a.score - b.score;
    })
    .map((item) => item.entry);
};
