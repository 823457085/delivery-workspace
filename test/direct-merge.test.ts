import test from 'node:test';
import assert from 'node:assert/strict';
import { directMergeReasonError } from '../src/features/catchup/domain.js';
import { statusLabels, statusTone } from '../src/shared/format.js';

test('exception reason requires a meaningful bounded audit entry', () => {
  for (const value of ['', '太短', '\n'.repeat(15), 'x'.repeat(1001)]) assert.notEqual(directMergeReasonError(value), true);
  assert.equal(directMergeReasonError('i18n-test 不支持特殊分期环境，后续在相应环境补测'), true);
});
test('exception delivery is not presented as self-test success', () => {
  assert.equal(statusLabels.EXCEPTION_MERGED, '例外已合入');
  assert.equal(statusTone('EXCEPTION_MERGED'), 'warning');
  assert.equal(statusTone('APPROVED'), 'success');
});
