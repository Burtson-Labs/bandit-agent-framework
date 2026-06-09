import { createActionServices, type ActionServicesHost } from './actionServices';
import { createAutoHealer, type AutoHealerDeps, type AutoHealer } from './autoHealer';

export interface ActionRuntimeDeps {
  actionHost: ActionServicesHost;
  autoHealer: AutoHealerDeps;
}

export interface ActionRuntimeResult {
  internalActions: ReturnType<typeof createActionServices>['internalActions'];
  pythonActions: ReturnType<typeof createActionServices>['pythonActions'];
  autoHealer: AutoHealer;
}

export function createActionRuntimeServices(deps: ActionRuntimeDeps): ActionRuntimeResult {
  const actionServices = createActionServices(deps.actionHost);
  const autoHealer = createAutoHealer(deps.autoHealer);

  return {
    internalActions: actionServices.internalActions,
    pythonActions: actionServices.pythonActions,
    autoHealer
  };
}
