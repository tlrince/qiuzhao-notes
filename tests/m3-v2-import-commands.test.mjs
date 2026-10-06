import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.M3_IMPORT_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const { acceptanceSnapshot, emptySnapshot } = await moduleAt('fixtures/acceptance.js');
const { migrateV1Snapshot, validateV2Snapshot } = await moduleAt('domain/v2/index.js');
const { parseRawApplicationsImport } = await moduleAt('domain/v2/raw-import.js');
const { createMemorySnapshotStoreV2 } = await moduleAt('repositories/storage-v2-contract.js');
const { createImportCommands } = await moduleAt('repositories/v2/import-commands.js');

const now = '2026-09-17T08:00:00.000Z';

function sourceRow(id, status = '已投递') {
  return {
    id, company: `公司 ${id}`, position: '后端工程师', location: '上海', channel: '官网',
    link: 'https://jobs.example/apply', applyDate: '2026-09-01', status,
    createdAt: '2026-09-01T09:00:00+08:00', updatedAt: '2026-09-03T10:00:00+08:00',
    statusUpdatedAt: '2026-09-03T10:00:00+08:00', note: `备注 ${id}`,
  };
}

function parseRows(snapshot, seasonId, rows, prefix = 'import') {
  return parseRawApplicationsImport(rows, {
    seasonId,
    channels: snapshot.channels,
    definitions: snapshot.definitions,
    applicationId: sourceId => `${prefix}-${sourceId}`,
  });
}

function fixture() {
  const source = acceptanceSnapshot();
  source.seasons.push({ id: '2025-spring', name: '2025 春招', startDate: '2025-01-01', endDate: '2025-06-30', targetCount: 40, archivedAt: null });
  const initial = migrateV1Snapshot(source, { migratedAt: now });
  const other = parseRows(initial, '2025-spring', [sourceRow('other-season')], 'old');
  assert.deepEqual(other.issues, []);
  initial.applications.push(other.applications[0].application);
  initial.progressRecords.push(other.applications[0].progress);
  initial.schedules.push({ id: 'schedule-other', applicationId: other.applications[0].application.id, type: 'interview', title: '保留的日程', startsAt: now, status: 'pending', notes: '' });
  initial.schedules.push({ id: 'schedule-target', applicationId: 'A', type: 'follow_up', title: '应清理的日程', startsAt: now, status: 'pending', notes: '' });
  initial.legacyHistory.push({ applicationId: 'A', stageEvents: [], outcomeEvents: [], orderStatus: 'needs_confirmation', uncertainEventIds: [] });
  validateV2Snapshot(initial);

  const inner = createMemorySnapshotStoreV2(initial);
  const recovery = [];
  const calls = [];
  const store = {
    read: () => inner.read(),
    commit: (revision, data) => inner.commit(revision, data),
    async restore(revision, data) {
      calls.push(['restore', revision]);
      recovery.push(await inner.read());
      return inner.restore(revision, data);
    },
    close: () => inner.close(),
  };
  return { store, recovery, calls, commands: createImportCommands(store) };
}

function imported(store, rows) {
  return store.read().then(snapshot => parseRows(snapshot.data, '2026-autumn', rows));
}

async function assertNoWrite(store, before, run) {
  await assert.rejects(run());
  assert.deepEqual(await store.read(), before);
}

test('按招聘季原子替换投递与历史，其他招聘季和全局数据保留并备份被替换快照', async () => {
  const { store, commands, recovery, calls } = fixture();
  const before = await store.read();
  const rows = await imported(store, [sourceRow('new-a', '筛选中'), sourceRow('new-draft', '待投递')]);
  assert.deepEqual(rows.issues, []);

  const result = await commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: rows.applications });
  assert.deepEqual(result, { revision: before.revision + 1, seasonId: '2026-autumn', removedApplicationCount: 6, importedApplicationCount: 2 });
  const after = await store.read();
  validateV2Snapshot(after.data);
  assert.deepEqual(after.data.applications.filter(item => item.seasonId === '2026-autumn').map(item => item.id), ['import-new-a', 'import-new-draft']);
  assert.deepEqual(after.data.applications.find(item => item.seasonId === '2025-spring'), before.data.applications.find(item => item.seasonId === '2025-spring'));
  assert.deepEqual(after.data.progressRecords.find(item => item.applicationId === 'old-other-season'), before.data.progressRecords.find(item => item.applicationId === 'old-other-season'));
  assert.deepEqual(after.data.schedules, [before.data.schedules.find(item => item.id === 'schedule-other')]);
  assert.equal(after.data.legacyHistory.some(item => item.applicationId === 'A'), false);
  assert.deepEqual(after.data.channels, before.data.channels);
  assert.deepEqual(after.data.definitions, before.data.definitions);
  assert.deepEqual(after.data.settings, before.data.settings);
  assert.deepEqual(recovery, [before]);
  assert.deepEqual(calls, [['restore', before.revision]]);
});

