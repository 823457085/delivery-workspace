<script setup lang="ts">
/** 主面板与实验室共用同一偏好入口；自定义项只写浏览器本地图片与配色，不触发任何业务接口。 */
import { Check, ImagePlus, Monitor, Palette, RotateCcw, Trash2 } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import { computed, shallowRef } from 'vue';
import { themeOptions } from './theme';
import { useTheme } from './useTheme';

const { preference, current, customTheme, wallpaperUrl, storageAvailable, setTheme, updateCustomTheme, updateCustomWallpaper, resetCustomTheme } = useTheme();
const visible = shallowRef(false);
const trigger = shallowRef<HTMLButtonElement>();
const imageInput = shallowRef<HTMLInputElement>();
const uploading = shallowRef(false);
const displayedOptions = computed(() => themeOptions.map((option) => option.id === 'custom'
  ? { ...option, colors: [customTheme.value.background, '#20293a', customTheme.value.accent] }
  : option));

function closeWithKeyboard() { visible.value = false; trigger.value?.focus(); }
function colorChanged(key: 'accent' | 'background', event: Event) {
  updateCustomTheme({ [key]: (event.target as HTMLInputElement).value });
}
function overlayChanged(event: Event) {
  updateCustomTheme({ overlay: Number((event.target as HTMLInputElement).value) });
}
function messageOpacityChanged(event: Event) {
  updateCustomTheme({ messageOpacity: Number((event.target as HTMLInputElement).value) });
}
function positionChanged(event: Event) {
  updateCustomTheme({ position: (event.target as HTMLSelectElement).value as 'center' | 'top' | 'bottom' });
}
async function imageChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { ElMessage.warning('请选择图片文件'); return; }
  uploading.value = true;
  const saved = await updateCustomWallpaper(file);
  uploading.value = false;
  if (!saved) ElMessage.error('图片未能保存在当前浏览器');
}
async function removeWallpaper() {
  if (!await updateCustomWallpaper(null)) ElMessage.error('图片未能从当前浏览器移除');
}
</script>

<template>
  <el-popover v-model:visible="visible" trigger="click" :width="340" placement="bottom-end" popper-class="theme-popover" :show-arrow="false">
    <template #reference>
      <button ref="trigger" class="theme-trigger" aria-label="切换皮肤" :aria-expanded="visible" @keydown.esc.stop="closeWithKeyboard"><Palette :size="17" /><span>{{ current.name }}</span></button>
    </template>
    <div class="theme-content" @keydown.esc.stop="closeWithKeyboard">
      <div class="theme-heading"><strong>选择主题颜色</strong><span>仅改变外观，不影响任务与数据</span></div>
      <fieldset class="theme-options"><legend class="visually-hidden">面板皮肤</legend>
        <label v-for="option in displayedOptions" :key="option.id" class="theme-option" :class="{ selected: preference === option.id }">
          <input type="radio" name="workspace-theme" :value="option.id" :checked="preference === option.id" @change="setTheme(option.id)" />
          <span class="theme-swatch" aria-hidden="true"><i v-for="color in option.colors" :key="color" :style="{ background: color }"></i><Monitor v-if="option.id === 'system'" :size="14" /></span>
          <span class="theme-copy"><strong>{{ option.name }}</strong><small>{{ option.description }}</small></span><Check v-if="preference === option.id" class="theme-check" :size="16" aria-hidden="true" />
        </label>
      </fieldset>
      <section v-if="preference === 'custom'" class="custom-theme" aria-label="自定义主题设置">
        <div class="wallpaper-preview" :class="{ empty: !wallpaperUrl }" :style="wallpaperUrl ? { backgroundImage: `linear-gradient(rgb(0 0 0 / ${customTheme.overlay / 100}), rgb(0 0 0 / ${customTheme.overlay / 100})), url('${wallpaperUrl}')`, backgroundPosition: customTheme.position } : undefined">
          <span>{{ customTheme.wallpaperName || '还没有选择背景图' }}</span>
        </div>
        <div class="wallpaper-actions">
          <button type="button" :disabled="uploading" @click="imageInput?.click()"><ImagePlus :size="14" />{{ uploading ? '保存中' : '选择本地图片' }}</button>
          <button v-if="customTheme.wallpaperName" type="button" @click="removeWallpaper"><Trash2 :size="13" />移除图片</button>
          <input ref="imageInput" class="visually-hidden" type="file" accept="image/*" @change="imageChanged" />
        </div>
        <div class="custom-colors">
          <label><span>主色</span><input type="color" :value="customTheme.accent" @input="colorChanged('accent', $event)" /></label>
          <label><span>背景色</span><input type="color" :value="customTheme.background" @input="colorChanged('background', $event)" /></label>
          <label><span>对齐</span><select :value="customTheme.position" @change="positionChanged"><option value="center">居中</option><option value="top">顶部</option><option value="bottom">底部</option></select></label>
        </div>
        <label class="overlay-control"><span>背景遮罩 <output>{{ customTheme.overlay }}%</output></span><input type="range" min="20" max="90" step="1" :value="customTheme.overlay" @input="overlayChanged" /></label>
        <label class="overlay-control"><span>消息卡片透明度 <output>{{ customTheme.messageOpacity }}%</output></span><input type="range" min="35" max="100" step="1" :value="customTheme.messageOpacity" @input="messageOpacityChanged" /></label>
        <button type="button" class="reset-custom" @click="resetCustomTheme"><RotateCcw :size="13" />恢复自定义默认值</button>
      </section>
      <p class="theme-note" :role="storageAvailable ? undefined : 'status'">{{ storageAvailable ? '自动保存在当前浏览器，下次打开仍然生效。' : '浏览器禁止保存偏好，本次切换有效，刷新后可能恢复默认。' }}</p>
    </div>
  </el-popover>
