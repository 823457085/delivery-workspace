<script setup lang="ts">
import { computed } from 'vue';
import type { JiraIssue } from '../../../shared/hub';
import { isDone } from '../../shared/format';
import { buildCalendarWeeks, buildMonthCalendar, calendarWeekdays, monthTitle } from './calendar-domain';

const props = defineProps<{ itemsByDay: Map<string, JiraIssue[]> }>();
const emit = defineEmits<{ inspect: [issue: JiraIssue]; selectDay: [day: string] }>();
const calendarDate = defineModel<Date>({ required: true });
const weeks = computed(() => buildCalendarWeeks(buildMonthCalendar(calendarDate.value), props.itemsByDay));
const title = computed(() => monthTitle(calendarDate.value));
function moveMonth(offset: number) {
  calendarDate.value = new Date(calendarDate.value.getFullYear(), calendarDate.value.getMonth() + offset, 1);
}
function showToday() { calendarDate.value = new Date(); }
</script>

<template>
  <section class="calendar-month" aria-label="工作日任务月历">
    <header class="calendar-header">
      <h2>{{ title }}</h2>
      <el-button-group>
        <el-button size="small" @click="moveMonth(-1)">上个月</el-button>
        <el-button size="small" @click="showToday">今天</el-button>
        <el-button size="small" @click="moveMonth(1)">下个月</el-button>
      </el-button-group>
    </header>
    <div class="calendar-scroll" role="region" aria-label="月历任务" tabindex="0">
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
              <span class="day-meta"><span v-if="cell.isRestDay">休息</span><small v-if="props.itemsByDay.get(cell.day)?.length">{{ props.itemsByDay.get(cell.day)?.length }} 项</small></span>
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
  </section>
</template>

<style scoped>
.calendar-month { min-width: 0; }
.calendar-scroll { overflow-x: auto; overscroll-behavior-x: contain; }
.workday-calendar { min-width: 840px; background: var(--ui-surface); }
.calendar-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--ui-border); }
.calendar-header h2 { margin: 0; color: var(--ui-text); font-size: 18px; font-weight: 600; }
.calendar-weekdays { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); background: var(--ui-raised); border-bottom: 1px solid var(--ui-border); }
.calendar-weekdays span { padding: 11px 12px; color: var(--ui-muted); font-size: 11px; font-weight: 500; }
.calendar-weekdays .weekend { color: var(--ui-danger); }
.calendar-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); isolation: isolate; border-bottom: 1px solid var(--ui-divider); }
.calendar-week:last-child { border-bottom: 0; }
.calendar-date-cell { min-width: 0; padding: 0; border: 0; border-right: 1px solid var(--ui-divider); border-radius: 0; background: var(--ui-surface); color: var(--ui-text); text-align: left; cursor: pointer; }
.calendar-date-cell:nth-child(7) { border-right: 0; }
.calendar-date-cell.rest-day { background: color-mix(in srgb, var(--ui-raised) 70%, var(--ui-surface)); }
.calendar-date-cell.today { box-shadow: inset 0 2px var(--ui-accent); }
.week-day-heading { position: absolute; top: 0; display: flex; align-items: center; gap: 6px; width: 100%; height: 31px; padding: 0 12px; border: 0; background: transparent; color: inherit; text-align: left; line-height: 1; cursor: pointer; }
.calendar-date-cell { position: relative; }
.week-day-heading strong { font: 500 13px/1 var(--mono); }
.outside-month .week-day-heading { color: var(--ui-muted); opacity: .6; }
.rest-day .week-day-heading strong { color: var(--ui-danger); }
.today-label { color: var(--ui-accent); font-size: 10px; }
.day-meta { display: flex; align-items: baseline; gap: 7px; margin-left: auto; color: var(--ui-muted); font-size: 10px; }
.day-meta small { font: inherit; }
.calendar-event { z-index: 1; display: flex; flex-direction: column; justify-content: center; gap: 1px; min-width: 0; margin: 2px 5px; padding: 2px 7px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--ui-accent) 25%, var(--ui-border)); border-left: 3px solid var(--ui-accent); border-radius: 5px; background: var(--ui-accent-soft); color: var(--ui-text); text-align: left; cursor: pointer; transition: filter 120ms ease, box-shadow 120ms ease; }
.calendar-event strong { color: var(--ui-accent); font: 600 10px/1.3 var(--sans); letter-spacing: .3px; }
.calendar-event > span { display: block; max-width: 100%; overflow: hidden; font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.calendar-event.done { border-color: color-mix(in srgb, var(--ui-success) 30%, var(--ui-border)); border-left-color: var(--ui-success); background: var(--ui-success-bg); }
.calendar-event.done strong { color: var(--ui-success); }
.calendar-event.continues-before { border-top-left-radius: 2px; border-bottom-left-radius: 2px; }
.calendar-event.continues-after { border-top-right-radius: 2px; border-bottom-right-radius: 2px; }
.calendar-event:hover { filter: brightness(.97); box-shadow: 0 1px 4px #00000012; }
.week-day-heading:focus-visible, .calendar-event:focus-visible { z-index: 2; outline: 2px solid var(--ui-accent); outline-offset: -2px; }
</style>
