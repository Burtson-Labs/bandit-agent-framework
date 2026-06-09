import type {
  DiffStreamUpdate,
  FileChangeSnapshot,
  IDiffManager,
  PendingDiff,
  DiffTransaction
} from '../internalTypes';

const safeRandomId = (): string => {
  const globalCrypto = typeof globalThis !== 'undefined' ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto : undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `uuid-${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
};

const MAX_SNAPSHOT_HISTORY = 25;

export interface DiffManagerDeps {
  postSnapshot(payload: {
    path: string;
    diff: string;
    summary?: { added: number; removed: number };
    confidence?: number;
  }): Promise<void>;
  postStream(update: DiffStreamUpdate): Promise<void>;
  computeDiff(before: string, after: string, relativePath: string): Promise<string | undefined>;
  summarizeDiff(diff: string): { added: number; removed: number };
}

export function createDiffManager(deps: DiffManagerDeps): IDiffManager {
  const pendingDiffs = new Map<string, PendingDiff>();
  const pendingComputations = new Set<string>();
  const snapshots: FileChangeSnapshot[] = [];
  const diffStreamTimestamps = new Map<string, number>();
  let reviewModeEnabled = false;
  let activeTransaction: DiffTransaction | undefined;

  return {
    clear(): void {
      pendingDiffs.clear();
      pendingComputations.clear();
      activeTransaction = undefined;
    },

    getPendingDiff(path: string): PendingDiff | undefined {
      return activeTransaction?.pending.get(path) ?? pendingDiffs.get(path);
    },

    async registerPendingDiff(
      path: string,
      original: string | undefined,
      updated: string | undefined,
      confidence?: number
    ): Promise<PendingDiff> {
      const existing = pendingDiffs.get(path);
      const normalizedOriginal = typeof original === 'string' ? original : existing?.original ?? '';
      const normalizedUpdated = typeof updated === 'string' ? updated : existing?.updated ?? '';
      const hasUpdated = typeof updated === 'string';
      const pending: PendingDiff = {
        original: normalizedOriginal,
        updated: normalizedUpdated,
        confidence: confidence ?? existing?.confidence,
        diff: existing?.diff,
        summary: existing?.summary,
        changed: existing?.changed
      };
      pendingDiffs.set(path, pending);
      if (!hasUpdated || pendingComputations.has(path)) {
        return pending;
      }
      pendingComputations.add(path);
      try {
        const diff = await deps.computeDiff(normalizedOriginal, normalizedUpdated, path);
        if (diff) {
          const summary = deps.summarizeDiff(diff);
          const changed = summary.added > 0 || summary.removed > 0;
          const next: PendingDiff = {
            ...pending,
            diff,
            summary,
            changed
          };
          if (activeTransaction) {
            activeTransaction.pending.set(path, next);
          } else {
            pendingDiffs.set(path, next);
            await deps.postSnapshot({
              path,
              diff,
              summary,
              confidence: next.confidence
            });
          }
          return next;
        }
        const unchanged: PendingDiff = {
          ...pending,
          diff: '',
          summary: pending.summary ?? { added: 0, removed: 0 },
          changed: false
        };
        if (activeTransaction) {
          activeTransaction.pending.set(path, unchanged);
        } else {
          pendingDiffs.set(path, unchanged);
        }
        return unchanged;
      } catch (error) {
        console.warn(`Failed to compute diff for ${path}`, error);
        return pending;
      } finally {
        pendingComputations.delete(path);
      }
    },

    beginTransaction(): DiffTransaction {
      if (activeTransaction) {
        throw new Error('A diff transaction is already active.');
      }
      activeTransaction = {
        id: safeRandomId(),
        pending: new Map()
      };
      return activeTransaction;
    },

    applyInTransaction(tx: DiffTransaction, path: string, diff: PendingDiff): void {
      if (!activeTransaction || tx.id !== activeTransaction.id) {
        throw new Error('Diff transaction mismatch.');
      }
      activeTransaction.pending.set(path, diff);
    },

    async commitTransaction(tx: DiffTransaction): Promise<void> {
      if (!activeTransaction || tx.id !== activeTransaction.id) {
        return;
      }
      for (const [path, diff] of activeTransaction.pending.entries()) {
        pendingDiffs.set(path, diff);
        if (diff.diff) {
          await deps.postSnapshot({
            path,
            diff: diff.diff,
            summary: diff.summary,
            confidence: diff.confidence
          });
        }
      }
      activeTransaction.pending.clear();
      activeTransaction = undefined;
    },

    rollbackTransaction(tx: DiffTransaction): void {
      if (!activeTransaction || tx.id !== activeTransaction.id) {
        return;
      }
      activeTransaction.pending.clear();
      activeTransaction = undefined;
    },

    recordSnapshot(snapshot: FileChangeSnapshot): void {
      if (!snapshot.path || !snapshot.absolutePath) {
        return;
      }
      snapshots.push(snapshot);
      if (snapshots.length > MAX_SNAPSHOT_HISTORY) {
        snapshots.shift();
      }
    },

    popSnapshot(): FileChangeSnapshot | undefined {
      return snapshots.pop();
    },

    hasSnapshots(): boolean {
      return snapshots.length > 0;
    },

    getSnapshotCount(): number {
      return snapshots.length;
    },

    enableReviewMode(enabled: boolean): void {
      reviewModeEnabled = enabled;
    },

    isReviewModeEnabled(): boolean {
      return reviewModeEnabled;
    },

    async postDiffStream(update: DiffStreamUpdate): Promise<void> {
      if (!reviewModeEnabled) {
        return;
      }
      const last = diffStreamTimestamps.get(update.path) ?? 0;
      const now = Date.now();
      if (update.kind === 'progress' && now - last < 120) {
        return;
      }
      diffStreamTimestamps.set(update.path, now);
      await deps.postStream(update);
    }
  };
}
