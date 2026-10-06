import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { acceptanceSnapshot, emptySnapshot } from '../dist/fixtures/acceptance.js';
import { DomainError } from '../dist/domain/errors.js';
import { migrateV1Snapshot } from '../dist/domain/v2/migration.js';
import { createBackupCommands, createBackupEnvelope, parseBackup } from '../dist/repositories/v2/backup-commands.js';
import { createMemorySnapshotStoreV2 } from '../dist/repositories/storage-v2-contract.js';
import { createIndexedDbSnapshotStoreV2 } from '../dist/repositories/web/indexeddb-v2.js';

let invokeImpl;
mock.module('@tauri-apps/api/core', { exports: { invoke: (...args) => invokeImpl(...args) } });
const { createDesktopSnapshotStoreV2 } = await import('../dist/repositories/desktop/sqlite-v2.js');

const now = '2026-09-17T02:00:00.000Z';
const name = () => `m8-${Math.random()}`;
const v2Acceptance = () => migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: now });

function makeStore(initial = v2Acceptance()) {
  let current = { revision: 4, data: structuredClone(initial) };
  const recovery = [];
  const calls = [];
  return {
    calls,
    recovery,
    async read() { return structuredClone(current); },
    async commit(expectedRevision, nextData) {
      calls.push(['commit', expectedRevision]);
      if (expectedRevision !== current.revision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      current = { revision: current.revision + 1, data: structuredClone(nextData) };
      return current.revision;
    },
    async restore(expectedRevision, nextData) {
      calls.push(['restore', expectedRevision]);
      if (expectedRevision !== current.revision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      recovery.push(structuredClone(current));
      current = { revision: current.revision + 1, data: structuredClone(nextData) };
      return current.revision;
    },
    async close() {},
  };
}

test('M8 导出完整 v2 快照且导出时间由调用者提供，不改 lastBackupAt', async () => {
  const data = v2Acceptance();
  data.settings.lastBackupAt = '2026-09-16T12:00:00.000Z';
  const store = createMemorySnapshotStoreV2(data);
  const backup = await createBackupCommands(store).exportAll(now);
  assert.equal(backup.format, 'autumn-applications');
  assert.equal(backup.schemaVersion, 2);
  assert.equal(backup.exportedAt, now);
  assert.equal(backup.data.applications.length, data.applications.length);
  assert.equal(backup.data.progressRecords.length, data.progressRecords.length);
  assert.deepEqual(backup.data, data);
  assert.equal((await store.read()).data.settings.lastBackupAt, data.settings.lastBackupAt);
  await store.close();
});

test('M8 v1/v2 预览均校验完整备份，v1 经无损迁移保留历史并显示来源版本', () => {
  const v1 = { format: 'autumn-applications', schemaVersion: 1, exportedAt: now, data: acceptanceSnapshot() };
  const parsedV1 = parseBackup(JSON.stringify(v1), now);
  assert.equal(parsedV1.sourceSchemaVersion, 1);
  assert.equal(parsedV1.seasonCount, v1.data.seasons.length);
  assert.equal(parsedV1.applicationCount, v1.data.applications.length);
  assert.equal(parsedV1.data.schemaVersion, 2);
  assert.equal(parsedV1.data.applications.length, v1.data.applications.length);
  assert.equal(parsedV1.data.legacyHistory.length, v1.data.applications.length);
  assert.equal(parsedV1.data.applications.find(item => item.id === 'C').outcome, 'failed');

  const v2 = createBackupEnvelope(parsedV1.data, now);
  assert.equal(parseBackup(v2, now).sourceSchemaVersion, 2);
  assert.equal(parseBackup(v2, now).applicationCount, v1.data.applications.length);
});

test('M8 拒绝未知格式/版本、版本不匹配、坏 JSON 和违反领域关联的快照', () => {
  const valid = createBackupEnvelope(v2Acceptance(), now);
  const cases = [
    ['not-json', /JSON/],
    [{ ...valid, format: 'other' }, /格式/],
    [{ ...valid, schemaVersion: 3 }, /版本/],
    [{ ...valid, schemaVersion: 1 }, /版本/],
    [{ ...valid, data: { ...valid.data, applications: [{ ...valid.data.applications[0], seasonId: 'missing' }] } }, /招聘季/],
  ];
  for (const [value, message] of cases) assert.throws(() => parseBackup(value, now), message);
});

test('M8 restore 校验成功后只调用受保护 restore CAS 原语，不调用普通 commit', async () => {
  const store = makeStore();
  const before = await store.read();
  const backup = createBackupEnvelope(emptySnapshotV2(), now);
  const result = await createBackupCommands(store).restore(backup, before.revision, now);
  assert.equal(result.revision, 5);
  assert.deepEqual(result.preview, { sourceSchemaVersion: 2, exportedAt: now, workspaceName: '秋招工作空间', seasonNames: [], seasonCount: 0, applicationCount: 0, progressEventCount: 0, scheduleCount: 0 });
  assert.deepEqual(store.calls, [['restore', 4]]);
  assert.deepEqual(store.recovery[0], before);
  assert.deepEqual((await store.read()).data, backup.data);
});

test('M8 格式或快照校验失败、CAS 冲突时不改当前快照', async () => {
  const store = makeStore();
  const commands = createBackupCommands(store);
  const before = await store.read();
  const malformed = createBackupEnvelope(v2Acceptance(), now);
  malformed.data.applications[0].seasonId = 'missing-season';
  assert.throws(() => commands.inspect(malformed, now), /招聘季/);
  await assert.rejects(commands.restore(malformed, before.revision, now), /招聘季/);
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(store.calls, []);

  const valid = createBackupEnvelope(emptySnapshotV2(), now);
  await assert.rejects(commands.restore(valid, before.revision - 1, now), error => error.code === 'CONFLICT');
  assert.deepEqual(await store.read(), before);
  assert.deepEqual(store.recovery, []);
  assert.deepEqual(store.calls, [['restore', 3]]);
});

test('M8 IndexedDB restore 在一个 readwrite 事务内保留被替换快照并执行 CAS', async () => {
  const factory = new FDBFactory();
  const dbName = name();
  const store = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName });
  const initial = await store.read();
  const target = v2Acceptance();
  const rev1 = await store.restore(initial.revision, target);
  const changed = structuredClone((await store.read()).data);
  changed.workspace.name = '恢复前快照';
  const rev2 = await store.commit(rev1, changed);

  const commands = createBackupCommands(store);
  const backup = createBackupEnvelope(target, now);
  const restored = await commands.restore(backup, rev2, now);
  assert.equal(restored.revision, rev2 + 1);
  assert.deepEqual((await store.read()).data, target);
  const recovery = await readRecovery(factory, dbName, `restore-v2-${rev2}`);
  assert.equal(recovery.schemaVersion, 2);
  assert.equal(recovery.revision, rev2);
  assert.equal(recovery.data.workspace.name, '恢复前快照');

  const afterRestore = await store.read();
  await assert.rejects(commands.restore(backup, rev2, now), error => error.code === 'CONFLICT');
  assert.deepEqual(await store.read(), afterRestore);
  assert.equal(await readRecovery(factory, dbName, `restore-v2-${afterRestore.revision}`), undefined);
  const invalid = structuredClone(afterRestore.data);
  invalid.applications[0].seasonId = 'missing-season';
  await assert.rejects(store.restore(afterRestore.revision, invalid));
  assert.deepEqual(await store.read(), afterRestore);
  assert.equal(await readRecovery(factory, dbName, `restore-v2-${afterRestore.revision}`), undefined);
  await store.close();
});

