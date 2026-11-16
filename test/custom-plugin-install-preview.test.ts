import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pluginManifestSchema, type CustomPluginInfo } from '../shared/custom-plugins.js';
import { pluginInstallDefaults } from '../src/features/custom-plugins/install-preview.js';
import { discoverBundledPlugins } from '../server/plugins/bundled-packages.js';

test('应用插件首次检查不默认信任本机代码，也不默认添加菜单', async () => {
  const manifest = pluginManifestSchema.parse(JSON.parse(await fs.readFile('plugins/go-learning/plugin.json', 'utf8')));
  const preview = pluginInstallDefaults(manifest);
  assert.ok(manifest.permissions.includes('application.local'));
  assert.equal(preview.grants.includes('application.local'), false);
  assert.equal(preview.showInMenu, false);
  assert.ok(preview.grants.includes('storage.read'));
});

test('应用更新展示已有授权与菜单偏好，预览变更不修改已安装状态', async () => {
  const manifest = pluginManifestSchema.parse(JSON.parse(await fs.readFile('plugins/go-learning/plugin.json', 'utf8')));
  const installed: CustomPluginInfo = { manifest, source: '/example', digest: 'old', enabled: false,
    showInMenu: true, grants: ['storage.read'] };
  const preview = pluginInstallDefaults(manifest, installed);
  assert.deepEqual(preview.grants, installed.grants);
  assert.equal(preview.showInMenu, true);
  preview.grants.push('application.local');
  assert.deepEqual(installed.grants, ['storage.read']);
  assert.equal(installed.enabled, false);
});

test('内附包通过声明自动发现，支持任意插件名且不执行入口或安装插件', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-discovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const record = JSON.parse(await fs.readFile('plugins/example-notes/plugin.json', 'utf8'));
  const app = JSON.parse(await fs.readFile('plugins/go-learning/plugin.json', 'utf8'));
  record.id = 'other-record'; record.name = '自定义记录';
  app.id = 'other-application'; app.name = '自定义应用';
  const recordDir = path.join(root, 'record'), appDir = path.join(root, 'tool', 'package');
  await fs.mkdir(recordDir); await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(path.join(recordDir, 'plugin.json'), JSON.stringify(record));
  await fs.writeFile(path.join(appDir, 'plugin.json'), JSON.stringify(app));
  await fs.writeFile(path.join(appDir, 'ui.js'), 'throw new Error("must not execute")');
  await fs.writeFile(path.join(appDir, 'ui.css'), 'body {}');
  await fs.writeFile(path.join(appDir, 'server.mjs'), 'throw new Error("must not execute")');
  await fs.mkdir(path.join(root, 'invalid'));
  await fs.writeFile(path.join(root, 'invalid', 'plugin.json'), '{}');
  await fs.symlink(recordDir, path.join(root, 'linked'));
  assert.deepEqual(await discoverBundledPlugins(root), [
    { name: record.name, directory: recordDir },
    { name: app.name, directory: appDir },
  ]);
});
