import examplePlan from './refactor-integration-plan.json';
import type { ApexBffInterface } from './apex-bff-review';

export type IntegrationPlan = typeof examplePlan;
export interface InterfaceInventory {
  source: string;
  sourceSheet: string;
  contractSnapshot: string;
  items: ApexBffInterface[];
}
export interface IntegrationCatalog {
  plan: IntegrationPlan;
  inventory: InterfaceInventory;
  refactorRepository?: string;
}
