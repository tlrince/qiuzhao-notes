import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.M3_V2_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const { acceptanceSnapshot } = await moduleAt('fixtures/acceptance.js');
const { migrateV1Snapshot, validateV2Snapshot } = await moduleAt('domain/v2/index.js');
const { createMemorySnapshotStoreV2 } = await moduleAt('repositories/storage-v2-contract.js');
const { createApplicationCommands } = await moduleAt('repositories/v2/application-commands.js');

const migrationTime = '2026-09-17T00:00:00.000Z';
const applicationId = 'A';

function makeCommands(overrides = {}) {
  const initial = migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: migrationTime });
  const store = createMemorySnapshotStoreV2(initial);
  let tick = 1;
  let serial = 0;
  const commands = createApplicationCommands(store, {
    now: overrides.now ?? (() => `2026-09-17T00:00:${String(tick++).padStart(2, '0')}.000Z`),
    id: overrides.id ?? (() => `m3-${++serial}`),
  });
  return { store, commands };
}

const newApplicationInput = {
  seasonId: '2026-autumn',
  company: '  新公司  ',
  role: '  客户端工程师  ',
  city: '上海',
  channelId: 'official',
  jobUrl: 'https://jobs.example/new-role',
  trackingUrl: 'https://portal.example/new-application',
  isStarred: true,
  notes: '准备投递',
};

async function appState(store) {
  const stored = await store.read();
  return {
    ...stored,
    application: stored.data.applications.find(item => item.id === applicationId),
    progress: stored.data.progressRecords.find(item => item.applicationId === applicationId),
  };
}

test('创建投递事务写入空 draft 与进度记录，不生成已投递事件', async () => {
  const { store, commands } = makeCommands();
  const before = await store.read();
  const created = await commands.createApplication({ expectedRevision: before.revision, ...newApplicationInput });
  assert.equal(created.revision, before.revision + 1);
  assert.equal(created.value.id, 'm3-1');
  assert.equal(created.value.company, '新公司');
  assert.equal(created.value.role, '客户端工程师');
  assert.equal(created.value.jobUrl, newApplicationInput.jobUrl);
  assert.equal(created.value.trackingUrl, newApplicationInput.trackingUrl);
  assert.equal(created.value.currentStatusId, 'draft');
  assert.equal(created.value.currentEventId, null);
  assert.equal(created.value.currentStage, null);
  assert.equal(created.value.phase, 'unknown');
  assert.equal(created.value.outcome, 'active');
  assert.equal(created.value.appliedOn, null);
  const after = await store.read();
  const progress = after.data.progressRecords.find(record => record.applicationId === created.value.id);
  assert.deepEqual(progress, { applicationId: created.value.id, appliedOn: null, events: [], annotations: [] });
  validateV2Snapshot(after.data);
});

