import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.WORKSPACE_V2_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const { emptySnapshot } = await moduleAt('fixtures/acceptance.js');
const { migrateV1Snapshot } = await moduleAt('domain/v2/index.js');
const { createMemorySnapshotStoreV2 } = await moduleAt('repositories/storage-v2-contract.js');
const { createWorkspaceCommands } = await moduleAt('repositories/v2/workspace-commands.js');

const now = '2026-09-17T08:00:00.000Z';
function fixture() {
  const store = createMemorySnapshotStoreV2(migrateV1Snapshot(emptySnapshot(), { migratedAt: now }));
  let sequence = 0;
  const commands = createWorkspaceCommands(store, { now: () => now, id: () => `season-${++sequence}` });
  return { store, commands };
}

test('创建招聘季校验字段、原子保存并可设为当前季', async () => {
  const { store, commands } = fixture();
  const before = await store.read();
  const created = await commands.createSeason({ expectedRevision: before.revision, name: '  秋招  ', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 80 });
  assert.equal(created.revision, 1);
  assert.equal(created.value.name, '秋招');
  const state = await store.read();
  assert.equal(state.data.workspace.activeSeasonId, 'season-1');
  assert.equal(state.data.seasons[0].targetCount, 80);
});

test('无效区间、空名称和非正整数目标均回滚', async () => {
  const { store, commands } = fixture();
  const before = await store.read();
  for (const input of [
    { name: ' ', startDate: '2026-01-01', endDate: '2026-12-31', targetCount: 10 },
    { name: '春招', startDate: '2026-04-01', endDate: '2026-03-01', targetCount: 10 },
    { name: '春招', startDate: '2026-01-01', endDate: '2026-12-31', targetCount: 0 },
    { name: '春招', startDate: '2026-02-30', endDate: '2026-12-31', targetCount: 10 },
  ]) {
    await assert.rejects(commands.createSeason({ expectedRevision: before.revision, ...input }), error => error.code === 'VALIDATION');
  }
  assert.deepEqual(await store.read(), before);
});

test('切换招聘季、修改目标与归档会同步清理当前选择', async () => {
  const { store, commands } = fixture();
  let state = await store.read();
  const autumn = await commands.createSeason({ expectedRevision: state.revision, name: '秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 80 });
  state = await store.read();
  const spring = await commands.createSeason({ expectedRevision: state.revision, name: '春招', startDate: '2027-01-01', endDate: '2027-06-30', targetCount: 50, activate: false });
  state = await store.read();
  const switched = await commands.setActiveSeason({ expectedRevision: state.revision, seasonId: spring.value.id });
  assert.equal(switched.value.activeSeasonId, spring.value.id);
  state = await store.read();
  const updated = await commands.updateSeason({ expectedRevision: state.revision, seasonId: spring.value.id, patch: { name: '2027 春招', targetCount: 60 } });
  assert.equal(updated.value.name, '2027 春招');
  assert.equal(updated.value.targetCount, 60);
  state = await store.read();
  const archived = await commands.archiveSeason({ expectedRevision: state.revision, seasonId: spring.value.id });
  assert.equal(archived.value.archivedAt, now);
  assert.equal((await store.read()).data.workspace.activeSeasonId, null);
  assert.equal((await store.read()).data.seasons.find(item => item.id === autumn.value.id).archivedAt, null);
});

test('陈旧 revision、归档后设为当前与修改已归档季都被拒绝', async () => {
  const { store, commands } = fixture();
  const first = await store.read();
  const created = await commands.createSeason({ expectedRevision: first.revision, name: '秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 80 });
  await assert.rejects(commands.setActiveSeason({ expectedRevision: first.revision, seasonId: created.value.id }), error => error.code === 'CONFLICT');
  let state = await store.read();
  const archived = await commands.archiveSeason({ expectedRevision: state.revision, seasonId: created.value.id });
  state = await store.read();
  await assert.rejects(commands.setActiveSeason({ expectedRevision: state.revision, seasonId: archived.value.id }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.updateSeason({ expectedRevision: state.revision, seasonId: archived.value.id, patch: { targetCount: 120 } }), error => error.code === 'VALIDATION');
  assert.deepEqual(await store.read(), state);
});

test('工作空间偏好与招聘季配置共用快照 CAS，拒绝无效 key/value', async () => {
  const { store, commands } = fixture();
  const initial = await store.read();
  const saved = await commands.setPreference({ expectedRevision: initial.revision, key: 'progress-table.columns.v1', value: '{"stageOrder":["interview"],"hiddenStageIds":[]}' });
  assert.equal(saved.revision, initial.revision + 1);
  assert.equal((await store.read()).data.settings.preferences['progress-table.columns.v1'], saved.value);
  const current = await store.read();
  await assert.rejects(commands.setPreference({ expectedRevision: current.revision, key: '', value: 'x' }), error => error.code === 'VALIDATION');
  await assert.rejects(commands.setPreference({ expectedRevision: current.revision, key: 'bad-number', value: Number.NaN }), error => error.code === 'VALIDATION');
  assert.deepEqual(await store.read(), current);
});

test('归档的招聘季可以恢复；渠道可新增、改名、归档和恢复', async () => {
  const { store, commands } = fixture();
  let state = await store.read();
  const autumn = await commands.createSeason({ expectedRevision: state.revision, name: '秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 80 });
  state = await store.read();
  await commands.archiveSeason({ expectedRevision: state.revision, seasonId: autumn.value.id });
  state = await store.read();
  assert.equal(state.data.workspace.activeSeasonId, null);
  const restored = await commands.unarchiveSeason({ expectedRevision: state.revision, seasonId: autumn.value.id });
  assert.equal(restored.value.archivedAt, null);
  state = await store.read();
  assert.equal(state.data.workspace.activeSeasonId, autumn.value.id);

  const created = await commands.createChannel({ expectedRevision: state.revision, name: '  牛客  ' });
  assert.equal(created.value.name, '牛客');
  state = await store.read();
  await assert.rejects(commands.createChannel({ expectedRevision: state.revision, name: '牛客' }), /同名渠道/);
  const renamed = await commands.renameChannel({ expectedRevision: state.revision, channelId: created.value.id, name: '牛客网' });
  assert.equal(renamed.value.name, '牛客网');
  state = await store.read();
  await commands.archiveChannel({ expectedRevision: state.revision, channelId: created.value.id });
  state = await store.read();
  assert.equal(state.data.channels.find(item => item.id === created.value.id).archivedAt, now);
  await commands.unarchiveChannel({ expectedRevision: state.revision, channelId: created.value.id });
  state = await store.read();
  assert.equal(state.data.channels.find(item => item.id === created.value.id).archivedAt, null);
});
