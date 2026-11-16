<script setup lang="ts">
import { ArrowUpRight, RefreshCw } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useEmbeddedTheme } from '../../shared/theme/useEmbeddedTheme';

const { frame, syncTheme } = useEmbeddedTheme();
// Keep the hostname aligned so the console session works inside the local workbench.
const host = window.location.hostname === 'localhost' ? 'localhost' : '127.0.0.1';
const consoleUrl = `http://${host}:8990/`;
const checking = ref(true);
const available = ref(false);

async function connectSession() {
  checking.value = true;
  try {
    const response = await fetch('/api/sign-hub/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      signal: AbortSignal.timeout(5000),
    });
    available.value = response.ok;
  } catch {
    available.value = false;
  } finally {
    checking.value = false;
  }
}

onMounted(() => {
  void connectSession();
});
</script>

<template>
  <Teleport defer to="#workspace-embedded-actions">
    <a :href="consoleUrl" target="_blank" rel="noopener noreferrer" class="workspace-back"
      aria-label="浏览器助手" title="在独立页面连接和使用浏览器助手">
      <span>浏览器助手</span><ArrowUpRight :size="14" />
    </a>
  </Teleport>
  <iframe v-if="available" ref="frame" :src="consoleUrl" title="Sign Hub 自动签到控制台" class="sign-hub-frame"
    @load="syncTheme" />
  <div v-else class="sign-hub-offline">
    <div class="sign-hub-offline-card">
      <header class="sign-hub-offline-head">
        <h2>Sign Hub 自动签到控制台</h2>
        <span class="status-pill">{{ checking ? '正在检测连接…' : '本机服务未启动' }}</span>
      </header>
      <p>未能连接到本机 Sign Hub 服务，请确认后台进程已在本地监听后重新检测，或直接在新标签页打开。</p>
      <div class="sign-hub-offline-endpoint">
        <span>监听地址</span>
        <code>{{ consoleUrl }}</code>
      </div>
      <div class="sign-hub-offline-actions">
        <el-button type="primary" :loading="checking" @click="connectSession">
          <RefreshCw v-if="!checking" :size="13" />重新连接
        </el-button>
        <el-button @click="available = true">尝试加载内嵌页</el-button>
        <a :href="consoleUrl" target="_blank" rel="noopener noreferrer" class="el-button">
          独立窗口打开<ArrowUpRight :size="13" />
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sign-hub-frame { flex: 1; width: 100%; min-height: 0; border: 0; }
.sign-hub-offline {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--ui-bg);
}
.sign-hub-offline-card {
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
.sign-hub-offline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.sign-hub-offline-card h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.sign-hub-offline-card p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ui-secondary);
}
.sign-hub-offline-endpoint {
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
.sign-hub-offline-card code {
  font: 500 12px/1.5 var(--mono);
  color: var(--ui-text);
}
.sign-hub-offline-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
.sign-hub-offline-actions a.el-button {
  text-decoration: none;
}
</style>
