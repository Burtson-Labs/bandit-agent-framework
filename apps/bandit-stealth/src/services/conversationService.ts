/**
 * ConversationService — manages conversation state, persistence, and CRUD.
 *
 * Extracted from BanditStealthViewProvider to isolate conversation logic
 * from VS Code webview concerns. The provider delegates all conversation
 * operations here and handles UI sync separately.
 */

import type {
  ConversationEntry,
  ConversationRecord,
  ConversationRole,
  ConversationFeedback,
  ConversationPlanRun,
  ConversationPlanStepState,
  ConversationSummary,
  StoredConversationHistory,
  IntentInsight,
  SerializedPlanRun,
  Plan,
  Task
} from './conversationTypes';
import { buildPlanArtifactsPath, createPlanRunId as createPlanRunIdHelper } from '../helpers/plan';

const MAX_PLAN_RUNS_PER_CONVERSATION = 10;

export interface ConversationStorage {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface ConversationServiceOptions {
  storage: ConversationStorage;
  historyStorageKey: string;
  legacyStorageKey: string;
}

function createConversationId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `conv-${ts}-${rand}`;
}

function sanitizeConversationName(name: string): string {
  if (!name || !name.trim()) {return 'New Conversation';}
  return name.trim().slice(0, 120);
}

function deriveConversationNameFromEntries(entries: ConversationEntry[], fallback: string): string {
  const firstUser = entries.find((e) => e.role === 'user' && e.content.trim().length > 0);
  if (!firstUser) {return sanitizeConversationName(fallback);}
  // Strip trailing punctuation and collapse whitespace for cleaner titles
  const collapsed = firstUser.content
    .replace(/\s+/g, ' ')
    .replace(/[?!.]+\s*$/g, '')
    .trim();
  if (collapsed.length <= 60) {return collapsed;}
  return `${collapsed.slice(0, 57).trimEnd()}…`;
}

export class ConversationService {
  private history = new Map<string, ConversationRecord>();
  private _currentId: string | undefined;
  private _messages: ConversationEntry[] = [];
  private _historyVisible = true;
  private _activePlan: Plan | undefined;
  private _planStates = new Map<string, ConversationPlanStepState>();
  private _activePlanRunId: string | undefined;

  constructor(private readonly options: ConversationServiceOptions) {
    this.loadFromStorage();
  }

  // ── Accessors ───────────────────────────────────────────────────────────────

  get currentId(): string | undefined { return this._currentId; }
  get messages(): ConversationEntry[] { return this._messages; }
  get historyVisible(): boolean { return this._historyVisible; }
  set historyVisible(value: boolean) { this._historyVisible = value; }
  get activePlan(): Plan | undefined { return this._activePlan; }
  get planStates(): Map<string, ConversationPlanStepState> { return this._planStates; }
  get activePlanRunId(): string | undefined { return this._activePlanRunId; }
  set activePlanRunId(value: string | undefined) { this._activePlanRunId = value; }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  ensureActive(): ConversationRecord {
    if (this._currentId) {
      const existing = this.history.get(this._currentId);
      if (existing) {
        this._messages = existing.messages;
        this.syncPlanState(existing);
        return existing;
      }
    }
    const fresh = this.createRecord('New Conversation');
    this.history.set(fresh.id, fresh);
    this._currentId = fresh.id;
    this._messages = fresh.messages;
    this._historyVisible = false;
    this.syncPlanState(fresh);
    void this.persist();
    return fresh;
  }

  getCurrent(): ConversationRecord | undefined {
    return this._currentId ? this.history.get(this._currentId) : undefined;
  }

