import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { acceptanceSnapshot, emptySnapshot } from '../dist/fixtures/acceptance.js';
import { calculateV2Analytics } from '../dist/domain/v2/analytics.js';
import { migrateV1Snapshot } from '../dist/domain/v2/migration.js';
import { createBackupCommands } from '../dist/repositories/v2/backup-commands.js';
import { createIndexedDbSnapshotStoreV2 } from '../dist/repositories/web/indexeddb-v2.js';

let invokeImpl;
mock.module('@tauri-apps/api/core', { exports: { invoke: (...args) => invokeImpl(...args) } });
const { createDesktopSnapshotStoreV2 } = await import('../dist/repositories/desktop/sqlite-v2.js');

const now = '2026-09-17T08:00:00.000Z';
const name = () => `m9-roundtrip-${Math.random()}`;

function makeSourceSnapshot() {
  const data = migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: now });
  data.workspace.name = 'M9 双端往返验收';
  data.settings.preferences = {
    theme: 'dark',
    density: 'compact',
    'board.columnWidths': JSON.stringify({ company: 260, status: 184 }),
  };
  data.schedules = [{
    id: 'schedule-m9-interview',
    applicationId: 'A',
    type: 'interview',
    title: '一面时间',
    startsAt: '2026-09-22T02:00:00.000Z',
    status: 'pending',
    notes: '从 Web 端导出的日程',
  }];
  return data;
}

function emptySnapshotV2() {
  return migrateV1Snapshot(emptySnapshot(), { migratedAt: now });
}

function keyStatistics(data) {
  const result = calculateV2Analytics(data, { seasonId: '2026-autumn' }, {
    now: '2026-09-17T12:00:00.000Z',
    timeZone: 'Asia/Shanghai',
  });
  return {
    recordCount: result.recordCount,
    submittedCount: result.submittedCount,
    activeCount: result.activeCount,
    humanInterviewCount: result.humanInterviewCount,
    aiInterviewCount: result.aiInterviewCount,
    offerCount: result.offerCount,
    failedCount: result.failedCount,
    interviewRate: result.interviewRate,
    offerRate: result.offerRate,
    stages: result.stages.map(({ stageId, touchCount, visitCount, rate }) => ({ stageId, touchCount, visitCount, rate })),
  };
}

function setupMockSqlite(initialData, revision = 0) {
  let current = { revision, data: structuredClone(initialData) };
  const recovery = [];
  const calls = [];
  invokeImpl = async (command, args = {}) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === 'read_snapshot_v2') return structuredClone(current);
    if (command === 'commit_snapshot_v2' || command === 'restore_snapshot_v2') {
      if (args.expectedRevision !== current.revision) throw new Error('CONFLICT: 数据已更新，请重新加载');
      if (command === 'restore_snapshot_v2') {
        recovery.push({ revision: current.revision, data: structuredClone(current.data) });
      }
      current = { revision: current.revision + 1, data: structuredClone(args.data) };
      return current.revision;
    }
    if (command === 'read_recovery_snapshots_v2') return recovery.map((item, index) => ({
      id: `restore-v2-${item.revision}`,
      sourceRevision: item.revision,
      sourceSchemaVersion: 2,
      data: structuredClone(item.data),
    }));
    throw new Error(`unexpected native command: ${command}`);
  };
  return {
    calls,
    recovery,
    read: () => structuredClone(current),
  };
}

