export interface ProviderChatOptions {
  mode?: "plan" | "execute" | "report" | string;
  metadata?: Record<string, unknown>;
  context?: unknown;
  [key: string]: unknown;
}

export interface ProviderClient {
  readonly name: string;
  chat(prompt: string, options?: ProviderChatOptions): AsyncIterable<string>;
}

export async function collectFromStream(stream: AsyncIterable<string>): Promise<string> {
  let result = "";

  for await (const chunk of stream) {
    result += chunk;
  }

  return result;
}
