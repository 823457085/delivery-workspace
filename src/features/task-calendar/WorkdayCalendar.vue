<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { CalendarDays, GanttChart } from '@lucide/vue';
import type { JiraIssue } from '../../../shared/hub';
import { isDone } from '../../shared/format';
import { plannedTaskRange } from '../../shared/task-schedule';
import { buildCalendarWeeks, buildMonthCalendar, calendarWeekdays, monthTitle } from './calendar-domain';
import { buildGanttRows, buildGanttWindowDays } from './calendar-timeline-studio';

const props = withDefaults(
  defineProps<{
    itemsByDay: Map<string, JiraIssue[]>;
    items?: JiraIssue[];
    dateField?: string;
  }>(),
  {
    items: undefined,
    dateField: 'planned',
  },
);
const emit = defineEmits<{ inspect: [issue: JiraIssue]; selectDay: [day: string] }>();
const calendarDate = defineModel<Date>({ required: true });

const calendarMode = defineModel<'month' | 'gantt'>('mode', { default: 'month' });

const allIssues = computed<JiraIssue[]>(() => {
  if (props.items) return props.items;
  const dedup = new Map<string, JiraIssue>();
  for (const list of props.itemsByDay.values()) {
    for (const issue of list) dedup.set(issue.key, issue);
  }
  return [...dedup.values()];
});

const weeks = computed(() => buildCalendarWeeks(buildMonthCalendar(calendarDate.value), props.itemsByDay));
const title = computed(() => monthTitle(calendarDate.value));

const ganttDays = computed(() => buildGanttWindowDays(calendarDate.value, 14));
const ganttRows = computed(() => buildGanttRows(allIssues.value, ganttDays.value, props.dateField));
const ganttWindowTitle = computed(() => {
  const first = ganttDays.value[0]?.day || '';
  const last = ganttDays.value[ganttDays.value.length - 1]?.day || '';
  return `${first} — ${last}`;
});

const nearestScheduledDate = computed(() => {
  for (const issue of allIssues.value) {
    if (props.dateField === 'planned') {
      const range = plannedTaskRange(issue);
      if (range) return range.start;
    } else {
      const raw =
        props.dateField === 'created'
          ? issue.created
          : props.dateField === 'duedate'
            ? issue.dueDate
            : props.dateField === 'resolutiondate'
              ? issue.resolutionDate
              : issue.updated;
      if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
    }
  }
  return '';
});

function movePeriod(offset: number) {
  if (calendarMode.value === 'gantt') {
    calendarDate.value = new Date(
      calendarDate.value.getFullYear(),
      calendarDate.value.getMonth(),
      calendarDate.value.getDate() + offset * 14,
    );
  } else {
    calendarDate.value = new Date(calendarDate.value.getFullYear(), calendarDate.value.getMonth() + offset, 1);
  }
}

function showToday() {
  calendarDate.value = new Date();
}

function jumpToNearestScheduled() {
  const raw = nearestScheduledDate.value;
  if (!raw) return;
  const [y, m, d] = raw.split('-').map(Number);
  if (y && m && d) {
    calendarDate.value = new Date(y, m - 1, d);
  }
}

function onCalendarKeydown(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('.el-dialog, .el-drawer, .cmd-palette-backdrop')) return;
  if (event.key === '[') {
    event.preventDefault();
    movePeriod(-1);
  } else if (event.key === ']') {
    event.preventDefault();
    movePeriod(1);
  } else if (event.key === 't' || event.key === 'T') {
    event.preventDefault();
    showToday();
  }
}

onMounted(() => document.addEventListener('keydown', onCalendarKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onCalendarKeydown));
</script>

