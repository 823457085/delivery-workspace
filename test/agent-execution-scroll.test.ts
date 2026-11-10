/** 执行真实执行记录 SFC 的滚动 watcher，复现实时刷新与拖动、切换会话的冲突。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { effectScope, nextTick, shallowReactive, shallowRef, watch } from 'vue';

const script = readFileSync(new URL('../src/features/agent-workbench/AgentExecutionPanel.vue', import.meta.url), 'utf8')
  .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];
const tree = ts.createSourceFile('AgentExecutionPanel.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const code = ts.transpileModule(tree.statements.filter(node =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => ['executionScroll', 'scrollPositions'].includes(item.name.getText(tree)))
  || ts.isExpressionStatement(node) && node.getText(tree).startsWith('watch(') && node.getText(tree).includes('executionScroll')
  || ts.isFunctionDeclaration(node) && node.name?.text === 'rememberScroll'
).map(node => node.getText(tree)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const conversation = (id: string, revision = 0) => ({ id, latest: { updatedAt: String(revision), events: Array(revision).fill({}) } });
function mount(visible = true) {
  const props = shallowReactive({ conversation: conversation('a'), visible });
  const scroll = shallowRef<object>();
  let offset = 0, displayed = visible;
  const createViewport = () => ({
    get clientHeight() { return displayed ? 600 : 0; },
    get scrollTop() { return displayed ? offset : 0; },
    set scrollTop(value: number) { offset = displayed ? value : 0; },
  });
  let viewport = createViewport();
  const scope = effectScope();
  const state = scope.run(() => new Function('props', 'useTemplateRef', 'watch', 'nextTick',
    `${code}; return { rememberScroll: typeof rememberScroll === 'function' ? rememberScroll : () => {} };`)(props, () => scroll, watch, nextTick)) as { rememberScroll: () => void };
  scope.run(() => watch(() => [props.conversation.id, props.visible], ([id], [previousId]) => {
    displayed = props.visible;
    // key=conversation.id 替换滚动元素，模拟 DOM patch 在 post watcher 前发生。
    if (id !== previousId) { offset = 0; viewport = createViewport(); scroll.value = viewport; }
  }));
  return { props, get viewport() { return viewport; },
    attach() { scroll.value = viewport; },
    scroll(top: number) { viewport.scrollTop = top; state.rememberScroll(); },
    refresh(revision: number) { props.conversation = conversation(props.conversation.id, revision); },
    select(id: string) { props.conversation = conversation(id); },
    close() { scope.stop(); },
  };
}
async function settled() { await nextTick(); await nextTick(); }

test('实时运行事件和轮询刷新不抢回执行记录滚动条', async () => {
  const view = mount();
  try {
    view.attach(); await settled(); view.scroll(850);
    view.refresh(1); await settled();
    assert.equal(view.viewport.scrollTop, 850);
    view.scroll(1200); view.refresh(2); await settled();
    assert.equal(view.viewport.scrollTop, 1200);
  } finally { view.close(); }
});

test('执行记录切换会话分别恢复位置，包括显式停留在顶部的0', async () => {
  const view = mount();
  try {
    view.attach(); await settled(); view.scroll(850);
    view.select('b'); await settled();
    assert.equal(view.viewport.scrollTop, 0);
    view.scroll(0); view.select('a'); await settled();
    assert.equal(view.viewport.scrollTop, 850);
    view.select('b'); await settled();
    assert.equal(view.viewport.scrollTop, 0);
  } finally { view.close(); }
});

test('隐藏执行面板时刷新不覆盖阅读位置，再显示后恢复；初次隐藏挂载可正常打开', async () => {
  const view = mount(false);
  try {
    view.attach(); await settled(); view.refresh(1); await settled();
    view.props.visible = true; await settled();
    assert.equal(view.viewport.scrollTop, 0);
    view.scroll(620); view.props.visible = false; await settled();
    view.refresh(2); await settled();
    view.props.visible = true; await settled();
    assert.equal(view.viewport.scrollTop, 620);
  } finally { view.close(); }
});


test('切换会话同时隐藏执行页，不把上一会话滚动位置写入新会话', async () => {
  const view = mount();
  try {
    view.attach(); await settled(); view.scroll(850);
    view.select('b'); view.props.visible = false; await settled();
    view.props.visible = true; await settled();
    assert.equal(view.viewport.scrollTop, 0);
    view.scroll(350); view.select('a'); view.props.visible = false; await settled();
    view.props.visible = true; await settled();
    assert.equal(view.viewport.scrollTop, 850);
    view.select('b'); await settled();
    assert.equal(view.viewport.scrollTop, 350);
  } finally { view.close(); }
});
