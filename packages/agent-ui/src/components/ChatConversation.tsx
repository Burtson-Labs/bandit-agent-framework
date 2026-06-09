import { useMemo, type JSX } from "react";
import type { ChatMessage, ChatMessageContextFile } from "../types/ui-schema";
import { ChatMessageBubble } from "./ChatMessage";
import { renderMarkdownToHtml, type MarkdownRenderOptions } from "./MarkdownMessage";

const GROUP_TIME_GAP_MS = 5 * 60 * 1000;
const ROLE_LABELS: Partial<Record<ChatMessage["role"], string>> = {
  user: "You",
  assistant: "Bandit",
  system: "System",
  tool: "Tool"
};

type MessageGroup = {
  id: string;
  role: ChatMessage["role"];
  label: string;
  messages: ChatMessage[];
  timestampMs?: number;
  lastTimestampMs?: number;
};

const normalizeTimestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return numeric < 1e12 ? numeric * 1000 : numeric;
      }
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
};

const getMessageTimestamp = (message: ChatMessage): number | null => {
  const raw =
    (message as { createdAt?: unknown; timestamp?: unknown }).createdAt ??
    (message as { timestamp?: unknown }).timestamp;
  return normalizeTimestamp(raw);
};

const formatTimestampLabel = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export interface ChatConversationProps extends MarkdownRenderOptions {
  messages: ChatMessage[];
  renderMarkdown?: (content: string) => string;
  onFeedback?: (messageId: string, rating: "up" | "down") => void;
  onDismissFeedback?: (messageId: string) => void;
  onContextFileClick?: (file: ChatMessageContextFile) => void;
  onFileReferenceClick?: (reference: string) => void;
  onPermissionChoice?: (id: string, choice: "once" | "session" | "save" | "deny", notes?: string) => void;
  /** When present, each assistant message renders a speaker pill that
   *  invokes this callback with the message id, speakable text, and a
   *  control action ("start" | "pause" | "resume" | "stop"). Host handles
   *  TTS (fetch audio, play, pause, resume, stop). Currently active
   *  message id is passed via `speakingMessageId`; pause vs play state via
   *  `speakPaused`. Leave undefined to hide voice affordances entirely. */
  onSpeak?: (
    messageId: string,
    text: string,
    action?: "start" | "pause" | "resume" | "stop"
  ) => void;
  speakingMessageId?: string | null;
  /** True when speakingMessageId's audio is paused (vs playing). */
  speakPaused?: boolean;
  /** Id of the assistant message currently being streamed. While set,
   *  the speaker pill on that message is hidden — listening to a
   *  half-baked response is jarring. */
  streamingMessageId?: string | null;
}

export const ChatConversation = ({
  messages,
  renderMarkdown,
  onFeedback,
  onDismissFeedback,
  onContextFileClick,
  resolveFileHref,
  onFileReferenceClick,
  onPermissionChoice,
  onSpeak,
  speakingMessageId,
  speakPaused,
  streamingMessageId
}: ChatConversationProps): JSX.Element => {
  const renderContent = renderMarkdown ?? renderMarkdownToHtml;
  const groupedMessages = useMemo(() => {
    const groups: MessageGroup[] = [];
    messages.forEach((message, index) => {
      const role = message.role;
      const timestampMs = getMessageTimestamp(message);
      const lastGroup = groups[groups.length - 1];
      const isSameRole = lastGroup?.role === role;
      const timeGapExceeded =
        isSameRole &&
        typeof timestampMs === "number" &&
        typeof lastGroup?.lastTimestampMs === "number" &&
        timestampMs - lastGroup.lastTimestampMs > GROUP_TIME_GAP_MS;
      if (!lastGroup || !isSameRole || timeGapExceeded) {
        groups.push({
          id: message.id ?? `group-${index}`,
          role,
          label: ROLE_LABELS[role] ?? role,
          messages: [message],
          timestampMs: timestampMs ?? undefined,
          lastTimestampMs: timestampMs ?? undefined
        });
        return;
      }
      lastGroup.messages.push(message);
      if (typeof timestampMs === "number") {
        lastGroup.timestampMs = timestampMs;
        lastGroup.lastTimestampMs = timestampMs;
      }
    });
    return groups;
  }, [messages]);

  return (
    <div className="chat-conversation">
      {groupedMessages.map((group) => {
        const timestampLabel =
          typeof group.timestampMs === "number" ? formatTimestampLabel(group.timestampMs) : undefined;
        const showHeader = group.messages.length > 1 || Boolean(timestampLabel);
        return (
          <div key={group.id} className="chat-message-group" data-role={group.role}>
            {showHeader ? (
              <div className="chat-message-group__header">
                <span className="chat-message-group__label">{group.label}</span>
                {timestampLabel ? (
                  <span className="chat-message-group__timestamp">{timestampLabel}</span>
                ) : null}
              </div>
            ) : null}
            <div className="chat-message-group__messages">
              {group.messages.map((message, index) => (
                <ChatMessageBubble
                  key={message.id ?? `${group.id}-message-${index}`}
                  message={message}
                  renderMarkdown={renderContent}
                  onFeedback={onFeedback}
                  onDismissFeedback={onDismissFeedback}
                  onContextFileClick={onContextFileClick}
                  resolveFileHref={resolveFileHref}
                  onFileReferenceClick={onFileReferenceClick}
                  showTimestamp={!timestampLabel}
                  onPermissionChoice={onPermissionChoice}
                  onSpeak={onSpeak}
                  speakingMessageId={speakingMessageId}
                  speakPaused={speakPaused}
                  streamingMessageId={streamingMessageId}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
