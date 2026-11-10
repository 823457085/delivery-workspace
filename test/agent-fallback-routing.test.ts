import test from 'node:test';
import assert from 'node:assert/strict';
import { codexFallbackFor, reviewChoiceFor } from '../shared/agent-roles.js';

test('Claude 切换后的审查模型避开当前实现模型；没有独立备选时明确阻塞', () => {
  const review = reviewChoiceFor('codex');
  assert.equal(codexFallbackFor(review, ['gpt-6.1-sol']).model, 'gpt-6-astra');
  assert.equal(codexFallbackFor(review, ['gpt-6-astra']).model, 'gpt-6.1-sol');
  assert.throws(() => codexFallbackFor(review, ['gpt-6.1-sol', 'gpt-6-astra']), /没有可用的 Codex 审查模型/);
});