<template>
  <section class="calendar-month" aria-label="工作日任务月历与时间线">
    <header class="calendar-header">
      <div class="calendar-title-wrap">
        <h2>{{ calendarMode === 'gantt' ? ganttWindowTitle : title }}</h2>
        <span class="calendar-subtitle-pill">
          {{ calendarMode === 'gantt' ? `双周甘特 · ${ganttRows.length} 项排期` : '月度工作历' }}
        </span>
      </div>

      <div class="calendar-header-controls">
        <span class="calendar-kbd-hint" title="按 [ / ] 翻页，按 t 回到今天">
          <kbd>[</kbd><kbd>]</kbd> 翻页 · <kbd>t</kbd> 今天
        </span>

        <div class="calendar-mode-switch" role="group" aria-label="切换月历或双周甘特时间线">
          <button
            type="button"
            :class="{ 'is-active': calendarMode === 'month' }"
            :aria-pressed="calendarMode === 'month'"
            @click="calendarMode = 'month'"
          >
            <CalendarDays :size="13" /><span>月历</span>
          </button>
          <button
            type="button"
            :class="{ 'is-active': calendarMode === 'gantt' }"
            :aria-pressed="calendarMode === 'gantt'"
            @click="calendarMode = 'gantt'"
          >
            <GanttChart :size="13" /><span>14天甘特</span>
          </button>
        </div>

        <el-button-group>
          <el-button size="small" @click="movePeriod(-1)">{{ calendarMode === 'gantt' ? '上两周' : '上个月' }}</el-button>
          <el-button size="small" @click="showToday">今天</el-button>
          <el-button size="small" @click="movePeriod(1)">{{ calendarMode === 'gantt' ? '下两周' : '下个月' }}</el-button>
        </el-button-group>
      </div>
    </header>

    <!-- Mode 1: Month Grid -->
    <div v-if="calendarMode === 'month'" class="calendar-scroll" role="region" aria-label="月历任务" tabindex="0">
      <div class="workday-calendar">
        <div class="calendar-weekdays" role="row">
          <span v-for="(weekday, index) in calendarWeekdays" :key="weekday" :class="{ weekend: index > 4 }" role="columnheader">{{ weekday }}</span>
        </div>
        <section v-for="week in weeks" :key="week.days[0].day" class="calendar-week"
          :aria-label="`${week.days[0].day} 至 ${week.days.at(-1)?.day}`"
          :style="{ gridTemplateRows: week.laneCount ? `31px repeat(${week.laneCount}, 40px) 6px` : '46px' }">
          <div v-for="(cell, column) in week.days" :key="cell.day" class="calendar-date-cell" :data-day="cell.day"
            :class="{ 'outside-month': !cell.isCurrentMonth, 'rest-day': cell.isRestDay, today: cell.isToday }"
            :style="{ gridColumn: column + 1, gridRow: '1 / -1' }"
            @click.self="emit('selectDay', cell.day)">
            <button type="button" class="week-day-heading" :aria-label="`${cell.day}，${props.itemsByDay.get(cell.day)?.length || 0} 项任务`" @click="emit('selectDay', cell.day)">
              <strong>{{ cell.dateNumber }}</strong><span v-if="cell.isToday" class="today-label">今天</span>
              <span class="day-meta">
                <span v-if="cell.isRestDay">休息</span>
                <small v-if="props.itemsByDay.get(cell.day)?.length" :class="{ 'is-dense': (props.itemsByDay.get(cell.day)?.length || 0) >= 3 }">
                  {{ props.itemsByDay.get(cell.day)?.length }} 项
                </small>
              </span>
            </button>
          </div>
          <button v-for="segment in week.segments" :key="`${segment.issue.key}-${segment.startColumn}`" type="button" class="calendar-event"
            :class="{ done: isDone(segment.issue), 'continues-before': segment.continuesBefore, 'continues-after': segment.continuesAfter }"
            :style="{ gridColumn: `${segment.startColumn + 1} / ${segment.endColumn + 2}`, gridRow: segment.lane + 2 }"
            :title="`${segment.issue.key} ${segment.issue.summary}`"
            :aria-label="`${segment.issue.key} ${segment.issue.summary}`" @click="emit('inspect', segment.issue)">
            <strong>{{ segment.issue.key }}</strong><span>{{ segment.issue.summary }}</span>
          </button>
        </section>
      </div>
    </div>

    <!-- Mode 2: Frappe Gantt / Plane 14-Day Sprint Roadmap Timeline -->
    <div v-else class="gantt-scroll" role="region" aria-label="14天双周甘特时间线" tabindex="0">
      <div class="gantt-board">
        <div class="gantt-head-row">
          <div class="gantt-task-col gantt-corner">Jira 事项 / 经办人</div>
          <div class="gantt-days-grid">
            <button
              v-for="cell in ganttDays"
              :key="cell.day"
              type="button"
              class="gantt-day-head"
              :class="{ 'is-rest': cell.isRestDay, 'is-today': cell.isToday }"
              :title="`查看 ${cell.day} 当日事项`"
              @click="emit('selectDay', cell.day)"
            >
              <strong>{{ cell.monthDay }}</strong>
              <small>{{ cell.isToday ? '今天' : `周${cell.weekdayShort}` }}</small>
            </button>
          </div>
        </div>

        <template v-if="ganttRows.length">
          <div v-for="row in ganttRows" :key="row.issue.key" class="gantt-item-row">
            <button type="button" class="gantt-task-col gantt-task-meta" @click="emit('inspect', row.issue)">
              <div class="gantt-task-top">
                <span class="gantt-key">{{ row.issue.key }}</span>
                <span v-if="row.isOverdue" class="gantt-overdue-pill">逾期</span>
                <span class="gantt-assignee">{{ row.issue.assignee || '未指派' }}</span>
              </div>
              <span class="gantt-summary" :title="row.issue.summary">{{ row.issue.summary }}</span>
            </button>

            <div class="gantt-track-grid">
              <span
                v-for="(cell, idx) in ganttDays"
                :key="cell.day"
                class="gantt-bg-col"
                :class="{ 'is-rest': cell.isRestDay, 'is-today': cell.isToday }"
                :style="{ gridColumn: idx + 1, gridRow: 1 }"
              ></span>
              <button
                type="button"
                class="gantt-bar"
                :data-stage="row.stage"
                :class="{
                  'is-overdue': row.isOverdue,
                  'continues-before': row.continuesBefore,
                  'continues-after': row.continuesAfter,
                }"
                :style="{ gridColumn: `${row.startCol + 1} / ${row.endCol + 2}`, gridRow: 1 }"
                :title="`${row.issue.key} · ${row.issue.summary} (${row.rangeLabel})`"
                @click="emit('inspect', row.issue)"
              >
                <strong class="gantt-bar-label">{{ row.issue.key }} · {{ row.issue.summary }}</strong>
                <small class="gantt-bar-dates">{{ row.rangeLabel }}</small>
              </button>
            </div>
          </div>
        </template>

        <div v-else class="gantt-empty">
          <p>当前双周窗口（{{ ganttWindowTitle }}）内暂无带日期的事项。</p>
          <div class="gantt-empty-actions">
            <el-button v-if="nearestScheduledDate" size="small" type="primary" plain @click="jumpToNearestScheduled">
              跳至最近有排期的周（{{ nearestScheduledDate }}）
            </el-button>
            <el-button size="small" @click="calendarMode = 'month'">切回月历总览</el-button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.calendar-month { min-width: 0; }
