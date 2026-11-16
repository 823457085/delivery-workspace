import type { CustomPluginInfo, CustomPluginManifest } from '../../../shared/custom-plugins';

export function pluginInstallDefaults(manifest: CustomPluginManifest, current?: CustomPluginInfo) {
  return {
    grants: current ? [...current.grants] : manifest.permissions.filter(permission => permission !== 'application.local'),
    showInMenu: current?.showInMenu ?? false,
  };
}
