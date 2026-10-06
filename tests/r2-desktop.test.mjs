import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot } from '../dist/fixtures/acceptance.js';
import { DomainError } from '../dist/domain/errors.js';
import { migrateV1Snapshot } from '../dist/domain/v2/index.js';

let invokeImpl;
mock.module('@tauri-apps/api/core', {
  exports: {
    invoke: (...args) => invokeImpl(...args),
  },
});

const { createDesktopSnapshotStoreV2 } = await import('../dist/repositories/desktop/sqlite-v2.js');
const instant = '2026-09-17T00:00:00.000Z';

test('R2 桌面 adapter 读取 v1 后迁移并以原 revision 调用 SQLite v2 命令', async () => {
  const calls = [];
  invokeImpl = async (command, args) => {
    calls.push({ command, args });
    if (command === 'read_snapshot_v2') return { revision: 7, data: emptySnapshot() };
    if (command === 'commit_snapshot_v2') return args.expectedRevision + 1;
    throw new Error(`意外的 Tauri 命令: ${command}`);
  };

  const store = createDesktopSnapshotStoreV2({ migrationNow: () => instant });
  const result = await store.read();
  assert.deepEqual(calls.map(call => call.command), ['read_snapshot_v2', 'commit_snapshot_v2']);
  assert.equal(calls[1].args.expectedRevision, 7);
  assert.equal(calls[1].args.data.schemaVersion, 2);
  assert.equal(calls[1].args.data.migration.migratedAt, instant);
  assert.equal(result.revision, 8);
  assert.deepEqual(result.data, calls[1].args.data);
  await store.close();
});

test('R2 桌面 adapter v2 commit 发送完整快照和 revision CAS 参数', async () => {
  const calls = [];
  invokeImpl = async (command, args) => {
    calls.push({ command, args });
    return 12;
  };
  const snapshot = migrateV1Snapshot(emptySnapshot(), { migratedAt: instant });
  const store = createDesktopSnapshotStoreV2();
  const revision = await store.commit(11, snapshot);

  assert.equal(revision, 12);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'commit_snapshot_v2');
  assert.equal(calls[0].args.expectedRevision, 11);
  assert.deepEqual(calls[0].args.data, snapshot);
  assert.notEqual(calls[0].args.data, snapshot);
  await store.close();
});

test('R2 桌面 adapter 将原生 SQLite 错误映射为领域错误码', async () => {
  const snapshot = migrateV1Snapshot(emptySnapshot(), { migratedAt: instant });
  const cases = [
    ['CONFLICT:版本冲突', 'CONFLICT'],
    ['BACKUP_INCOMPATIBLE:版本不兼容', 'BACKUP_INCOMPATIBLE'],
    ['VALIDATION:快照无效', 'VALIDATION'],
    ['SQLite disk I/O error', 'STORAGE'],
  ];

  for (const [nativeMessage, expectedCode] of cases) {
    invokeImpl = async () => { throw nativeMessage; };
    const store = createDesktopSnapshotStoreV2();
    await assert.rejects(store.commit(3, snapshot), error => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, expectedCode);
      return true;
    });
    await store.close();
  }
});