.calendar-scroll, .gantt-scroll { overflow-x: auto; overscroll-behavior-x: contain; }
.workday-calendar { min-width: 840px; background: var(--ui-surface); }
.calendar-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 14px; padding: 11px 14px; border-bottom: 1px solid var(--ui-border); }
.calendar-title-wrap { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.calendar-header h2 { margin: 0; color: var(--ui-text); font: 600 14px/1.3 var(--mono); font-variant-numeric: tabular-nums; }
.calendar-subtitle-pill {
  padding: 2px 7px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  font-size: 11px;
}
.calendar-header-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; }
.calendar-kbd-hint { display: inline-flex; align-items: center; gap: 3px; color: var(--ui-muted); font-size: 11px; }
.calendar-kbd-hint kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-raised);
  color: var(--ui-secondary);
  font: 500 10px/1 var(--mono);
}
.calendar-mode-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ds-radius-xs, 6px);
  background: var(--ui-raised);
}
.calendar-mode-switch > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.calendar-mode-switch > button.is-active {
  background: var(--ui-surface);
  color: var(--ui-accent);
  font-weight: 600;
  box-shadow: 0 1px 2px #0000000d;
}

.calendar-weekdays { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); background: var(--ui-raised); border-bottom: 1px solid var(--ui-border); }
.calendar-weekdays span { padding: 8px 12px; color: var(--ui-muted); font-size: 11.5px; font-weight: 600; }
.calendar-weekdays .weekend { color: var(--ui-muted); opacity: 0.85; }
.calendar-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); isolation: isolate; border-bottom: 1px solid var(--ui-divider); }
.calendar-week:last-child { border-bottom: 0; }
.calendar-date-cell { position: relative; min-width: 0; padding: 0; border: 0; border-right: 1px solid var(--ui-divider); border-radius: 0; background: var(--ui-surface); color: var(--ui-text); text-align: left; cursor: pointer; }
.calendar-date-cell:nth-child(7) { border-right: 0; }
.calendar-date-cell.rest-day { background: color-mix(in srgb, var(--ui-raised) 65%, var(--ui-surface)); }
.calendar-date-cell.today { box-shadow: inset 0 2px var(--ui-accent); }
.week-day-heading { position: absolute; top: 0; display: flex; align-items: center; gap: 6px; width: 100%; height: 31px; padding: 0 10px; border: 0; background: transparent; color: inherit; text-align: left; line-height: 1; cursor: pointer; }
.week-day-heading strong { font: 500 12px/1 var(--mono); }
.outside-month .week-day-heading { color: var(--ui-muted); opacity: .55; }
.rest-day .week-day-heading strong { color: var(--ui-muted); }
.today-label { color: var(--ui-accent); font-size: 10px; font-weight: 600; }
.day-meta { display: flex; align-items: baseline; gap: 6px; margin-left: auto; color: var(--ui-muted); font-size: 10px; }
.day-meta small { font: inherit; }
.day-meta small.is-dense { color: var(--ui-accent); font-weight: 600; }
.calendar-event { z-index: 1; display: flex; flex-direction: column; justify-content: center; gap: 1px; min-width: 0; margin: 2px 5px; padding: 2px 7px; overflow: hidden; border: 1px solid var(--ui-border); border-left: 2.5px solid color-mix(in srgb, var(--ui-accent) 72%, var(--ui-border)); border-radius: 5px; background: var(--ui-raised); color: var(--ui-text); text-align: left; cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease; }
.calendar-event strong { color: var(--ui-muted); font: 600 10px/1.3 var(--mono); letter-spacing: .02em; }
.calendar-event > span { display: block; max-width: 100%; overflow: hidden; font-size: 11.5px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.calendar-event.done { border-color: color-mix(in srgb, var(--ui-success) 30%, var(--ui-border)); border-left-color: var(--ui-success); background: var(--ui-success-bg); }
.calendar-event.done strong { color: var(--ui-success); }
.calendar-event.continues-before { border-top-left-radius: 2px; border-bottom-left-radius: 2px; }
.calendar-event.continues-after { border-top-right-radius: 2px; border-bottom-right-radius: 2px; }
.calendar-event:hover { border-color: color-mix(in srgb, var(--ui-text) 20%, var(--ui-border)); background: var(--ui-surface); box-shadow: 0 1px 4px #00000012; }
.week-day-heading:focus-visible, .calendar-event:focus-visible { z-index: 2; outline: 2px solid var(--ui-accent); outline-offset: -2px; }

/* Frappe Gantt / Plane 14-Day Timeline */
.gantt-board { min-width: 920px; background: var(--ui-surface); }
.gantt-head-row,
.gantt-item-row {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr);
  border-bottom: 1px solid var(--ui-divider);
}
.gantt-item-row:last-child { border-bottom: 0; }
.gantt-task-col {
  position: sticky;
  left: 0;
  z-index: 2;
  border-right: 1px solid var(--ui-border);
  background: var(--ui-surface);
}
.gantt-corner {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  background: var(--ui-raised);
  color: var(--ui-muted);
  font-size: 11.5px;
  font-weight: 600;
}
.gantt-days-grid,
.gantt-track-grid {
  display: grid;
  grid-template-columns: repeat(14, minmax(46px, 1fr));
}
.gantt-day-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 6px 4px;
  border: 0;
  border-right: 1px solid var(--ui-divider);
  background: var(--ui-raised);
  color: var(--ui-secondary);
  cursor: pointer;
}
.gantt-day-head:last-child { border-right: 0; }
.gantt-day-head strong { font: 600 11px/1.1 var(--mono); font-variant-numeric: tabular-nums; }
.gantt-day-head small { font-size: 10px; color: var(--ui-muted); }
.gantt-day-head.is-rest { opacity: 0.72; }
.gantt-day-head.is-today {
  background: color-mix(in srgb, var(--ui-accent-soft) 72%, var(--ui-raised));
  color: var(--ui-accent);
  box-shadow: inset 0 -2px 0 var(--ui-accent);
}
.gantt-day-head.is-today small { color: var(--ui-accent); font-weight: 600; }