test('M8 SQLite adapter 走独立原生 restore 命令并透传 expectedRevision', async () => {
  let calls = [];
  invokeImpl = async (command, args) => {
    calls.push({ command, args });
    return args.expectedRevision + 1;
  };
  const store = createDesktopSnapshotStoreV2();
  const data = v2Acceptance();
  assert.equal(await store.restore(12, data), 13);
  assert.deepEqual(calls, [{ command: 'restore_snapshot_v2', args: { expectedRevision: 12, data } }]);
  await store.close();
});

test('M8 用户可列出并按 ID 原子回滚恢复副本，回滚前快照也会成为新副本', async () => {
  const original = emptySnapshotV2();
  original.workspace.name = '最初快照';
  const store = createMemorySnapshotStoreV2(original);
  const commands = createBackupCommands(store);

  let state = await store.read();
  const imported = structuredClone(state.data);
  imported.workspace.name = '整体替换后的快照';
  const importedRevision = await store.restore(state.revision, imported);
  let copies = await commands.listRecoverySnapshots();
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0], {
    id: 'restore-v2-0', sourceRevision: 0, sourceSchemaVersion: 2,
    workspaceName: '最初快照', seasonNames: [], seasonCount: 0, applicationCount: 0,
    estimatedJsonBytes: Buffer.byteLength(JSON.stringify(original), 'utf8'),
  });

  const ordinaryEdit = structuredClone((await store.read()).data);
  ordinaryEdit.workspace.name = '普通保存后的快照';
  const editedRevision = await store.commit(importedRevision, ordinaryEdit);
  assert.equal((await commands.listRecoverySnapshots())[0].workspaceName, '最初快照');

  const rollback = await commands.restoreRecoverySnapshot(copies[0].id, editedRevision);
  assert.equal(rollback.revision, editedRevision + 1);
  assert.equal(rollback.recovery.workspaceName, '最初快照');
  assert.equal((await store.read()).data.workspace.name, '最初快照');
  copies = await commands.listRecoverySnapshots();
  assert.deepEqual(copies.map(item => item.id), ['restore-v2-2', 'restore-v2-0']);
  assert.equal(copies[0].workspaceName, '普通保存后的快照');
  assert.equal(copies[1].workspaceName, '最初快照');

  const beforeConflict = await store.read();
  await assert.rejects(commands.restoreRecoverySnapshot('restore-v2-2', editedRevision), error => error.code === 'CONFLICT');
  assert.deepEqual(await store.read(), beforeConflict);
  assert.deepEqual(await commands.listRecoverySnapshots(), copies);
  await store.close();
});

