export interface NoTokenWatchdogInput {
  promptChars: number;
  inflightPeers: number;
  envValue?: string;
  configValue?: number;
}

export interface ResolvedNoTokenWatchdog {
  ms: number;
  source: 'env' | 'config' | 'auto';
  promptChars: number;
  inflightPeers: number;
}

export interface NoTokenWatchdogErrorInput {
  elapsedMs: number;
  model: string;
  think: boolean | undefined;
  messages: number;
  promptChars: number;
  chunksReceived: number;
  thinkingChunks: number;
  contentChunks: number;
  firstChunkMs: number | null;
  firstThinkingMs: number | null;
  firstContentMs: number | null;
  peersAtStart: number;
  inflightNow: number;
  callId: string;
  verbose?: boolean;
}

const WATCHDOG_FLOOR_MS = 120_000;
const WATCHDOG_PER_CHAR_MS = 2;
const WATCHDOG_CAP_MS = 300_000;
const WATCHDOG_PEER_HEADROOM_MS = 25_000;

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function resolveNoTokenWatchdog(input: NoTokenWatchdogInput): ResolvedNoTokenWatchdog {
  const envParsed = Number.parseInt(input.envValue ?? '', 10);
  if (Number.isFinite(envParsed) && envParsed >= 0) {
    return {
      ms: envParsed,
      source: 'env',
      promptChars: Math.max(0, Math.floor(input.promptChars)),
      inflightPeers: Math.max(0, Math.floor(input.inflightPeers))
    };
  }

  const configOverride = positiveInteger(input.configValue);
  if (configOverride !== undefined) {
    return {
      ms: configOverride,
      source: 'config',
      promptChars: Math.max(0, Math.floor(input.promptChars)),
      inflightPeers: Math.max(0, Math.floor(input.inflightPeers))
    };
  }

  const promptChars = Math.max(0, Math.floor(input.promptChars));
  const inflightPeers = Math.max(0, Math.floor(input.inflightPeers));
  const peerHeadroomMs = inflightPeers * WATCHDOG_PEER_HEADROOM_MS;
  const baselineMs = WATCHDOG_FLOOR_MS + peerHeadroomMs;
  const scaledMs = Math.min(WATCHDOG_CAP_MS, (promptChars * WATCHDOG_PER_CHAR_MS) + peerHeadroomMs);
  return {
    ms: Math.max(baselineMs, scaledMs),
    source: 'auto',
    promptChars,
    inflightPeers
  };
}

export function createNoTokenWatchdogError(input: NoTokenWatchdogErrorInput): Error & { code: 'WATCHDOG' } {
  const elapsed = Math.round(input.elapsedMs / 1000);
  const formatMs = (value: number | null): string => value === null ? 'NEVER' : `${value}ms`;
  const diag = [
    `model=${input.model}`,
    `think=${input.think === undefined ? 'default' : String(input.think)}`,
    `messages=${input.messages}`,
    `promptChars=${input.promptChars}`,
    `chunks=${input.chunksReceived}(content=${input.contentChunks},thinking=${input.thinkingChunks})`,
    `ttfc=${formatMs(input.firstChunkMs)}`,
    `ttft=${formatMs(input.firstThinkingMs)}`,
    `ttcontent=${formatMs(input.firstContentMs)}`,
    `peersAtStart=${input.peersAtStart}`,
    `inflightNow=${input.inflightNow}`,
    `callId=${input.callId}`
  ].join(' ');
  const tail = input.verbose ? ` [${diag}]` : '';
  const err = new Error(
    `The model server did not respond within ${elapsed}s. Most often this is a cold-load or transient gateway issue; Bandit will retry when it is safe to replay. Set BANDIT_NO_TOKEN_WATCHDOG_MS=120000 to extend, or =0 to disable. For diagnostics: BANDIT_VERBOSE=1.${tail}`
  ) as Error & { code: 'WATCHDOG' };
  err.code = 'WATCHDOG';
  return err;
}
