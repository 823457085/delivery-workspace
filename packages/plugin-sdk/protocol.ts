export const MANAGEMENT_PROTOCOL = 1 as const;
export const SDK_VERSION = '2.1.0' as const;
export type PluginCategory = 'capability' | 'tool' | 'application';
export type InstallStatus = 'awaiting-confirmation' | 'installing' | 'installed' | 'failed' | 'cancelled';
export interface ReleaseEnvelope { format: 'delivery-plugin/1'; files: Record<string, string> }
export interface CatalogEntry { id: string; version: string; manifest: Record<string, unknown>; package: string; sha256: string }
export interface Catalog { protocol: 1; releases: CatalogEntry[] }
