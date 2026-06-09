/**
 * Legacy direct-stream completion path — the `enableToolUse: false`
 * fallback in `performCompletion`. Drives `provider.chat()` straight
 * into an assistant entry without going through the tool-use loop.
 *
 * `enableToolUse` defaults to `true` (the IDE config schema sets it
 * in package.json), so this path is OPT-OUT only. A user has to flip
 * the workspace setting off to land here. Kept available because some
 * environments (locked-down hosts, model-evaluation runs) need a
 * tool-less chat surface and because pulling it out would change
 * behavior for the few users running with the setting disabled.
 *
 * Behavioral fidelity preserved from the inline path:
 *
 *  - **`setBusy(true, "Waiting for {provider}…")`** before stream
 *    open, `setBusy(false)` in finally. Drives the busy indicator
 *    same as the tool-use loop.
 *  - **`assistantEntry` is hidden until the first content chunk.**
 *    The "Streaming X response…" status push fires on the first
 *    non-`done` chunk, not on iterator open.
 *  - **`syncState()` per content-bearing chunk.** Keeps the chat
 *    panel scrolled to the live response as it streams.
 *  - **AbortError → `completedNaturally = true`.** A user-triggered
 *    abort mid-stream isn't an error; it just stops the loop without
 *    surfacing a toast.
 *  - **`iterator.return?.()` on incomplete exit.** Best-effort
 *    provider cleanup if we bailed before `done: true`.
 *  - **Empty content → filter assistantEntry out of conversation.**
 *    A stream that produced nothing usable shouldn't leave a blank
 *    bubble in the transcript.
 *  - **Rate-limit branch preserved.** The bandit provider attaches
 *    `isRateLimit` + `window` + `resetsAtUnix` to its Error on 429;
 *    we surface a `rateLimited` webview message and a friendly
 *    warning toast instead of the generic error path.
 *
 * The extraction takes a `LegacyDirectStreamDeps` instead of the
 * provider class — provider methods used here (`describeProvider`,
 * `getProviderKind`, `buildProviderSettings`, `buildContextBlock`,
 * `buildChatRequest`) flow as callbacks so the helper doesn't carry
 * a `this` reference.
 */
import * as vscode from 'vscode';
import type { AIChatRequest, AIChatResponse, ProviderKind } from '@burtson-labs/stealth-core-runtime';
import { createProvider } from '@burtson-labs/stealth-core-runtime';
import type { ConversationEntry } from '../services/conversationTypes';
import type { OutgoingMessage } from '../messages';
import { createConversationEntry } from '../helpers/conversation';
import { OLLAMA_AUTH_SECRET_KEY } from '../storageKeys';

export interface LegacyDirectStreamDeps {
  apiKey: string;
  configuration: vscode.WorkspaceConfiguration;
  secrets: vscode.SecretStorage;
  getConversation: () => ConversationEntry[];
  setConversation: (entries: ConversationEntry[]) => void;
  setActiveStream: (stream: AsyncIterator<AIChatResponse> | undefined) => void;
  getProviderKind: (cfg: vscode.WorkspaceConfiguration) => ProviderKind;
  describeProvider: (kind: ProviderKind) => string;
  buildProviderSettings: (
    cfg: vscode.WorkspaceConfiguration,
    apiKey: string,
    ollamaAuth: string | undefined
  ) => Parameters<typeof createProvider>[0];
  buildChatRequest: (cfg: vscode.WorkspaceConfiguration, contextBlock: string | undefined) => AIChatRequest;
  buildContextBlock: (
    prompt: string,
    cfg: vscode.WorkspaceConfiguration
  ) => Promise<{ formatted?: string } | undefined>;
  setBusy: (busy: boolean, statusText?: string) => Promise<void>;
  setStatusMessage: (text: string) => void;
  cancelActiveStream: () => void;
  updateConversation: (entries: ConversationEntry[], options?: { persist?: boolean }) => Promise<void>;
  syncState: () => Promise<void>;
  postMessage: (msg: OutgoingMessage) => void;
}