</template>

<style scoped>
.theme-trigger{display:inline-flex;align-items:center;gap:8px;min-height:36px;white-space:nowrap;padding:7px 11px;border:1px solid var(--ui-border);border-radius:8px;color:var(--ui-text);background:var(--ui-surface);cursor:pointer;font-size:12px;font-weight:600}.theme-trigger:hover{border-color:var(--ui-accent);background:var(--ui-accent-soft)}.theme-content{max-height:calc(100vh - 90px);overflow-y:auto;padding-right:3px}.theme-heading strong{display:block;font-size:15px;color:var(--ui-text)}.theme-heading>span{display:block;font-size:12px;color:var(--ui-muted);margin-top:6px}.theme-options{padding:0;margin:16px 0 0;border:0;display:grid;gap:8px;max-height:min(46vh,360px);overflow-y:auto}.theme-option{display:flex;position:relative;align-items:center;gap:10px;min-height:66px;border:1px solid var(--ui-border);border-radius:9px;padding:10px;cursor:pointer;background:var(--ui-surface)}.theme-option:hover{background:var(--ui-hover)}.theme-option.selected{border-color:var(--ui-accent);background:var(--ui-accent-soft)}.theme-option:focus-within{outline:2px solid var(--ui-accent);outline-offset:2px}.theme-option input{position:absolute;opacity:0;width:1px;height:1px;inset:0}.theme-swatch{display:flex;position:relative;overflow:hidden;width:42px;height:36px;border-radius:6px;border:1px solid var(--ui-border);flex-shrink:0}.theme-swatch i:first-child{width:32%}.theme-swatch i:nth-child(2){flex:1}.theme-swatch i:nth-child(3){position:absolute;width:15px;height:5px;right:4px;top:8px;border-radius:2px}.theme-swatch svg{position:absolute;bottom:4px;right:3px;color:#172232;background:#fff;border-radius:2px}.theme-copy{flex:1}.theme-copy strong{display:block;color:var(--ui-text);font-size:13px}.theme-copy small{display:block;color:var(--ui-muted);font-size:11px;margin-top:5px}.theme-check{color:var(--ui-accent)}
.custom-theme{margin-top:12px;padding:12px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-raised)}.wallpaper-preview{display:flex;align-items:flex-end;height:96px;padding:9px;overflow:hidden;border:1px solid var(--ui-border);border-radius:8px;background-color:var(--ui-bg);background-repeat:no-repeat;background-size:cover;color:#fff}.wallpaper-preview.empty{align-items:center;justify-content:center;background:linear-gradient(135deg,var(--ui-bg),var(--ui-surface));color:var(--ui-muted)}.wallpaper-preview span{max-width:100%;overflow:hidden;padding:3px 6px;border-radius:5px;background:#0008;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.wallpaper-preview.empty span{background:transparent}.wallpaper-actions{display:flex;gap:7px;margin-top:9px}.wallpaper-actions button,.reset-custom{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:29px;padding:0 9px;border:1px solid var(--ui-border);border-radius:7px;background:var(--ui-surface);color:var(--ui-secondary);font-size:10px;cursor:pointer}.wallpaper-actions button:hover,.reset-custom:hover{border-color:var(--ui-accent);color:var(--ui-accent)}.wallpaper-actions button:disabled{cursor:wait;opacity:.6}.custom-colors{display:grid;grid-template-columns:1fr 1fr 1.15fr;gap:7px;margin-top:11px}.custom-colors label{display:grid;gap:5px;color:var(--ui-muted);font-size:10px}.custom-colors input,.custom-colors select{width:100%;height:31px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-surface);color:var(--ui-text)}.custom-colors input{padding:3px}.custom-colors select{padding:0 7px;font-size:10px}.overlay-control{display:grid;gap:4px;margin-top:11px;color:var(--ui-muted);font-size:10px}.overlay-control span{display:flex;justify-content:space-between}.overlay-control output{color:var(--ui-text);font-family:var(--mono)}.overlay-control input{width:100%;accent-color:var(--ui-accent)}.reset-custom{width:100%;margin-top:8px;background:transparent}.theme-note{font-size:11px;line-height:1.8;margin:6px 0 0;color:var(--ui-muted)}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media(max-width:550px){.theme-trigger{padding:8px}.theme-trigger span{display:none}}
</style>
