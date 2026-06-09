import type {
  ProviderClient,
  ProviderChatOptions} from "@burtson-labs/agent-core";
import {
  DeterministicProviderClient
} from "@burtson-labs/agent-core";

type TextDecoderLike = {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
};

interface TextDecoderConstructor {
  new (): TextDecoderLike;
}

const TextDecoderCtor: TextDecoderConstructor = (() => {
  if (typeof globalThis !== "undefined") {
    const ctor = (globalThis as { TextDecoder?: TextDecoderConstructor }).TextDecoder;
    if (typeof ctor === "function") {
      return ctor;
    }
  }

  return class TextDecoderFallback {
    decode(input?: Uint8Array) {
      if (!input) {
        return "";
      }

      let result = "";
      for (const code of input) {
        result += String.fromCharCode(code);
      }
      return result;
    }
  };
})();

export interface HttpProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
  mapper?: (prompt: string, options?: ProviderChatOptions) => Record<string, unknown>;
  responsePath?: string[];
}

export interface BanditGatewayProviderOptions extends Partial<HttpProviderOptions> {
  baseUrl?: string;
}

export class HttpProviderAdapter implements ProviderClient {
  readonly name: string;

  constructor(private readonly options: HttpProviderOptions & { name?: string }) {
    this.name = options.name ?? "http-provider";
  }

  async *chat(prompt: string, options?: ProviderChatOptions): AsyncIterable<string> {
    const requestPayload = this.buildPayload(prompt, options);
    const response = await this.fetchWithFallback(requestPayload, prompt);
    yield* response;
  }

  private buildPayload(prompt: string, options?: ProviderChatOptions): Record<string, unknown> {
    if (typeof this.options.mapper === "function") {
      return this.options.mapper(prompt, options);
    }

    return {
      input: prompt,
      mode: options?.mode ?? "plan",
      metadata: options?.metadata ?? {},
      context: options?.context ?? {},
      model: this.options.model ?? "default"
    };
  }

  private async fetchWithFallback(
    payload: Record<string, unknown>,
    prompt: string
  ): Promise<AsyncIterable<string>> {
    const globalFetch = (globalThis as { fetch?: unknown }).fetch as
      | ((input: string, init?: Record<string, unknown>) => Promise<Response>)
      | undefined;

    if (typeof globalFetch !== "function") {
      return this.runDeterministic(prompt);
    }

    try {
      const response = await globalFetch(this.options.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
          ...(this.options.headers ?? {})
        },
        body: JSON.stringify(payload)
      });

      if (!response?.ok) {
        throw new Error(`Provider responded with status ${response.status}`);
      }

      if (!response.body || typeof response.body.getReader !== "function") {
        const text = await response.text();
        return this.unwrapResponse(text);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoderCtor();

      async function* streamReader(): AsyncIterable<string> {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          yield decoder.decode(value, { stream: true });
        }
      }

      return streamReader();
    } catch (error) {
      return this.runDeterministic(prompt, error);
    }
  }

  private unwrapResponse(payload: string): AsyncIterable<string> {
    const iterator = (async function* (self: HttpProviderAdapter) {
      try {
        const json = JSON.parse(payload);
        const value = self.resolveResponse(json);
        yield typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        yield payload;
      }
    })(this);

    return iterator;
  }

  private resolveResponse(payload: unknown): unknown {
    if (!this.options.responsePath?.length) {
      return payload;
    }

    return this.options.responsePath.reduce((acc: unknown, key) => {
      if (acc && typeof acc === "object" && key in acc) {
        return (acc as Record<string, unknown>)[key];
      }

      return acc;
    }, payload);
  }

  private async runDeterministic(prompt: string, error?: unknown): Promise<AsyncIterable<string>> {
    if (error) {
      console.warn(`[${this.name}] Falling back to deterministic provider:`, error);
    }

    const fallback = new DeterministicProviderClient();
    return fallback.chat(prompt);
  }
}

export const createBanditGatewayProvider = (options: BanditGatewayProviderOptions = {}): ProviderClient => {
  const baseUrl = options.baseUrl ?? process.env.BANDIT_API_URL ?? "https://api.bandit.run/v1/chat";
  const apiKey = options.apiKey ?? process.env.BANDIT_API_KEY;

  return new HttpProviderAdapter({
    ...options,
    baseUrl,
    apiKey,
    model: options.model ?? process.env.BANDIT_MODEL ?? "bandit/gateway",
    name: "bandit-gateway-provider",
    headers: {
      "X-Bandit-Client": "bandit-agent-framework",
      ...(options.headers ?? {})
    },
    mapper: (prompt, chatOptions) => ({
      model: options.model ?? process.env.BANDIT_MODEL ?? "bandit/gateway",
      messages: [
        {
          role: "system",
          content: "You are the Bandit planning assistant."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      metadata: chatOptions?.metadata,
      mode: chatOptions?.mode
    }),
    responsePath: ["data", "output"]
  });
};