test('M8 内存存储只在显式 revision-CAS 删除时移除指定副本', async () => {
  const original = emptySnapshotV2();
  const store = createMemorySnapshotStoreV2(original);
  const commands = createBackupCommands(store);
  const first = structuredClone(original); first.workspace.name = '第一份替换';
  await store.restore(0, first);
  const second = structuredClone(first); second.workspace.name = '第二份替换';
  await store.restore(1, second);
  const ordinary = structuredClone(second); ordinary.workspace.name = '普通提交';
  await store.commit(2, ordinary);
  let copies = await commands.listRecoverySnapshots();
  assert.deepEqual(copies.map(copy => copy.id), ['restore-v2-1', 'restore-v2-0']);

  const deletion = await commands.deleteRecoverySnapshot('restore-v2-0', 3);
  assert.equal(deletion.revision, 4);
  assert.equal(deletion.recovery.workspaceName, '秋招工作空间');
  assert.deepEqual((await store.read()).data, ordinary);
  copies = await commands.listRecoverySnapshots();
  assert.deepEqual(copies.map(copy => copy.id), ['restore-v2-1']);
  await assert.rejects(commands.deleteRecoverySnapshot('restore-v2-1', 3), error => error.code === 'CONFLICT');
  assert.deepEqual((await commands.listRecoverySnapshots()).map(copy => copy.id), ['restore-v2-1']);
  const last = await commands.deleteRecoverySnapshot('restore-v2-1', 4);
  assert.equal(last.revision, 5);
  assert.deepEqual(await commands.listRecoverySnapshots(), []);
  await assert.rejects(commands.deleteRecoverySnapshot('restore-v2-1', 5), error => error.code === 'NOT_FOUND');
  assert.equal((await store.read()).revision, 5);
  await store.close();
});

test('M8 副本容量按保存数据的 JSON UTF-8 字节估算，含中文的合计会随删除更新', async () => {
  const original = emptySnapshotV2();
  original.workspace.name = '起始快照';
  const store = createMemorySnapshotStoreV2(original);
  const commands = createBackupCommands(store);
  const first = structuredClone(original);
  first.workspace.name = '第一份比起始快照更长的中文副本';
  await store.restore(0, first);
  const second = structuredClone(first);
  second.workspace.name = `第二份容量更大的中文副本-${'秋招字节估算'.repeat(40)}`;
  await store.restore(1, second);

  const copies = await commands.listRecoverySnapshots();
  const expectedOriginalBytes = Buffer.byteLength(JSON.stringify(original), 'utf8');
  const expectedFirstBytes = Buffer.byteLength(JSON.stringify(first), 'utf8');
  assert.deepEqual(copies.map(copy => copy.estimatedJsonBytes), [expectedFirstBytes, expectedOriginalBytes]);
  assert.notEqual(copies[0].estimatedJsonBytes, copies[1].estimatedJsonBytes);
  const estimatedTotal = copies.reduce((sum, copy) => sum + copy.estimatedJsonBytes, 0);
  assert.equal(estimatedTotal, expectedFirstBytes + expectedOriginalBytes);

  await commands.deleteRecoverySnapshot(copies[0].id, 2);
  const remaining = await commands.listRecoverySnapshots();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].estimatedJsonBytes, expectedOriginalBytes);
  assert.equal(remaining.reduce((sum, copy) => sum + copy.estimatedJsonBytes, 0), estimatedTotal - expectedFirstBytes);
  await store.close();
});

