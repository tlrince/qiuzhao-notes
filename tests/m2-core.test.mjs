import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotRepositories } from '../dist/repositories/core.js';
import { createMemorySnapshotStore } from '../dist/repositories/storage-contract.js';
import { acceptanceSnapshot } from '../dist/fixtures/acceptance.js';
const setup = () => createSnapshotRepositories(createMemorySnapshotStore(acceptanceSnapshot()), { now: () => '2026-09-17T00:00:00.000Z', id: (() => { let n = 0; return () => `m2-${++n}`; })() });
test('M2a 事务仓库读写详情并通知成功变更', async () => {
  const repo = setup(); const events = []; repo.events.subscribe(change => events.push(change));
  const detail = await repo.applications.getDetail('B');
  const updated = await repo.applications.update('B', { expectedUpdatedAt: detail.application.updatedAt, notes: '事务写入' });
  assert.equal(updated.application.notes, '事务写入'); assert.deepEqual(events, [{ scope: 'applications', id: 'B' }]);
});
test('M2a CAS 冲突和业务校验失败不产生部分提交', async () => {
  const repo = setup(); const before = await repo.snapshot(); const detail = await repo.applications.getDetail('D');
  await assert.rejects(repo.applications.update('B', { expectedUpdatedAt: '2000-01-01T00:00:00.000Z', notes: '冲突' }), e => e.code === 'CONFLICT');
  await assert.rejects(repo.applications.update('D', { expectedUpdatedAt: detail.application.updatedAt, appliedOn: '2026-10-01' }), e => e.code === 'VALIDATION');
  assert.deepEqual((await repo.snapshot()).data, before.data); assert.equal((await repo.snapshot()).revision, before.revision);
});
test('M2a 日程和招聘季写入均走同一快照事务', async () => {
  const repo = setup(); const d = await repo.applications.getDetail('B');
  const schedule = await repo.schedules.save({ applicationId: 'B', type: 'interview', title: '一面', startsAt: '2026-09-20T02:00:00.000Z', status: 'pending', notes: '' });
  assert.equal((await repo.schedules.list({ seasonId: '2026-autumn' })).length, 1);
  await repo.schedules.remove(schedule.id); assert.equal((await repo.schedules.list({ seasonId: '2026-autumn' })).length, 0);
  await repo.close(); await assert.rejects(repo.snapshot(), e => e.code === 'STORAGE');
});
