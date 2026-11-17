<script setup lang="ts">
/** 主面板与实验室共用同一偏好入口；自定义项只写浏览器本地图片与配色，不触发任何业务接口。 */
import { Camera, Check, Clock3, Film, ImagePlus, Monitor, Palette, Pause, Play, RefreshCw, RotateCcw, Sparkles, Sun, Trash2, X } from '@lucide/vue';
import { ElMessage } from 'element-plus';
import { computed, onBeforeUnmount, shallowRef, useId, watch } from 'vue';
import { useCinematicVideo } from './cinematicVideo';
import { isSupportedWallpaperFile } from './customTheme';
import { designMdMeta } from './designMd';
import { useImmersivePhoto } from './immersivePhoto';
import { themeOptions } from './theme';
import { useTheme } from './useTheme';

const {
  preference,
  current,
  customTheme,
  wallpaperUrl,
  recentWallpapers,
  extractedSwatches,
  activeGalleryId,
  storageAvailable,
  setTheme,
  updateCustomTheme,
  updateCustomWallpaper,
  selectGalleryWallpaper,
  removeGalleryWallpaper,
  reextractCurrentPalette,
  applyPresetWallpaper,
  applyRandomAuroraWallpaper,
  resetCustomTheme,
} = useTheme();
const {
  frames: photoFrames,
  activeFrame,
  kenBurnsEnabled,
  daylightEnabled: photoDaylightEnabled,
  daylightSlot: photoDaylightSlot,
  setFrame,
  toggleKenBurns,
  toggleDaylight: togglePhotoDaylight,
} = useImmersivePhoto();
const {
  scenes: videoScenes,
  activeScene,
  loopEnabled,
  daylightEnabled: videoDaylightEnabled,
  daylightSlot: videoDaylightSlot,
  setScene,
  toggleLoop,
  toggleDaylight: toggleVideoDaylight,
} = useCinematicVideo();

const visible = shallowRef(false);
const themeGroup = useId();
const wallpaperInputId = useId();
const trigger = shallowRef<HTMLButtonElement>();
const imageInput = shallowRef<HTMLInputElement>();
const uploading = shallowRef(false);
const draggingWallpaper = shallowRef(false);

const displayedOptions = computed(() => themeOptions.map((option) => option.id === 'custom'
  ? { ...option, colors: [customTheme.value.background, '#20293a', customTheme.value.accent] }
  : option));

const builtinCustomWallpapers = computed(() => [
  ...photoFrames.map((item) => ({ id: `photo-${item.id}`, title: item.title, url: item.webp, lqip: item.lqip })),
  ...videoScenes.map((item) => ({ id: `video-${item.id}`, title: item.title, url: item.posterWebp, lqip: item.lqip })),
]);

function closeWithKeyboard() { visible.value = false; trigger.value?.focus(); }
function openFilePicker() { imageInput.value?.click(); }
function selectThemeOption(id: (typeof themeOptions)[number]['id']) {
  setTheme(id);
  if (id === 'custom' && !wallpaperUrl.value && !customTheme.value.wallpaperName && builtinCustomWallpapers.value[0]) {
    void selectBuiltinCustomWallpaper(builtinCustomWallpapers.value[0].url, builtinCustomWallpapers.value[0].title);
  }
}
function colorChanged(key: 'accent' | 'background', event: Event) {
  updateCustomTheme({ [key]: (event.target as HTMLInputElement).value });
}
function pickSwatch(hex: string) {
  updateCustomTheme({ accent: hex });
}
function toggleAutoPalette(event: Event) {
  updateCustomTheme({ autoPalette: (event.target as HTMLInputElement).checked });
}
function overlayChanged(event: Event) {
  updateCustomTheme({ overlay: Number((event.target as HTMLInputElement).value) });
}
function messageOpacityChanged(event: Event) {
  updateCustomTheme({ messageOpacity: Number((event.target as HTMLInputElement).value) });
}
function blurChanged(event: Event) {
  updateCustomTheme({ blur: Number((event.target as HTMLInputElement).value) });
}
function brightnessChanged(event: Event) {
  updateCustomTheme({ brightness: Number((event.target as HTMLInputElement).value) });
}
function positionChanged(event: Event) {
  updateCustomTheme({ position: (event.target as HTMLSelectElement).value as 'center' | 'top' | 'bottom' });
}

