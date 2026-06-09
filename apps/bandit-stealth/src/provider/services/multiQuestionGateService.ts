/**
 * `MultiQuestionGateService` owns the in-chat ask-user card lifecycle:
 * post a `userInputRequest` to the webview, hold the resolver until the
 * user submits (or dismisses), and settle the Promise the `ask_user` tool
 * is awaiting. The host side of agent-core's `requestUserInput` callback.
 *
 * Modeled on PermissionGateService, but simpler: there's no in-transcript
 * card fence to inject/replace — the `ask_user` tool result already records
 * the Q&A in the conversation, so this service is purely the
 * post-message-and-await-reply bridge. The webview renders the form from a
 * transient queue (see AskUserForm), and posts `userInputResponse` back.
 */
import type { UserInputQuestion, UserInputResponse } from '@burtson-labs/agent-core';
import type { ProviderContext } from '../context';

type UserInputResolver = (response: UserInputResponse) => void;

export class MultiQuestionGateService {
  private readonly pending = new Map<string, UserInputResolver>();

  constructor(private readonly ctx: ProviderContext) {}

  /** In-flight request count. Primarily used by tests and diagnostics. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Post a `userInputRequest` to the webview and return a Promise that
   * resolves once the webview replies via `respond()`. Each request gets a
   * unique `ask-{base36ts}-{rand4}` id so concurrent requests stay distinct.
   * Returns `{ answers: {}, cancelled: true }` if the view is gone.
   */
  request(questions: UserInputQuestion[]): Promise<UserInputResponse> {
    if (!this.ctx.view) {
      return Promise.resolve({ answers: {}, cancelled: true });
    }
    const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.ctx.postMessage({
      type: 'userInputRequest',
      id,
      questions: questions.map((q) => ({
        id: q.id,
        question: q.question,
        header: q.header,
        options: q.options,
        allowFreeform: q.allowFreeform
      }))
    });
    return new Promise<UserInputResponse>((resolvePromise) => {
      this.pending.set(id, (response) => {
        this.pending.delete(id);
        resolvePromise(response);
      });
    });
  }

  /**
   * Webview bridge — called by `handleMessage` on `userInputResponse`.
   * No-op if the id has no pending request (already resolved, or a stale
   * id after a reload).
   */
  respond(id: string, answers: Record<string, string>, cancelled?: boolean): void {
    const resolver = this.pending.get(id);
    if (resolver) {resolver({ answers, cancelled });}
  }
}