test('M8 IndexedDB 按所选不可变副本恢复并保留回滚前快照', async () => {
  const factory = new FDBFactory();
  const dbName = name();
  const store = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName });
  const initial = await store.read();
  const target = v2Acceptance();
  target.workspace.name = '导入后的工作空间';
  const revision = await store.restore(initial.revision, target);
  const copies = await store.listRecoverySnapshots();
  assert.equal(copies.length, 1);
  assert.equal(copies[0].id, `restore-v2-${initial.revision}`);
  assert.equal(copies[0].workspaceName, '秋招工作空间');

  const rollbackRevision = await store.restoreRecoverySnapshot(revision, copies[0].id);
  assert.equal(rollbackRevision, revision + 1);
  assert.equal((await store.read()).data.workspace.name, '秋招工作空间');
  const afterRollback = await store.listRecoverySnapshots();
  assert.equal(afterRollback.length, 2);
  assert.equal(afterRollback[0].id, `restore-v2-${revision}`);
  assert.equal(afterRollback[0].workspaceName, '导入后的工作空间');
  assert.equal(afterRollback[1].id, copies[0].id);

  const live = await store.read();
  const edited = structuredClone(live.data);
  edited.workspace.name = '普通保存';
  await store.commit(live.revision, edited);
  assert.equal((await store.listRecoverySnapshots())[0].workspaceName, '导入后的工作空间');
  await assert.rejects(store.restoreRecoverySnapshot(live.revision, copies[0].id), error => error.code === 'CONFLICT');
  await store.close();
});

test('M8 IndexedDB 用一个原子 CAS 事务删除单个副本，冲突和未知 ID 不改动', async () => {
  const factory = new FDBFactory();
  const dbName = name();
  const store = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName });
  const initial = await store.read();
  const one = structuredClone(initial.data); one.workspace.name = '副本一之后';
  await store.restore(initial.revision, one);
  const two = structuredClone(one); two.workspace.name = '副本二之后';
  await store.restore(1, two);
  const ordinary = structuredClone(two); ordinary.workspace.name = '普通保存不会清理副本';
  await store.commit(2, ordinary);
  assert.deepEqual((await store.listRecoverySnapshots()).map(item => item.id), ['restore-v2-1', 'restore-v2-0']);
  const liveBeforeDelete = await store.read();

  await assert.rejects(store.deleteRecoverySnapshot(2, 'restore-v2-0'), error => error.code === 'CONFLICT');
  await assert.rejects(store.deleteRecoverySnapshot(3, 'restore-v2-999'), error => error.code === 'NOT_FOUND');
  assert.deepEqual(await store.listRecoverySnapshots().then(items => items.map(item => item.id)), ['restore-v2-1', 'restore-v2-0']);
  assert.deepEqual(await store.read(), liveBeforeDelete);

  assert.equal(await store.deleteRecoverySnapshot(3, 'restore-v2-0'), 4);
  assert.deepEqual(await store.read(), { revision: 4, data: ordinary });
  assert.deepEqual((await store.listRecoverySnapshots()).map(item => item.id), ['restore-v2-1']);
  await assert.rejects(store.deleteRecoverySnapshot(3, 'restore-v2-1'), error => error.code === 'CONFLICT');
  assert.deepEqual((await store.listRecoverySnapshots()).map(item => item.id), ['restore-v2-1']);
  await store.close();
});

test('M8 Web 端也能按 ID 恢复迁移前 v1 副本且保留来源与当前快照', async () => {
  const factory = new FDBFactory();
  const dbName = name();
  const source = acceptanceSnapshot();
  await seedV1Database(factory, dbName, source, 7);
  const store = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName, migrationNow: () => now });
  const before = await store.read();
  const beforeMigration = await store.listRecoverySnapshots();
  assert.equal(before.revision, 7);
  assert.equal(beforeMigration.length, 1);
  assert.equal(beforeMigration[0].id, 'v1-7');
  assert.equal(beforeMigration[0].sourceSchemaVersion, 1);
  assert.equal(beforeMigration[0].applicationCount, source.applications.length);
  assert.equal(beforeMigration[0].estimatedJsonBytes, Buffer.byteLength(JSON.stringify(source), 'utf8'));
  assert.notEqual(beforeMigration[0].estimatedJsonBytes, Buffer.byteLength(JSON.stringify(migrateV1Snapshot(source, { migratedAt: now })), 'utf8'));

  assert.equal(await store.restoreRecoverySnapshot(7, 'v1-7'), 8);
  assert.deepEqual((await store.read()).data, migrateV1Snapshot(source, { migratedAt: now }));
  const after = await store.listRecoverySnapshots();
  assert.deepEqual(after.map(item => item.id).sort(), ['restore-v2-7', 'v1-7']);
  assert.equal(after.find(item => item.id === 'restore-v2-7').workspaceName, before.data.workspace.name);
  assert.equal(after.find(item => item.id === 'v1-7').sourceSchemaVersion, 1);
  await store.close();
});

