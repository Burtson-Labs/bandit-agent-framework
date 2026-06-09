/**
 * `VoiceService` owns the speech surface end-to-end: text-to-speech
 * dispatch (auto-speak after assistant turns + the manual speaker
 * button), speech-to-text (the composer's mic capture), and the
 * extension-side recorder lifecycle (probe → install offer → start /
 * stop / cancel).
 *
 * Two adapter paths converge here:
 * - TTS via `synthesizeSpeech` (Bandit / OpenAI / ElevenLabs / Piper /
 *   custom) — auto-speak and manual playback both dispatch through it.
 * - STT via `transcribeAudio` (Bandit / OpenAI Whisper / custom) —
 *   both the webview's browser recorder and the extension-side native
 *   recorder feed the same path.
 *
 * Cloud-gating: `ttsRequiresBanditKey` / `sttRequiresBanditKey` flag
 * which provider needs the Bandit Cloud API key vs the
 * `voice.{stt,tts}.apiKey` setting. The service short-circuits with
 * an `audioError` / `notification` post when the gate is configured
 * but no key is stored — never silently fails.
 *
 * Pre-extraction (≤ v1.7.349) this was four private methods + five
 * inline `extensionMic*` branches in `handleMessage` on the provider.
 * Pulling it out leaves the provider's dispatch as a thin switch and
 * keeps the auto-speak gating decisions in one place.
 */
import * as vscode from 'vscode';
import type { ProviderKind } from '@burtson-labs/stealth-core-runtime';
import { resolveSttUrl, resolveTtsUrl } from '../../helpers/endpoints';
import { extractSpeakableText } from '../../helpers/speakableText';
import {
  cancelRecording as cancelExtensionRecording,
  getInstallHint as getRecorderInstallHint,
  probeRecorder,
  startRecording as startExtensionRecording,
  stopRecording as stopExtensionRecording
} from '../../extensionRecorder';
import type { ConversationEntry } from '../../services/conversationTypes';
import { API_KEY_SECRET_KEY } from '../../storageKeys';
import { sttRequiresBanditKey, synthesizeSpeech, transcribeAudio, ttsRequiresBanditKey } from '../../voiceProviders';
import type { ProviderContext } from '../context';

export class VoiceService {
  constructor(private readonly ctx: ProviderContext) {}

  /**
   * Auto-speak gating + dispatch. Called from
   * `performToolUseCompletion` after the assistant entry finalizes.
   *
   * Skip conditions (in order):
   * 1. `voice.autoSpeak` is off (silent)
   * 2. TTS provider needs a Bandit key and none is stored (loud —
   *    posts `audioError` so the user knows why nothing played)
   * 3. No speakable text after stripping code/tool/diff fences (silent
   *    — too noisy on agentic turns)
   * 4. Word count exceeds `voice.maxAutoSpeakWords` (silent — long
   *    responses shouldn't auto-play)
   */
  async maybeAutoSpeak(
    entry: ConversationEntry,
    configuration: vscode.WorkspaceConfiguration,
    apiKey: string | undefined,
    providerKind: ProviderKind
  ): Promise<void> {
    const autoSpeakOn = configuration.get<boolean>('voice.autoSpeak', false);
    if (!autoSpeakOn) {return;}

    const ttsProvider = configuration.get<'bandit' | 'openai' | 'elevenlabs' | 'piper' | 'custom'>('voice.tts.provider', 'bandit');
    if (ttsRequiresBanditKey(ttsProvider) && !apiKey) {
      this.ctx.postMessage({
        type: 'audioError',
        entryId: entry.id,
        message: 'Auto-speak is on but no Bandit API key is saved. Paste one in Settings → Account, or switch the TTS provider in Voice settings.'
      });
      return;
    }
    void providerKind;

    const speakable = extractSpeakableText(entry.content ?? '');
    if (!speakable) {
      return;
    }

    const wordCap = Math.max(0, configuration.get<number>('voice.maxAutoSpeakWords', 120));
    if (wordCap > 0) {
      const wordCount = speakable.split(/\s+/).filter(Boolean).length;
      if (wordCount > wordCap) {return;}
    }

    await this.sendTts(entry.id, speakable, configuration, apiKey);
  }

