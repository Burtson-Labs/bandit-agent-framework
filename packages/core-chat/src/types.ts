export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessageFileReference {
  path: string;
  repoId?: string | number;
  repoFullName?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

export interface ChatMessageMetadata {
  repoId?: string | number;
  repoFullName?: string;
  branch?: string;
  taskId?: string;
  workspaceId?: string;
  spans?: Array<{ start: number; end: number; label?: string }>;
  fileReferences?: ChatMessageFileReference[];
  [key: string]: unknown;
}

export interface ChatMessageContextFile {
  path: string;
  source?: "auto" | "manual";
}

export interface ChatMessage {
  id?: string;
  role: ChatMessageRole;
  // Content should already be sanitized markdown ready for rendering.
  content: string;
  rawModelText?: string;
  metadata?: ChatMessageMetadata;
  feedback?: {
    submitted?: boolean;
    rating?: "up" | "down";
  };
  contextFiles?: ChatMessageContextFile[];
  images?: string[];
}
