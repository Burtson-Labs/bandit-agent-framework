import type { ProviderKind, ProviderSettings, ChatProvider } from '../../banditEngineProvider';
import { createProvider } from '../../banditEngineProvider';
import { getProviderKind, getAgentProviderModel, buildProviderSettings } from '../providerSettings';
import type { WorkspaceConfiguration } from '../rewriteOrchestration';

export interface ProviderHostDeps {
  getConfiguration(): WorkspaceConfiguration;
  fetchApiKey(): Promise<string | undefined>;
  fetchSecret(key: string): Promise<string | undefined>;
}

export interface ProviderHost {
  getConfiguration(): WorkspaceConfiguration;
  getProviderKind(configuration: WorkspaceConfiguration): ProviderKind;
  getModel(configuration: WorkspaceConfiguration, kind: ProviderKind): string;
  buildProviderSettings(configuration: WorkspaceConfiguration, apiKey: string): ProviderSettings;
  getTopP(configuration: WorkspaceConfiguration): number | undefined;
  fetchApiKey(): Promise<string | undefined>;
  createProvider(settings: ProviderSettings): Promise<ChatProvider>;
  fetchSecret(key: string): Promise<string | undefined>;
}

export function createProviderHost(deps: ProviderHostDeps): ProviderHost {
  return {
    getConfiguration: () => deps.getConfiguration(),
    getProviderKind: (configuration) => getProviderKind(configuration),
    getModel: (configuration, kind) => getAgentProviderModel(configuration, kind),
    buildProviderSettings: (configuration, apiKey) => buildProviderSettings(configuration, apiKey),
    getTopP: (configuration) => configuration.get<number>('topP', 1),
    fetchApiKey: () => deps.fetchApiKey(),
    createProvider: (settings) => createProvider(settings),
    fetchSecret: async (key) => await deps.fetchSecret(key)
  };
}