async function applyWallpaperFile(file: File, successToast?: string) {
  if (!isSupportedWallpaperFile(file)) {
    ElMessage.warning('请选择图片文件（支持 PNG / JPG / WebP / AVIF / SVG / HEIC 等）');
    return;
  }
  uploading.value = true;
  try {
    const saved = await updateCustomWallpaper(file);
    if (!saved) ElMessage.warning('当前环境限制本地持久存储，壁纸已在本次会话生效');
    else if (successToast) ElMessage.success(successToast);
  } finally {
    uploading.value = false;
  }
}

async function imageChanged(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await applyWallpaperFile(file);
}

function onDragOver(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  draggingWallpaper.value = true;
}

function onDragLeave(event: DragEvent) {
  const currentTarget = event.currentTarget as HTMLElement | null;
  const related = event.relatedTarget as Node | null;
  if (currentTarget && related && currentTarget.contains(related)) return;
  draggingWallpaper.value = false;
}

async function onDropWallpaper(event: DragEvent) {
  draggingWallpaper.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  event.preventDefault();
  await applyWallpaperFile(file, `已应用拖拽壁纸：${file.name}`);
}

function extractClipboardImage(event: ClipboardEvent): File | null {
  const directFile = Array.from(event.clipboardData?.files ?? []).find((f) => isSupportedWallpaperFile(f));
  if (directFile) return directFile;
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) {
        const ext = blob.type.split('/')[1]?.split('+')[0] || 'png';
        return new File([blob], blob.name || `剪贴板壁纸-${new Date().toTimeString().slice(0, 8).replaceAll(':', '')}.${ext}`, { type: blob.type });
      }
    }
  }
  return null;
}

function onWindowPaste(event: ClipboardEvent) {
  if (!visible.value || uploading.value) return;
  const imageFile = extractClipboardImage(event);
  if (!imageFile) return;
  event.preventDefault();
  void applyWallpaperFile(imageFile, '已应用剪贴板图片壁纸');
}

watch(visible, (isOpen) => {
  if (isOpen) window.addEventListener('paste', onWindowPaste);
  else {
    window.removeEventListener('paste', onWindowPaste);
    draggingWallpaper.value = false;
  }
});
onBeforeUnmount(() => window.removeEventListener('paste', onWindowPaste));

async function selectBuiltinCustomWallpaper(url: string, title: string) {
  if (uploading.value) return;
  uploading.value = true;
  try {
    const saved = await applyPresetWallpaper(url, title);
    if (!saved) ElMessage.warning('当前环境限制本地持久存储，壁纸已在本次会话生效');
  } catch {
    ElMessage.error('预设壁纸加载失败，请重试或选择本地图片');
  } finally {
    uploading.value = false;
  }
}

async function generateRandomWallpaper() {
  if (uploading.value) return;
  uploading.value = true;
  try {
    const saved = await applyRandomAuroraWallpaper();
    if (!saved) ElMessage.warning('当前环境限制本地持久存储，流光壁纸已在本次会话生效');
  } finally {
    uploading.value = false;
  }
}

async function pickRecentWallpaper(id: string) {
  if (uploading.value) return;
  uploading.value = true;
  try {
    const ok = await selectGalleryWallpaper(id);
    if (!ok) ElMessage.warning('该历史壁纸缓存已失效，请重新上传');
  } finally {
    uploading.value = false;
  }
}

async function removeWallpaper() {
  if (!await updateCustomWallpaper(null)) ElMessage.warning('已移除当前会话壁纸');
}
</script>

