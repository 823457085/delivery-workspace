<script setup lang="ts">
import { ArrowUpRight, RefreshCw } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useEmbeddedTheme } from '../../shared/theme/useEmbeddedTheme';

const { frame, syncTheme } = useEmbeddedTheme();
const { hostname, protocol } = window.location;
const consoleUrl = protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(hostname)
  ? `http://${hostname}:18081/`
  : '';
const checking = ref(!!consoleUrl);
const available = ref(false);

async function probeConsole() {
  if (!consoleUrl) {
    checking.value = false;
    available.value = false;
    return;
  }
  checking.value = true;
  try {
    await fetch(consoleUrl, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3500) });
    available.value = true;
  } catch {
    available.value = false;
  } finally {
    checking.value = false;
  }
}

onMounted(() => {
  void probeConsole();
});
</script>

<template>
  <Teleport v-if="consoleUrl" defer to="#workspace-embedded-actions">
    <a :href="consoleUrl" target="_blank" rel="noopener noreferrer" class="workspace-back"
      aria-label="独立打开闪连" title="在独立标签页打开闪连控制台">
      <span>独立窗口</span><ArrowUpRight :size="14" />
    </a>
  </Teleport>
  <iframe v-if="consoleUrl && available" ref="frame" :src="consoleUrl" title="闪连控制台" class="shanlian-frame"
    referrerpolicy="origin" allow="clipboard-write" @load="syncTheme" />
  <div v-else-if="consoleUrl" class="shanlian-offline">
    <div class="shanlian-offline-card">
      <header class="shanlian-offline-head">
        <h2>闪连 VPN 控制台</h2>
        <span class="status-pill">{{ checking ? '正在检测连接…' : '本机服务未启动' }}</span>
      </header>
      <p>未能连接到本机闪连服务，请确认后台服务已在本地监听后重新检测，或直接在新标签页打开。</p>
      <div class="shanlian-offline-endpoint">
        <span>监听地址</span>
        <code>{{ consoleUrl }}</code>
      </div>
      <div class="shanlian-offline-actions">
        <el-button type="primary" :loading="checking" @click="probeConsole">
          <RefreshCw v-if="!checking" :size="13" />重新连接
        </el-button>
        <el-button @click="available = true">尝试加载内嵌页</el-button>
        <a :href="consoleUrl" target="_blank" rel="noopener noreferrer" class="el-button">
          独立窗口打开<ArrowUpRight :size="13" />
        </a>
      </div>
    </div>
  </div>
  <el-empty v-else description="请从本机工作台打开闪连控制台。" />
</template>

<style scoped>
.shanlian-frame { flex: 1; width: 100%; min-height: 0; border: 0; }
.shanlian-offline {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--ui-bg);
}
.shanlian-offline-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  width: min(520px, 100%);
  padding: 20px 22px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-lg, 12px);
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: 0 4px 20px -6px rgba(15, 23, 42, 0.06);
}
.shanlian-offline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.shanlian-offline-card h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.shanlian-offline-card p { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--ui-secondary); }
.shanlian-offline-endpoint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--ui-divider);
  border-radius: var(--ds-radius-xs, 8px);
  background: var(--ui-raised);
  font-size: 12px;
  color: var(--ui-muted);
}
.shanlian-offline-card code {
  font: 500 12px/1.5 var(--mono);
  color: var(--ui-text);
}
.shanlian-offline-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; }
.shanlian-offline-actions :deep(.el-button > span),
.shanlian-offline-actions a { display: inline-flex; align-items: center; gap: 5px; text-decoration: none; }
</style>
