import test from 'node:test';
import assert from 'node:assert/strict';
import { menuIconNames, menuIconSchema, isMenuIconUrl, navigationPreferencesSchema } from '../shared/workspace-navigation.js';
import { menuIcons, menuIconLabels } from '../src/shared/menu-icons.js';

test('全部内置图标都有显示组件和中文名称，旧图标保持有效', () => {
  assert.equal(menuIconNames.length, 64);
  assert.equal(new Set(menuIconNames).size, menuIconNames.length);
  for (const name of menuIconNames) {
    assert.ok(menuIcons[name]); assert.ok(menuIconLabels[name]);
    assert.equal(menuIconSchema.parse(name), name);
  }
});
test('图片直链保留查询参数，拒绝脚本、内联数据、文件路径及账号密码', () => {
  for (const url of ['https://example.com/logo.svg?v=2', 'http://localhost:18082/icon.png']) {
    assert.equal(isMenuIconUrl(url), true);
    assert.equal(navigationPreferencesSchema.parse({icons:{today:url}}).icons.today, url);
  }
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'file:///tmp/icon.svg', '//example.com/icon.png', 'https://user:password@example.com/icon.png', 'https://example.com/icon\n.png', 'https://', 'https://example.com/'+'a'.repeat(2048)]) {
    assert.equal(isMenuIconUrl(url), false, url);
    assert.equal(menuIconSchema.safeParse(url).success, false);
  }
});