test('创建校验失败与应用 ID 冲突不写入任何数据', async () => {
  const { store, commands } = makeCommands();
  const before = await store.read();
  await assert.rejects(commands.createApplication({ expectedRevision: before.revision, ...newApplicationInput, company: ' ' }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.createApplication({ expectedRevision: before.revision, ...newApplicationInput, role: '' }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.createApplication({ expectedRevision: before.revision, ...newApplicationInput, seasonId: 'missing-season' }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.createApplication({ expectedRevision: before.revision, ...newApplicationInput, trackingUrl: 'javascript:alert(1)' }), error => error.code === 'VALIDATION');
  assert.deepEqual(await store.read(), before);

  const conflicting = createApplicationCommands(store, { now: () => migrationTime, id: () => 'A' });
  await assert.rejects(conflicting.createApplication({ expectedRevision: before.revision, ...newApplicationInput }), error => error.code === 'CONFLICT');
  assert.deepEqual(await store.read(), before);
});

test('M3 v2 基础字段和 trackingUrl 独立更新，并通过 CAS 提交完整快照', async () => {
  const { store, commands } = makeCommands();
  const before = await appState(store);
  const result = await commands.updateFields({
    applicationId,
    expectedRevision: before.revision,
    patch: { company: '更新后的公司', jobUrl: 'https://jobs.example/role', trackingUrl: 'https://portal.example/application' },
  });

  assert.equal(result.revision, before.revision + 1);
  assert.equal(result.value.company, '更新后的公司');
  assert.equal(result.value.jobUrl, 'https://jobs.example/role');
  assert.equal(result.value.trackingUrl, 'https://portal.example/application');
  assert.equal(result.value.createdAt, before.application.createdAt);
  assert.equal(result.value.updatedAt, '2026-09-17T00:00:01.000Z');
  const trackingOnly = await commands.updateFields({
    applicationId,
    expectedRevision: result.revision,
    patch: { trackingUrl: 'https://portal.example/second' },
  });
  assert.equal(trackingOnly.value.trackingUrl, 'https://portal.example/second');
  assert.equal(trackingOnly.value.jobUrl, 'https://jobs.example/role');
  validateV2Snapshot((await store.read()).data);
});

test('追加状态事件同步 current 投影与 appliedOn，重复 command 幂等且不重排 createdAt', async () => {
  const { store, commands } = makeCommands();
  let state = await appState(store);
  const submitted = await commands.appendProgress({
    applicationId,
    expectedRevision: state.revision,
    command: { commandId: 'submit-a', statusId: 'submitted', occurredOn: '2026-09-01' },
  });
  assert.equal(submitted.value.application.appliedOn, '2026-09-01');
  assert.equal(submitted.value.application.currentEventId, submitted.value.event.id);
  assert.equal(submitted.value.progress.appliedOn, '2026-09-01');
  assert.equal(submitted.value.application.currentStatusId, 'submitted');

  state = await appState(store);
  const interview = await commands.appendProgress({
    applicationId,
    expectedRevision: state.revision,
    command: { commandId: 'interview-a', statusId: 'interview_1_active', occurredOn: '2026-09-02' },
  });
  assert.equal(interview.value.application.currentStatusId, 'interview_1_active');
  assert.equal(interview.value.application.currentStage, 'interview_1');
  assert.equal(interview.value.application.phase, 'in_progress');
  assert.equal(interview.value.application.outcome, 'active');
  assert.equal(interview.value.application.currentEventId, interview.value.event.id);
  assert.equal(interview.value.progress.events[0].createdAt, submitted.value.event.createdAt);

  const beforeRetry = await store.read();
  const retry = await commands.appendProgress({
    applicationId,
    expectedRevision: interview.revision,
    command: { commandId: 'interview-a', statusId: 'interview_1_active', occurredOn: '2026-09-02' },
  });
  assert.equal(retry.value.duplicate, true);
  assert.equal(retry.value.event.id, interview.value.event.id);
  assert.equal(retry.revision, interview.revision);
  assert.equal(retry.value.progress.events.filter(event => event.invalidatedAt === null).length, 2);
  assert.equal(retry.value.application.updatedAt, interview.value.application.updatedAt);
  assert.deepEqual(await store.read(), beforeRetry);
  validateV2Snapshot((await store.read()).data);
});

test('纠正与作废原子重算链尾、失败归因和有效事件序号', async () => {
  const { store, commands } = makeCommands();
  let state = await appState(store);
  const submitted = await commands.appendProgress({ applicationId, expectedRevision: state.revision, command: {
    commandId: 'submit', statusId: 'submitted', occurredOn: '2026-09-01',
  } });
  state = await appState(store);
  const failed = await commands.appendProgress({ applicationId, expectedRevision: state.revision, command: {
    commandId: 'failed', statusId: 'interview_1_failed', occurredOn: '2026-09-02', failedAt: { stageId: 'interview_1' },
  } });
  assert.equal(failed.value.application.outcome, 'failed');
  assert.deepEqual(failed.value.application.failedAt, { stageId: 'interview_1', stageNameSnapshot: '一面' });

  const originalCreatedAt = failed.value.event.createdAt;
  const corrected = await commands.correctProgress({ applicationId, expectedRevision: failed.revision, eventId: failed.value.event.id, command: {
    commandId: 'correct-failed', statusId: 'interview_1_active', occurredOn: '2026-09-02', notes: '更正为仍在面试',
  } });
  assert.equal(corrected.value.progress.events.find(event => event.id === failed.value.event.id).invalidatedAt, '2026-09-17T00:00:03.000Z');
  assert.equal(corrected.value.event.correctionOfEventId, failed.value.event.id);
  assert.notEqual(corrected.value.event.createdAt, originalCreatedAt);
  assert.equal(corrected.value.application.currentEventId, corrected.value.event.id);
  assert.equal(corrected.value.application.outcome, 'active');
  assert.equal(corrected.value.application.failedAt, null);
  assert.deepEqual(corrected.value.progress.events.filter(event => event.invalidatedAt === null).map(event => event.sequence), [1, 2]);

  const invalidated = await commands.invalidateProgress({ applicationId, expectedRevision: corrected.revision, eventId: corrected.value.event.id });
  assert.equal(invalidated.value.application.currentEventId, submitted.value.event.id);
  assert.equal(invalidated.value.application.currentStatusId, 'submitted');
  assert.equal(invalidated.value.application.currentStage, null);
  assert.equal(invalidated.value.application.phase, 'unknown');
  assert.equal(invalidated.value.application.appliedOn, '2026-09-01');
  assert.equal(invalidated.value.progress.events.filter(event => event.invalidatedAt === null).at(-1).id, submitted.value.event.id);
  validateV2Snapshot((await store.read()).data);
});

test('校验失败、陈旧 revision 和并发写入均不产生部分更新', async () => {
  const { store, commands } = makeCommands();
  const before = await appState(store);
  await assert.rejects(commands.updateFields({ applicationId, expectedRevision: before.revision, patch: { trackingUrl: 'not a URL' } }));
  await assert.rejects(commands.updateFields({ applicationId, expectedRevision: before.revision, patch: { company: '   ' } }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.updateFields({ applicationId, expectedRevision: before.revision, patch: { role: '' } }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.updateFields({ applicationId, expectedRevision: before.revision, patch: { jobUrl: 'javascript:alert(1)' } }), error => error.code === 'VALIDATION');
  assert.deepEqual(await appState(store), before);

  await assert.rejects(commands.appendProgress({ applicationId, expectedRevision: before.revision, command: {
    commandId: 'bad-state', statusId: 'missing-status', occurredOn: '2026-09-01',
  } }), error => error.code === 'NOT_FOUND');
  assert.deepEqual(await appState(store), before);

  const committed = await commands.updateFields({ applicationId, expectedRevision: before.revision, patch: { notes: 'first writer' } });
  await assert.rejects(commands.updateFields({ applicationId, expectedRevision: before.revision, patch: { notes: 'stale writer' } }), error => error.code === 'CONFLICT');
  assert.equal((await appState(store)).application.notes, 'first writer');
  assert.equal(committed.revision, before.revision + 1);

  const current = await appState(store);
  const race = await Promise.allSettled([
    commands.updateFields({ applicationId, expectedRevision: current.revision, patch: { company: 'writer one' } }),
    commands.updateFields({ applicationId, expectedRevision: current.revision, patch: { company: 'writer two' } }),
  ]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.filter(result => result.status === 'rejected' && result.reason.code === 'CONFLICT').length, 1);
  assert.equal((await appState(store)).revision, current.revision + 1);
});