<template>
  <el-popover v-model:visible="visible" trigger="click" :width="568" placement="bottom-end" :popper-options="{ strategy: 'fixed' }" popper-class="theme-popover" :show-arrow="false">
    <template #reference>
      <button ref="trigger" class="theme-trigger" aria-label="切换皮肤" :aria-expanded="visible" @keydown.esc.stop="closeWithKeyboard"><Palette :size="15" /><span>{{ current.name }}</span></button>
    </template>
    <div
      class="theme-content"
      :class="{ 'is-dragging-file': draggingWallpaper }"
      @keydown.esc.stop="closeWithKeyboard"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDropWallpaper"
    >
      <div class="theme-heading">
        <strong>选择主题与壁纸</strong>
        <span>支持本地上传、拖拽 / ⌘V 粘贴图片与智能取色</span>
      </div>

      <div class="wallpaper-quickbar" role="group" aria-label="壁纸快捷切换">
        <label :for="uploading ? undefined : wallpaperInputId" role="button" tabindex="0" class="quick-pill primary" :class="{ 'is-disabled': uploading }" @keydown.enter.prevent="openFilePicker" @keydown.space.prevent="openFilePicker">
          <ImagePlus :size="13" /><span>{{ uploading ? '正在应用…' : '上传本地壁纸' }}</span>
        </label>
        <button type="button" class="quick-pill" :disabled="uploading" title="程序化生成 1080P 流光极光 SVG 壁纸并自动配色" @click="generateRandomWallpaper">
          <Sparkles :size="13" /><span>随机流光</span>
        </button>
        <button type="button" class="quick-pill" :class="{ active: preference === 'immersive-photo' }" @click="selectThemeOption('immersive-photo')">
          <Camera :size="13" /><span>沉浸摄影</span>
        </button>
        <button type="button" class="quick-pill" :class="{ active: preference === 'cinematic-video-hero' }" @click="selectThemeOption('cinematic-video-hero')">
          <Film :size="13" /><span>动态视频</span>
        </button>
        <button type="button" class="quick-pill" :class="{ active: preference === 'custom' }" @click="selectThemeOption('custom')">
          <Palette :size="13" /><span>随心配色</span>
        </button>
      </div>
      <input :id="wallpaperInputId" ref="imageInput" class="visually-hidden" type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.avif,.gif,.svg,.bmp,.ico,.heic,.heif" @change="imageChanged" />

      <section v-if="preference === 'immersive-photo'" class="stage-switcher" aria-label="沉浸摄影画幅切换">
        <div class="stage-switcher-head">
          <strong>沉浸摄影壁纸画幅</strong>
          <div class="stage-head-actions">
            <button
              type="button"
              class="stage-motion-btn"
              :class="{ active: photoDaylightEnabled }"
              :aria-pressed="photoDaylightEnabled"
              :title="`按本地时段自动流转画幅 · 当前：${photoDaylightSlot.label}`"
              @click="togglePhotoDaylight()"
            >
              <Sun :size="12" />
              <span>{{ photoDaylightEnabled ? `昼夜流转 · ${photoDaylightSlot.label.slice(0, 4)}` : '昼夜流转' }}</span>
            </button>
            <button type="button" class="stage-motion-btn" :class="{ active: kenBurnsEnabled }" :aria-pressed="kenBurnsEnabled" @click="toggleKenBurns">
              <Pause v-if="kenBurnsEnabled" :size="12" /><Play v-else :size="12" />
              <span>{{ kenBurnsEnabled ? '呼吸镜头已开' : '静态画幅' }}</span>
            </button>
          </div>
        </div>
        <div class="stage-grid">
          <button
            v-for="frame in photoFrames"
            :key="frame.id"
            type="button"
            class="stage-card"
            :class="{ selected: activeFrame.id === frame.id }"
            :aria-pressed="activeFrame.id === frame.id"
            :style="{ backgroundImage: `linear-gradient(180deg, rgb(12 13 16 / 0.2), rgb(12 13 16 / 0.82)), url('${frame.webp}')` }"
            @click="setFrame(frame.id)"
          >
            <em>{{ frame.code }}</em>
            <strong>{{ frame.title }}</strong>
            <small>{{ frame.subtitle }}</small>
          </button>
        </div>
      </section>

      <section v-else-if="preference === 'cinematic-video-hero'" class="stage-switcher" aria-label="电影动态壁纸幕次切换">
        <div class="stage-switcher-head">
          <strong>电影首屏动态壁纸</strong>
          <div class="stage-head-actions">
            <button
              type="button"
              class="stage-motion-btn"
              :class="{ active: videoDaylightEnabled }"
              :aria-pressed="videoDaylightEnabled"
              :title="`按本地时段自动流转幕次 · 当前：${videoDaylightSlot.label}`"
              @click="toggleVideoDaylight()"
            >
              <Sun :size="12" />
              <span>{{ videoDaylightEnabled ? `昼夜流转 · ${videoDaylightSlot.label.slice(0, 4)}` : '昼夜流转' }}</span>
            </button>
            <button type="button" class="stage-motion-btn" :class="{ active: loopEnabled }" :aria-pressed="loopEnabled" @click="toggleLoop">
              <Pause v-if="loopEnabled" :size="12" /><Play v-else :size="12" />
              <span>{{ loopEnabled ? '循环播放中' : '海报静帧' }}</span>
            </button>
          </div>
        </div>
        <div class="stage-grid">
          <button
            v-for="scene in videoScenes"
            :key="scene.id"
            type="button"
            class="stage-card"
            :class="{ selected: activeScene.id === scene.id }"
            :aria-pressed="activeScene.id === scene.id"
            :style="{ backgroundImage: `linear-gradient(180deg, rgb(5 6 10 / 0.2), rgb(5 6 10 / 0.85)), url('${scene.posterWebp}')` }"
            @click="setScene(scene.id)"
          >
            <em>{{ scene.code }}</em>
            <strong>{{ scene.title }}</strong>
            <small>{{ scene.subtitle }}</small>
          </button>
        </div>
      </section>

      <section v-else-if="preference === 'custom'" class="custom-theme" aria-label="自定义主题设置">
        <div class="wallpaper-preview" :class="{ empty: !wallpaperUrl, dragging: draggingWallpaper }">
          <i
            v-if="wallpaperUrl"
            class="wallpaper-preview-backdrop"
            aria-hidden="true"
            :style="{
              backgroundImage: `linear-gradient(rgb(0 0 0 / ${customTheme.overlay / 100}), rgb(0 0 0 / ${customTheme.overlay / 100})), url('${wallpaperUrl}')`,
              backgroundPosition: customTheme.position,
              filter: `blur(${Math.min(12, customTheme.blur * 0.6)}px) brightness(${customTheme.brightness}%)`,
            }"
          />
          <span>
            {{ draggingWallpaper ? '松开鼠标即可应用新壁纸' : (customTheme.wallpaperName || '拖拽或 ⌘V 粘贴图片至此，也可选择本地图片 / 下方精选壁纸') }}
          </span>
        </div>

        <div class="wallpaper-actions">
          <label :for="uploading ? undefined : wallpaperInputId" role="button" tabindex="0" class="wallpaper-action-label" :class="{ 'is-disabled': uploading }" @keydown.enter.prevent="openFilePicker" @keydown.space.prevent="openFilePicker"><ImagePlus :size="14" />{{ uploading ? '保存中…' : '选择本地图片' }}</label>
          <button type="button" :disabled="uploading" @click="generateRandomWallpaper"><Sparkles :size="13" />随机流光壁纸</button>
          <button v-if="wallpaperUrl || customTheme.wallpaperName" type="button" :disabled="uploading" @click="removeWallpaper"><Trash2 :size="13" />移除图片</button>
        </div>

        <div class="smart-palette-bar" aria-label="壁纸智能取色板">
          <div class="smart-palette-left">
            <span class="smart-palette-label">智能取色</span>
            <div v-if="extractedSwatches.length" class="swatch-chips">
              <button
                v-for="hex in extractedSwatches"
                :key="hex"
                type="button"
                class="swatch-chip"
                :class="{ active: customTheme.accent.toLowerCase() === hex.toLowerCase() }"
                :style="{ background: hex }"
                :title="`应用壁纸提取色 ${hex}`"
                :aria-label="`应用壁纸提取色 ${hex}`"
                @click="pickSwatch(hex)"
              />
            </div>
            <small v-else class="smart-palette-hint">上传壁纸后自动提取高对比色板</small>
          </div>
          <div class="smart-palette-right">
            <label class="auto-palette-toggle" title="切换壁纸时自动匹配 WCAG 高对比度主色、深色底调与遮罩浓度">
              <input type="checkbox" :checked="customTheme.autoPalette" @change="toggleAutoPalette" />
              <span>自动配主色</span>
            </label>
            <button v-if="wallpaperUrl" type="button" class="mini-reextract-btn" title="根据当前壁纸重新提取配色" @click="reextractCurrentPalette">
              <RefreshCw :size="11" />
            </button>
          </div>
        </div>

        <div v-if="recentWallpapers.length" class="recent-gallery" aria-label="最近使用壁纸">
          <div class="recent-gallery-head">
            <span><Clock3 :size="11" />最近使用（{{ recentWallpapers.length }}/6）</span>
          </div>
          <div class="recent-gallery-strip">
            <div
              v-for="item in recentWallpapers"
              :key="item.id"
              class="recent-thumb-wrap"
              :class="{ active: activeGalleryId === item.id }"
            >
              <button
                type="button"
                class="recent-thumb"
                :disabled="uploading"
                :title="`切换到 ${item.name}`"
                :style="item.thumbnailDataUrl
                  ? { backgroundImage: `linear-gradient(180deg, rgb(0 0 0 / 0.1), rgb(0 0 0 / 0.72)), url('${item.thumbnailDataUrl}')` }
                  : { backgroundImage: `linear-gradient(135deg, ${item.background}, ${item.accent})` }"
                @click="pickRecentWallpaper(item.id)"
              >
                <span>{{ item.name }}</span>
              </button>
              <button
                type="button"
                class="recent-remove"
                aria-label="从历史壁纸移除"
                title="从历史记录移除"
                @click.stop="removeGalleryWallpaper(item.id)"
              >
                <X :size="10" />
              </button>
            </div>
          </div>
        </div>

        <div class="wallpaper-presets" aria-label="内置精选壁纸">
          <button
            v-for="preset in builtinCustomWallpapers"
            :key="preset.id"
            type="button"
            class="preset-thumb"
            :class="{ active: customTheme.wallpaperName === `${preset.title}.webp` }"
            :disabled="uploading"
            :style="{ backgroundImage: `linear-gradient(180deg, rgb(0 0 0 / 0.12), rgb(0 0 0 / 0.72)), url('${preset.url}')` }"
            @click="selectBuiltinCustomWallpaper(preset.url, preset.title)"
          >
            <span>{{ preset.title }}</span>
          </button>
        </div>

        <div class="custom-colors">
          <label><span>主色</span><input type="color" :value="customTheme.accent" @input="colorChanged('accent', $event)" /></label>
          <label><span>背景色</span><input type="color" :value="customTheme.background" @input="colorChanged('background', $event)" /></label>
          <label><span>对齐</span><select :value="customTheme.position" @change="positionChanged"><option value="center">居中</option><option value="top">顶部</option><option value="bottom">底部</option></select></label>
        </div>

        <div class="optical-grid">
          <label class="overlay-control"><span>背景遮罩 <output>{{ customTheme.overlay }}%</output></span><input type="range" min="20" max="90" step="1" :value="customTheme.overlay" @input="overlayChanged" /></label>
          <label class="overlay-control"><span>卡片透明度 <output>{{ customTheme.messageOpacity }}%</output></span><input type="range" min="35" max="100" step="1" :value="customTheme.messageOpacity" @input="messageOpacityChanged" /></label>
          <label class="overlay-control"><span>景深模糊 <output>{{ customTheme.blur }}px</output></span><input type="range" min="0" max="24" step="1" :value="customTheme.blur" @input="blurChanged" /></label>
          <label class="overlay-control"><span>画面亮度 <output>{{ customTheme.brightness }}%</output></span><input type="range" min="50" max="130" step="1" :value="customTheme.brightness" @input="brightnessChanged" /></label>
        </div>

        <button type="button" class="reset-custom" @click="resetCustomTheme"><RotateCcw :size="13" />恢复自定义默认值</button>
      </section>

      <fieldset class="theme-options"><legend class="visually-hidden">面板皮肤</legend>
        <label v-for="option in displayedOptions" :key="option.id" class="theme-option" :class="{ selected: preference === option.id }">
          <input type="radio" :name="themeGroup" :value="option.id" :checked="preference === option.id" @change="selectThemeOption(option.id)" />
          <span class="theme-swatch" aria-hidden="true"><i v-for="color in option.colors" :key="color" :style="{ background: color }"></i><Monitor v-if="option.id === 'system'" :size="14" /></span>
          <span class="theme-copy"><span class="theme-title-row"><strong>{{ option.name }}</strong><em v-if="designMdMeta(option.id)" class="theme-source-tag">{{ designMdMeta(option.id)!.layout }}</em></span><small>{{ option.description }}</small></span><Check v-if="preference === option.id" class="theme-check" :size="16" aria-hidden="true" />
        </label>
      </fieldset>
      <p class="theme-note" :role="storageAvailable ? undefined : 'status'">{{ storageAvailable ? '自动保存在当前浏览器，下次打开仍然生效。' : '浏览器限制持久保存偏好，本次壁纸与主题切换立即生效。' }}</p>
    </div>
  </el-popover>
