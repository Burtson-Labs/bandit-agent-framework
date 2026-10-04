import { memo, useCallback, useMemo, useRef, type JSX } from "react";
import type { ChatMessage, ChatMessageContextFile } from "../types/ui-schema.js";
import { ChatMessageBubble } from "./ChatMessage.js";
import { renderMarkdownToHtml, type MarkdownRenderOptions } from "./MarkdownMessage.js";

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

// One formatter for every label. toLocaleTimeString(…, options) constructs an
// Intl.DateTimeFormat per call, and every group header formats its time on
// every state post while a turn streams.
let timeFormat: Intl.DateTimeFormat | null = null;
const formatTimestampLabel = (timestampMs: number): string =>
  (timeFormat ??= new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" })).format(timestampMs);

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
  // Bubbles are memoized; hosts pass inline lambdas, so hand the bubbles
  // stable functions that always call the latest prop.
  const feedback = useLatest(onFeedback);
  const dismissFeedback = useLatest(onDismissFeedback);
  const contextFileClick = useLatest(onContextFileClick);
  const fileReferenceClick = useLatest(onFileReferenceClick);
  const permissionChoice = useLatest(onPermissionChoice);
  const speak = useLatest(onSpeak);
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
                <MemoChatMessageBubble
                  key={message.id ?? `${group.id}-message-${index}`}
                  message={message}
                  renderMarkdown={renderContent}
                  onFeedback={feedback}
                  onDismissFeedback={dismissFeedback}
                  onContextFileClick={contextFileClick}
                  resolveFileHref={resolveFileHref}
                  onFileReferenceClick={fileReferenceClick}
                  showTimestamp={!timestampLabel}
                  onPermissionChoice={permissionChoice}
                  onSpeak={speak}
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

/** A stable function calling the latest `fn`; undefined when `fn` is (an
 *  absent callback hides its affordance, so presence must be preserved). */
function useLatest<F extends (...args: never[]) => unknown>(fn: F | undefined): F | undefined {
  const ref = useRef(fn);
  ref.current = fn;
  const stable = useCallback(((...args: Parameters<F>) => ref.current?.(...args)) as F, []);
  return fn ? stable : undefined;
}

/** Same message by value. The extension re-posts its whole state every frame
 *  while a turn streams and the webview maps it to fresh objects, so identity
 *  alone would re-render every settled bubble on every post. */
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) {return true;}
  const keys = Object.keys(a) as (keyof ChatMessage)[];
  if (keys.length !== Object.keys(b).length) {return false;}
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (x === y) {continue;}
    if (x === null || y === null || typeof x !== "object" || typeof y !== "object") {return false;}
    if (JSON.stringify(x) !== JSON.stringify(y)) {return false;}
  }
  return true;
}

const MemoChatMessageBubble = memo(ChatMessageBubble, (prev, next) => {
  for (const key of Object.keys(next) as (keyof typeof next)[]) {
    if (key === "message") {
      if (!sameMessage(prev.message, next.message)) {return false;}
    } else if (prev[key] !== next[key]) {
      return false;
    }
  }
  return Object.keys(prev).length === Object.keys(next).length;
});
