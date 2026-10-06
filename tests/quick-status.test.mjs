import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.QUICK_STATUS_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const domain = await moduleAt('domain/v2/index.js');
const quick = await moduleAt('features/progress/quick-status.js');

const definitions = domain.defaultR1Definitions();
let serial = 0;
function append(record, statusId, occurredOn, options = {}) {
  const id = ++serial;
  return domain.appendProgressEvent(record, definitions, { commandId: `c-${id}`, statusId, occurredOn, ...options }, { now: '2026-09-20T00:00:00.000Z', id: () => `e-${id}-${Math.random()}` }).record;
}
function apply(record, result) {
  for (const step of result.steps) record = domain.appendProgressEvent(record, definitions, step, { now: '2026-09-21T00:00:00.000Z', id: () => `q-${++serial}` }).record;
  return record;
}
const option = (record, key) => quick.quickStatusOptions(definitions, record).find(item => item.key === key);
const change = (record, key, extra = {}) => quick.buildQuickStatusChange({ definitions, record, option: option(record, key), today: '2026-09-21', commandId: `quick-${++serial}`, ...extra });

test('options follow offer.html: coarse stages in process order, current one shows its exact status', () => {
  const record = append(append(domain.createProgressRecord('a'), 'submitted', '2026-09-01'), 'interview_1_result', '2026-09-10');
  const options = quick.quickStatusOptions(definitions, record);
  const labels = options.map(item => item.label);
  assert.deepEqual(labels.slice(0, 2), ['已投递', '筛选中']);
  assert.ok(labels.includes('笔试') && labels.includes('一面待结果') && labels.includes('泡池子') && labels.includes('Offer') && labels.includes('挂掉'));
  assert.equal(option(record, 'submitted').disabled, true, '已投递只能记录一次');
  assert.equal(quick.currentQuickStatusKey(record), 'stage:interview_1');
  assert.equal(option(record, 'offer_accepted'), undefined, '没有待决定的 Offer 时不出现接受/拒绝');
});

test('changing status appends one event, continues forward progress in a stage, and attributes 挂掉 to the current stage', () => {
  let record = append(append(domain.createProgressRecord('b'), 'submitted', '2026-09-01'), 'written_test_waiting', '2026-09-05');
  const written = change(record, 'stage:written_test');
  assert.equal(written.kind, 'noop', '已经在笔试环节');
  const interview = change(record, 'stage:interview_1');
  assert.equal(interview.kind, 'append');
  assert.equal(interview.steps.length, 1);
  assert.equal(interview.steps[0].statusId, 'interview_1_active');
  assert.equal(interview.steps[0].mode, undefined);
  record = apply(record, interview);

  const failed = change(record, 'failed');
  assert.equal(failed.steps[0].statusId, 'interview_1_failed');
  assert.deepEqual(failed.steps[0].failedAt, { stageId: 'interview_1' });
  record = apply(record, failed);
  assert.equal(quick.currentQuickStatusKey(record), 'failed');
  assert.equal(change(record, 'stage:pool').kind, 'needs-reopen', '挂掉后恢复流程需要填写原因');

  const submittedOnly = append(domain.createProgressRecord('c'), 'submitted', '2026-09-01');
  const failedUnknown = change(submittedOnly, 'failed');
  assert.equal(failedUnknown.steps[0].statusId, 'failed_unknown');
  assert.equal(failedUnknown.steps[0].failedAt, 'unknown');
});

test('a draft asks before recording a submission, then records both in order', () => {
  const draft = domain.createProgressRecord('d');
  assert.equal(change(draft, 'stage:written_test').kind, 'needs-submission');
  const both = change(draft, 'stage:written_test', { withSubmission: true });
  assert.deepEqual(both.steps.map(step => step.statusId), ['submitted', 'written_test_active']);
  const record = apply(draft, both);
  assert.equal(record.appliedOn, '2026-09-21');
  assert.equal(change(draft, 'submitted').steps.length, 1, '直接选已投递不需要确认');
});

test('status tones follow offer.html colours and fall back to category colours', () => {
  assert.deepEqual(quick.quickStatusTone('failed', definitions), { color: '#dc2626', background: '#fef2f2' });
  const custom = structuredClone(definitions);
  custom.stages.push({ id: 'hr', name: 'HR 面', category: 'interview', sortOrder: 95, archivedAt: null, countsAsInterview: true });
  assert.equal(quick.quickStatusTone('stage:hr', custom).color, '#7c3aed');
});
