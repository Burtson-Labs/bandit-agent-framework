import type { IConnectorBus } from '../../internalTypes';

export type ConnectorHandler = (action: string, payload: unknown) => Promise<unknown> | unknown;

export interface ConnectorRegistry {
  [connector: string]: ConnectorHandler;
}

export function createConnectorBus(
  initialRegistry: ConnectorRegistry = {}
): IConnectorBus & { register(connector: string, handler: ConnectorHandler): void } {
  const registry = new Map<string, ConnectorHandler>(Object.entries(initialRegistry));

  return {
    async call<T = unknown>(connector: string, action: string, payload: unknown): Promise<T> {
      const handler = registry.get(connector);
      if (!handler) {
        throw new Error(`Connector "${connector}" is not registered.`);
      }
      const result = await handler(action, payload);
      return result as T;
    },
    register(connector: string, handler: ConnectorHandler): void {
      registry.set(connector, handler);
    }
  };
}
