import { useEffect, useRef, useState, type JSX } from "react";
import {
  DocumentTextIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  PauseIcon,
  PlayIcon,
  SpeakerWaveIcon,
  StopIcon,
  XMarkIcon
} from "@heroicons/react/24/outline";
import clsx from "clsx";
import type { ChatMessage, ChatMessageContextFile } from "../types/ui-schema";
import { MarkdownMessage, renderMarkdownToHtml, type MarkdownRenderOptions } from "./MarkdownMessage";
import { PermissionCard, type BanditPermissionPayload, type PermissionChoice } from "./PermissionCard";

export interface ChatMessageProps extends MarkdownRenderOptions {
  message: ChatMessage;
  renderMarkdown?: (content: string) => string;
  onFeedback?: (messageId: string, rating: "up" | "down") => void;
  onDismissFeedback?: (messageId: string) => void;
  onContextFileClick?: (file: ChatMessageContextFile) => void;
  onFileReferenceClick?: (reference: string) => void;
  showTimestamp?: boolean;
  /** Show the thumbs up/down feedback buttons on assistant messages. Default: false. */
  showFeedbackButtons?: boolean;
  /** Show the "Copy" button on assistant messages. Default: false. */
  showCopyButton?: boolean;
  /** Called when the user clicks a button on an inline permission card.
   * The host is expected to post the choice back to the extension. */
  onPermissionChoice?: (id: string, choice: PermissionChoice, notes?: string) => void;
  /** Called when the user clicks a speaker control on an assistant
   *  message. Host fetches TTS audio and plays/pauses/resumes/stops it.
   *  Action defaults to "start" for backward compatibility. When the
   *  prop is undefined, no speaker affordance renders. */
  onSpeak?: (
    messageId: string,
    text: string,
    action?: "start" | "pause" | "resume" | "stop"
  ) => void;
  /** Id of the message whose audio is currently active (playing or
   *  paused). Used to render the multi-button speaker pill. */
  speakingMessageId?: string | null;
  /** True when speakingMessageId's audio is paused (vs playing). Drives
   *  the Pause vs Play icon swap inside the active pill. */
  speakPaused?: boolean;
  /** Id of the assistant message currently being streamed in. While set,
   *  we hide the speaker pill on that message — listening to a half-baked
   *  response is jarring, and the button reappears as soon as the stream
   *  closes. */
  streamingMessageId?: string | null;
}

// Matches the fenced markdown block the extension injects for permission
// prompts: ```bandit-permission\n{...json...}\n```
const PERMISSION_BLOCK_RE = /```bandit-permission\n([\s\S]*?)\n```/g;

interface PermissionSegment { kind: "permission"; payload: BanditPermissionPayload }
interface TextSegment { kind: "text"; text: string }
type ContentSegment = PermissionSegment | TextSegment;

/** Split content into an ordered list of markdown-text and permission-card
 * segments so we can render each in-line in the correct position. */
function splitPermissionSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let cursor = 0;
  PERMISSION_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PERMISSION_BLOCK_RE.exec(content)) !== null) {
    if (m.index > cursor) {
      segments.push({ kind: "text", text: content.slice(cursor, m.index) });
    }
    try {
      const payload = JSON.parse(m[1]) as BanditPermissionPayload;
      if (payload && payload.type === "bandit:permission" && typeof payload.id === "string") {
        segments.push({ kind: "permission", payload });
      } else {
        segments.push({ kind: "text", text: m[0] });
      }
    } catch {
      segments.push({ kind: "text", text: m[0] });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < content.length) {
    segments.push({ kind: "text", text: content.slice(cursor) });
  }
  return segments.length ? segments : [{ kind: "text", text: content }];
}

