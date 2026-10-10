/** 在真实 Vue 生命周期中模拟视口事件；布局像素由浏览器回归验证，不使用快照代替实际样式。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderer } from 'vue';
import { useAgentViewport } from '../src/features/agent-workbench/useAgentViewport';

test('手机键盘高度、旋转、缩放与卸载监听清理', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const media = Object.assign(new EventTarget(), { matches: true });
  const visualViewport = Object.assign(new EventTarget(), { height: 956, offsetTop: 0, scale: 1 });
  const windowStub = Object.assign(new EventTarget(), { innerHeight: 956, visualViewport, matchMedia: () => media });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowStub });
  // 无 DOM 的宿主仅用于触发生命周期，不额外引入测试渲染依赖。
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  });
  let state!: ReturnType<typeof useAgentViewport>;
  const app = renderer.createApp({ setup() { state = useAgentViewport(); return () => null; } });
  try {
    app.mount({});
    assert.equal(state.mobile.value, true);
    assert.deepEqual(state.viewportStyle.value, { height: '956px', top: '0px' });
    visualViewport.height = 510;
    visualViewport.offsetTop = 12;
    visualViewport.dispatchEvent(new Event('resize'));
    assert.equal(state.keyboardOpen.value, true);
    assert.deepEqual(state.viewportStyle.value, { height: '510px', top: '12px' });
    visualViewport.scale = 2;
    visualViewport.height = 255;
    visualViewport.dispatchEvent(new Event('resize'));
    assert.equal(state.viewportStyle.value.height, '510px', '缩放不触发键盘重排');
    visualViewport.scale = 1;
    visualViewport.height = 440;
    visualViewport.offsetTop = 0;
    windowStub.innerHeight = 440;
    windowStub.dispatchEvent(new Event('resize'));
    assert.equal(state.keyboardOpen.value, false);
    assert.equal(state.viewportStyle.value.height, '440px');
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    assert.equal(state.mobile.value, false);
    assert.deepEqual(state.viewportStyle.value, {}, '桌面不覆盖原布局高度');
    app.unmount();
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    assert.equal(state.mobile.value, false, '卸载后不再响应视口事件');
  } finally {
    app.unmount();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
