import test from 'node:test';
import assert from 'node:assert/strict';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { acceptanceSnapshot, emptySnapshot } from '../dist/fixtures/acceptance.js';
import { createIndexedDbSnapshotStoreV2 } from '../dist/repositories/web/indexeddb-v2.js';
import { createIndexedDbSnapshotStore } from '../dist/repositories/web/indexeddb.js';
import { createMemorySnapshotStoreV2 } from '../dist/repositories/storage-v2-contract.js';
import { migrateV1Snapshot } from '../dist/domain/v2/index.js';

const now = () => '2026-09-17T00:00:00.000Z';
const name = () => `r2-${Math.random()}`;
function seedV1(factory, dbName, data, revision = 7) {
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
function readRaw(factory, dbName, version = 2) {
  return new Promise((resolve, reject) => {
    const request = factory.open(dbName, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const stores = [...db.objectStoreNames];
      const tx = db.transaction(stores, 'readonly');
      const snapshot = tx.objectStore('snapshot').get('current');
      const state = tx.objectStore('meta').get('state');
      const result = {};
      snapshot.onsuccess = () => { result.current = snapshot.result; };
      state.onsuccess = () => { result.state = state.result; };
      if (stores.includes('recovery')) {
        const backup = tx.objectStore('recovery').get('v1-7');
        backup.onsuccess = () => { result.backup = backup.result; };
      }
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

test('R2 IndexedDB 升级时保留 revision 和 v1 恢复副本，重开后 CAS 写入 v2', async () => {
  const factory = new FDBFactory(); const dbName = name();
  await seedV1(factory, dbName, acceptanceSnapshot());
  const store = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName, migrationNow: now });
  const initial = await store.read();
  assert.equal(initial.revision, 7);
  assert.equal(initial.data.schemaVersion, 2);
  assert.equal(initial.data.applications.find(item => item.id === 'C').outcome, 'failed');
  const raw = await readRaw(factory, dbName);
  assert.equal(raw.state.schemaVersion, 2);
  assert.equal(raw.state.physicalVersion, 2);
  assert.equal(raw.backup.schemaVersion, 1);
  assert.equal(raw.backup.revision, 7);
  assert.equal(raw.backup.data.applications.length, 6);

  const nextData = structuredClone(initial.data); nextData.workspace.name = '新快照';
  assert.equal(await store.commit(7, nextData), 8);
  await assert.rejects(store.commit(7, nextData), error => error.code === 'CONFLICT');
  await store.close();
  const reopened = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName, migrationNow: now });
  assert.equal((await reopened.read()).data.workspace.name, '新快照');
  await reopened.close();
  const legacy = createIndexedDbSnapshotStore({ indexedDB: factory, dbName });
  await assert.rejects(legacy.read());
});

test('R2 IndexedDB 迁移失败回滚版本升级且原 v1 数据完整可读', async () => {
  const factory = new FDBFactory(); const dbName = name(); const source = emptySnapshot();
  await seedV1(factory, dbName, source, 4);
  const failed = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName, migrationNow: () => 'not-an-instant' });
  await assert.rejects(failed.read());
  const original = await readRaw(factory, dbName, 1);
  assert.equal(original.current.revision, 4);
  assert.equal(original.current.data.settings.schemaVersion, 1);
  assert.equal(original.current.data.workspace.name, source.workspace.name);
  await failed.close().catch(() => undefined);
});

test('R2 v2 内存与 IndexedDB 共用 revision CAS 和整快照校验契约', async () => {
  const factory = new FDBFactory(); const dbName = name();
  const seed = migrateV1Snapshot(emptySnapshot(), { migratedAt: now() });
  const memory = createMemorySnapshotStoreV2(seed);
  await seedV1(factory, dbName, emptySnapshot(), 0);
  const web = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName, migrationNow: now });
  const memoryRead = await memory.read(), webRead = await web.read();
  for (const store of [memory, web]) {
    const current = await store.read(); const next = structuredClone(current.data); next.workspace.name = '替换成功';
    assert.equal(await store.commit(current.revision, next), current.revision + 1);
    await assert.rejects(store.commit(current.revision, next), error => error.code === 'CONFLICT');
    const before = await store.read(); const malformed = structuredClone(before.data); malformed.schemaVersion = 1;
    await assert.rejects(store.commit(before.revision, malformed));
    assert.deepEqual(await store.read(), before);
  }
  assert.equal(memoryRead.data.schemaVersion, webRead.data.schemaVersion);
  await memory.close(); await web.close();
});

test('R2 automatic recovery copies keep only the newest five in memory and IndexedDB; the v1 copy stays', async () => {
  const factory = new FDBFactory();
  const dbName = name();
  await seedV1(factory, dbName, acceptanceSnapshot());
  const migrated = migrateV1Snapshot(acceptanceSnapshot(), { migratedAt: now() });
  const stores = [createMemorySnapshotStoreV2(migrated), createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName, migrationNow: now })];
  for (const store of stores) {
    let { revision, data } = await store.read();
    for (let index = 0; index < 7; index += 1) revision = await store.restore(revision, data);
    const automatic = (await store.listRecoverySnapshots()).filter(item => item.id.startsWith('restore-v2-'));
    assert.equal(automatic.length, 5);
    assert.deepEqual(automatic.map(item => item.sourceRevision), [revision - 1, revision - 2, revision - 3, revision - 4, revision - 5]);
    const oldest = automatic.at(-1);
    revision = await store.restoreRecoverySnapshot(revision, oldest.id);
    assert.equal((await store.listRecoverySnapshots()).filter(item => item.id.startsWith('restore-v2-')).length, 5);
    await store.close();
  }
  const reopened = createIndexedDbSnapshotStoreV2({ indexedDB: factory, dbName, migrationNow: now });
  assert.ok((await reopened.listRecoverySnapshots()).some(item => item.id === 'v1-7'), '迁移前的 v1 副本不计入上限、不会被清理');
  await reopened.close();
});
