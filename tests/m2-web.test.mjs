import test from 'node:test';
import assert from 'node:assert/strict';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';
import { createIndexedDbSnapshotStore } from '../dist/repositories/web/indexeddb.js';
import { emptySnapshot } from '../dist/fixtures/acceptance.js';
const make = () => createIndexedDbSnapshotStore({ indexedDB: new FDBFactory(), dbName: `m2-${Math.random()}` });
test('M2b IndexedDB 首次为空，写入后重开可恢复并保持深拷贝', async () => {
  const factory = new FDBFactory(); const name = `m2-${Math.random()}`;
  const a = createIndexedDbSnapshotStore({ indexedDB: factory, dbName: name }); const first = await a.read(); assert.equal(first.revision, 0);
  const data = emptySnapshot(); data.workspace.name = '已保存'; assert.equal(await a.commit(0, data), 1); await a.close();
  const b = createIndexedDbSnapshotStore({ indexedDB: factory, dbName: name }); const read = await b.read(); assert.equal(read.revision, 1); assert.equal(read.data.workspace.name, '已保存'); read.data.workspace.name = '污染'; assert.equal((await b.read()).data.workspace.name, '已保存'); await b.close();
});
test('M2b 单事务 CAS 冲突不覆盖最新快照，关闭后拒绝读写', async () => {
  const store = make(); const data = emptySnapshot(); await store.commit(0, data); await assert.rejects(store.commit(0, data), e => e.code === 'CONFLICT'); await store.close(); await assert.rejects(store.read(), e => e.code === 'STORAGE');
});