export async function runLegacyDirectStream(deps: LegacyDirectStreamDeps): Promise<void> {
  const {
    apiKey,
    configuration,
    secrets,
    getConversation,
    setConversation,
    setActiveStream,
    getProviderKind,
    describeProvider,
    buildProviderSettings,
    buildChatRequest,
    buildContextBlock,
    setBusy,
    setStatusMessage,
    cancelActiveStream,
    updateConversation,
    syncState,
    postMessage
  } = deps;

  cancelActiveStream();
  const providerKind = getProviderKind(configuration);
  const providerLabel = describeProvider(providerKind);
  await setBusy(true, `Waiting for ${providerLabel}…`);

  const assistantEntry = createConversationEntry('assistant', '', { payload: '' });
  let assistantAdded = false;

  try {
    const ollamaAuth = await Promise.resolve(secrets.get(OLLAMA_AUTH_SECRET_KEY)).catch(() => undefined);
    const provider = await createProvider(buildProviderSettings(configuration, apiKey, ollamaAuth));
    const lastUserMessage = [...getConversation()].reverse().find((e) => e.role === 'user')?.content ?? '';
    const contextResult = await buildContextBlock(lastUserMessage, configuration).catch(() => undefined);
    const request = buildChatRequest(configuration, contextResult?.formatted);

    await updateConversation([...getConversation(), assistantEntry], { persist: false });
    assistantAdded = true;
    await syncState();

    const iterator = provider.chat(request)[Symbol.asyncIterator]();
    setActiveStream(iterator);
    let streamStarted = false;
    let completedNaturally = false;
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) {
          completedNaturally = true;
          break;
        }

        const chunk = value;
        if (!chunk) {continue;}

        if (!streamStarted && !chunk.done) {
          streamStarted = true;
          setStatusMessage(`Streaming ${providerLabel} response…`);
        }

        const content = chunk.message?.content ?? '';
        if (content) {
          assistantEntry.content += content;
          assistantEntry.payload = assistantEntry.content;
          assistantEntry.timestamp = Date.now();
          void syncState();
        }

        if (chunk.done) {
          completedNaturally = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        completedNaturally = true;
      } else {
        throw error;
      }
    } finally {
      setActiveStream(undefined);
      if (!completedNaturally && typeof iterator.return === 'function') {
        try { await iterator.return(); } catch { /* ignore iterator cleanup errors */ }
      }
    }

    assistantEntry.content = assistantEntry.content.trim();
    assistantEntry.payload = assistantEntry.content;
    if (!assistantEntry.content) {
      setConversation(getConversation().filter((entry) => entry.id !== assistantEntry.id));
    }
    await updateConversation(getConversation());
    await syncState();
  } catch (error) {
    if (assistantAdded && !assistantEntry.content.trim()) {
      setConversation(getConversation().filter((entry) => entry.id !== assistantEntry.id));
    }

    const message = error instanceof Error ? error.message : 'Unknown issue.';
    const friendlyProvider = describeProvider(getProviderKind(configuration));

    const rateErr = error as { isRateLimit?: boolean; window?: string; resetsAtUnix?: number } | undefined;
    if (rateErr?.isRateLimit) {
      postMessage({
        type: 'rateLimited',
        window: rateErr.window ?? 'session',
        resetsAtUnix: rateErr.resetsAtUnix,
        message
      });
      void vscode.window.showWarningMessage(`Bandit cloud: ${message}`);
    } else {
      postMessage({ type: 'error', message: `${friendlyProvider} error: ${message}` });
      void vscode.window.showErrorMessage(`${friendlyProvider} error: ${message}`);
    }

    if (assistantAdded) {
      await updateConversation(getConversation());
      await syncState();
    }
  } finally {
    cancelActiveStream();
    await setBusy(false);
  }
}
