import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySnapshotStore } from '../dist/repositories/storage-contract.js';
import { createSnapshotRepositories } from '../dist/repositories/core.js';
import { emptySnapshot } from '../dist/fixtures/acceptance.js';
test('M2 共用事务仓库可从空快照创建招聘季并保留 CAS revision', async () => {
  const store = createMemorySnapshotStore(); const repo = createSnapshotRepositories(store, { now: () => '2026-09-17T00:00:00.000Z', id: (() => { let n = 0; return () => `contract-${++n}`; })() });
  const season = await repo.workspace.saveSeason({ name: '2026 秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 50, archivedAt: null });
  assert.equal((await repo.snapshot()).revision, 1); assert.equal((await repo.workspace.get()).workspace.activeSeasonId, season.id);
  const detail = await repo.applications.create({ seasonId: season.id, company: '测试公司', role: '工程师' });
  assert.equal((await repo.snapshot()).revision, 2); assert.equal((await repo.applications.list({ seasonId: season.id })).length, 1); assert.equal(detail.application.currentStage, 'draft');
});
test('M2 快照写入失败不会改变原数据', async () => {
  const store = createMemorySnapshotStore(emptySnapshot()); const repo = createSnapshotRepositories(store); const before = await repo.snapshot();
  await assert.rejects(repo.workspace.saveSeason({ name: '', startDate: '2026-01-01', endDate: '2026-01-02', targetCount: 1, archivedAt: null }), e => e.code === 'VALIDATION');
  assert.deepEqual(await repo.snapshot(), before);
});