  /**
   * TTS dispatcher — fetch synthesized audio via the configured
   * voice-provider adapter and forward to the webview. Shared by
   * auto-speak and the manual speaker button.
   */
  async sendTts(
    entryId: string,
    text: string,
    configuration: vscode.WorkspaceConfiguration,
    apiKey: string | undefined
  ): Promise<void> {
    const voiceId = configuration.get<string>('voice.voiceId', 'en_US-brian-premium');
    const banditUrl = resolveTtsUrl(configuration);
    try {
      const result = await synthesizeSpeech(
        { get: <T,>(section: string, def: T) => configuration.get<T>(section, def) },
        { text, voice: voiceId, banditApiKey: apiKey, banditUrl }
      );
      this.ctx.postMessage({
        type: 'playAudio',
        entryId,
        mimeType: result.mimeType,
        audioBase64: Buffer.from(result.audio).toString('base64')
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.postMessage({ type: 'audioError', entryId, message: msg });
    }
  }

  /**
   * Webview handler — user clicked the speaker icon on an assistant
   * entry. Re-extracts speakable text (in case the entry was edited
   * or compacted) and dispatches through the same TTS pipeline as
   * auto-speak. Bypasses the word-count cap since the user explicitly
   * asked for it.
   */
  async handleSpeak(entryId: string, text: string): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const ttsProvider = configuration.get<'bandit' | 'openai' | 'elevenlabs' | 'piper' | 'custom'>('voice.tts.provider', 'bandit');
    const apiKey = ttsRequiresBanditKey(ttsProvider)
      ? await this.ctx.extensionContext.secrets.get(API_KEY_SECRET_KEY)
      : undefined;
    if (ttsRequiresBanditKey(ttsProvider) && !apiKey) {
      this.ctx.postMessage({
        type: 'audioError',
        entryId,
        message: 'Bandit TTS needs a Bandit API key — set one in the Account tab, or switch the TTS provider in Voice settings.'
      });
      return;
    }
    const speakable = extractSpeakableText(text) || text;
    if (!speakable.trim()) {
      this.ctx.postMessage({ type: 'audioError', entryId, message: 'No speakable text in this message.' });
      return;
    }
    await this.sendTts(entryId, speakable, configuration, apiKey);
  }

  /**
   * Webview handler — `transcribeAudio` message. Rebuilds the bytes
   * from base64, dispatches through the configured STT adapter, and
   * posts the resulting transcription back as `voiceTranscription`
   * so the composer can insert it.
   */
  async handleTranscribe(audioBase64: string, mimeType: string): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('banditStealth');
    const sttProvider = configuration.get<'bandit' | 'openai-whisper' | 'custom'>('voice.stt.provider', 'bandit');
    const apiKey = sttRequiresBanditKey(sttProvider)
      ? await this.ctx.extensionContext.secrets.get(API_KEY_SECRET_KEY)
      : undefined;
    if (sttRequiresBanditKey(sttProvider) && !apiKey) {
      this.ctx.postMessage({ type: 'notification', message: 'Bandit STT needs a Bandit API key — set one in Account, or switch the STT provider in Voice settings.' });
      return;
    }
    try {
      const banditUrl = resolveSttUrl(configuration);
      const bytes = Buffer.from(audioBase64, 'base64');
      const normalizedMime = (mimeType || 'audio/webm').split(';')[0].trim();
      const result = await transcribeAudio(
        { get: <T,>(section: string, def: T) => configuration.get<T>(section, def) },
        { audioBytes: bytes, mimeType: normalizedMime, banditApiKey: apiKey, banditUrl }
      );
      const transcription = result.text.trim();
      if (!transcription) {
        this.ctx.postMessage({ type: 'notification', message: 'Transcription returned empty text.' });
        return;
      }
      this.ctx.postMessage({ type: 'voiceTranscription', text: transcription });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.postMessage({ type: 'notification', message: msg });
    }
  }

  /**
   * Webview handler — `extensionMicProbe`. Posts the recorder
   * availability + install hint so the composer can decide whether
   * to render the mic button enabled, disabled-with-install, or
   * disabled-no-option.
   */
  handleMicProbe(): void {
    const probe = probeRecorder();
    const hint = probe.available ? null : getRecorderInstallHint();
    this.ctx.postMessage({
      type: 'extensionMicAvailability',
      available: probe.available,
      kind: probe.kind,
      message: probe.message,
      canAutoInstall: hint !== null && hint.manager !== null,
      installerName: hint?.friendlyName
    });
  }

  /**
   * Webview handler — `extensionMicInstallOffer`. Opens a visible
   * terminal and runs the platform install command. We deliberately
   * don't spawn the install in the background — the user should see
   * what's being installed (it's their machine, their package
   * manager). Surfaces a "reload after install" notification
   * follow-up so the user knows what to do next.
   */
  handleMicInstallOffer(): void {
    const hint = getRecorderInstallHint();
    if (!hint.manager) {
      this.ctx.postMessage({ type: 'extensionMicError', message: hint.command });
      return;
    }
    const terminal = vscode.window.createTerminal({ name: 'Bandit: install recorder' });
    terminal.show(true);
    terminal.sendText(hint.command);
    void vscode.window.showInformationMessage(
      `Bandit started ${hint.friendlyName} in the terminal. After it finishes, reload this window to enable the mic.`,
      'Reload window'
    ).then((choice) => {
      if (choice === 'Reload window') {
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  }

  /**
   * Webview handler — `extensionMicStart`. Errors surface as
   * `extensionMicError` so the composer can show a banner and
   * disable the mic button.
   */
  async handleMicStart(): Promise<void> {
    try {
      await startExtensionRecording();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.postMessage({ type: 'extensionMicError', message: msg });
    }
  }

  /**
   * Webview handler — `extensionMicStop`. The recorder produces a
   * 16kHz mono WAV, so we hand it to the existing transcribe path
   * with a fixed mime type.
   */
  async handleMicStop(): Promise<void> {
    try {
      const buf = await stopExtensionRecording();
      await this.handleTranscribe(buf.toString('base64'), 'audio/wav');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.postMessage({ type: 'extensionMicError', message: msg });
    }
  }

  /** Webview handler — `extensionMicCancel`. */
  handleMicCancel(): void {
    cancelExtensionRecording();
  }
}
