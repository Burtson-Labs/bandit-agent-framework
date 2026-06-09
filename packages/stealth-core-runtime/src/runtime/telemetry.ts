import type { ITelemetry } from '../hostTypes';
import type { LogPayload, StatusPayload } from '../statusTypes';

export interface TelemetryDeps {
  post(message: unknown): Promise<void> | void;
}

const DEFAULT_BATCH_INTERVAL_MS = 250;

export function createTelemetry(deps: TelemetryDeps): ITelemetry {
  const post = deps.post;
  let batchTimer: NodeJS.Timeout | undefined;
  const statusQueue: StatusPayload[] = [];

  function scheduleFlush(): void {
    if (batchTimer) {
      return;
    }
    batchTimer = setTimeout(() => {
      batchTimer = undefined;
      flushStatusQueue().catch((error) => {
        console.warn('Failed to flush telemetry status queue', error);
      });
    }, DEFAULT_BATCH_INTERVAL_MS);
  }

  async function flushStatusQueue(): Promise<void> {
    if (statusQueue.length === 0) {
      return;
    }
    const payloads = statusQueue.splice(0, statusQueue.length);
    for (const payload of payloads) {
      await post({ type: 'agent:status', ...payload });
    }
  }

  return {
    async status(payload: StatusPayload): Promise<void> {
      statusQueue.push(payload);
      scheduleFlush();
    },
    async log(entry: LogPayload): Promise<void> {
      await post({ type: 'agent:log', entry });
    },
    async event(kind: string, data?: Record<string, unknown>): Promise<void> {
      await post({ type: 'agent:event', kind, data });
    }
  };
}
