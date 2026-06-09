import { sanitizeModelOutput } from "@burtson-labs/core-chat";

export const stripTurnTokens = (value?: string | null): string => sanitizeModelOutput(value ?? "");
