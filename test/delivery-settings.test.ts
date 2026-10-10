import test from 'node:test';
import assert from 'node:assert/strict';
import { validDeliverySettings } from '../src/features/delivery-settings/domain.js';
import type { AutomationSettings } from '../shared/hub.js';

const settings: AutomationSettings = { enabled: false, dailyTime: '09:00', dailyTimes: ['09:00', '19:00'], maxDispatchPerRun: 8, autoCreateCodex: false, autoCreateMergeRequest: false, autoTransitionJira: false, startStatus: '开始', completedStatus: '完成', targetBranch: 'feature/test', reviewer: '' };
test('dispatch quantity preserves original zero-unlimited semantics and no invented cap of 100', () => {
  for (const maxDispatchPerRun of [0, 1, 8, 101]) assert.equal(validDeliverySettings({ ...settings, maxDispatchPerRun }), true);
  for (const maxDispatchPerRun of [-1, 1.2, NaN, Infinity]) assert.equal(validDeliverySettings({ ...settings, maxDispatchPerRun }), false);
});
test('invalid schedule and required status or branch remain blocked', () => {
  assert.equal(validDeliverySettings(), false);
  for (const dailyTimes of [[], ['24:00'], ['09:60'], ['']]) assert.equal(validDeliverySettings({ ...settings, dailyTimes }), false);
  for (const field of ['startStatus', 'completedStatus', 'targetBranch']) assert.equal(validDeliverySettings({ ...settings, [field]: ' ' }), false);
});
