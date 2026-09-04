/**
 * Live-session remote control for the interactive REPL — the "continue on your
 * phone / the web" experience.
 *
 * When enabled, the running `bandit` session registers itself as a controllable
 * session with the gateway and:
 *   - MIRRORS every turn (local or remote) to the session stream, so another
 *     surface can watch the conversation live;
 *   - RECEIVES remote turns over the same inbox the one-shot runner uses, and
 *     hands them to the host to run as the next prompt IN THE SAME conversation
 *     (full context), then mirrors the result back.
 *
 * It reuses the deployed relay (HttpRunnerGateway inbox + the task event
 * ingest) — the only new gateway surface is session register/input. Safety is
 * unchanged: remote turns run under the session's permission mode (plan by
 * default), enforced by the same host-kit boundary.
 */
import { HttpRunnerGateway } from './httpGateway';
import type { RemoteRunMode } from './contract';

export interface RemoteSessionOptions {
  /** Gateway base URL (no trailing slash). */
  gatewayBase: string;
  /** Bandit cloud JWT / API key. */
  token: string;
  deviceId: string;
  deviceLabel: string;
  /** Web base for the "continue at" URL shown in the banner. */
  webBase: string;
  /** Session title (project folder / first prompt). */
  title: string;
  /** Permission mode for remote turns. */
  mode: RemoteRunMode;
  /** Called when a remote turn arrives — the host enqueues it as the next
   *  prompt in the live conversation. */
  onRemoteTurn: (prompt: string) => void;
  /** Runner plumbing logs (not conversation). */
  onStatus?: (message: string) => void;
}

export class RemoteSession {
  private sessionId: string | null = null;
  private readonly gateway: HttpRunnerGateway;
  private readonly controller = new AbortController();
  private inboxLoop: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RemoteSessionOptions, fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.gateway = new HttpRunnerGateway({
      baseUrl: opts.gatewayBase,
      token: opts.token,
      deviceId: opts.deviceId,
      deviceLabel: opts.deviceLabel,
      fetchImpl: this.fetchImpl
    });
  }

  get id(): string | null { return this.sessionId; }
  get active(): boolean { return this.sessionId !== null; }
  get continueUrl(): string {
    return this.sessionId ? `${this.opts.webBase.replace(/\/$/, '')}/remote/${this.sessionId}` : '';
  }

  /** Register the session and start receiving remote turns. Returns the
   *  continue URL, or throws if registration fails. */
  async start(): Promise<string> {
    const res = await this.fetchImpl(`${this.opts.gatewayBase}/api/stealth/runner/session`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
        'x-bandit-device-id': this.opts.deviceId,
        'x-bandit-device-label': this.opts.deviceLabel
      },
      body: JSON.stringify({ deviceId: this.opts.deviceId, title: this.opts.title, mode: this.opts.mode })
    });
    if (!res.ok) {
      throw new Error(`register session failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { sessionId?: string };
    if (!body.sessionId) throw new Error('register session: no sessionId returned');
    this.sessionId = body.sessionId;
    this.inboxLoop = this.consumeInbox();
    return this.continueUrl;
  }

  private async consumeInbox(): Promise<void> {
    try {
      for await (const task of this.gateway.inbox(this.controller.signal)) {
        // A delivery task carrying OUR session id is a remote turn for this
        // session. (The interactive REPL only handles its own session.)
        if (task.sessionId && task.sessionId === this.sessionId) {
          this.opts.onStatus?.('remote turn received');
          this.opts.onRemoteTurn(task.prompt);
        }
      }
    } catch (err) {
      this.opts.onStatus?.(`inbox stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Mirror the user side of a turn (a prompt) into the session stream. */
  async mirrorUser(prompt: string): Promise<void> {
    await this.post({ type: 'user.message', text: prompt });
  }

  /** Mirror a structured turn event (tool.call / tool.result /
   *  reasoning.text) so remote viewers see the turn's anatomy, not just
   *  its final text. */
  async mirrorEvent(evt: { type: string } & Record<string, unknown>): Promise<void> {
    await this.post(evt);
  }

  /** Mirror the assistant side of a turn (the final response). We deliberately
   *  DON'T emit turn.completed here — that would flip the session container's
   *  status; the gateway keeps a "live" task live. */
  async mirrorAssistant(response: string): Promise<void> {
    await this.post({ type: 'assistant.delta', text: response });
  }

  private async post(event: Record<string, unknown>): Promise<void> {
    if (!this.sessionId) return;
    try {
      const res = await this.fetchImpl(
        `${this.opts.gatewayBase}/api/stealth/tasks/${encodeURIComponent(this.sessionId)}/events`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ...event, taskId: this.sessionId })
        }
      );
      if (!res.ok) this.opts.onStatus?.(`mirror ${event.type} failed: HTTP ${res.status}`);
    } catch (err) {
      this.opts.onStatus?.(`mirror ${event.type} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    this.controller.abort();
    this.sessionId = null;
  }
}
