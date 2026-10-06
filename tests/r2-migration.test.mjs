import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot } from '../dist/fixtures/acceptance.js';
import { migrateV1Snapshot, projectProgress, validateV2Snapshot, assertV2Backup } from '../dist/domain/v2/index.js';

const instant = '2026-09-17T00:00:00.000Z';
function oldSnapshot({ stage = 'draft', outcome = 'active', stages = [], outcomes = [], appliedOn = null } = {}) {
  const data = emptySnapshot();
  data.seasons.push({ id: 's', name: '2026 秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 10, archivedAt: null });
  data.workspace.activeSeasonId = 's';
  data.applications.push({ id: 'job', seasonId: 's', company: '旧公司', role: '工程师', city: '上海', channelId: 'official', jobUrl: 'https://jobs.example/1', appliedOn, currentStage: stage, outcome, isStarred: false, notes: '', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z' });
  data.stageEvents.push(...stages.map(event => ({ applicationId: 'job', ...event })));
  data.outcomeEvents.push(...outcomes.map(event => ({ applicationId: 'job', ...event })));
  return data;
}
const stage = (id, value, occurredOn, createdAt, extra = {}) => ({ id, stage: value, occurredOn, createdAt, supersededAt: null, source: 'transition', ...extra });
const outcome = (id, value, occurredOn, createdAt, extra = {}) => ({ id, outcome: value, occurredOn, createdAt, supersededAt: null, ...extra });

test('R2 空 v1 快照迁移为空 v2，并可严格校验', () => {
  const empty = emptySnapshot();
  const migrated = migrateV1Snapshot(empty, { migratedAt: instant });
  validateV2Snapshot(migrated);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.settings.schemaVersion, 2);
  assert.deepEqual(migrated.applications, []);
  assert.equal(migrated.definitions.statuses.length > 0, true);
});

test('assessment 改为笔试但 phase 保持 unknown，三面及以上保留为待确认', () => {
  const migrated = migrateV1Snapshot(oldSnapshot({ stage: 'interview_3_plus', appliedOn: '2026-09-01', stages: [
    stage('submitted-id', 'submitted', '2026-09-01', '2026-09-17T00:00:00.000Z'),
    stage('assessment-id', 'assessment', '2026-09-02', '2026-08-01T00:00:00.000Z'),
    stage('rounds-id', 'interview_3_plus', '2026-09-03', '2026-08-02T00:00:00.000Z'),
  ] }), { migratedAt: instant });
  validateV2Snapshot(migrated);
  const events = migrated.progressRecords[0].events;
  assert.deepEqual(events.map(event => event.statusId), ['submitted', 'legacy_assessment_unknown', 'legacy_interview_3_plus_unknown']);
  assert.equal(events[1].semantics.stageId, 'written_test');
  assert.equal(events[1].phase, 'unknown');
  assert.equal(events[1].migrationMeta.legacyReached, true);
  assert.equal(events[2].semantics.stageId, 'legacy_interview_3_plus');
  assert.equal(migrated.definitions.stages.find(item => item.id === 'legacy_interview_3_plus').name, '三面及以上·待确认');
  assert.notEqual(events[2].semantics.stageId, 'interview_3');
  assert.notEqual(events[2].semantics.stageId, 'interview_4');
  const projected = projectProgress(migrated.progressRecords[0], migrated.definitions, '2026-09-17');
  assert.equal(projected.visits.find(item => item.stageId === 'legacy_interview_3_plus').countAsInterview, true);
  assert.equal(projected.visits.find(item => item.stageId === 'written_test').countAsInterview, false);
});

test('rejected 迁移为 failed/unknown，offer 与主动退出保持各自语义', () => {
  const make = result => migrateV1Snapshot(oldSnapshot({ stage: 'assessment', outcome: result, appliedOn: '2026-09-01', stages: [stage('submitted-id', 'submitted', '2026-09-01', instant), stage('assessment-id', 'assessment', '2026-09-02', instant)], outcomes: [outcome(`outcome-${result}`, result, '2026-09-03', instant)] }), { migratedAt: instant });
  const rejected = make('rejected');
  assert.equal(rejected.applications[0].outcome, 'failed');
  assert.equal(rejected.applications[0].failedAt, 'unknown');
  assert.equal(rejected.applications[0].currentStatusId, 'failed_unknown');
  assert.notEqual(rejected.applications[0].currentStatusId, 'offer_declined');
  const offer = make('offer');
  assert.equal(offer.applications[0].outcome, 'offer_received');
  assert.equal(offer.progressRecords[0].events.at(-1).occurredOn, '2026-09-03');
  const withdrawn = make('withdrawn');
  assert.equal(withdrawn.applications[0].outcome, 'withdrawn');
  assert.equal(withdrawn.applications[0].currentStatusId, 'withdrawn');
});

test('历史来源 ID、原始内容、失效信息和同日不确定连接均保留；不按 createdAt 排序', () => {
  const rawStage = stage('assessment-id', 'assessment', '2026-09-03', '2026-07-01T00:00:00.000Z', { source: 'correction' });
  const rawOutcome = outcome('reject-id', 'rejected', '2026-09-03', '2026-12-01T00:00:00.000Z');
  const data = oldSnapshot({ stage: 'assessment', outcome: 'rejected', appliedOn: '2026-09-01', stages: [
    stage('submitted-id', 'submitted', '2026-09-01', '2026-12-31T00:00:00.000Z'), rawStage,
  ], outcomes: [rawOutcome] });
  const migrated = migrateV1Snapshot(data, { migratedAt: instant });
  const record = migrated.progressRecords[0];
  assert.deepEqual(record.events.map(event => event.id), ['submitted-id', 'assessment-id', 'reject-id']);
  assert.equal(record.events[1].createdAt, rawStage.createdAt);
  assert.equal(record.events[1].migrationMeta.legacySource, 'correction');
  assert.deepEqual(record.events[1].migrationMeta.rawEvent, { ...rawStage, applicationId: 'job' });
  assert.equal(record.events[2].failedAt, 'unknown');
  assert.equal(record.migrationReview.status, 'needs_confirmation');
  assert.equal(record.migrationReview.uncertainEdges.some(edge => edge.fromEventId === 'assessment-id' && edge.toEventId === 'reject-id'), true);
  assert.equal(migrated.legacyHistory[0].outcomeEvents[0].id, 'reject-id');
  assert.equal(migrated.applications[0].jobUrl, 'https://jobs.example/1');
  assert.equal(migrated.applications[0].trackingUrl, '');
  const staleProjection = structuredClone(migrated); staleProjection.applications[0].currentEventId = 'assessment-id';
  assert.throws(() => validateV2Snapshot(staleProjection), /当前进度事件必须指向有效事件链尾/);
});

test('被纠正的旧事件标记失效且完整原始历史可追溯', () => {
  const retired = stage('assessment-old', 'assessment', '2026-09-02', '2026-09-03T00:00:00.000Z', { supersededAt: '2026-09-04T00:00:00.000Z', source: 'correction' });
  const migrated = migrateV1Snapshot(oldSnapshot({ stage: 'submitted', appliedOn: '2026-09-01', stages: [stage('submitted-id', 'submitted', '2026-09-01', instant), retired] }), { migratedAt: instant });
  const event = migrated.progressRecords[0].events.find(item => item.id === 'assessment-old');
  assert.equal(event.invalidatedAt, retired.supersededAt);
  assert.equal(event.migrationMeta.rawEvent.id, 'assessment-old');
  assert.equal(migrated.legacyHistory[0].stageEvents[1].supersededAt, retired.supersededAt);
});

test('v1 只写“恢复进行中”时不伪造 reopen，而是保留待确认续接并继续可校验', () => {
  const migrated = migrateV1Snapshot(oldSnapshot({ stage: 'submitted', outcome: 'active', appliedOn: '2026-09-01', stages: [stage('submitted-id', 'submitted', '2026-09-01', instant)], outcomes: [
    outcome('failed-id', 'rejected', '2026-09-02', instant),
    outcome('active-id', 'active', '2026-09-03', instant),
  ] }), { migratedAt: instant });
  validateV2Snapshot(migrated);
  const record = migrated.progressRecords[0];
  assert.deepEqual(record.events.map(event => event.source), ['entered', 'entered', 'entered']);
  assert.equal(record.events[2].reopenReason, null);
  assert.equal(record.events[2].migrationMeta.legacyContinuationOfEventId, 'failed-id');
  assert.equal(record.migrationReview.status, 'needs_confirmation');
  assert.match(record.migrationReview.uncertainEdges.find(edge => edge.fromEventId === 'failed-id').reason, /重新开启/);
  assert.equal(migrated.applications[0].outcome, 'active');
  assert.equal(migrated.applications[0].currentEventId, 'active-id');
});

test('与旧历史不一致或未知备份版本拒绝迁移，不生成部分 v2 快照', () => {
  const invalid = oldSnapshot({ stage: 'interview_1', appliedOn: '2026-09-01', stages: [stage('submitted-id', 'submitted', '2026-09-01', instant)] });
  assert.throws(() => migrateV1Snapshot(invalid, { migratedAt: instant }), /当前状态与旧历史不一致/);
  assert.throws(() => migrateV1Snapshot({ ...emptySnapshot(), settings: { ...emptySnapshot().settings, schemaVersion: 2 } }, { migratedAt: instant }), /只支持从 v1/);
  assert.throws(() => assertV2Backup({ format: 'autumn-applications', schemaVersion: 3, exportedAt: instant, data: {} }), /版本不受支持/);
});

test('currentStage 严格投影到事件语义环节，不能被不同上下文环节替代', () => {
  const data = migrateV1Snapshot(oldSnapshot({ stage: 'interview_2', appliedOn: '2026-09-01', stages: [
    stage('submitted-id', 'submitted', '2026-09-01', instant),
    stage('interview-2-id', 'interview_2', '2026-09-03', instant),
  ] }), { migratedAt: instant });
  const mismatched = structuredClone(data);
  const current = mismatched.progressRecords[0].events.at(-1);
  current.contextStageId = 'interview_1';
  mismatched.applications[0].currentStage = 'interview_1';
  assert.throws(() => validateV2Snapshot(mismatched), /当前状态与进度历史不一致/);
});
