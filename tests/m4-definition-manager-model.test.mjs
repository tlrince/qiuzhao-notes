import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderedStages,
  orderedStatuses,
  stageDraftFrom,
  stageDraftToPatch,
  stageDraftToValues,
  statusDraftFrom,
  statusDraftToPatch,
  statusDraftToValues,
} from '../src/features/settings/definition-manager-model.ts';

const stage = (id, name, category, sortOrder, extra = {}) => ({
  id, name, category, sortOrder, archivedAt: null, countsAsInterview: false, ...extra,
});

const status = (id, name, sortOrder, extra = {}) => ({
  id,
  name,
  color: '#76835f',
  sortOrder,
  version: 1,
  archivedAt: null,
  semantic: 'custom',
  stageId: null,
  defaultPhase: 'unknown',
  statisticsCategory: null,
  semanticsHistory: [{ version: 1, semantic: 'custom', stageId: null, stageCategory: null, defaultPhase: 'unknown', statisticsCategory: null, countsAsInterview: false }],
  ...extra,
});

const definitions = () => ({
  stages: [stage('stage-interview', '一面', 'interview', 20, { countsAsInterview: true, interviewRound: 1 }), stage('stage-screen', '简历筛选', 'screening', 10)],
  statuses: [status('status-b', '自定义 B', 20), status('status-a', '自定义 A', 10)],
});

test('orders stage/status definitions by numeric sort value with stable name/id tie breaks', () => {
  const data = definitions();
  data.stages.push(stage('stage-screen-2', '初筛', 'screening', 10));
  data.statuses.push(status('status-c', '自定义 A', 10));
  assert.deepEqual(orderedStages(data).map(item => item.id), ['stage-screen-2', 'stage-screen', 'stage-interview']);
  assert.deepEqual(orderedStatuses(data).map(item => item.id), ['status-a', 'status-c', 'status-b']);
});

test('creates a custom stage form value and validates whole-number order/round', () => {
  const draft = { ...stageDraftFrom(), name: '  用户沟通  ', category: 'interview', sortOrder: '35', countsAsInterview: true, interviewRound: '5' };
  assert.deepEqual(stageDraftToValues(draft), {
    ok: true,
    value: { name: '用户沟通', category: 'interview', sortOrder: 35, countsAsInterview: true, interviewRound: 5 },
  });
  assert.equal(stageDraftToValues({ ...draft, sortOrder: '2.5' }).ok, false);
  assert.equal(stageDraftToValues({ ...draft, interviewRound: '-1' }).ok, false);
});

test('stage patch maps editable fields and preserves an existing optional round if the field is blank', () => {
  const current = definitions().stages[0];
  const draft = { ...stageDraftFrom(current), name: '二面', sortOrder: '30', interviewRound: '' };
  assert.deepEqual(stageDraftToPatch(draft, current), {
    ok: true,
    value: { name: '二面', category: 'interview', sortOrder: 30, countsAsInterview: true, interviewRound: 1 },
  });
});

test('permits a custom status with no stage and null statistics category', () => {
  const result = statusDraftToValues({ ...statusDraftFrom(), name: '自定义沟通', semantic: 'custom', stageId: '', defaultPhase: 'unknown', statisticsCategory: '   ' }, definitions());
  assert.deepEqual(result, {
    ok: true,
    value: { name: '自定义沟通', color: '#76835f', sortOrder: 0, semantic: 'custom', stageId: null, defaultPhase: 'unknown', statisticsCategory: null },
  });
});

test('maps status semantics, phase, stage and free-form statistics category into an update patch', () => {
  const draft = {
    ...statusDraftFrom(), name: '待二面', color: '#AABBCC', sortOrder: '16', semantic: 'stage',
    stageId: 'stage-interview', defaultPhase: 'waiting', statisticsCategory: '  人工面试  ',
  };
  const result = statusDraftToPatch(draft, definitions());
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    name: '待二面', color: '#aabbcc', sortOrder: 16, semantic: 'stage', stageId: 'stage-interview',
    defaultPhase: 'waiting', statisticsCategory: '人工面试',
  });
});

test('rejects status definitions that violate semantic-to-stage and phase relationships', () => {
  const base = statusDraftFrom();
  const data = definitions();
  assert.match(statusDraftToValues({ ...base, name: '筛选', semantic: 'screening', stageId: 'stage-interview' }, data).error, /筛选类环节/);
  assert.match(statusDraftToValues({ ...base, name: '拿 Offer', semantic: 'offer_received', stageId: 'stage-screen' }, data).error, /Offer 类环节/);
  assert.match(statusDraftToValues({ ...base, name: '普通阶段', semantic: 'stage', stageId: '' }, data).error, /必须关联环节/);
  assert.match(statusDraftToValues({ ...base, name: '自定义', semantic: 'custom', stageId: '', defaultPhase: 'waiting' }, data).error, /未关联环节/);
  assert.match(statusDraftToValues({ ...base, name: '自定义', color: 'red' }, data).error, /六位十六进制/);
});

