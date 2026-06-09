import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import {
  CommandLineIcon,
  MicrophoneIcon,
  PaperClipIcon,
  PhotoIcon,
  PlusIcon,
  StopCircleIcon,
  XMarkIcon
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import type { ChatMessageContextFile } from "../types/ui-schema";

export interface ComposerContextAttachment extends ChatMessageContextFile {
  preview?: string;
}

export interface SlashCommandHint {
  /** Command name, no leading slash. */
  name: string;
  /** One-line description shown beside the name in the popover. */
  description?: string;
}

export interface ComposerSkillOption {
  /** Short id used as the slash-token inserted into the textarea (`/<id>`). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Optional one-line description shown beside the name in the picker. */
  description?: string;
  /** Source grouping used to split built-in skills from workspace skills. */
  source?: "builtin" | "workspace";
}

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onAttach?: () => void;
  onPasteImages?: (files: File[]) => void;
  onCancel?: () => void;
  isStreaming?: boolean;
  /** Voice input. When `onMicStart` is provided the composer renders a
   * mic button next to the attach button. State is owned by the host:
   * the host flips `micState` as recording starts/stops/uploads and
   * the button shows the matching affordance. Click → start, click
   * again while recording → stop and upload. */
  onMicStart?: () => void;
  onMicStop?: () => void;
  micState?: "idle" | "recording" | "uploading";
  placeholder?: string;
  disabled?: boolean;
  contextFiles?: ComposerContextAttachment[];
  onRemoveContextFile?: (path: string) => void;
  images?: string[];
  onRemoveImage?: (index: number) => void;
  autoContextEnabled?: boolean;
  onToggleAutoContext?: () => void;
  /** Optional slash-command autocomplete. When provided and the user types `/`,
   * a filterable popover appears above the textarea. */
  slashCommands?: SlashCommandHint[];
  /** When provided, renders a Claude-Code-style `/` button that opens a
   * slash-command picker. For v1 the callback can be a no-op stub — this
   * prop exists so the button can be unconditionally mounted and hosts
   * can flesh out the picker later. If {@link onRequestSkills} is supplied
   * the built-in skill picker takes over and this callback is ignored. */
  onOpenSlashPicker?: () => void;
  /** Optional async resolver that returns the list of skills available for
   * the current workspace. When supplied, clicking the `/` button opens a
   * filterable, keyboard-navigable popover that lets the user insert
   * `/<skill-id>` as a prefix in the textarea. */
  onRequestSkills?: () => Promise<ComposerSkillOption[]> | ComposerSkillOption[];
  /** Controls the Ask/Auto edit-approval toggle. When set, the composer
   * renders a toggle near the submit arrow matching the Claude UX. */
  editAutoApproveEnabled?: boolean;
  /** Handler invoked when the user toggles edit-auto-approve. When omitted
   * the toggle is hidden. */
  onToggleEditAutoApprove?: () => void;
  /** Extra controls rendered inside the `/` command menu under a
   * "Settings" section. Use this to hang host-specific settings
   * (e.g. model picker, provider switcher) off the same menu that
   * carries skills — keeps the composer row to `+ / send`. */
  settingsSlot?: ReactNode;
  /** Compact label shown in the composer header when the chat is
   * focused on a specific model (e.g. "bandit-core:12b-it-qat"). The
   * full picker lives inside the `/` settings slot; this is read-only. */
  modelLabel?: string;
  /** DEPRECATED: use {@link settingsSlot} instead. Kept for
   * back-compat; renders nothing in v1.5.53+ because the composer row
   * no longer has room for an inline footer chip. */
  footerSlot?: ReactNode;
  /**
   * File / folder suggestions for `@` mention autocomplete. Host
   * populates this in response to {@link onFileMentionQuery}. Each
   * entry carries `isDir` so the composer can:
   * - render folders distinctly (trailing `/`, dim subpath)
   * - on folder select, DRILL IN (update the query to `folder/` and
   * keep the picker open) rather than committing the mention
   * - on file select, commit the mention and close the picker
   *
   * Accepts the legacy `string[]` shape for back-compat — each string
   * is treated as a file entry.
   */
  fileMentionSuggestions?: Array<{ path: string; isDir: boolean }> | string[];
  /**
   * Fires whenever the user is actively typing a `@<query>` token
   * (after whitespace or at line start, no closing space yet). Host
   * should debounce + search workspace files and feed results back
   * via {@link fileMentionSuggestions}. Called with an empty string
   * when the `@` is still bare — host can return the N most recently
   * touched files as a sensible default.
   */
  onFileMentionQuery?: (query: string) => void;
  /**
   * When true, allow the user to submit a new message while a turn
   * is already streaming. The host receives `onSubmit` and is
   * expected to queue the message (not send it). Default `false`
   * preserves the original behavior (submit is blocked during
   * stream). When true, the stop-button stays visible and the host
   * shows its own "queued" affordance — the composer just stops
   * eating Enter / form-submit events.
   */
  allowQueueWhileStreaming?: boolean;
  /** Number of messages the host is currently holding behind the
   * active turn. Renders as a small "N queued" pill inside the
   * composer footer when > 0. The composer is otherwise unaware
   * of the queue contents — host owns the array and dispatches
   * on stream completion. Ignored when `queuedItems` is provided. */
  queuedCount?: number;
  /** Rich queue contents: when provided, the composer renders one
   * cancellable pill per item (preview text + ✕). Falls back to
   * `queuedCount` rendering when this is not provided so older
   * hosts keep working. */
  queuedItems?: Array<{ id: string; preview: string; imageCount?: number; fileCount?: number }>;
  /** Invoked when the user clicks the ✕ on a queued-message pill. */
  onCancelQueued?: (id: string) => void;
}