.gantt-task-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 3px;
  padding: 8px 12px;
  border-top: 0;
  border-left: 0;
  border-bottom: 0;
  text-align: left;
  cursor: pointer;
}
.gantt-task-meta:hover { background: var(--ui-hover); }
.gantt-task-top { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; }
.gantt-key {
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 28%, var(--ui-border));
  border-radius: 4px;
  background: color-mix(in srgb, var(--ui-accent-soft) 52%, var(--ui-surface));
  color: var(--ui-accent);
  font: 600 10.5px/1.3 var(--mono);
  flex-shrink: 0;
}
.gantt-overdue-pill {
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, #ef4444 16%, var(--ui-surface));
  color: #ef4444;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
.gantt-assignee {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--ui-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gantt-summary {
  width: 100%;
  font-size: 12px;
  font-weight: 550;
  color: var(--ui-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.gantt-track-grid { align-items: center; min-height: 48px; position: relative; }
.gantt-bg-col {
  align-self: stretch;
  border-right: 1px solid var(--ui-divider);
}
.gantt-bg-col:nth-child(14) { border-right: 0; }
.gantt-bg-col.is-rest { background: color-mix(in srgb, var(--ui-raised) 58%, var(--ui-surface)); }
.gantt-bg-col.is-today { background: color-mix(in srgb, var(--ui-accent-soft) 32%, var(--ui-surface)); }

.gantt-bar {
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 28px;
  margin: 0 4px;
  padding: 0 8px;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 42%, var(--ui-border));
  border-left: 3px solid var(--ui-accent);
  border-radius: 5px;
  background: color-mix(in srgb, var(--ui-accent-soft) 68%, var(--ui-surface));
  color: var(--ui-text);
  cursor: pointer;
  overflow: hidden;
  transition: transform .12s ease, border-color .12s ease;
}
.gantt-bar:hover { border-color: var(--ui-accent); transform: translateY(-0.5px); }
.gantt-bar[data-stage='verify'] {
  border-color: color-mix(in srgb, #f59e0b 45%, var(--ui-border));
  border-left-color: #f59e0b;
  background: color-mix(in srgb, #f59e0b 14%, var(--ui-surface));
}
.gantt-bar[data-stage='done'] {
  border-color: color-mix(in srgb, #10b981 42%, var(--ui-border));
  border-left-color: #10b981;
  background: color-mix(in srgb, #10b981 14%, var(--ui-surface));
}
.gantt-bar.is-overdue {
  border-color: color-mix(in srgb, #ef4444 52%, var(--ui-border));
  border-left-color: #ef4444;
  background: color-mix(in srgb, #ef4444 13%, var(--ui-surface));
}
.gantt-bar-label {
  font-size: 11.5px;
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gantt-bar-dates {
  flex-shrink: 0;
  font: 500 10px/1 var(--mono);
  color: var(--ui-secondary);
}

.gantt-empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--ui-muted);
  font-size: 12.5px;
}
.gantt-empty p { margin: 0 0 12px; }
.gantt-empty-actions { display: inline-flex; align-items: center; gap: 8px; }

:root[data-theme='acid'] .calendar-subtitle-pill,
:root[data-theme='acid'] .calendar-mode-switch,
:root[data-theme='acid'] .calendar-mode-switch > button,
:root[data-theme='acid'] .calendar-kbd-hint kbd,
:root[data-theme='acid'] .gantt-key,
:root[data-theme='acid'] .gantt-bar {
  border-radius: 0 !important;
}

@media (max-width: 860px) {
  .calendar-kbd-hint { display: none; }
}
</style>
