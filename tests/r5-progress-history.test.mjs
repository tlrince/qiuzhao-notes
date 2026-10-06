import assert from 'node:assert/strict';
import test from 'node:test';
import { projectProgressHistory } from '../src/features/progress/history.ts';

function event(id, sequence, overrides = {}) {
  const previousEventId = sequence === 1 ? null : `event-${sequence - 1}`;
  return {
    id,
    applicationId: 'app-1',
    commandId: `command-${sequence}`,
    statusId: `status-${sequence}`,
    statusNameSnapshot: `状态 ${sequence}`,
    definitionVersion: 1,
    semantics: {
      semantic: 'stage',
      stageId: `stage-${sequence}`,
      stageCategory: 'custom',
      stageNameSnapshot: `环节 ${sequence}`,
      countsAsInterview: false,
      statisticsCategory: null,
      terminalOutcome: 'active',
    },
    phase: 'passed',
    occurredOn: `2026-09-0${sequence}`,
    // Intentionally unrelated to business order; the projection must not use it.
    createdAt: `2026-09-0${6 - sequence}T00:00:00.000Z`,
    sequence,
    previousEventId,
    visitId: `visit-${sequence}`,
    source: 'entered',
    visitAction: 'new',
    insertedBeforeEventId: null,
    reopenReason: null,
    reopensEventId: null,
    correctionOfEventId: null,
    failedAt: null,
    contextStageId: null,
    notes: '',
    invalidatedAt: null,
    ...overrides,
  };
}

test('uses previousEventId and sequence, filters invalidated records, and keeps repeat visits separate', () => {
  const first = event('first', 1, { semantics: { ...event('seed', 1).semantics, stageId: 'screening' }, visitId: 'screen-1' });
  const second = event('second', 2, {
    previousEventId: 'first',
    semantics: { ...first.semantics },
    statusNameSnapshot: '筛选中',
    visitId: 'screen-2',
  });
  const audit = event('invalidated', 3, { invalidatedAt: '2026-09-17T00:00:00.000Z', previousEventId: 'second' });
  const third = event('third', 3, { previousEventId: 'second' });
  const projected = projectProgressHistory([third, audit, second, first]);

  assert.deepEqual(projected.nodes.map(node => node.event.id), ['first', 'second', 'third']);
  assert.equal(projected.nodes[0].visitOrdinal, 1);
  assert.equal(projected.nodes[1].visitOrdinal, 2);
  assert.equal(projected.nodes[0].visitCount, 2);
  assert.equal(projected.nodes[1].visitCount, 2);
  assert.equal(projected.currentEventId, 'third');
});

test('marks uncertain connectors and disables precise timing for those edges', () => {
  const first = event('first', 1);
  const second = event('second', 2, { previousEventId: 'first' });
  const history = projectProgressHistory([first, second], [
    { fromEventId: 'first', toEventId: 'second', reason: '旧历史顺序待确认' },
  ]);

  assert.equal(history.links[0].uncertain, true);
  assert.equal(history.links[0].timingIsPrecise, false);
  assert.equal(history.links[0].uncertaintyReason, '旧历史顺序待确认');
});

test('labels failure, Offer rejection, and voluntary withdrawal as distinct outcomes', () => {
  const priorInterview = event('interview', 1, {
    semantics: { ...event('seed', 1).semantics, stageId: 'stage-interview', stageNameSnapshot: '二面' },
    visitId: 'interview-visit',
  });
  const failed = event('failure', 2, {
    previousEventId: 'interview',
    semantics: { ...priorInterview.semantics, terminalOutcome: 'failed', semantic: 'failed' },
    failedAt: { stageId: 'stage-interview', stageNameSnapshot: '二面' },
  });
  const declined = event('declined', 3, {
    previousEventId: 'failure',
    semantics: { ...event('seed', 1).semantics, terminalOutcome: 'offer_declined', semantic: 'offer_declined', stageId: null, stageNameSnapshot: null, stageCategory: null },
    failedAt: null,
  });
  const withdrawn = event('withdrawn', 4, {
    previousEventId: 'declined',
    semantics: { ...event('seed', 1).semantics, terminalOutcome: 'withdrawn', semantic: 'withdrawn', stageId: null, stageNameSnapshot: null, stageCategory: null },
    failedAt: null,
  });
  const history = projectProgressHistory([priorInterview, failed, declined, withdrawn]);

  assert.equal(history.nodes[1].outcomeLabel, '流程挂掉');
  assert.equal(history.nodes[1].failureLabel, '失败环节：二面');
  assert.equal(history.nodes[1].visitOrdinal, null, '失败归因不是新的阶段访问');
  assert.equal(history.nodes[1].visitCount, null);
  assert.equal(history.nodes[2].outcomeLabel, '已拒绝 Offer');
  assert.equal(history.nodes[3].outcomeLabel, '主动退出');
});

test('rejects forked, gapped, or cross-application effective chains', () => {
  const first = event('first', 1);
  const second = event('second', 2, { previousEventId: 'first' });
  const fork = event('fork', 3, { previousEventId: 'first' });
  assert.throws(() => projectProgressHistory([first, second, fork]), /多个后续事件/);
  assert.throws(() => projectProgressHistory([first, event('third', 3, { previousEventId: 'first' })]), /sequence/);
  assert.throws(() => projectProgressHistory([first, { ...second, applicationId: 'app-2' }]), /混合不同投递/);
});

test('resolves uncertain edges through a corrected event to its effective replacement', () => {
  const old = event('old', 1, { invalidatedAt: '2026-09-17T01:00:00.000Z' });
  const replacement = event('replacement', 1, { correctionOfEventId: 'old' });
  const later = event('later', 2, { previousEventId: 'replacement' });
  // The display list contains only effective events. Correction ancestry must be
  // resolved from the complete audit record set so filtering `old` is safe.
  const history = projectProgressHistory([replacement, later], [
    { fromEventId: 'old', toEventId: 'later', reason: '迁移顺序未确认' },
  ], [old, replacement, later]);
  assert.deepEqual(history.nodes.map(node => node.event.id), ['replacement', 'later']);
  assert.equal(history.links[0].fromEventId, 'replacement');
  assert.equal(history.links[0].toEventId, 'later');
  assert.equal(history.links[0].uncertain, true);
  assert.equal(history.links[0].timingIsPrecise, false);
  assert.equal(history.links[0].uncertaintyReason, '迁移顺序未确认');
});

test('maps progress phases to Chinese labels and hides unknown phase', () => {
  const labels = [
    ['waiting', '等待中'],
    ['in_progress', '进行中'],
    ['awaiting_result', '等待结果'],
    ['passed', '已通过'],
    ['unknown', null],
  ];

  for (const [phase, expected] of labels) {
    const history = projectProgressHistory([event('phase', 1, { phase })]);
    assert.equal(history.nodes[0].phaseLabel, expected);
  }
});