export const ChatComposer = ({
  value,
  onChange,
  onSubmit,
  onAttach,
  onPasteImages,
  onCancel,
  isStreaming = false,
  onMicStart,
  onMicStop,
  micState = "idle",
  placeholder = "Message Bandit — @ to mention a file, / for commands",
  disabled,
  contextFiles,
  onRemoveContextFile,
  images,
  onRemoveImage,
  autoContextEnabled = true,
  onToggleAutoContext,
  slashCommands,
  onOpenSlashPicker,
  onRequestSkills,
  editAutoApproveEnabled,
  onToggleEditAutoApprove,
  settingsSlot,
  modelLabel,
  footerSlot,
  fileMentionSuggestions,
  onFileMentionQuery,
  allowQueueWhileStreaming = false,
  queuedCount = 0,
  queuedItems,
  onCancelQueued
}: ChatComposerProps): JSX.Element => {
  // footerSlot is retained for type-compat; ignored in v1.5.53+.
  void footerSlot;
  const hasContextFiles = Array.isArray(contextFiles) && contextFiles.length > 0;
  const hasImages = Array.isArray(images) && images.length > 0;
  const [expandedImage, setExpandedImage] = useState<string | null>(null);
  // Skill picker state: opened from the `/` button, populated on demand.
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillList, setSkillList] = useState<ComposerSkillOption[] | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillIndex, setSkillIndex] = useState(0);
  // Slash-command autocomplete: active when value starts with `/` and the
  // user hasn't typed a space yet (i.e. we're still picking the command).
  const [slashIndex, setSlashIndex] = useState(0);
  const slashQuery = value.startsWith('/') && !value.includes(' ') ? value.slice(1).toLowerCase() : null;
  const slashMatches = slashCommands && slashQuery !== null
    ? slashCommands.filter(c => c.name.toLowerCase().startsWith(slashQuery)).slice(0, 8)
    : [];
  const showSlashMenu = slashMatches.length > 0;
  useEffect(() => {
    // Reset selected index when the filter changes.
    setSlashIndex(0);
  }, [value]);
  const completeSlash = (name: string): void => {
    onChange('/' + name + ' ');
  };

  // @-mention autocomplete. Active when the caret sits inside an
  // `@<token>` at or near the end of the input — specifically, when
  // the last `@` in the string is preceded by a whitespace char (or
  // is at position 0) and has no whitespace after it yet. Keeps the
  // popover tight to real mention intent; prevents spurious activation
  // on email addresses mid-prose (e.g. "mark@burtson.ai") because
  // those have no leading-whitespace anchor.
  const mentionMatch = (() => {
    const lastAt = value.lastIndexOf('@');
    if (lastAt < 0) {return null;}
    const precedingChar = lastAt === 0 ? ' ' : value[lastAt - 1];
    if (!/\s/.test(precedingChar)) {return null;}
    const rest = value.slice(lastAt + 1);
    if (/\s/.test(rest)) {return null;}
    return { at: lastAt, query: rest };
  })();
  const mentionQuery = mentionMatch?.query ?? null;
  const [mentionIndex, setMentionIndex] = useState(0);
  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);
  // Tell the host to fetch matching files whenever the @-token changes.
  useEffect(() => {
    if (mentionQuery === null) {return;}
    if (!onFileMentionQuery) {return;}
    onFileMentionQuery(mentionQuery);
  }, [mentionQuery, onFileMentionQuery]);
  // Normalize legacy `string[]` input into the entry shape so the rest
  // of this component deals with one type. New callers pass entries
  // directly; old callers keep working.
  const mentionMatches: Array<{ path: string; isDir: boolean }> =
    mentionQuery !== null && Array.isArray(fileMentionSuggestions)
      ? fileMentionSuggestions.slice(0, 8).map((s) =>
          typeof s === "string" ? { path: s, isDir: false } : s
        )
      : [];
  const showMentionMenu = mentionMatches.length > 0 && mentionQuery !== null;
  const completeMention = (entry: { path: string; isDir: boolean }): void => {
    if (!mentionMatch) {return;}
    const before = value.slice(0, mentionMatch.at);
    const after = value.slice(mentionMatch.at + 1 + mentionMatch.query.length);
    if (entry.isDir) {
      // Folder drill: insert `@folder/` (trailing slash) but do NOT add
      // a trailing space — that would close the mention token. The
      // mention-query effect re-fires on the new value and the host
      // returns the folder's direct children for the next pick.
      const trimmed = entry.path.replace(/\/+$/, '');
      onChange(`${before}@${trimmed}/${after}`);
    } else {
      // File pick: commit the mention with a trailing space so the
      // user can keep typing the rest of their prompt immediately.
      onChange(`${before}@${entry.path} ${after}`);
    }
  };

  // Flatten + filter the skill list for the picker.
  const filteredSkills = (() => {
    if (!skillList) {return [] as ComposerSkillOption[];}
    const q = skillQuery.trim().toLowerCase();
    if (!q) {return skillList;}
    return skillList.filter((s) =>
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      (s.description ?? "").toLowerCase().includes(q)
    );
  })();
  const builtinSkills = filteredSkills.filter((s) => s.source !== "workspace");
  const workspaceSkills = filteredSkills.filter((s) => s.source === "workspace");
  // Build a flat ordered list mirroring the rendered order, so the
  // keyboard index maps correctly across the divider.
  const orderedSkills: ComposerSkillOption[] = [...builtinSkills, ...workspaceSkills];

  // Reset highlight when the query changes.
  useEffect(() => {
    setSkillIndex(0);
  }, [skillQuery, skillPickerOpen]);

  // Close on outside click / escape handled by a doc listener.
  useEffect(() => {
    if (!skillPickerOpen) {return;}
    const onDocKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSkillPickerOpen(false);
      }
    };
    const onDocClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (!target) {return;}
      if (target.closest(".composer-skill-picker")) {return;}
      if (target.closest(".composer-slash-button")) {return;}
      setSkillPickerOpen(false);
    };
    window.addEventListener("keydown", onDocKey);
    window.addEventListener("mousedown", onDocClick);
    return () => {
      window.removeEventListener("keydown", onDocKey);
      window.removeEventListener("mousedown", onDocClick);
    };
  }, [skillPickerOpen]);

  const openSkillPicker = async (): Promise<void> => {
    if (onRequestSkills) {
      setSkillPickerOpen(true);
      setSkillQuery("");
      // Populate on demand so the picker reflects freshly loaded
      // workspace skills every time it opens.
      try {
        setSkillLoading(true);
        const next = await onRequestSkills();
        setSkillList(Array.isArray(next) ? next : []);
      } catch {
        setSkillList([]);
      } finally {
        setSkillLoading(false);
      }
      return;
    }
    // Fallback to the legacy stub callback when no resolver supplied.
    if (onOpenSlashPicker) {
      onOpenSlashPicker();
    }
  };

  const insertSkillPrefix = (skillId: string): void => {
    // Preserve whatever the user had typed: if the value already starts
    // with a slash-token, replace it; otherwise prepend `/<id> ` to the
    // existing text. The model reads the prefix verbatim.
    const token = `/${skillId}`;
    const trimmed = value.trimStart();
    if (trimmed.startsWith("/")) {
      const rest = trimmed.replace(/^\/\S*\s*/, "");
      onChange(rest ? `${token} ${rest}` : `${token} `);
    } else {
      onChange(trimmed ? `${token} ${trimmed}` : `${token} `);
    }
    setSkillPickerOpen(false);
  };

  const handleSkillKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSkillIndex((i) => Math.min(i + 1, Math.max(orderedSkills.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSkillIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const pick = orderedSkills[skillIndex];
      if (pick) {insertSkillPrefix(pick.id);}
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSkillPickerOpen(false);
    }
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    // While streaming, the host can opt into queueing rather than
    // blocking — the composer hands the message up via onSubmit and
    // it's the host's job to stash it on the queue (not the network).
    if (isStreaming && !allowQueueWhileStreaming) {
      return;
    }
    const nextValue = value.trim();
    if (!nextValue) {
      return;
    }
    onSubmit(nextValue);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(event.target.value);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Mention menu takes precedence when visible — same keyboard nav
    // contract as the slash menu (ArrowUp/Down to move, Tab/Enter to
    // complete, Escape to dismiss). Escape just clears the token from
    // input so the user can keep typing without the popover.
    if (showMentionMenu) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionMatches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const pick = mentionMatches[mentionIndex];
        if (pick) {completeMention(pick);}
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (mentionMatch) {
          const before = value.slice(0, mentionMatch.at);
          const after = value.slice(mentionMatch.at + 1 + mentionMatch.query.length);
          onChange(before + after);
        }
        return;
      }
    }
    // Slash menu keyboard nav takes precedence when visible.
    if (showSlashMenu) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, slashMatches.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const pick = slashMatches[slashIndex];
        if (pick) {completeSlash(pick.name);}
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const pick = slashMatches[slashIndex];
        if (pick) {completeSlash(pick.name);}
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onChange("");
        return;
      }
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      if (disabled || (isStreaming && !allowQueueWhileStreaming) || !value.trim()) {
        return;
      }
      event.preventDefault();
      onSubmit(value.trim());
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!onPasteImages) {
      return;
    }
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      onPasteImages(imageFiles);
    }
  };

  useEffect(() => {
    if (!expandedImage) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setExpandedImage(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [expandedImage]);

  const handleOpenImagePreview = (src: string): void => {
    setExpandedImage(src);
  };

  const handleCloseImagePreview = (): void => {
    setExpandedImage(null);
  };

  // when streaming with text in the composer AND the host
  // allows queueing, the action button flips to "send" instead of
  // "stop": the user clearly intends to deliver the message, not to
  // cancel the in-flight turn. Empty composer while streaming keeps
  // the stop affordance. This makes the button match what Enter
  // already does (handleSubmit honours `allowQueueWhileStreaming`)
  // so the visual matches the keyboard.
  const isStopMode = isStreaming && (!allowQueueWhileStreaming || !value.trim());
  const actionDisabled = isStopMode ? !onCancel : Boolean(disabled) || !value.trim();

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {showSlashMenu && (
        <div className="composer-slash-menu" role="listbox" aria-label="Slash command suggestions">
          {slashMatches.map((cmd, i) => (
            <button
              type="button"
              key={cmd.name}
              role="option"
              aria-selected={i === slashIndex}
              className={clsx("composer-slash-item", i === slashIndex && "is-active")}
              onMouseDown={(e) => { e.preventDefault(); completeSlash(cmd.name); }}
            >
              <span className="composer-slash-name">/{cmd.name}</span>
              {cmd.description && <span className="composer-slash-desc">{cmd.description}</span>}
            </button>
          ))}
        </div>
      )}
      {showMentionMenu && (
        <div className="composer-slash-menu composer-mention-menu" role="listbox" aria-label="File mention suggestions">
          {mentionMatches.map((entry, i) => {
            const p = entry.path;
            const base = p.split('/').pop() ?? p;
            const dir = p.slice(0, Math.max(0, p.length - base.length - 1));
            // Folders render with a trailing `/` + dim cyan tint via a
            // modifier class. Makes folder-drill entries visually
            // distinct from file picks at a glance.
            return (
              <button
                type="button"
                key={(entry.isDir ? "dir:" : "file:") + p}
                role="option"
                aria-selected={i === mentionIndex}
                className={clsx(
                  "composer-slash-item",
                  i === mentionIndex && "is-active",
                  entry.isDir && "is-directory"
                )}
                onMouseDown={(e) => { e.preventDefault(); completeMention(entry); }}
              >
                <span className="composer-slash-name">
                  @{base}{entry.isDir ? "/" : ""}
                </span>
                {dir && <span className="composer-slash-desc">{dir}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="composer-input">
        {(hasContextFiles || hasImages) && (
          <div className="composer-attachments" aria-label="Attached context">
            {contextFiles?.map((file) => (
              <div className="composer-attachment" key={file.path}>
                <div className="composer-attachment__icon" aria-hidden="true">
                  <PaperClipIcon />
                </div>
                <div className="composer-attachment__body">
                  <p className="composer-attachment__title" title={file.path}>
                    {file.path}
                  </p>
                  {file.preview && (
                    <p className="composer-attachment__meta" title={file.preview}>
                      {file.preview}
                    </p>
                  )}
                </div>
                {onRemoveContextFile && (
                  <button
                    type="button"
                    className="composer-attachment__remove"
                    onClick={() => onRemoveContextFile(file.path)}
                    aria-label={`Remove ${file.path} from context`}
                  >
                    <XMarkIcon aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
            {images?.map((src, index) => (
              <div className="composer-image" key={`${src}-${index}`}>
                {src ? (
                  <button
                    type="button"
                    className="composer-image__preview"
                    onClick={() => handleOpenImagePreview(src)}
                    aria-label={`Open image attachment ${index + 1}`}
                  >
                    <img className="composer-image__img" src={src} alt={`Attachment ${index + 1}`} loading="lazy" />
                  </button>
                ) : (
                  <div className="composer-image__placeholder" aria-hidden="true">
                    <PhotoIcon />
                  </div>
                )}
                {onRemoveImage && (
                  <button
                    type="button"
                    className="composer-image__remove"
                    onClick={() => onRemoveImage(index)}
                    aria-label={`Remove image ${index + 1}`}
                  >
                    <XMarkIcon aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className={clsx("composer-field", value.startsWith("!") && "composer-field--shell-mode")}>
          {value.startsWith("!") ? (
            <div className="composer-shell-banner" role="note" aria-live="polite">
              <strong>▸ SHELL MODE</strong>
              <span>next Enter runs in your integrated terminal — agent will not see the output</span>
            </div>
          ) : null}
          <textarea
            className="composer-textarea"
            placeholder={
              isStreaming && allowQueueWhileStreaming
                ? "Ask a follow-up or steer me if I'm going off the rails — sends after this turn"
                : placeholder
            }
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled}
          />
          {queuedItems && queuedItems.length > 0 ? (
            <div className="composer-queued-list" aria-label="Messages queued to send after current turn">
              {queuedItems.map((item) => {
                const attachmentNote = (() => {
                  const parts: string[] = [];
                  if (item.imageCount && item.imageCount > 0) {parts.push(`${item.imageCount} img`);}
                  if (item.fileCount && item.fileCount > 0) {parts.push(`${item.fileCount} file`);}
                  return parts.length ? ` · ${parts.join(", ")}` : "";
                })();
                return (
                  <div
                    key={item.id}
                    className="composer-queued-pill is-cancellable"
                    title="Will send after the current turn finishes"
                  >
                    <span className="composer-queued-pill__label">
                      {item.preview}
                      {attachmentNote ? (
                        <span className="composer-queued-pill__attachments">{attachmentNote}</span>
                      ) : null}
                    </span>
                    {onCancelQueued ? (
                      <button
                        type="button"
                        className="composer-queued-pill__cancel"
                        onClick={() => onCancelQueued(item.id)}
                        aria-label="Cancel this queued message"
                        title="Cancel this queued message"
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : queuedCount > 0 ? (
            <div className="composer-queued-pill" title="Will send after the current turn finishes">
              {queuedCount} queued · sends after this turn
            </div>
          ) : null}
        </div>
        <div className="composer-controls">
          <button
            type="button"
            className="composer-attach-button composer-icon-button"
            onClick={onAttach}
            aria-label="Attach files"
            title="Attach files"
            disabled={!onAttach || disabled}
          >
            <PlusIcon aria-hidden="true" className="composer-icon" />
          </button>
          {onMicStart && (
            <button
              type="button"
              className={clsx(
                "composer-mic-button composer-icon-button",
                micState === "recording" && "is-recording",
                micState === "uploading" && "is-uploading"
              )}
              onClick={() => {
                if (micState === "recording" && onMicStop) {
                  onMicStop();
                } else if (micState === "idle") {
                  onMicStart();
                }
              }}
              aria-label={
                micState === "recording"
                  ? "Stop recording"
                  : micState === "uploading"
                  ? "Transcribing…"
                  : "Record voice prompt"
              }
              title={
                micState === "recording"
                  ? "Stop recording"
                  : micState === "uploading"
                  ? "Transcribing…"
                  : "Record voice prompt"
              }
              disabled={disabled || micState === "uploading"}
            >
              {micState === "recording" ? (
                <StopCircleIcon aria-hidden="true" className="composer-icon" />
              ) : (
                <MicrophoneIcon aria-hidden="true" className="composer-icon" />
              )}
            </button>
          )}
          {(onOpenSlashPicker || onRequestSkills) && (
            <div className="composer-slash-wrap">
              <button
                type="button"
                className="composer-slash-button composer-icon-button"
                onClick={() => {
                  if (skillPickerOpen) {
                    setSkillPickerOpen(false);
                  } else {
                    void openSkillPicker();
                  }
                }}
                aria-label="Slash commands"
                aria-expanded={skillPickerOpen}
                title="Slash commands"
                disabled={disabled}
              >
                <CommandLineIcon aria-hidden="true" className="composer-icon" />
              </button>
              {skillPickerOpen && onRequestSkills && (
                <div
                  className="composer-skill-picker"
                  role="dialog"
                  aria-label="Skill picker"
                >
                  <input
                    type="text"
                    autoFocus
                    value={skillQuery}
                    onChange={(e) => setSkillQuery(e.target.value)}
                    onKeyDown={handleSkillKeyDown}
                    placeholder="Filter skills…"
                    className="composer-skill-picker__filter"
                    aria-label="Filter skills"
                  />
                  <div className="composer-skill-picker__list" role="listbox">
                    {skillLoading && (
                      <div className="composer-skill-picker__empty">Loading skills…</div>
                    )}
                    {!skillLoading && orderedSkills.length === 0 && (
                      <div className="composer-skill-picker__empty">No skills available</div>
                    )}
                    {!skillLoading && builtinSkills.length > 0 && (
                      <>
                        {builtinSkills.map((skill, i) => (
                          <button
                            key={`b:${skill.id}`}
                            type="button"
                            role="option"
                            aria-selected={i === skillIndex}
                            className={clsx(
                              "composer-skill-picker__item",
                              i === skillIndex && "is-active"
                            )}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              insertSkillPrefix(skill.id);
                            }}
                            onMouseEnter={() => setSkillIndex(i)}
                          >
                            <span className="composer-skill-picker__name">/{skill.id}</span>
                            <span className="composer-skill-picker__label">{skill.name}</span>
                            {skill.description && (
                              <span className="composer-skill-picker__desc">{skill.description}</span>
                            )}
                          </button>
                        ))}
                      </>
                    )}
                    {!skillLoading && workspaceSkills.length > 0 && (
                      <>
                        <div className="composer-skill-picker__divider" role="separator">
                          Workspace
                        </div>
                        {workspaceSkills.map((skill, i) => {
                          const index = builtinSkills.length + i;
                          return (
                            <button
                              key={`w:${skill.id}`}
                              type="button"
                              role="option"
                              aria-selected={index === skillIndex}
                              className={clsx(
                                "composer-skill-picker__item",
                                index === skillIndex && "is-active"
                              )}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                insertSkillPrefix(skill.id);
                              }}
                              onMouseEnter={() => setSkillIndex(index)}
                            >
                              <span className="composer-skill-picker__name">/{skill.id}</span>
                              <span className="composer-skill-picker__label">{skill.name}</span>
                              {skill.description && (
                                <span className="composer-skill-picker__desc">{skill.description}</span>
                              )}
                            </button>
                          );
                        })}
                      </>
                    )}
                    {(onToggleAutoContext || modelLabel || settingsSlot) && (
                      <>
                        <div className="composer-skill-picker__divider" role="separator">
                          Settings
                        </div>
                        {modelLabel && (
                          <div className="composer-skill-picker__modelrow" aria-label="Active model">
                            <span className="composer-skill-picker__modelrow-label">Model</span>
                            <span className="composer-skill-picker__modelrow-value">{modelLabel}</span>
                          </div>
                        )}
                        {onToggleAutoContext && (
                          <button
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={autoContextEnabled}
                            className={clsx(
                              "composer-skill-picker__item",
                              "composer-skill-picker__setting",
                              autoContextEnabled && "is-on"
                            )}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              onToggleAutoContext();
                            }}
                            disabled={disabled}
                          >
                            <span className="composer-skill-picker__toggle" aria-hidden="true">
                              {autoContextEnabled ? "●" : "○"}
                            </span>
                            <span className="composer-skill-picker__label">Auto-context</span>
                            <span className="composer-skill-picker__desc">
                              {autoContextEnabled
                                ? "Pulling relevant files automatically"
                                : "Off — only attached files are sent"}
                            </span>
                          </button>
                        )}
                        {settingsSlot && (
                          <div className="composer-skill-picker__slot">{settingsSlot}</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* Edit-auto pill joins the controls row next to the slash
              button — keeps the textarea full-width above and gives
              the composer a single Claude-style bottom row. */}
          {onToggleEditAutoApprove && (
            <button
              type="button"
              className={clsx(
                "composer-edit-auto",
                editAutoApproveEnabled && "is-active"
              )}
              onClick={onToggleEditAutoApprove}
              aria-pressed={Boolean(editAutoApproveEnabled)}
              data-has-tooltip="true"
              data-tooltip={
                editAutoApproveEnabled
                  ? "Edits apply automatically. run_command still prompts."
                  : "Ask before applying edits. Click to auto-apply."
              }
              disabled={disabled}
            >
              <span className="composer-edit-auto__label">
                {editAutoApproveEnabled ? "Edit automatically" : "Ask before edit"}
              </span>
            </button>
          )}
        </div>
      </div>
      <div className="composer-actions">
        <button
          className="send-button"
          type={isStopMode ? "button" : "submit"}
          aria-label={isStopMode ? "Stop response" : "Send message"}
          onClick={isStopMode ? onCancel : undefined}
          disabled={actionDisabled}
          data-variant={isStopMode ? "stop" : "send"}
        >
          {isStopMode ? (
            // Filled square — reads as "stop" unambiguously at 18px.
            <svg aria-hidden="true" viewBox="0 0 20 20" className="composer-icon" fill="currentColor">
              <rect x="4.5" y="4.5" width="11" height="11" rx="2" />
            </svg>
          ) : (
            // Chunky upward chevron — reads as "send/submit" at small sizes
            // without the chrome of ArrowUpCircleIcon's outer ring that
            // made the button look muddy against the themed gradient.
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className="composer-icon"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 15V5" />
              <path d="M5 10l5-5 5 5" />
            </svg>
          )}
        </button>
      </div>
      {expandedImage && (
        <div
          className="agent-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={handleCloseImagePreview}
        >
          <div className="agent-image-lightbox__frame" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="agent-image-lightbox__close"
              onClick={handleCloseImagePreview}
              aria-label="Close image preview"
            >
              <XMarkIcon aria-hidden="true" />
            </button>
            <img
              className="agent-image-lightbox__img"
              src={expandedImage}
              alt="Image attachment preview"
              loading="eager"
              decoding="sync"
            />
          </div>
        </div>
      )}
    </form>
  );
};