  getSorted(includeArchived = true): ConversationRecord[] {
    const all = Array.from(this.history.values());
    const filtered = includeArchived ? all : all.filter((c) => !c.archived);
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSummaries(): ConversationSummary[] {
    return this.getSorted(true)
      .filter((c) => c.messages.length > 0)
      .map((c) => ({ id: c.id, name: c.name, updatedAt: c.updatedAt, archived: c.archived }));
  }

  hasArchived(): boolean {
    for (const c of this.history.values()) {
      if (c.archived) {return true;}
    }
    return false;
  }

  async startNew(): Promise<ConversationRecord> {
    const record = this.createRecord('New Conversation');
    this.history.set(record.id, record);
    this._currentId = record.id;
    this._messages = record.messages;
    this._historyVisible = false;
    this.resetPlanState();
    await this.persist();
    return record;
  }

  async select(id: string): Promise<ConversationRecord | undefined> {
    const record = this.history.get(id);
    if (!record) {return undefined;}
    this._currentId = id;
    this._messages = record.messages;
    this._historyVisible = false;
    this.syncPlanState(record);
    await this.persist();
    return record;
  }

  async remove(id: string): Promise<void> {
    this.history.delete(id);
    if (this._currentId === id) {
      const fallback = this.getSorted(true)[0];
      if (fallback) {
        this._currentId = fallback.id;
        this._messages = fallback.messages;
      } else {
        this._currentId = undefined;
        this._messages = [];
      }
      this._historyVisible = true;
      this.resetPlanState();
    }
    await this.persist();
  }

  async setArchived(id: string, archived: boolean): Promise<void> {
    const record = this.history.get(id);
    if (record) {
      record.archived = archived;
      record.updatedAt = Date.now();
      await this.persist();
    }
  }

  async updateMessages(entries: ConversationEntry[], options?: { persist?: boolean }): Promise<void> {
    const conversation = this.ensureActive();
    const previousLength = conversation.messages.length;
    conversation.messages = entries;
    conversation.updatedAt = Date.now();
    this._messages = entries;

    if (entries.length === 0) {
      conversation.name = 'New Conversation';
      conversation.planRuns = [];
      if (this._currentId === conversation.id) {
        this.resetPlanState();
      }
    } else {
      if (conversation.archived) {conversation.archived = false;}
      if (previousLength === 0 || conversation.name === 'New Conversation' || conversation.name === 'Untitled Conversation') {
        conversation.name = deriveConversationNameFromEntries(entries, conversation.name);
      }
    }

    if (options?.persist !== false) {
      await this.persist();
    }
  }

  async clearAll(): Promise<void> {
    this.history.clear();
    this._currentId = undefined;
    this._messages = [];
    this._historyVisible = true;
    this.resetPlanState();
    await this.persist();
  }

  // ── Plan run tracking ───────────────────────────────────────────────────────

  /**
   * Begin a new plan run on the current conversation. Validates the plan
   * has steps; clones it; mints a run id and (optionally) an artifacts
   * path; appends the run to `planRuns`, enforcing the 10-run cap;
   * activates it; clears stale per-step state; persists. Returns the run
   * for callers that need to emit serialized history.
   *
   * The planStates clear is load-bearing — a second plan in the same
   * conversation must NOT inherit step badges from the first run.
   */
  startPlanRun(options: { plan: Plan; artifactsEnabled: boolean }): ConversationPlanRun | undefined {
    const conversation = this.getCurrent();
    if (!conversation) {return undefined;}
    const source = options.plan;
    if (!source || !Array.isArray(source.steps) || source.steps.length === 0) {return undefined;}

    const planData = this.clonePlan(source);
    const runId = createPlanRunIdHelper();
    const now = Date.now();
    const run: ConversationPlanRun = {
      id: runId,
      goal: planData.goal,
      plan: planData,
      createdAt: now,
      updatedAt: now,
      updates: {},
      artifactsPath: options.artifactsEnabled ? buildPlanArtifactsPath(conversation.id, runId) : undefined
    };

    if (!Array.isArray(conversation.planRuns)) {
      conversation.planRuns = [];
    }
    conversation.planRuns.push(run);
    if (conversation.planRuns.length > MAX_PLAN_RUNS_PER_CONVERSATION) {
      conversation.planRuns = conversation.planRuns.slice(conversation.planRuns.length - MAX_PLAN_RUNS_PER_CONVERSATION);
    }
    conversation.updatedAt = now;
    this._activePlanRunId = runId;
    this._activePlan = planData;
    this._planStates.clear();
    void this.persist();
    return run;
  }

  /**
   * Drop the active plan pointer without touching `planRuns` history.
   * Used by the no-plan branch of `agent:plan` (a turn that completes
   * without producing a plan must clear stale run-context wiring).
   */
  clearActivePlan(): void {
    this.resetPlanState();
  }

  /**
   * Look up the active plan run on the given conversation (or the
   * current one). When no `_activePlanRunId` is set, falls back to the
   * latest run by `createdAt` and adopts it as active.
   */
  getActivePlanRun(conversation?: ConversationRecord): ConversationPlanRun | undefined {
    const source = conversation ?? this.getCurrent();
    if (!source?.planRuns?.length) {return undefined;}
    if (this._activePlanRunId) {
      const existing = source.planRuns.find((r) => r.id === this._activePlanRunId);
      if (existing) {return existing;}
    }
    let latest = source.planRuns[0];
    for (const run of source.planRuns) {
      if (run.createdAt > latest.createdAt) {latest = run;}
    }
    this._activePlanRunId = latest.id;
    return latest;
  }

  /**
   * Write the evaluation onto the active plan run. Returns the mutated
   * run, or undefined when no active run exists — the bridge uses that
   * to skip the `agentPlanHistory` rebroadcast.
   */
  recordFinalEvaluation(report: { success?: boolean; confidence?: number; feedback?: string }): ConversationPlanRun | undefined {
    const conversation = this.getCurrent();
    const run = this.getActivePlanRun(conversation);
    if (!run) {return undefined;}
    run.evaluation = {
      success: report.success,
      confidence: report.confidence,
      feedback: report.feedback
    };
    const now = Date.now();
    run.completedAt = now;
    run.updatedAt = now;
    void this.persist();
    return run;
  }

  updatePlanStep(stepId: string, update: Partial<ConversationPlanStepState>): ConversationPlanStepState | undefined {
    if (!stepId) {return undefined;}
    const conversation = this.getCurrent();
    if (!conversation?.planRuns?.length) {return undefined;}
    const run = this.getActivePlanRun(conversation);
    if (!run) {return undefined;}

    const existing = run.updates[stepId] ?? {};
    const merged: ConversationPlanStepState = { ...existing, ...update, updatedAt: Date.now() };
    run.updates[stepId] = merged;
    run.updatedAt = Date.now();
    this._planStates.set(stepId, { ...merged });
    void this.persist();
    return merged;
  }

  getPlanSnapshot(): { plan: Plan | null; updates: Record<string, ConversationPlanStepState> } {
    const run = this.getActivePlanRun();
    if (!run) {return { plan: null, updates: {} };}
    const updates: Record<string, ConversationPlanStepState> = {};
    for (const [stepId, detail] of Object.entries(run.updates ?? {})) {
      if (detail) {updates[stepId] = { ...detail };}
    }
    return { plan: this.clonePlan(run.plan), updates };
  }

  serializePlanRuns(runs: ConversationPlanRun[]): SerializedPlanRun[] {
    return runs.map((run) => ({
      id: run.id,
      goal: run.goal,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt ?? null,
      evaluation: run.evaluation ? { ...run.evaluation } : null,
      artifactsPath: run.artifactsPath ?? null,
      plan: this.clonePlan(run.plan),
      updates: Object.fromEntries(
        Object.entries(run.updates ?? {}).map(([stepId, detail]) => [stepId, { ...detail }])
      )
    }));
  }

  createPlanRunId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `run-${timestamp}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ── Normalization ───────────────────────────────────────────────────────────

  normalizeEntry(entry: Partial<ConversationEntry> | undefined): ConversationEntry {
    const role: ConversationRole = entry?.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof entry?.content === 'string' ? entry.content : '';
    const timestamp = typeof entry?.timestamp === 'number' ? entry.timestamp : Date.now();
    const fallbackId = `${timestamp.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const images = Array.isArray(entry?.images) && entry.images.length > 0 ? [...entry.images] : undefined;
    const intent = normalizeIntentInsight(entry?.intent);
    const feedback = normalizeConversationFeedback(entry?.feedback);
    return { id: typeof entry?.id === 'string' && entry.id.length > 0 ? entry.id : fallbackId, role, content, timestamp, images, intent, feedback };
  }

  normalizeRecord(record: Partial<ConversationRecord> | undefined): ConversationRecord {
    const messages = Array.isArray(record?.messages) ? record.messages.map((e) => this.normalizeEntry(e)) : [];
    const baseName = record?.name ?? (messages.length > 0 ? deriveConversationNameFromEntries(messages, 'New Conversation') : 'New Conversation');
    const timestamps = messages.map((e) => e.timestamp);
    const fallbackCreated = timestamps.length > 0 ? Math.min(...timestamps) : Date.now();
    const fallbackUpdated = timestamps.length > 0 ? Math.max(...timestamps) : fallbackCreated;
    const name = messages.length > 0 ? deriveConversationNameFromEntries(messages, baseName) : sanitizeConversationName(baseName);
    const planRuns = Array.isArray(record?.planRuns)
      ? record.planRuns.map((r) => this.normalizePlanRun(r)).filter((r): r is ConversationPlanRun => Boolean(r))
      : [];

    return {
      id: typeof record?.id === 'string' && record.id.length > 0 ? record.id : createConversationId(),
      name,
      messages,
      archived: Boolean(record?.archived),
      createdAt: typeof record?.createdAt === 'number' ? record.createdAt : fallbackCreated,
      updatedAt: typeof record?.updatedAt === 'number' ? record.updatedAt : fallbackUpdated,
      planRuns: planRuns.slice(-10)
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private loadFromStorage(): void {
    const stored = this.options.storage.get<StoredConversationHistory | undefined>(this.options.historyStorageKey, undefined);
    if (stored?.conversations) {
      for (const record of stored.conversations) {
        const normalized = this.normalizeRecord(record);
        this.history.set(normalized.id, normalized);
      }
    }

    if (this.history.size === 0) {
      const legacy = this.options.storage.get<ConversationEntry[]>(this.options.legacyStorageKey, []);
      if (legacy.length > 0) {
        const imported = this.createRecord('Imported Conversation', legacy);
        this.history.set(imported.id, imported);
      }
    }

    if (this.history.size === 0) {
      const fresh = this.createRecord('New Conversation');
      this.history.set(fresh.id, fresh);
    }

    if (stored?.currentId && this.history.has(stored.currentId)) {
      this._currentId = stored.currentId;
      const current = this.history.get(stored.currentId)!;
      this._messages = current.messages;
      this._historyVisible = false;
    } else {
      const fallback = this.getSorted(true)[0];
      if (fallback) {
        this._currentId = fallback.id;
        this._messages = fallback.messages;
      }
      this._historyVisible = this._messages.length === 0;
    }

    this.syncPlanState(this.getCurrent());
  }

  private createRecord(name: string, messages?: ConversationEntry[]): ConversationRecord {
    const now = Date.now();
    const normalized = Array.isArray(messages) ? messages.map((e) => this.normalizeEntry(e)) : [];
    const timestamps = normalized.map((e) => e.timestamp);
    return {
      id: createConversationId(),
      name: normalized.length > 0 ? deriveConversationNameFromEntries(normalized, name) : sanitizeConversationName(name),
      messages: normalized,
      archived: false,
      createdAt: timestamps.length > 0 ? Math.min(...timestamps) : now,
      updatedAt: timestamps.length > 0 ? Math.max(...timestamps) : now,
      planRuns: []
    };
  }

  private async persist(): Promise<void> {
    const sorted = this.getSorted(true);
    const meaningful = sorted.filter((c) => c.messages.length > 0);

    // Prune empty non-current conversations
    for (const c of sorted) {
      if (c.messages.length === 0 && c.id !== this._currentId) {
        this.history.delete(c.id);
      }
    }

    if (meaningful.length === 0) {
      await this.options.storage.update(this.options.historyStorageKey, undefined);
      await this.options.storage.update(this.options.legacyStorageKey, []);
      return;
    }

    const payload: StoredConversationHistory = {
      currentId: meaningful.some((c) => c.id === this._currentId) ? this._currentId : undefined,
      conversations: meaningful.map((c) => ({
        ...c,
        messages: c.messages.map((e) => ({ ...e, images: e.images?.length ? [...e.images] : undefined })),
        planRuns: (c.planRuns ?? []).map((run) => ({
          ...run,
          plan: this.clonePlan(run.plan),
          updates: Object.fromEntries(Object.entries(run.updates ?? {}).map(([k, v]) => [k, v ? { ...v } : {}]))
        }))
      }))
    };

    await this.options.storage.update(this.options.historyStorageKey, payload);
    const current = this.getCurrent();
    await this.options.storage.update(
      this.options.legacyStorageKey,
      current ? current.messages.map((e) => ({ ...e, images: e.images?.length ? [...e.images] : undefined })) : []
    );
  }

  private syncPlanState(conversation?: ConversationRecord | null): void {
    if (!conversation?.planRuns?.length) {
      this.resetPlanState();
      return;
    }
    const run = this.getActivePlanRun(conversation);
    if (!run) { this.resetPlanState(); return; }
    this._activePlanRunId = run.id;
    this._activePlan = run.plan;
    this._planStates.clear();
    for (const [stepId, detail] of Object.entries(run.updates ?? {})) {
      if (detail) {this._planStates.set(stepId, { ...detail });}
    }
  }

  private resetPlanState(): void {
    this._activePlanRunId = undefined;
    this._activePlan = undefined;
    this._planStates.clear();
  }

  private normalizePlanRun(raw: unknown): ConversationPlanRun | undefined {
    if (!raw || typeof raw !== 'object') {return undefined;}
    const input = raw as Partial<ConversationPlanRun> & Record<string, unknown>;
    const plan = input.plan as Plan | undefined;
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps) || plan.steps.length === 0) {return undefined;}
    const cloned = this.clonePlan(plan);
    const updatesInput = typeof input.updates === 'object' && input.updates !== null ? (input.updates as Record<string, unknown>) : {};
    const updates: Record<string, ConversationPlanStepState> = {};
    for (const [stepId, value] of Object.entries(updatesInput)) {
      if (!stepId || !value || typeof value !== 'object') {continue;}
      const d = value as Record<string, unknown>;
      updates[stepId] = {
        state: typeof d.state === 'string' ? d.state : undefined,
        summary: typeof d.summary === 'string' ? d.summary : undefined,
        durationMs: typeof d.durationMs === 'number' && Number.isFinite(d.durationMs) ? d.durationMs : undefined,
        tokens: typeof d.tokens === 'number' && Number.isFinite(d.tokens) ? d.tokens : undefined,
        updatedAt: typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt) ? d.updatedAt : undefined
      };
    }
    const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : Date.now();
    const evaluation = input.evaluation && typeof input.evaluation === 'object'
      ? {
          success: typeof input.evaluation.success === 'boolean' ? input.evaluation.success : undefined,
          confidence: typeof input.evaluation.confidence === 'number' ? input.evaluation.confidence : undefined,
          feedback: typeof input.evaluation.feedback === 'string' ? input.evaluation.feedback : undefined
        }
      : undefined;
    return {
      id: typeof input.id === 'string' && input.id.length > 0 ? input.id : this.createPlanRunId(),
      goal: typeof input.goal === 'string' ? input.goal : cloned.goal,
      plan: cloned,
      createdAt,
      updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : createdAt,
      updates,
      completedAt: typeof input.completedAt === 'number' ? input.completedAt : undefined,
      evaluation,
      artifactsPath: typeof input.artifactsPath === 'string' ? input.artifactsPath : undefined
    };
  }

