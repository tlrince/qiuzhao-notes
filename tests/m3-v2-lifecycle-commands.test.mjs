import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.M3_LIFECYCLE_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const { acceptanceSnapshot } = await moduleAt('fixtures/acceptance.js');
const { migrateV1Snapshot, validateV2Snapshot } = await moduleAt('domain/v2/index.js');
const { createMemorySnapshotStoreV2 } = await moduleAt('repositories/storage-v2-contract.js');
const { createApplicationCommands } = await moduleAt('repositories/v2/application-commands.js');
const { createScheduleCommands } = await moduleAt('repositories/v2/schedule-commands.js');

const date = '2026-09-17T00:00:00.000Z';
function trackedStore(seed) {
  const base = createMemorySnapshotStoreV2(seed);
  let restores = 0;
  return {
    base,
    get restores() { return restores; },
    read: () => base.read(),
    commit: (revision, value) => base.commit(revision, value),
    restore: (revision, value) => { restores += 1; return base.restore(revision, value); },
    close: () => base.close(),
  };
}

test('删除投递通过 CAS 原子级联清理进度、日程与旧历史，并保留其他投递和删除前快照', async () => {
  const seed = migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: date });
  seed.legacyHistory = seed.legacyHistory.filter(item => !['A', 'B'].includes(item.applicationId));
  seed.schedules.push(
    { id: 'schedule-A', applicationId: 'A', type: 'interview', title: '一面', startsAt: date, status: 'pending', notes: '' },
    { id: 'schedule-B', applicationId: 'B', type: 'follow_up', title: '跟进', startsAt: date, status: 'pending', notes: '' },
  );
  seed.legacyHistory.push(
    { applicationId: 'A', stageEvents: [], outcomeEvents: [], orderStatus: 'confirmed', uncertainEventIds: [] },
    { applicationId: 'B', stageEvents: [], outcomeEvents: [], orderStatus: 'needs_confirmation', uncertainEventIds: [] },
  );
  const store = trackedStore(seed);
  const commands = createApplicationCommands(store, { now: () => date });
  const before = await store.read();
  const removed = await commands.deleteApplication({ applicationId: 'A', expectedRevision: before.revision });
  const after = await store.read();

  assert.equal(removed.revision, before.revision + 1);
  assert.deepEqual(removed.value, { applicationId: 'A', removedScheduleCount: 1, removedLegacyHistoryCount: 1, removedProgressRecordCount: 1 });
  assert.ok(!after.data.applications.some(item => item.id === 'A'));
  assert.ok(!after.data.progressRecords.some(item => item.applicationId === 'A'));
  assert.deepEqual(after.data.schedules.map(item => item.id), ['schedule-B']);
  assert.deepEqual(after.data.legacyHistory.map(item => item.applicationId), ['C', 'D', 'E', 'F', 'B']);
  assert.ok(after.data.applications.some(item => item.id === 'B'));
  assert.ok(after.data.progressRecords.some(item => item.applicationId === 'B'));
  assert.equal(store.restores, 1);
  validateV2Snapshot(after.data);
  await assert.rejects(commands.deleteApplication({ applicationId: 'A', expectedRevision: after.revision }), error => error.code === 'NOT_FOUND');
  await assert.rejects(commands.deleteApplication({ applicationId: 'B', expectedRevision: before.revision }), error => error.code === 'CONFLICT');
  assert.deepEqual(await store.read(), after);
});

test('新建、编辑、完成、取消、恢复和删除日程都各自 CAS 提交，不自动推进投递状态', async () => {
  const seed = migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: date });
  const store = trackedStore(seed);
  let serial = 0;
  const commands = createScheduleCommands(store, { id: () => `schedule-${++serial}` });
  const before = await store.read();
  const created = await commands.createSchedule({ expectedRevision: before.revision, applicationId: 'A', type: 'interview', title: '一面', startsAt: '2026-09-20T02:00:00.000Z', notes: '线上会议' });
  assert.equal(created.value.status, 'pending');
  assert.equal(created.value.title, '一面');
  const afterCreate = await store.read();
  const edited = await commands.updateSchedule({ expectedRevision: afterCreate.revision, scheduleId: created.value.id, patch: { title: '技术一面', startsAt: '2026-09-21T02:30:00.000Z', notes: '更新入口' } });
  assert.equal(edited.value.title, '技术一面');
  assert.equal(edited.value.startsAt, '2026-09-21T02:30:00.000Z');
  assert.equal(edited.value.status, 'pending');

  const completed = await commands.setScheduleStatus({ expectedRevision: edited.revision, scheduleId: created.value.id, status: 'completed' });
  assert.equal(completed.value.status, 'completed');
  const cancelled = await commands.setScheduleStatus({ expectedRevision: completed.revision, scheduleId: created.value.id, status: 'cancelled' });
  assert.equal(cancelled.value.status, 'cancelled');
  const pending = await commands.setScheduleStatus({ expectedRevision: cancelled.revision, scheduleId: created.value.id, status: 'pending' });
  assert.equal(pending.value.status, 'pending');
  const beforeDelete = await store.read();
  const deleted = await commands.deleteSchedule({ expectedRevision: beforeDelete.revision, scheduleId: created.value.id });
  assert.deepEqual(deleted.value, { scheduleId: created.value.id, applicationId: 'A' });
  assert.ok(!(await store.read()).data.schedules.some(item => item.id === created.value.id));
  assert.equal(store.restores, 1);
  const final = await store.read();
  const application = final.data.applications.find(item => item.id === 'A');
  assert.equal(application.currentStatusId, 'draft');
  assert.equal(application.currentEventId, null);
  validateV2Snapshot(final.data);
});

test('日程校验和版本冲突失败时快照不变，不能跨投递伪造日程关联', async () => {
  const seed = migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: date });
  const store = trackedStore(seed);
  const commands = createScheduleCommands(store, { id: () => 'schedule-validation' });
  const before = await store.read();
  await assert.rejects(commands.createSchedule({ expectedRevision: before.revision, applicationId: 'missing', type: 'interview', title: '面试', startsAt: date, notes: '' }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.createSchedule({ expectedRevision: before.revision, applicationId: 'A', type: 'interview', title: '  ', startsAt: date, notes: '' }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.createSchedule({ expectedRevision: before.revision, applicationId: 'A', type: 'interview', title: '面试', startsAt: '2026-09-17T24:00:00Z', notes: '' }), error => error.code === 'VALIDATION');
  const valid = await commands.createSchedule({ expectedRevision: before.revision, applicationId: 'A', type: 'interview', title: '面试', startsAt: date, notes: '' });
  const fresh = await store.read();
  await assert.rejects(commands.updateSchedule({ expectedRevision: valid.revision, scheduleId: valid.value.id, patch: { applicationId: 'B' } }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.setScheduleStatus({ expectedRevision: valid.revision, scheduleId: valid.value.id, status: 'unknown' }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.deleteSchedule({ expectedRevision: before.revision, scheduleId: valid.value.id }), error => error.code === 'CONFLICT');
  assert.deepEqual(await store.read(), fresh);
});
