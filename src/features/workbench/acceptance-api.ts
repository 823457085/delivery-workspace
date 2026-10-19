import { deliveryAcceptanceInputSchema, deliveryAcceptanceRecordSchema, type DeliveryAcceptanceInput } from '../../../shared/delivery-acceptance';

export const deliveryAcceptanceQueryKey = ['delivery-acceptance'] as const;
const endpoint = '/api/agent-runtimes/delivery-acceptance';
export async function readDeliveryAcceptances(signal?: AbortSignal) {
  const response = await fetch(endpoint, { signal });
  if (response.headers.get('X-Delivery-Source') === 'Delivery-Offline') throw new Error('交付后端不可用，无法读取验收记录');
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '验收记录读取失败');
  if (!Array.isArray(data.records)) throw new Error('验收记录响应缺少 records');
  return data.records.map((record: unknown) => deliveryAcceptanceRecordSchema.parse(record));
}
export async function saveDeliveryAcceptance(input: DeliveryAcceptanceInput) {
  const body = deliveryAcceptanceInputSchema.parse(input);
  const response = await fetch(endpoint, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '验收保存失败，请重新读取核对');
  return deliveryAcceptanceRecordSchema.parse(data);
}
