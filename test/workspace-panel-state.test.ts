import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer, defineComponent, h, provide } from 'vue';
import { agentWorkspaceContext } from '../src/shared/agent-workspace-context';
import { useWorkspacePanelState } from '../src/shared/useWorkspacePanelState';

// 使用 Vue 原生轻量宿主测试生命周期，不引入浏览器模拟依赖或缓存业务组件。
type Host = { children: Host[] };
const renderer = createRenderer<Host, Host>({
  createElement: () => ({ children: [] }), createText: () => ({ children: [] }), createComment: () => ({ children: [] }),
  insert: (child, parent) => { parent.children.push(child); }, remove: () => {},
  setText: () => {}, setElementText: () => {}, patchProp: () => {}, parentNode: () => null, nextSibling: () => null,
});
function mount(memory: Map<string, unknown> | undefined, key: string) {
  let state!: ReturnType<typeof useWorkspacePanelState<{ search: string; page: number }>>;
  const Child = defineComponent({ setup() { state = useWorkspacePanelState(key, () => ({ search: '', page: 1 })); return () => h('div'); } });
  const Root = defineComponent({ setup() {
    if (memory) provide(agentWorkspaceContext, { compose() {}, openRun() {}, readState: key => memory.get(key), saveState: (key, value) => { memory.set(key, value); } });
    return () => h(Child);
  } });
  const app = renderer.createApp(Root);
  app.mount({ children: [] });
  return { state, unmount: () => app.unmount() };
}
test('卸载查询组件后恢复筛选分页，各工作区及面板互不串状态', () => {
  const memory = new Map<string, unknown>();
  const first = mount(memory, 'tasks');
  first.state.search.value = 'APEX'; first.state.page.value = 4; first.unmount();
  const restored = mount(memory, 'tasks');
  assert.equal(restored.state.search.value, 'APEX'); assert.equal(restored.state.page.value, 4); restored.unmount();
  const other = mount(memory, 'projects'); assert.equal(other.state.page.value, 1); other.unmount();
  const separate = mount(new Map(), 'tasks'); assert.equal(separate.state.search.value, ''); separate.unmount();
});
test('独立旧页面没有宿主时正常使用，不在全局残留状态', () => {
  const first = mount(undefined, 'tasks'); first.state.page.value = 4; first.unmount();
  const second = mount(undefined, 'tasks'); assert.equal(second.state.page.value, 1); second.unmount();
});