test('陈旧 revision 与其他招聘季的投递 ID 冲突均拒绝写入', async () => {
  const { store, commands, calls, recovery } = fixture();
  const before = await store.read();
  const rows = await imported(store, [sourceRow('new-a')]);
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision - 1, seasonId: '2026-autumn', applications: rows.applications }));

  const conflict = await imported(store, [sourceRow('conflict')]);
  conflict.applications[0].application.id = 'old-other-season';
  conflict.applications[0].progress.applicationId = 'old-other-season';
  for (const event of conflict.applications[0].progress.events) event.applicationId = 'old-other-season';
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: conflict.applications }));
  assert.deepEqual(calls, []);
  assert.deepEqual(recovery, []);
});

test('重复源 ID 与重复投递 ID 拒绝写入', async () => {
  const { store, commands } = fixture();
  const before = await store.read();
  const duplicateSources = await imported(store, [sourceRow('duplicate'), sourceRow('duplicate')]);
  assert.equal(duplicateSources.applications.length, 1);
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: [...duplicateSources.applications, duplicateSources.applications[0]] }));

  const twoRows = await imported(store, [sourceRow('first'), sourceRow('second')]);
  twoRows.applications[1].application.id = twoRows.applications[0].application.id;
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: twoRows.applications }));
});

test('目标招聘季不匹配、渠道不存在或完整进度校验失败时完全回滚', async () => {
  const { store, commands } = fixture();
  const before = await store.read();
  const wrongSeason = await store.read().then(snapshot => parseRows(snapshot.data, '2025-spring', [sourceRow('wrong-season')]));
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: wrongSeason.applications }));

  const missingChannel = await imported(store, [sourceRow('missing-channel')]);
  missingChannel.applications[0].application.channelId = 'not-a-channel';
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: missingChannel.applications }));

  const malformedProgress = await imported(store, [sourceRow('bad-progress')]);
  malformedProgress.applications[0].progress.events = [];
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: malformedProgress.applications }));
});

test('缺少 source 记录、空导入与已归档目标招聘季均拒绝替换', async () => {
  const { store, commands } = fixture();
  const before = await store.read();
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: [] }));
  const incomplete = await imported(store, [sourceRow('incomplete')]);
  incomplete.applications[0].sourceRecord.status = '错误状态';
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: '2026-autumn', applications: incomplete.applications }));
  await assertNoWrite(store, before, () => commands.replaceSeasonApplications({ expectedRevision: before.revision, seasonId: 'missing-season', applications: incomplete.applications }));

  const archived = structuredClone(before.data);
  archived.seasons.find(item => item.id === '2026-autumn').archivedAt = now;
  await store.commit(before.revision, archived);
  const archivedState = await store.read();
  await assertNoWrite(store, archivedState, () => commands.replaceSeasonApplications({ expectedRevision: archivedState.revision, seasonId: '2026-autumn', applications: incomplete.applications }));
});

test('重复渠道 ID 造成映射歧义时拒绝写入', async () => {
  const { store, commands } = fixture();
  const before = await store.read();
  const invalid = structuredClone(before.data);
  invalid.channels.push({ ...invalid.channels.find(item => item.id === 'official'), name: '重复官网' });
  await store.commit(before.revision, invalid);
  const ambiguous = await store.read();
  const rows = await imported(store, [sourceRow('ambiguous-channel')]);
  await assertNoWrite(store, ambiguous, () => commands.replaceSeasonApplications({ expectedRevision: ambiguous.revision, seasonId: '2026-autumn', applications: rows.applications }));
});