test('M9 Web IndexedDB → SQLite/Tauri → Web IndexedDB 完整备份往返保留快照与统计', async () => {
  const factory = new FDBFactory();
  const web = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName: name(), migrationNow: () => now });
  const webCommands = createBackupCommands(web);
  const source = makeSourceSnapshot();
  assert.ok(source.seasons.length > 0);
  assert.ok(source.applications.length > 0);
  assert.ok(source.progressRecords.some(record => record.events.length > 0));
  assert.ok(source.schedules.length > 0);
  assert.ok(Object.keys(source.settings.preferences).length > 0);

  const initialWeb = await web.read();
  const sourceRevision = await web.commit(initialWeb.revision, source);
  const firstEnvelope = await webCommands.exportAll(now);
  const firstFileContents = JSON.stringify(firstEnvelope);

  const sqliteBackend = setupMockSqlite(emptySnapshotV2(), 10);
  const desktop = createDesktopSnapshotStoreV2({ migrationNow: () => now });
  const desktopCommands = createBackupCommands(desktop);
  const desktopBefore = await desktop.read();
  const firstPreview = desktopCommands.inspect(firstFileContents, now);
  assert.equal(firstPreview.sourceSchemaVersion, 2);
  assert.equal(firstPreview.seasonCount, source.seasons.length);
  assert.equal(firstPreview.applicationCount, source.applications.length);
  assert.equal(firstPreview.progressEventCount, source.progressRecords.reduce((sum, record) => sum + record.events.length, 0));
  assert.equal(firstPreview.scheduleCount, source.schedules.length);
  const firstRestore = await desktopCommands.restore(firstFileContents, desktopBefore.revision, now);
  assert.equal(firstRestore.revision, desktopBefore.revision + 1);
  const afterFirstRestore = await desktop.read();
  assert.deepEqual(afterFirstRestore.data, source);
  assert.deepEqual(keyStatistics(afterFirstRestore.data), keyStatistics(source));
  assert.equal(sqliteBackend.recovery.length, 1, 'SQLite restore must retain the displaced snapshot');

  // Add a B-side change so the return leg proves the second export is fresh and complete.
  const desktopChanged = structuredClone(afterFirstRestore.data);
  desktopChanged.settings.preferences['m9.returnTrip'] = 'saved-on-desktop';
  desktopChanged.schedules[0].status = 'completed';
  const desktopRevision = await desktop.commit(afterFirstRestore.revision, desktopChanged);
  const returnEnvelope = await desktopCommands.exportAll('2026-09-17T09:00:00.000Z');
  const returnFileContents = JSON.stringify(returnEnvelope);

  const webWithLocalChange = structuredClone((await web.read()).data);
  webWithLocalChange.settings.preferences['m9.localChange'] = true;
  const changedWebRevision = await web.commit(sourceRevision, webWithLocalChange);
  const returnPreview = webCommands.inspect(returnFileContents, now);
  assert.equal(returnPreview.applicationCount, desktopChanged.applications.length);
  const returnRestore = await webCommands.restore(returnFileContents, changedWebRevision, now);
  assert.equal(returnRestore.revision, changedWebRevision + 1);
  const afterReturnRestore = await web.read();
  assert.deepEqual(afterReturnRestore.data, desktopChanged);
  assert.deepEqual(keyStatistics(afterReturnRestore.data), keyStatistics(desktopChanged));
  assert.equal(afterReturnRestore.data.settings.preferences['m9.returnTrip'], 'saved-on-desktop');
  assert.equal(afterReturnRestore.data.schedules[0].status, 'completed');

  // Invalid files and stale CAS revisions must leave both adapters and recovery data untouched.
  const webBeforeFailures = await web.read();
  const webRecoveryBeforeFailures = await web.listRecoverySnapshots();
  await assert.rejects(webCommands.restore('{broken json', webBeforeFailures.revision, now), /JSON/);
  await assert.rejects(webCommands.restore(firstFileContents, webBeforeFailures.revision - 1, now), error => error.code === 'CONFLICT');
  assert.deepEqual(await web.read(), webBeforeFailures);
  assert.deepEqual(await web.listRecoverySnapshots(), webRecoveryBeforeFailures);

  const desktopBeforeFailures = await desktop.read();
  const desktopRecoveryCount = sqliteBackend.recovery.length;
  const restoreCallCount = sqliteBackend.calls.filter(call => call.command === 'restore_snapshot_v2').length;
  await assert.rejects(desktopCommands.restore('{broken json', desktopBeforeFailures.revision, now), /JSON/);
  await assert.rejects(desktopCommands.restore(firstFileContents, desktopBeforeFailures.revision - 1, now), error => error.code === 'CONFLICT');
  assert.deepEqual(await desktop.read(), desktopBeforeFailures);
  assert.equal(sqliteBackend.recovery.length, desktopRecoveryCount);
  assert.equal(sqliteBackend.calls.filter(call => call.command === 'restore_snapshot_v2').length, restoreCallCount + 1, 'stale CAS reaches native restore once; malformed backup never reaches it');
  assert.ok(desktopRevision > desktopBefore.revision);

  await web.close();
  await desktop.close();
});
