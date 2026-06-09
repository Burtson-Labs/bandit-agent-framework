/**
 * `IntentService` owns the intent slice of conversation state:
 * the currently-detected user intent (shown as the composer chip and
 * the assistant entry's intent badge), the workspace-scoped memory
 * list of past intents (so the model can reference what the user
 * tends to ask), and the storage hooks for attaching intent metadata
 * to individual `ConversationEntry` items.
 *
 * NOT in this service (yet): the LLM classification call itself
 * (`interpretIntent` + `requestIntentViaCompletions`). Both depend on
 * `runBanditCompletion`, which is shared with the feedback pipeline
 * and stays on the provider until that shared utility moves to its
 * own module. After that, the classifier can land here too.
 *
 * Lifecycle:
 * - Constructed once per provider with the stored memory list pulled
 *   from `workspaceState`.
 * - `syncFromConversation` runs every flushState so `current` always
 *   reflects the latest assistant entry's intent annotation — this is
 *   how a /history-restored conversation resurrects its intent chip
 *   without re-running classification.
 * - `reset` runs on clearCurrent / clearAll so a fresh conversation
 *   starts with no chip.
 */
import type { ConversationEntry } from '../../services/conversationTypes';
import type { IntentInsight, IntentMemoryEntry } from '../../agentTypes';
import { findLatestIntent, normalizeIntentMemory, summarizeIntent } from '../../helpers/intent';
import { INTENT_MEMORY_STORAGE_KEY } from '../../storageKeys';
import type { ProviderContext } from '../context';

export interface IntentServiceOptions {
  /** Stored memory list pulled from `workspaceState` at provider
   *  construction time. Will be normalized before use. */
  stored: IntentMemoryEntry[];
}

export class IntentService {
  private currentInsight: IntentInsight | undefined;
  private memory: IntentMemoryEntry[];

  constructor(private readonly ctx: ProviderContext, options: IntentServiceOptions) {
    this.memory = normalizeIntentMemory(options.stored);
  }

  /** Live intent — mirrored into webview state on each flushState. */
  get current(): IntentInsight | undefined {
    return this.currentInsight;
  }

  /** Workspace-scoped memory list. Primarily used by tests. */
  get memorySnapshot(): IntentMemoryEntry[] {
    return [...this.memory];
  }

  /** Refresh the live intent from the conversation's latest annotated
   *  entry. Called from flushState so reopened conversations resurrect
   *  their intent chip without re-classifying. */
  syncFromConversation(messages: ConversationEntry[]): void {
    this.currentInsight = findLatestIntent(messages);
  }

  /** Clear the live intent without touching conversation entries.
   *  Called from clearCurrentConversation / clearAllConversations so
   *  a fresh conversation starts with no chip. */
  reset(): void {
    this.currentInsight = undefined;
  }

  /** Set the live intent and post a syncState so the webview re-
   *  renders the chip. Pass `undefined` to clear. */
  async setInsight(insight: IntentInsight | undefined): Promise<void> {
    this.currentInsight = insight ? { ...insight, summary: summarizeIntent(insight) } : undefined;
    await this.ctx.syncState();
  }

  /** Strip every intent annotation from the current conversation's
   *  messages and persist. Used by `dismiss()` so the user can clear
   *  a misclassified intent without re-typing the prompt. */
  async clearLatestFromConversation(): Promise<void> {
    const conversation = this.ctx.conversations.getCurrent();
    if (!conversation) {
      return;
    }
    let updated = false;
    for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
      const entry = conversation.messages[index];
      if (entry?.intent) {
        const updatedEntry: ConversationEntry = { ...entry };
        delete (updatedEntry as { intent?: IntentInsight }).intent;
        conversation.messages[index] = updatedEntry;
        updated = true;
      }
    }
    if (updated) {
      await this.ctx.conversations.updateMessages(conversation.messages);
    }
  }

  /** Attach (or strip) an intent annotation on a specific message.
   *  Called from the classifier orchestrator after a successful
   *  detection. */
  async attachToMessage(messageId: string, insight: IntentInsight | undefined): Promise<void> {
    const conversation = this.ctx.conversations.ensureActive();
    const index = conversation.messages.findIndex((entry) => entry.id === messageId);
    if (index === -1) {
      return;
    }
    const current = conversation.messages[index];
    const next: ConversationEntry = insight
      ? { ...current, intent: { ...insight, summary: summarizeIntent(insight) } }
      : { ...current };
    if (!insight) {
      delete (next as { intent?: IntentInsight }).intent;
    }
    conversation.messages[index] = next;
    await this.ctx.conversations.updateMessages(conversation.messages);
  }

  /**
   * Push a detected intent into the workspace-scoped memory list.
   * If an existing entry matches on (action, summary) it gets merged
   * in place; otherwise the new entry lands at the head. The list is
   * normalized (capped + freshness-sorted) before persistence.
   */
  async recordMemory(insight: IntentInsight): Promise<void> {
    const summary = summarizeIntent(insight);
    if (!summary) {
      return;
    }
    const entry: IntentMemoryEntry = {
      action: insight.action || 'general',
      target: insight.target,
      summary,
      confidence: insight.confidence,
      lastUsed: Date.now()
    };
    const existingIndex = this.memory.findIndex((item) => item.action === entry.action && item.summary === entry.summary);
    if (existingIndex >= 0) {
      this.memory[existingIndex] = { ...this.memory[existingIndex], ...entry };
    } else {
      this.memory.unshift(entry);
    }
    this.memory = normalizeIntentMemory(this.memory);
    await this.ctx.extensionContext.workspaceState.update(INTENT_MEMORY_STORAGE_KEY, this.memory);
  }

  /**
   * Webview bridge — user clicked dismiss on the live intent chip.
   * Strips the latest intent from the conversation AND clears the
   * live chip. Two syncStates fire (one from updateMessages via
   * clearLatestFromConversation, one from setInsight) — accepted as
   * the cost of the simpler boundary.
   */
  async dismiss(): Promise<void> {
    await this.clearLatestFromConversation();
    await this.setInsight(undefined);
  }
}
