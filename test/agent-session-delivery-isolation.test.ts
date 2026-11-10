/** 执行真实组件脚本及模板，验证会话切换时交付组件的挂载目标，避免在测试里复制筛选算法。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { compile, computed, createRenderer, defineComponent, h, nextTick, onBeforeUnmount, reactive, shallowReactive,
  shallowRef, toRefs, watch, type ComputedRef } from 'vue';
import type { AgentConversation } from '../src/features/agent-workbench/conversation.js';
import { agentConversationCodePath, agentConversationProjectPath, agentRunStatus } from '../src/features/agent-workbench/conversation.js';
import { conversationDeliveries } from '../src/features/agent-workbench/conversation-deliveries.js';
import { jiraDevTaskDeliveryId, jiraDevTaskWorkspacePaths, matchConversationJiraDevTask } from '../src/features/agent-workbench/jira-dev-context.js';
import type { JiraDevTaskView } from '../shared/jira-dev.js';

const renderer = createRenderer<object, object>({
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
});
function componentSource(name: string) {
  return readFileSync(new URL(`../src/features/agent-workbench/${name}.vue`, import.meta.url), 'utf8');
}
function scriptTree(source: string) {
  return ts.createSourceFile('component.ts', source.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, ts.ScriptTarget.Latest, true);
}
function evaluate(statements: readonly ts.Statement[], tree: ts.SourceFile, dependencies: Record<string, unknown>, returned: string[]) {
  const body = statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(tree)).join('\n');
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}\nreturn { ${returned.join(', ')} };`)(...Object.values(dependencies));
}
function task(id = 'task-a', roomId?: string): JiraDevTaskView {
  return { taskId: id, workflow: 'requirement', title: `需求开发 · ${id}`, projectPath: `/project/${id}`, baseBranch: 'master',
    branchName: `feature/${id}`, prompt: '', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    launch: { status: 'started', collaborationMode: roomId ? 'group' : 'manual', groupRoomId: roomId,
      workspacePath: `/worktree/${id}`, startedAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' } };
}
function conversation(id = 'unbound', bound?: JiraDevTaskView): AgentConversation {
  const run = { id: `run-${id}`, workspacePath: bound?.launch?.workspacePath || `/sessions/${id}`, sourceWorkspacePath: bound?.projectPath || '',
    objective: '检查测试环境的字段来源', result: '', events: [], status: 'running',
    ...(bound ? { task: { sourceId: `requirement:${bound.taskId}` } } : {}) };
  return { id, title: run.objective, latest: run, runs: [run], source: 'workspace', loaded: true, updatedAt: '2026-11-10T00:00:00Z' } as AgentConversation;
}

function deliveryFixture(initialConversation = conversation(), matchedJiraTask?: JiraDevTaskView) {
  const source = componentSource('AgentDeliveryPanel'), tree = scriptTree(source);
  const props = shallowReactive({ conversation: initialConversation, matchedJiraTask,
    // 即使上游误传全量列表，当前会话组件也不能选择其中的任意任务。
    jiraTasks: [task(), task('task-b')], context: { jiraIssues: [], jobs: [], catchup: [], merges: [] },
    record: undefined, loading: false, active: true, compact: true });
  const requestedTargets: string[] = [], displayedTargets = new Set<string>(), displayedCodePaths = new Set<string>();
  const remote = defineComponent({ props: ['targetId'], setup(remoteProps) {
    const id = String(remoteProps.targetId);
    requestedTargets.push(id); displayedTargets.add(id);
    onBeforeUnmount(() => displayedTargets.delete(id));
    return () => h('remote-delivery');
  } });
  const code = defineComponent({ props: ['paths'], setup(codeProps) {
    const paths = codeProps.paths as string[];
    paths.forEach(path => displayedCodePaths.add(path));
    onBeforeUnmount(() => paths.forEach(path => displayedCodePaths.delete(path)));
    return () => h('workspace-code');
  } });
  const stub = defineComponent({ setup: () => () => h('stub') });
  const names = tree.statements.flatMap(node => ts.isVariableStatement(node)
    ? node.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : [])
    : ts.isFunctionDeclaration(node) && node.name ? [node.name.text] : []);
  let state!: { activeJiraTask: ComputedRef<JiraDevTaskView | undefined>; codePaths: ComputedRef<string[]> };
  const app = renderer.createApp({
    components: { AgentRemoteDelivery: remote, AgentWorkspaceCodeArtifacts: code,
      ...Object.fromEntries(['StatusPill', 'AgentChangedFiles', 'AgentMarkdown', 'AgentDeliveryReport', 'DeliveryAcceptanceEditor',
        'CheckCircle2', 'ExternalLink', 'GitMerge', 'PackageCheck', 'ElEmpty', 'ElSkeleton', 'ElSelect', 'ElOption', 'RouterLink'].map(name => [name, stub])) },
    setup() {
      state = evaluate(tree.statements, tree, { computed, shallowRef, watch, agentConversationCodePath, agentRunStatus,
        conversationDeliveries, jiraDevTaskDeliveryId, jiraDevTaskWorkspacePaths,
        defineProps: () => props, defineEmits: () => () => {} }, names);
      return { ...toRefs(props), ...state, jiraDevTaskDeliveryId };
    },
    render: compile(source.match(/<template>([\s\S]*)<\/template>/)![1]!),
  });
  app.mount({});
  return { props, state, requestedTargets, displayedTargets, displayedCodePaths, close: () => app.unmount() };
}

test('无关联普通会话即使收到全量研发任务，也不挂载其他任务交付或代码查询', () => {
  const f = deliveryFixture();
  try {
    assert.equal(f.state.activeJiraTask.value, undefined);
    assert.deepEqual(f.state.codePaths.value, []);
    assert.deepEqual(f.requestedTargets, []);
    assert.equal(f.displayedTargets.size, 0);
    assert.equal(f.displayedCodePaths.size, 0);
  } finally { f.close(); }
});

test('关联会话切换到无关联会话后立即卸载旧交付，列表轮询不会带回旧任务', async () => {
  const bound = task(), f = deliveryFixture(conversation('bound', bound), bound);
  try {
    assert.deepEqual([...f.displayedTargets], [bound.taskId]);
    assert.deepEqual(f.state.codePaths.value, [], '关联任务已经展示该工作区时不重复展示代码');
    f.props.conversation = conversation(); f.props.matchedJiraTask = undefined;
    await nextTick();
    assert.equal(f.state.activeJiraTask.value, undefined);
    assert.equal(f.displayedTargets.size, 0);
    f.props.jiraTasks = [task('task-b'), task()];
    await nextTick();
    assert.deepEqual(f.requestedTargets, [bound.taskId]);
    assert.equal(f.displayedTargets.size, 0);
    assert.equal(f.displayedCodePaths.size, 0);
  } finally { f.close(); }
});

test('两个真实关联会话切换时分别使用当前任务或群聊的交付身份', async () => {
  const first = task('task-a', 'group-a'), second = task('task-b'), f = deliveryFixture(conversation('first', first), first);
  try {
    assert.deepEqual([...f.displayedTargets], ['group-a']);
    f.props.conversation = conversation('second', second); f.props.matchedJiraTask = second;
    await nextTick();
    assert.deepEqual([...f.displayedTargets], ['task-b']);
    assert.deepEqual(f.requestedTargets, ['group-a', 'task-b']);
  } finally { f.close(); }
});

function launchFixture() {
  const tree = scriptTree(componentSource('AgentRuntimePanel'));
  const selectedConversation = shallowRef<AgentConversation | undefined>(conversation()), jiraTasks = shallowRef([task(), task('task-b')]);
  const creating = shallowRef(false), workspacePaths = shallowRef<string[]>([]), form = reactive({ workspacePath: '' });
  // 直接执行业务组件的 computed 声明，包含旧版 fallback 声明时同样执行，确保此测试能捕捉原缺陷。
  const selected = new Set(['selectedJiraTaskId', 'matchedJiraTask', 'activeJiraTask', 'launchWorkspacePaths']);
  const statements = tree.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && selected.has(declaration.name.text)));
  const state = evaluate(statements, tree, { computed, shallowRef, selectedConversation, jiraTasks, creating, workspacePaths, form,
    matchConversationJiraDevTask, agentConversationProjectPath, jiraDevTaskWorkspacePaths }, ['matchedJiraTask', 'launchWorkspacePaths']) as {
    matchedJiraTask: ComputedRef<JiraDevTaskView | undefined>; launchWorkspacePaths: ComputedRef<string[]>;
  };
  return { ...state, selectedConversation, jiraTasks, creating, workspacePaths, form };
}

test('启动工具栏只使用当前关联任务或当前会话项目，不能回退到全局任务', () => {
  const f = launchFixture(), bound = f.jiraTasks.value[0]!;
  assert.equal(f.matchedJiraTask.value, undefined);
  assert.deepEqual(f.launchWorkspacePaths.value, []);
  f.selectedConversation.value = conversation('bound', bound);
  assert.equal(f.matchedJiraTask.value?.taskId, bound.taskId);
  assert.deepEqual(f.launchWorkspacePaths.value, [bound.launch!.workspacePath]);
  f.selectedConversation.value = conversation('other');
  assert.deepEqual(f.launchWorkspacePaths.value, []);
  const projectConversation = conversation('project');
  projectConversation.latest.sourceWorkspacePath = '/project/current';
  projectConversation.latest.workspacePath = '/project/current';
  f.selectedConversation.value = projectConversation;
  assert.equal(f.matchedJiraTask.value, undefined);
  assert.deepEqual(f.launchWorkspacePaths.value, ['/project/current']);
  f.selectedConversation.value = undefined;
  assert.deepEqual(f.launchWorkspacePaths.value, []);
});

test('新建会话仅保留用户选择的项目，不继承旧会话研发目录', () => {
  const f = launchFixture(), bound = f.jiraTasks.value[0]!;
  f.selectedConversation.value = conversation('bound', bound);
  f.creating.value = true;
  assert.equal(f.matchedJiraTask.value, undefined);
  assert.deepEqual(f.launchWorkspacePaths.value, []);
  f.form.workspacePath = '/selected/project';
  assert.deepEqual(f.launchWorkspacePaths.value, ['/selected/project']);
  f.workspacePaths.value = ['/selected/first', '/selected/second'];
  assert.deepEqual(f.launchWorkspacePaths.value, ['/selected/first', '/selected/second']);
});