export const ChatMessageBubble = ({
  message,
  renderMarkdown,
  onFeedback,
  onContextFileClick,
  resolveFileHref,
  onFileReferenceClick,
  showTimestamp = true,
  showFeedbackButtons = false,
  showCopyButton = false,
  onPermissionChoice,
  onSpeak,
  speakingMessageId,
  speakPaused = false,
  streamingMessageId = null
}: ChatMessageProps): JSX.Element => {
  const payload = tryParseJson(message.content);
  const payloadType = typeof payload?.type === "string" ? payload.type : undefined;
  const contentSegments = splitPermissionSegments(message.content);
  const hasPermissionCard = contentSegments.some(s => s.kind === "permission");
  const metadataModel =
    (message.metadata?.model as string | undefined) ||
    (message.metadata?.modelId as string | undefined) ||
    (message.metadata?.provider as string | undefined);
  const timestamp =
    typeof (message as { createdAt?: unknown }).createdAt === "string"
      ? (message as { createdAt?: string }).createdAt
      : undefined;
  const timestampLabel =
    showTimestamp && timestamp
      ? new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : undefined;
  const fileReferences = Array.isArray(message.metadata?.fileReferences)
    ? message.metadata?.fileReferences ?? []
    : [];

  const showFeedback = showFeedbackButtons && message.role === "assistant" && message.id;
  const submitted = message.feedback?.submitted ?? false;
  const rating = message.feedback?.rating;
  const hasContextFiles = Array.isArray(message.contextFiles) && message.contextFiles.length > 0;
  const contextSource = message.contextFiles?.[0]?.source;
  const contextLabel = contextSource === "auto" ? "Auto context" : "Attached context";
  const imageAttachments = Array.isArray(message.images)
    ? message.images
        .map((src) => (typeof src === "string" ? src.trim() : ""))
        .filter((src): src is string => src.length > 0)
    : [];
  const canCopyResponse =
    showCopyButton &&
    message.role === "assistant" &&
    message.content.trim().length > 0 &&
    payloadType !== "agent-summary";
  const [responseCopied, setResponseCopied] = useState(false);
  const [expandedImage, setExpandedImage] = useState<{ src: string; alt: string } | null>(null);
  const responseCopyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (responseCopyTimer.current !== null) {
        window.clearTimeout(responseCopyTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    setResponseCopied(false);
  }, [message.content]);

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

  const handleFeedback = (nextRating: "up" | "down"): void => {
    if (!message.id || submitted) {
      return;
    }
    onFeedback?.(message.id, nextRating);
  };

  const handleContextFileClick = (file: ChatMessageContextFile): void => {
    if (!file?.path) {
      return;
    }
    onContextFileClick?.(file);
  };

  const handleFileReferenceClick = (path: string): void => {
    if (!path) {return;}
    onFileReferenceClick?.(path);
  };

  const handleCopyResponse = (): void => {
    const text = message.content.trim();
    if (!text) {
      return;
    }
    void writeTextToClipboard(text).then(() => {
      setResponseCopied(true);
      if (responseCopyTimer.current !== null) {
        window.clearTimeout(responseCopyTimer.current);
      }
      responseCopyTimer.current = window.setTimeout(() => {
        setResponseCopied(false);
        responseCopyTimer.current = null;
      }, 1500);
    });
  };

  const handleOpenImagePreview = (src: string, alt: string): void => {
    setExpandedImage({ src, alt });
  };

  const handleCloseImagePreview = (): void => {
    setExpandedImage(null);
  };

  return (
    <article className={clsx("message", message.role)}>
      <div className={clsx("message-body", message.role)}>
        {payload?.type === "agent-summary" && payload.__html ? (
          <div
            className="message-content"
            dangerouslySetInnerHTML={{ __html: payload.__html }}
          />
        ) : hasPermissionCard ? (
          // Permission requests render as a compact placeholder IN the
          // transcript — the interactive card lives in the approval
          // queue above the composer (one-at-a-time, fixed position).
          // This keeps the chat history from getting flooded with
          // cards on multi-edit turns, and kills the screen jitter
          // when cards resolve and vanish from the middle of the
          // scrollback. `onPermissionChoice` is still wired so older
          // snapshots of a conversation that were rendered before the
          // queue existed remain interactive as a fallback.
          <div className="message-content">
            {contentSegments.map((seg, i) => seg.kind === "permission" ? (
              <div key={`perm-${seg.payload.id}-${i}`} className="permission-placeholder" role="status">
                {/* Clock-style icon — replaced the hourglass emoji which
                    rendered with a skin-tone modifier on some platforms
                    and looked out of place. SVG inherits currentColor
                    from the parent so it tints with the rest of the
                    placeholder text. */}
                <svg
                  className="permission-placeholder__icon"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15 14" />
                </svg>
                <span className="permission-placeholder__label">
                  Awaiting approval: <code>{seg.payload.tool}</code>
                  {seg.payload.primary ? <span className="permission-placeholder__primary"> · {seg.payload.primary}</span> : null}
                </span>
                <span className="permission-placeholder__hint">see approval card above composer</span>
                {onPermissionChoice && (
                  // Fallback: clicking the placeholder surfaces the old
                  // inline card. Only used when the queue isn't active
                  // (e.g. viewing a conversation history in isolation).
                  <details className="permission-placeholder__fallback">
                    <summary>Resolve here instead</summary>
                    <PermissionCard
                      payload={seg.payload}
                      onChoice={(id, choice, notes) => onPermissionChoice?.(id, choice, notes)}
                    />
                  </details>
                )}
              </div>
            ) : (
              <MarkdownMessage
                key={`md-${i}`}
                content={seg.text}
                renderHtml={renderMarkdown ?? renderMarkdownToHtml}
                resolveFileHref={resolveFileHref}
                onFileReferenceClick={onFileReferenceClick ? (reference) => onFileReferenceClick(reference) : undefined}
              />
            ))}
          </div>
        ) : (
          <MarkdownMessage
            className="message-content"
            content={message.content}
            renderHtml={renderMarkdown ?? renderMarkdownToHtml}
            resolveFileHref={resolveFileHref}
            onFileReferenceClick={onFileReferenceClick ? (reference) => onFileReferenceClick(reference) : undefined}
          />
        )}

        {(metadataModel || timestampLabel || fileReferences.length > 0) && (
          <div className="message-meta">
            <div className="message-meta__pills" role="list">
              {metadataModel && (
                <span className="message-meta__pill" role="listitem">
                  {metadataModel}
                </span>
              )}
              {timestampLabel && (
                <span className="message-meta__pill" role="listitem">
                  {timestampLabel}
                </span>
              )}
            </div>
            {fileReferences.length > 0 && (
              <div className="message-meta__files" role="list" aria-label="Message file references">
                {fileReferences.map((ref) => (
                  <button
                    key={ref.path}
                    type="button"
                    className="message-meta__file"
                    onClick={() => handleFileReferenceClick(ref.path)}
                  >
                    <DocumentTextIcon aria-hidden="true" />
                    <span className="message-meta__file-text">{ref.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {imageAttachments.length > 0 && (
          <div className="message-attachments" role="list" aria-label="Image attachments">
            {imageAttachments.map((src, index) => (
              <figure
                className="message-attachment"
                role="listitem"
                key={`${message.id ?? "message"}-image-${index}`}
              >
                <button
                  type="button"
                  className="message-attachment__button"
                  onClick={() => handleOpenImagePreview(src, `Image attachment ${index + 1}`)}
                  aria-label={`Open image attachment ${index + 1}`}
                >
                  <img src={src} alt={`Image attachment ${index + 1}`} loading="lazy" decoding="async" />
                </button>
              </figure>
            ))}
          </div>
        )}

        {hasContextFiles && (
          <div className="message-context">
            <span className="message-context__label">{contextLabel}</span>
            <div className="message-context__chips">
              {message.contextFiles?.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="message-context__chip"
                  onClick={() => handleContextFileClick(file)}
                  aria-label={`Open ${file.path}`}
                >
                  <DocumentTextIcon aria-hidden="true" className="message-context__chip-icon" />
                  <span className="message-context__chip-text">{file.path}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {showFeedback && (
          <div
            className={clsx("message-feedback", "message-feedback--compact")}
            data-status={submitted ? "submitted" : undefined}
            data-rating={submitted && rating ? rating : undefined}
          >
            {[
              { rating: "up" as const, Icon: HandThumbUpIcon, label: "Helpful" },
              { rating: "down" as const, Icon: HandThumbDownIcon, label: "Needs work" }
            ].map(({ rating: optionRating, Icon, label }) => (
              <button
                key={optionRating}
                type="button"
                className={clsx(
                  "feedback-icon-button",
                  optionRating,
                  submitted && rating === optionRating && "active"
                )}
                onClick={() => handleFeedback(optionRating)}
                disabled={submitted}
                aria-label={label}
                title={label}
              >
                <Icon aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        {(() => {
          const isStreamingThisMessage =
            Boolean(streamingMessageId) && message.id === streamingMessageId;
          const speakerEligible =
            Boolean(onSpeak) &&
            Boolean(message.id) &&
            message.role === "assistant" &&
            !isStreamingThisMessage;
          const isActive = speakerEligible && speakingMessageId === message.id;
          if (!canCopyResponse && !speakerEligible) {
            return null;
          }
          return (
            <div className="message-response-actions">
              {canCopyResponse && (
                <button
                  type="button"
                  className={clsx("message-response-copy", responseCopied && "is-copied")}
                  onClick={handleCopyResponse}
                  aria-label="Copy response"
                >
                  {responseCopied ? "Copied" : "Copy"}
                </button>
              )}
              {speakerEligible && !isActive && (
                <button
                  type="button"
                  className="message-response-speak"
                  onClick={() => onSpeak!(message.id!, message.content, "start")}
                  aria-label="Read aloud"
                  title="Read aloud (Brian voice, cloud only)"
                >
                  <SpeakerWaveIcon aria-hidden="true" />
                  <span className="message-response-speak__label">Listen</span>
                </button>
              )}
              {speakerEligible && isActive && (
                <div
                  className={clsx(
                    "message-response-speak-pill",
                    speakPaused ? "is-paused" : "is-playing"
                  )}
                  role="group"
                  aria-label={speakPaused ? "Audio paused" : "Audio playing"}
                >
                  <span className="message-response-speak-pill__status" aria-hidden="true">
                    <SpeakerWaveIcon />
                    <span className="message-response-speak-pill__label">
                      {speakPaused ? "Paused" : "Speaking"}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="message-response-speak-pill__btn"
                    onClick={() =>
                      onSpeak!(
                        message.id!,
                        message.content,
                        speakPaused ? "resume" : "pause"
                      )
                    }
                    aria-label={speakPaused ? "Resume playback" : "Pause playback"}
                    title={speakPaused ? "Resume" : "Pause"}
                  >
                    {speakPaused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="message-response-speak-pill__btn message-response-speak-pill__btn--stop"
                    onClick={() => onSpeak!(message.id!, message.content, "stop")}
                    aria-label="Stop playback"
                    title="Stop"
                  >
                    <StopIcon aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          );
        })()}

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
                src={expandedImage.src}
                alt={expandedImage.alt}
                loading="eager"
                decoding="sync"
              />
            </div>
          </div>
        )}
      </div>
    </article>
  );
};

const tryParseJson = (raw: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeTextToClipboard = async (text: string): Promise<void> => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to execCommand below.
    }
  }

  if (typeof document === "undefined") {
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
};
