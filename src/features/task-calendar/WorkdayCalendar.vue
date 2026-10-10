<script setup lang="ts">
import { computed } from 'vue';
import type { JiraIssue } from '../../../shared/hub';
import { isDone } from '../../shared/format';
import { buildMonthCalendar, calendarWeekdays, monthTitle } from './calendar-domain';

const props = defineProps<{ itemsByDay: Map<string, JiraIssue[]> }>();
const emit = defineEmits<{ inspect: [issue: JiraIssue]; selectDay: [day: string] }>();
const calendarDate = defineModel<Date>({ required: true });

const cells = computed(() => buildMonthCalendar(calendarDate.value));
const title = computed(() => monthTitle(calendarDate.value));

function moveMonth(offset: number) {
  calendarDate.value = new Date(calendarDate.value.getFullYear(), calendarDate.value.getMonth() + offset, 1);
}

function showToday() {
  calendarDate.value = new Date();
}

function selectDay(day: string) {
  emit('selectDay', day);
}
</script>

<template>
  <div class="calendar-scroll">
    <section class="workday-calendar" aria-label="工作日任务月历">
      <header class="calendar-header">
        <h2>{{ title }}</h2>
        <el-button-group>
          <el-button size="small" @click="moveMonth(-1)">上个月</el-button>
          <el-button size="small" @click="showToday">今天</el-button>
          <el-button size="small" @click="moveMonth(1)">下个月</el-button>
        </el-button-group>
      </header>

      <div class="calendar-weekdays" role="row">
        <span
          v-for="(weekday, index) in calendarWeekdays"
          :key="weekday"
          :class="{ weekend: index > 4 }"
          role="columnheader"
        >
          {{ weekday }}
        </span>
      </div>

      <div class="calendar-grid">
        <article
          v-for="cell in cells"
          :key="cell.day"
          class="calendar-cell"
          :class="{
            'outside-month': !cell.isCurrentMonth,
            'rest-day': cell.isRestDay,
            today: cell.isToday,
          }"
          tabindex="0"
          @click="selectDay(cell.day)"
          @keydown.enter="selectDay(cell.day)"
          @keydown.space.prevent="selectDay(cell.day)"
        >
          <div class="calendar-day">
            <strong>{{ cell.dateNumber }}</strong>
            <span v-if="cell.isToday">今天</span>
            <small v-else-if="props.itemsByDay.get(cell.day)?.length">
              {{ props.itemsByDay.get(cell.day)?.length }} 项
            </small>
          </div>

          <div v-if="cell.isRestDay" class="rest-band">休息</div>

          <button
            v-for="item in (props.itemsByDay.get(cell.day) || []).slice(0, 3)"
            :key="item.key"
            class="calendar-task"
            :class="{ done: isDone(item) }"
            :title="`${item.key} ${item.summary}`"
            @click.stop="emit('inspect', item)"
          >
            {{ item.key }} {{ item.summary }}
          </button>
          <span v-if="(props.itemsByDay.get(cell.day)?.length || 0) > 3" class="calendar-more">
            + {{ (props.itemsByDay.get(cell.day)?.length || 0) - 3 }} 项，点击查看
          </span>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.calendar-scroll {
  overflow-x: auto;
}

.workday-calendar {
  min-width: 920px;
  background: var(--ui-surface);
}

.calendar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ui-border);
}

.calendar-header h2 {
  margin: 0;
  color: var(--ui-text);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: .2px;
}

.calendar-weekdays,
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}

.calendar-weekdays {
  background: var(--ui-raised);
  border-bottom: 1px solid var(--ui-border);
}

.calendar-weekdays span {
  padding: 11px 12px;
  color: var(--ui-muted);
  font-size: 11px;
  font-weight: 500;
}

.calendar-weekdays .weekend {
  color: var(--ui-danger);
}

.calendar-cell {
  min-width: 0;
  min-height: 148px;
  padding: 10px;
  overflow: hidden;
  border-right: 1px solid var(--ui-divider);
  border-bottom: 1px solid var(--ui-divider);
  background: var(--ui-surface);
  cursor: pointer;
}

.calendar-cell:nth-child(7n) {
  border-right: 0;
}

.calendar-cell:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--ui-accent);
  outline-offset: -2px;
}

.calendar-cell.rest-day {
  background: color-mix(in srgb, var(--ui-raised) 72%, var(--ui-surface));
}

.calendar-cell.outside-month {
  opacity: .48;
}

.calendar-day {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  min-height: 22px;
  margin-bottom: 5px;
}

.calendar-day strong {
  color: var(--ui-text);
  font: 600 14px/1 var(--mono);
}

.rest-day .calendar-day strong {
  color: var(--ui-danger);
}

.calendar-day span {
  color: var(--ui-accent);
  font-size: 11px;
  font-weight: 600;
}

.calendar-day small {
  color: var(--ui-muted);
  font-size: 10px;
}

.rest-band {
  height: 19px;
  margin-bottom: 5px;
  padding: 2px 7px;
  border-radius: 3px;
  background: var(--ui-divider);
  color: var(--ui-secondary);
  font-size: 10px;
  line-height: 15px;
}

.calendar-task {
  display: block;
  width: 100%;
  margin-bottom: 4px;
  padding: 4px 6px;
  overflow: hidden;
  border: 0;
  border-left: 2px solid var(--ui-warning);
  border-radius: 3px;
  background: var(--ui-warning-bg);
  color: var(--ui-warning);
  font-size: 11px;
  line-height: 1.45;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.calendar-task.done {
  border-color: var(--ui-success);
  background: var(--ui-success-bg);
  color: var(--ui-success);
}

.calendar-more {
  color: var(--ui-muted);
  font-size: 10px;
}

@media (max-width: 1000px) {
  .workday-calendar {
    min-width: 840px;
  }
}
</style>