</template>

<style scoped>
.theme-trigger{display:inline-flex;align-items:center;gap:6px;min-height:30px;white-space:nowrap;padding:4px 10px;border:1px solid var(--ui-border);border-radius:6px;color:var(--ui-text);background:var(--ui-surface);cursor:pointer;font:500 12px/16px var(--sans);transition:background 220ms cubic-bezier(0.22,1,0.36,1),border-color 220ms cubic-bezier(0.22,1,0.36,1),color 220ms cubic-bezier(0.22,1,0.36,1),transform 220ms cubic-bezier(0.22,1,0.36,1)}.theme-trigger:hover{border-color:var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent)}.theme-trigger:active{transform:scale(0.98)}.theme-content{max-height:calc(100vh - 96px);overflow-y:auto;padding-right:2px}.theme-content.is-dragging-file{outline:2px dashed var(--ui-accent);outline-offset:4px;border-radius:10px}.theme-heading{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}.theme-heading strong{font:600 14px/20px var(--sans);color:var(--ui-text)}.theme-heading>span{font:400 11.5px/16px var(--sans);color:var(--ui-muted)}
.wallpaper-quickbar{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.quick-pill{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:4px 10px;border:1px solid var(--ui-border);border-radius:999px;background:var(--ui-surface);color:var(--ui-secondary);font:500 12px/16px var(--sans);cursor:pointer;user-select:none;transition:border-color 180ms ease,background 180ms ease,color 180ms ease}.quick-pill:hover{border-color:var(--ui-accent);color:var(--ui-accent);background:var(--ui-hover)}.quick-pill.active{border-color:var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent);font-weight:600}.quick-pill.primary{border-color:color-mix(in srgb,var(--ui-accent) 45%,var(--ui-border));color:var(--ui-text)}.quick-pill:disabled,.quick-pill.is-disabled{opacity:.6;cursor:wait;pointer-events:none}
.stage-switcher{margin-top:10px;padding:10px;border:1px solid var(--ui-border);border-radius:10px;background:var(--ui-raised)}.stage-switcher-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}.stage-switcher-head strong{font:600 12px/16px var(--sans);color:var(--ui-text)}.stage-head-actions{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}.stage-motion-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border:1px solid var(--ui-border);border-radius:999px;background:var(--ui-surface);color:var(--ui-secondary);font:500 11.5px/15px var(--sans);cursor:pointer;transition:border-color 160ms ease,color 160ms ease}.stage-motion-btn:hover{border-color:var(--ui-accent);color:var(--ui-text)}.stage-motion-btn.active{border-color:var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent)}.stage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.stage-card{display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;min-height:68px;padding:7px 8px;border:1px solid rgb(255 255 255 / .16);border-radius:8px;background-color:#0c0d10;background-size:cover;background-position:center;color:#f4f1ea;text-align:left;cursor:pointer;transition:border-color 180ms ease,transform 180ms ease}.stage-card:hover{border-color:var(--ui-accent)}.stage-card.selected{border-color:var(--ui-accent);box-shadow:0 0 0 1px var(--ui-accent)}.stage-card em{font:600 10px/12px var(--mono);font-style:normal;color:#e8b04b}.stage-card strong{font:600 12px/16px var(--sans);color:#fff;margin-top:2px}.stage-card small{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 10.5px/14px var(--sans);color:rgb(244 241 234 / .78)}
.theme-options{padding:0;margin:10px 0 0;border:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;max-height:min(40vh,320px);overflow-y:auto;scrollbar-gutter:stable}.theme-option{display:flex;position:relative;align-items:center;gap:9px;min-height:46px;border:1px solid var(--ui-border);border-radius:7px;padding:6px 9px;cursor:pointer;background:var(--ui-surface);transition:background 200ms cubic-bezier(0.22,1,0.36,1),border-color 200ms cubic-bezier(0.22,1,0.36,1)}.theme-option:hover{background:var(--ui-hover)}.theme-option.selected{border-color:var(--ui-accent);background:var(--ui-accent-soft)}.theme-option:focus-within{outline:2px solid var(--ui-accent);outline-offset:2px}.theme-option input{position:absolute;opacity:0;width:1px;height:1px;inset:0}.theme-swatch{display:flex;position:relative;overflow:hidden;width:34px;height:28px;border-radius:5px;border:1px solid var(--ui-border);flex-shrink:0}.theme-swatch i:first-child{width:32%}.theme-swatch i:nth-child(2){flex:1}.theme-swatch i:nth-child(3){position:absolute;width:13px;height:3px;right:3px;top:6px;border-radius:2px}.theme-swatch svg{position:absolute;bottom:3px;right:3px;color:#172232;background:#fff;border-radius:2px}.theme-copy{flex:1;min-width:0}.theme-title-row{display:flex;align-items:center;gap:5px;flex-wrap:nowrap;min-width:0}.theme-copy strong{display:inline-block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text);font:600 12.5px/17px var(--sans)}.theme-source-tag{display:none}.theme-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-muted);font:400 11px/15px var(--sans);margin-top:1px}.theme-check{color:var(--ui-accent);flex-shrink:0}
.custom-theme{margin-top:10px;padding:10px 12px;border:1px solid var(--ui-border);border-radius:12px;background:var(--ui-raised)}.wallpaper-preview{position:relative;display:flex;align-items:flex-end;height:78px;padding:8px;overflow:hidden;border:1px solid var(--ui-border);border-radius:8px;background-color:var(--ui-bg);color:#fff;transition:border-color 180ms ease}.wallpaper-preview.dragging{border-color:var(--ui-accent);box-shadow:0 0 0 1px var(--ui-accent)}.wallpaper-preview-backdrop{position:absolute;inset:-14px;background-repeat:no-repeat;background-size:cover;pointer-events:none}.wallpaper-preview.empty{align-items:center;justify-content:center;background:var(--ui-surface);color:var(--ui-muted);text-align:center}.wallpaper-preview span{position:relative;z-index:1;max-width:100%;overflow:hidden;padding:4px 8px;border-radius:6px;background:#0008;font:400 12px/16px var(--sans);text-overflow:ellipsis;white-space:nowrap}.wallpaper-preview.empty span{background:transparent;white-space:normal}.wallpaper-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.wallpaper-actions button,.wallpaper-actions .wallpaper-action-label,.reset-custom{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:29px;padding:4px 11px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface);color:var(--ui-secondary);font:500 12px/16px var(--sans);cursor:pointer;user-select:none;transition:background 220ms ease,border-color 220ms ease,color 220ms ease}.wallpaper-actions button:hover,.wallpaper-actions .wallpaper-action-label:hover,.reset-custom:hover{border-color:var(--ui-accent);color:var(--ui-accent);background:var(--ui-hover)}.wallpaper-actions button:disabled,.wallpaper-actions .wallpaper-action-label.is-disabled{cursor:wait;opacity:.6;pointer-events:none}
.smart-palette-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:8px;padding:6px 8px;border:1px solid var(--ui-border);border-radius:8px;background:var(--ui-surface)}.smart-palette-left{display:flex;align-items:center;gap:8px;min-width:0}.smart-palette-label{font:600 11.5px/15px var(--sans);color:var(--ui-secondary);white-space:nowrap}.swatch-chips{display:inline-flex;align-items:center;gap:5px}.swatch-chip{width:18px;height:18px;padding:0;border:1.5px solid rgb(255 255 255 / .28);border-radius:999px;cursor:pointer;transition:transform 140ms ease,box-shadow 140ms ease}.swatch-chip:hover{transform:scale(1.12)}.swatch-chip.active{border-color:#fff;box-shadow:0 0 0 2px var(--ui-accent)}.smart-palette-hint{font:400 11px/15px var(--sans);color:var(--ui-muted)}.smart-palette-right{display:inline-flex;align-items:center;gap:6px}.auto-palette-toggle{display:inline-flex;align-items:center;gap:4px;font:500 11px/15px var(--sans);color:var(--ui-muted);cursor:pointer;user-select:none}.auto-palette-toggle input{accent-color:var(--ui-accent);margin:0}.mini-reextract-btn{display:inline-grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid var(--ui-border);border-radius:5px;background:var(--ui-raised);color:var(--ui-secondary);cursor:pointer}.mini-reextract-btn:hover{border-color:var(--ui-accent);color:var(--ui-accent)}
.recent-gallery{margin-top:8px}.recent-gallery-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;color:var(--ui-muted);font:500 11px/14px var(--sans)}.recent-gallery-head span{display:inline-flex;align-items:center;gap:4px}.recent-gallery-strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px}.recent-thumb-wrap{position:relative;min-width:0}.recent-thumb{display:flex;align-items:flex-end;width:100%;height:38px;padding:3px 5px;border:1px solid rgb(255 255 255 / .16);border-radius:6px;background-color:#0c0d10;background-size:cover;background-position:center;color:#fff;cursor:pointer;overflow:hidden;transition:border-color 160ms ease}.recent-thumb:hover{border-color:var(--ui-accent)}.recent-thumb-wrap.active .recent-thumb{border-color:var(--ui-accent);box-shadow:0 0 0 1px var(--ui-accent)}.recent-thumb span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 9.5px/12px var(--sans);text-shadow:0 1px 4px #000}.recent-remove{position:absolute;top:2px;right:2px;display:grid;place-items:center;width:15px;height:15px;padding:0;border:0;border-radius:999px;background:rgb(0 0 0 / .68);color:#fff;opacity:0;cursor:pointer;transition:opacity 140ms ease,background 140ms ease}.recent-thumb-wrap:hover .recent-remove{opacity:1}.recent-remove:hover{background:var(--ui-danger)}
.wallpaper-presets{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px;margin-top:8px}.preset-thumb{display:flex;align-items:flex-end;height:38px;padding:4px 5px;border:1px solid rgb(255 255 255 / .16);border-radius:6px;background-color:#0c0d10;background-size:cover;background-position:center;color:#fff;cursor:pointer;overflow:hidden;transition:border-color 160ms ease}.preset-thumb:hover{border-color:var(--ui-accent)}.preset-thumb.active{border-color:var(--ui-accent);box-shadow:0 0 0 1px var(--ui-accent)}.preset-thumb:disabled{opacity:.6;cursor:wait}.preset-thumb span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 10px/12px var(--sans);text-shadow:0 1px 4px #000}
.custom-colors{display:grid;grid-template-columns:1fr 1fr 1.15fr;gap:8px;margin-top:8px}.custom-colors label{display:grid;gap:3px;color:var(--ui-muted);font:500 11.5px/15px var(--sans)}.custom-colors input,.custom-colors select{width:100%;height:28px;border:1px solid var(--ui-border);border-radius:6px;background:var(--ui-surface);color:var(--ui-text)}.custom-colors input{padding:3px}.custom-colors select{padding:0 8px;font:400 12px/16px var(--sans)}
.optical-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin-top:8px}.overlay-control{display:grid;gap:3px;color:var(--ui-muted);font:500 11.5px/15px var(--sans)}.overlay-control span{display:flex;justify-content:space-between}.overlay-control output{color:var(--ui-text);font-family:var(--mono);font-variant-numeric:tabular-nums}.overlay-control input{width:100%;accent-color:var(--ui-accent)}.reset-custom{width:100%;margin-top:8px;background:transparent}.theme-note{font:400 12px/18px var(--sans);margin:8px 0 0;color:var(--ui-muted)}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media(max-width:550px){.theme-trigger{padding:8px}.theme-trigger span{display:none}.stage-grid{grid-template-columns:1fr}.wallpaper-presets,.recent-gallery-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.optical-grid{grid-template-columns:1fr}}
</style>