  private clonePlan(plan: Plan): Plan {
    const cloneTask = (task: Task): Task => ({
      ...task,
      files: Array.isArray(task.files) ? [...task.files] : undefined,
      metadata: task.metadata ? { ...task.metadata } : undefined
    });
    return {
      goal: plan.goal,
      steps: Array.isArray(plan.steps) ? plan.steps.map((s) => ({ ...s })) : [],
      tasks: Array.isArray(plan.tasks) ? plan.tasks.map(cloneTask) : undefined,
      goals: Array.isArray(plan.goals) ? plan.goals.map((g) => ({ ...g, tasks: Array.isArray(g.tasks) ? g.tasks.map(cloneTask) : [] })) : undefined
    };
  }
}

// ── Standalone normalizers (no `this` dependency) ───────────────────────────

function normalizeIntentInsight(raw: unknown): IntentInsight | undefined {
  if (!raw || typeof raw !== 'object') {return undefined;}
  const input = raw as Record<string, unknown>;
  const action = typeof input.action === 'string' && input.action.trim().length > 0 ? input.action.trim() : undefined;
  if (!action) {return undefined;}
  return {
    action,
    target: typeof input.target === 'string' ? input.target.trim() : undefined,
    intent: typeof input.intent === 'string' ? input.intent.trim() : undefined,
    summary: typeof input.summary === 'string' ? input.summary.trim() : undefined,
    confidence: typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : undefined,
    rationale: typeof input.rationale === 'string' ? input.rationale.trim() : undefined,
    raw: typeof input.raw === 'object' && input.raw !== null ? (input.raw as Record<string, unknown>) : undefined
  };
}

function normalizeConversationFeedback(raw: unknown): ConversationFeedback | undefined {
  if (!raw || typeof raw !== 'object') {return undefined;}
  const input = raw as Record<string, unknown>;
  const rating = input.rating === 'up' || input.rating === 'down' ? input.rating : undefined;
  if (!rating) {return undefined;}
  return {
    rating,
    submitted: input.submitted === true,
    submittedAt: typeof input.submittedAt === 'number' ? input.submittedAt : undefined,
    note: typeof input.note === 'string' ? input.note.trim() : undefined
  };
}