test('M8 SQLite 适配器列出并将指定恢复副本绑定到原生原子回滚命令', async () => {
  const data = v2Acceptance();
  const sourceV1 = acceptanceSnapshot();
  let calls = [];
  invokeImpl = async (command, args) => {
    calls.push({ command, args });
    if (command === 'read_recovery_snapshots_v2') return [
      { id: 'restore-v2-7', sourceRevision: 7, sourceSchemaVersion: 2, data },
      { id: 'v1-2', sourceRevision: 2, sourceSchemaVersion: 1, data: sourceV1 },
    ];
    if (command === 'restore_recovery_snapshot_v2') return args.expectedRevision + 1;
    throw new Error(`unexpected ${command}`);
  };
  const store = createDesktopSnapshotStoreV2({ migrationNow: () => now });
  const recoveries = await store.listRecoverySnapshots();
  assert.equal(recoveries.length, 2);
  assert.equal(recoveries[0].workspaceName, data.workspace.name);
  assert.equal(recoveries[1].sourceSchemaVersion, 1);
  assert.equal(recoveries[1].workspaceName, sourceV1.workspace.name);
  assert.equal(recoveries[1].estimatedJsonBytes, Buffer.byteLength(JSON.stringify(sourceV1), 'utf8'));
  assert.notEqual(recoveries[1].estimatedJsonBytes, Buffer.byteLength(JSON.stringify(migrateV1Snapshot(sourceV1, { migratedAt: now })), 'utf8'));
  assert.equal(await store.restoreRecoverySnapshot(11, 'v1-2'), 12);
  assert.deepEqual(calls.map(call => call.command), ['read_recovery_snapshots_v2', 'read_recovery_snapshots_v2', 'restore_recovery_snapshot_v2']);
  assert.equal(calls[2].args.recoveryId, 'v1-2');
  assert.equal(calls[2].args.expectedRevision, 11);
  assert.equal(calls[2].args.data.schemaVersion, 2);
  assert.deepEqual(calls[2].args.sourceData, sourceV1);
  await store.close();
});

test('M8 SQLite 适配器把单副本删除绑定到带 revision 和单一 ID 的原生命令', async () => {
  const data = v2Acceptance();
  const sourceV1 = acceptanceSnapshot();
  const calls = [];
  invokeImpl = async (command, args) => {
    calls.push({ command, args });
    if (command === 'read_recovery_snapshots_v2') return [
      { id: 'restore-v2-7', sourceRevision: 7, sourceSchemaVersion: 2, data },
      { id: 'v1-2', sourceRevision: 2, sourceSchemaVersion: 1, data: sourceV1 },
    ];
    if (command === 'delete_recovery_snapshot_v2') return args.expectedRevision + 1;
    throw new Error(`unexpected ${command}`);
  };
  const store = createDesktopSnapshotStoreV2({ migrationNow: () => now });
  assert.equal(await store.deleteRecoverySnapshot(11, 'v1-2'), 12);
  assert.deepEqual(calls.map(call => call.command), ['read_recovery_snapshots_v2', 'delete_recovery_snapshot_v2']);
  assert.deepEqual(calls[1].args, { expectedRevision: 11, recoveryId: 'v1-2' });
  invokeImpl = async command => { if (command === 'read_recovery_snapshots_v2') return []; throw new Error(`unexpected ${command}`); };
  await assert.rejects(store.deleteRecoverySnapshot(12, 'v1-2'), error => error.code === 'NOT_FOUND');
  await store.close();
});

function emptySnapshotV2() {
  return migrateV1Snapshot(emptySnapshot(), { migratedAt: now });
}

function readRecovery(factory, dbName, key) {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['recovery'], 'readonly');
      const get = tx.objectStore('recovery').get(key);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error);
    };
  });
}

function seedV1Database(factory, dbName, data, revision) {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('snapshot'); request.result.createObjectStore('meta'); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['snapshot', 'meta'], 'readwrite');
      tx.objectStore('snapshot').put({ revision, data }, 'current');
      tx.objectStore('meta').put({ schemaVersion: 1, revision }, 'state');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}
