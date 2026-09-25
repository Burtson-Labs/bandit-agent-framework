import type { JSX } from "react";
import { QuestionCard, type QuestionPayload } from "@burtson-labs/agent-ui";

/**
 * Webview host of agent-core's `ask_user` tool. The card itself lives in
 * agent-ui as `QuestionCard`; this keeps the webview's existing names.
 */
export type AskUserQuestionPayload = QuestionPayload;

export interface AskUserFormProps {
  id: string;
  questions: AskUserQuestionPayload[];
  onSubmit: (id: string, answers: Record<string, string>, cancelled?: boolean) => void;
}

export const AskUserForm = (props: AskUserFormProps): JSX.Element => <QuestionCard {...props} />;
