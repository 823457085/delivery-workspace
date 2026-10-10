/** 自有计划只从明确配置的本机文件加载，未配置时使用未测试的中性示例。 */
import fs from 'node:fs/promises';
import { z } from 'zod';
import examplePlan from '../shared/refactor-integration-plan.json';
import exampleInventory from '../shared/apex-bff-interface-inventory.json';
import type { IntegrationCatalog } from '../shared/integration-catalog.js';

const operation = z.object({ operationId: z.string().min(1), method: z.string(), path: z.string().min(1), summary: z.string(), contractStatus: z.string() }).passthrough();
const planSchema = z.object({ stages: z.array(z.object({ id: z.string().min(1), title: z.string(), operations: z.array(operation) }).passthrough()) }).passthrough();
const item = z.object({ id: z.string().min(1), path: z.string().min(1), module: z.string(), pageModule: z.string(), name: z.string(),
  contract: z.object({ method: z.string(), status: z.string(), operationId: z.string() }).nullable(),
  ui: z.object({ module: z.string(), page: z.string(), route: z.string(), kind: z.enum(['route', 'shared', 'multiple', 'unmapped']) }).optional() }).passthrough();
const inventorySchema = z.object({ items: z.array(item) }).passthrough();

export async function loadIntegrationCatalog(environment: NodeJS.ProcessEnv = process.env): Promise<IntegrationCatalog> {
  const load = async (file: string | undefined, fallback: unknown) => file ? JSON.parse(await fs.readFile(file, 'utf8')) : fallback;
  const [plan, inventory] = await Promise.all([
    load(environment.DELIVERY_INTEGRATION_PLAN_FILE, examplePlan),
    load(environment.DELIVERY_INTERFACE_INVENTORY_FILE, exampleInventory),
  ]);
  planSchema.parse(plan);
  inventorySchema.parse(inventory);
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`${label}包含重复 ID`); };
  unique(plan.stages.map((stage: { id: string }) => stage.id), '联调阶段');
  unique(plan.stages.flatMap((stage: { operations: { operationId: string }[] }) => stage.operations.map(operation => operation.operationId)), '联调操作');
  unique(inventory.items.map((entry: { id: string }) => entry.id), '接口库存');
  return structuredClone({ plan: { ...examplePlan, ...plan }, inventory: { ...exampleInventory, ...inventory }, refactorRepository: environment.DELIVERY_REFACTOR_REPOSITORY || '' });
}
