import type { WebviewMessage } from "../types/webviewMessage";

export interface ContextFileAttachment {
  path: string;
  preview?: string;
}

export interface ComposerAttachmentMessagesDeps {
  setContextFiles: (
    updater: (prev: ContextFileAttachment[]) => ContextFileAttachment[]
  ) => void;
  setImageAttachments: (updater: (prev: string[]) => string[]) => void;
  updateToast: (message: string) => void;
  contextFileLimit: number;
  maxImageAttachments: number;
}

/**
 * Topic dispatcher for the two composer-side attachment add messages.
 * Both share the same shape — append-with-dedup + limit-aware toast —
 * captured here so App.tsx isn't carrying the verbose dedup loops in
 * the message switch.
 */
export function dispatchComposerAttachmentMessage(
  message: WebviewMessage,
  deps: ComposerAttachmentMessagesDeps
): boolean {
  switch (message.type) {
    case "contextFilesAdded": {
      const incoming = Array.isArray(message.files) ? message.files : [];
      if (!incoming.length) {return true;} // accepted (no-op), do not fall through
      deps.setContextFiles((prev) => {
        const existingPaths = new Set(prev.map((file) => file.path));
        const next = [...prev];
        let limitReached = false;
        for (const file of incoming) {
          const path = typeof file.path === "string" ? file.path : "";
          if (!path || existingPaths.has(path)) {continue;}
          if (next.length >= deps.contextFileLimit) {
            limitReached = true;
            break;
          }
          next.push({
            path,
            preview: typeof file.preview === "string" ? file.preview : undefined
          });
          existingPaths.add(path);
        }
        if (limitReached) {
          deps.updateToast(`You can attach up to ${deps.contextFileLimit} files.`);
        }
        return next;
      });
      return true;
    }
    case "imageAttachmentsAdded": {
      const incoming = Array.isArray(message.images) ? message.images : [];
      if (!incoming.length) {return true;}
      deps.setImageAttachments((prev) => {
        const next = [...prev];
        let limitReached = false;
        for (const image of incoming) {
          if (typeof image !== "string" || !image.trim()) {continue;}
          if (next.length >= deps.maxImageAttachments) {
            limitReached = true;
            break;
          }
          next.push(image.trim());
        }
        if (limitReached) {
          deps.updateToast(`You can attach up to ${deps.maxImageAttachments} images.`);
        }
        return next;
      });
      return true;
    }
    default:
      return false;
  }
}
