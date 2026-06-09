import type { JSX } from "react";
import clsx from "clsx";
import {
  ChatComposer,
  type ComposerSkillOption
} from "@burtson-labs/agent-ui";
import type { MicState } from "../hooks/useMicrophoneRecording";

export interface ComposerQueuedPrompt {
  id: string;
  text: string;
  images: unknown[];
  files: unknown[];
}

export interface ComposerProps {
  // Core composer state:
  composerValue: string;
  setComposerValue: (value: string) => void;
  composerDisabled: boolean;
  isChatStreaming: boolean;
  // Submission:
  onSubmit: (value: string) => void;
  onCancel: () => void;
  // Attachments:
  contextFiles: Array<{ path: string; preview?: string }>;
  onAttachContext: () => void;
  onRemoveContextFile: (path: string) => void;
  images: string[];
  onPasteImages: (files: File[]) => void;
  onRemoveImage: (index: number) => void;
  autoContextEnabled: boolean;
  onToggleAutoContext: () => void;
  // Queue (prompts queued while busy):
  queuedPrompts: ComposerQueuedPrompt[];
  onCancelQueuedPrompt: (id: string) => void;
  // Slash commands + mention picker:
  slashCommands: Array<{ name: string; description?: string }>;
  mentionSuggestions: Array<{ path: string; isDir: boolean }>;
  onFileMentionQuery: (query: string) => void;
  onRequestSkills: () => Promise<ComposerSkillOption[]>;
  // Voice input (mic):
  voiceMicEnabled: boolean;
  onMicStart: () => void;
  onMicStop: () => void;
  micState: MicState;
  // Auto-approve toggle + outbound config update:
  autoApproveEdits: boolean;
  onToggleEditAutoApprove: () => void;
  // Model / provider settings slot:
  modelLabel: string;
  providerKind: "bandit" | "ollama" | "openai-compatible";
  onSelectProvider: (provider: "bandit" | "ollama" | "openai-compatible") => void;
  onEditModel: () => void;
  onEditOllamaUrl: () => void;
}

/**
 * Wrapper around agent-ui's `<ChatComposer />` with the Bandit
 * Stealth-specific settings slot (provider picker + model link + the
 * Ollama URL link). All composer state + callbacks flow as props.
 */
export function Composer(props: ComposerProps): JSX.Element {
  const {
    composerValue,
    setComposerValue,
    composerDisabled,
    isChatStreaming,
    onSubmit,
    onCancel,
    contextFiles,
    onAttachContext,
    onRemoveContextFile,
    images,
    onPasteImages,
    onRemoveImage,
    autoContextEnabled,
    onToggleAutoContext,
    queuedPrompts,
    onCancelQueuedPrompt,
    slashCommands,
    mentionSuggestions,
    onFileMentionQuery,
    onRequestSkills,
    voiceMicEnabled,
    onMicStart,
    onMicStop,
    micState,
    autoApproveEdits,
    onToggleEditAutoApprove,
    modelLabel,
    providerKind,
    onSelectProvider,
    onEditModel,
    onEditOllamaUrl
  } = props;
  return (
    <ChatComposer
      value={composerValue}
      onChange={setComposerValue}
      onSubmit={onSubmit}
      onAttach={onAttachContext}
      onPasteImages={onPasteImages}
      onCancel={onCancel}
      isStreaming={isChatStreaming}
      allowQueueWhileStreaming
      queuedCount={queuedPrompts.length}
      queuedItems={queuedPrompts.map((q) => ({
        id: q.id,
        preview: q.text.length > 60 ? q.text.slice(0, 57).trimEnd() + "…" : q.text,
        imageCount: q.images.length || undefined,
        fileCount: q.files.length || undefined
      }))}
      onCancelQueued={onCancelQueuedPrompt}
      disabled={composerDisabled}
      contextFiles={contextFiles}
      onRemoveContextFile={onRemoveContextFile}
      images={images}
      onRemoveImage={onRemoveImage}
      autoContextEnabled={autoContextEnabled}
      onToggleAutoContext={onToggleAutoContext}
      slashCommands={slashCommands}
      fileMentionSuggestions={mentionSuggestions}
      onFileMentionQuery={onFileMentionQuery}
      onMicStart={voiceMicEnabled ? onMicStart : undefined}
      onMicStop={voiceMicEnabled ? onMicStop : undefined}
      micState={micState}
      onRequestSkills={onRequestSkills}
      editAutoApproveEnabled={autoApproveEdits}
      onToggleEditAutoApprove={onToggleEditAutoApprove}
      modelLabel={modelLabel}
      settingsSlot={
        <div className="composer-settings-models">
          <div className="composer-settings-models__label">Provider</div>
          <div className="composer-settings-models__row">
            <button
              type="button"
              className={clsx(
                "composer-settings-models__pill",
                providerKind === "bandit" && "is-active"
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectProvider("bandit");
              }}
            >
              Bandit AI
            </button>
            <button
              type="button"
              className={clsx(
                "composer-settings-models__pill",
                providerKind === "ollama" && "is-active"
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelectProvider("ollama");
              }}
            >
              Ollama
            </button>
          </div>
          <button
            type="button"
            className="composer-settings-models__link"
            onMouseDown={(e) => {
              e.preventDefault();
              onEditModel();
            }}
          >
            {providerKind === "ollama" ? "Set Ollama model…" : "Set Bandit model…"}
          </button>
          {providerKind === "ollama" && (
            <button
              type="button"
              className="composer-settings-models__link"
              onMouseDown={(e) => {
                e.preventDefault();
                onEditOllamaUrl();
              }}
            >
              Edit Ollama URL…
            </button>
          )}
        </div>
      }
    />
  );
}
