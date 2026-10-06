import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepositories } from '../dist/repositories/memory.js';
import { acceptanceSnapshot, emptySnapshot, ACCEPTANCE_EXPECTED } from '../dist/fixtures/acceptance.js';
import { validateDate, validateDetail, validateSeason } from '../dist/domain/validation.js';
const seasonId = '2026-autumn';
const setup = () => createMemoryRepositories(acceptanceSnapshot(), { now: () => '2026-09-16T00:00:00.000Z' });
const code = expected => error => error.code === expected;
async function move(repo, id, target) { const d = await repo.applications.getDetail(id); return repo.applications.transition({ id, expectedUpdatedAt: d.application.updatedAt, occurredOn: '2026-09-16', ...target }); }

test('默认工作空间无演示数据，测试样例按需加载且相互隔离', async () => {
  const r = createMemoryRepositories(); assert.equal(r.snapshot().applications.length, 0); assert.equal((await r.workspace.get()).workspace.activeSeasonId, null);
  const a = acceptanceSnapshot(); a.applications[0].company = '修改'; assert.notEqual(acceptanceSnapshot().applications[0].company, '修改');
});
test('A–F 样例全部通过实体与引用校验，验收常量符合固定事实', async () => {
  const r = setup(); const rows = await r.applications.list({ seasonId });
  for (const a of rows) validateDetail(await r.applications.getDetail(a.id));
  assert.equal(rows.length, ACCEPTANCE_EXPECTED.recordCount);
  assert.deepEqual(rows.filter(a => a.appliedOn).map(a => a.id).sort(), ['B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(rows.filter(a => a.appliedOn && a.outcome === 'active').map(a => a.id).sort(), ['B', 'D']);
  assert.deepEqual(r.snapshot().stageEvents.filter(e => e.stage === 'interview_1').map(e => e.applicationId).sort(), ['D', 'E', 'F']);
  assert.deepEqual(r.snapshot().outcomeEvents.filter(e => e.outcome === 'offer').map(e => e.applicationId), ['E']);
});
test('严格业务日期：闰年、跨年合法，溢出日期和非标准格式失败', () => {
  for (const date of ['2024-02-29', '2026-12-31', '2027-01-01']) validateDate(date);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-9-01']) assert.throws(() => validateDate(date), code('VALIDATION'));
});
test('公司岗位、投递日期、安全外链、关联招聘季与渠道必校验，失败无副作用', async () => {
  const r = setup(); const before = r.snapshot();
  for (const input of [{ company: ' ' }, { role: '' }, { currentStage: 'submitted' }, { currentStage: 'draft', appliedOn: '2026-09-10' }, { jobUrl: 'javascript:alert(1)' }, { seasonId: 'missing' }, { channelId: 'missing' }, { currentStage: 'unknown' }]) {
    await assert.rejects(r.applications.create({ company: '公司', role: '岗位', seasonId, ...input }), code('VALIDATION')); assert.deepEqual(r.snapshot(), before);
  }
});
test('新增直达二面仅生成 submitted 与二面，同公司岗位允许重复', async () => {
  const r = setup(); const input = { seasonId, company: ' 公司 ', role: '岗位', currentStage: 'interview_2', appliedOn: '2026-09-10', stageOccurredOn: '2026-09-12' };
  const a = await r.applications.create(input), b = await r.applications.create(input);
  assert.deepEqual(a.stageEvents.map(e => e.stage), ['submitted', 'interview_2']); assert.equal(a.application.company, '公司'); assert.notEqual(a.application.id, b.application.id);
});
test('草稿投递与跳级产生实际事件，不补笔试；重复阶段幂等', async () => {
  const r = setup(); const d = await move(r, 'A', { kind: 'stage', stage: 'interview_1' });
  assert.deepEqual(d.stageEvents.map(e => e.stage), ['submitted', 'interview_1']); assert.equal(d.application.appliedOn, '2026-09-16');
  const again = await move(r, 'A', { kind: 'stage', stage: 'interview_1' }); assert.deepEqual(again, d);
});
test('普通阶段命令拒绝回退，结束流程先重新开启才能推进', async () => {
  const r = setup(); await assert.rejects(move(r, 'D', { kind: 'stage', stage: 'assessment' }), code('VALIDATION'));
  await assert.rejects(move(r, 'C', { kind: 'stage', stage: 'interview_1' }), code('VALIDATION'));
  await move(r, 'C', { kind: 'outcome', outcome: 'active' }); const d = await move(r, 'C', { kind: 'stage', stage: 'interview_1' }); assert.equal(d.application.currentStage, 'interview_1');
});
test('草稿不能获得 Offer；阶段与结果日期不能早于已有历史', async () => {
  const r = setup(); await assert.rejects(move(r, 'A', { kind: 'outcome', outcome: 'offer' }), code('VALIDATION'));
  const d = await r.applications.getDetail('D'); await assert.rejects(r.applications.transition({ id: 'D', expectedUpdatedAt: d.application.updatedAt, kind: 'stage', stage: 'interview_2', occurredOn: '2026-09-01' }), code('VALIDATION'));
});
test('Offer 后主动结束保留有效 Offer 历史，当前阶段不丢失', async () => {
  const r = setup(); const d = await move(r, 'E', { kind: 'outcome', outcome: 'withdrawn' });
  assert.equal(d.application.currentStage, 'interview_2'); assert.equal(d.application.outcome, 'withdrawn'); assert.equal(d.outcomeEvents.filter(e => !e.supersededAt && e.outcome === 'offer').length, 1);
});
test('纠正误录 Offer 使旧历史失效，并重新推导当前结果', async () => {
  const r = setup(); const d = await r.applications.getDetail('E');
  const result = await r.applications.correctHistory({ id: 'E', expectedUpdatedAt: d.application.updatedAt, eventId: d.outcomeEvents[0].id, kind: 'outcome', replacement: null });
  assert.equal(result.application.outcome, 'active'); assert.ok(result.outcomeEvents[0].supersededAt);
});
test('纠正早期结果不会覆盖后续主动结束，替换阶段保留修改痕迹', async () => {
  const r = setup(); const e = await move(r, 'E', { kind: 'outcome', outcome: 'withdrawn' });
  const fixed = await r.applications.correctHistory({ id: 'E', expectedUpdatedAt: e.application.updatedAt, eventId: e.outcomeEvents[0].id, kind: 'outcome', replacement: null }); assert.equal(fixed.application.outcome, 'withdrawn');
  const d = await r.applications.getDetail('D'); const corrected = await r.applications.correctHistory({ id: 'D', expectedUpdatedAt: d.application.updatedAt, eventId: d.stageEvents.at(-1).id, kind: 'stage', replacement: { stage: 'assessment', occurredOn: '2026-09-10' } });
  assert.equal(corrected.application.currentStage, 'assessment'); assert.ok(corrected.stageEvents[1].supersededAt); assert.equal(corrected.stageEvents.at(-1).source, 'correction');
});
test('不能移除仍被后续阶段依赖的 submitted，错误纠正保持原数据', async () => {
  const r = setup(); const d = await r.applications.getDetail('D'), before = r.snapshot();
  await assert.rejects(r.applications.correctHistory({ id: 'D', expectedUpdatedAt: d.application.updatedAt, eventId: d.stageEvents[0].id, kind: 'stage', replacement: null }), code('VALIDATION')); assert.deepEqual(r.snapshot(), before);
});
test('修改投递日期同步 submitted 并保留旧事件；晚于面试的日期被拒绝', async () => {
  const r = setup(); const d = await r.applications.getDetail('D');
  const updated = await r.applications.update('D', { expectedUpdatedAt: d.application.updatedAt, appliedOn: '2026-09-09' });
  assert.equal(updated.application.appliedOn, '2026-09-09'); assert.equal(updated.stageEvents.find(e => e.stage === 'submitted' && !e.supersededAt).occurredOn, '2026-09-09'); assert.ok(updated.stageEvents[0].supersededAt);
  const before = r.snapshot(); await assert.rejects(r.applications.update('D', { expectedUpdatedAt: updated.application.updatedAt, appliedOn: '2026-09-20' }), code('VALIDATION')); assert.deepEqual(r.snapshot(), before);
});
test('过期编辑和阶段命令返回 CONFLICT，连续同毫秒编辑也可检测', async () => {
  const r = setup(); const d = await r.applications.getDetail('B');
  const first = await r.applications.update('B', { expectedUpdatedAt: d.application.updatedAt, notes: '第一版' });
  const second = await r.applications.update('B', { expectedUpdatedAt: first.application.updatedAt, notes: '第二版' }); assert.notEqual(first.application.updatedAt, second.application.updatedAt);
  await assert.rejects(r.applications.update('B', { expectedUpdatedAt: first.application.updatedAt, notes: '旧版本' }), code('CONFLICT'));
  await assert.rejects(r.applications.transition({ id: 'B', expectedUpdatedAt: d.application.updatedAt, occurredOn: '2026-09-16', kind: 'stage', stage: 'assessment' }), code('CONFLICT'));
});
test('组合查询：招聘季、关键词、阶段、结果、城市、渠道、日期边界、草稿排除', async () => {
  const r = setup(); const rows = await r.applications.list({ seasonId, keyword: '样例公司 D', stages: ['interview_1'], outcomes: ['active'], city: '上海', channelId: 'referral', appliedDateRange: { from: '2026-09-10', to: '2026-09-10' } }); assert.deepEqual(rows.map(a => a.id), ['D']);
  assert.equal((await r.applications.list({ seasonId, appliedDateRange: { from: '2026-09-10', to: '2026-09-10' } })).length, 5);
  assert.deepEqual(await r.applications.list({ seasonId: 'other' }), []);
  assert.equal((await r.applications.list({ seasonId, city: '' }))[0].id, 'B');
  await assert.rejects(r.applications.list({ seasonId, appliedDateRange: { from: '2026-09-11', to: '2026-09-10' } }), code('VALIDATION'));
});
test('排序稳定且空日期置后，返回数据无法绕过命令修改', async () => {
  const r = setup(); const rows = await r.applications.list({ seasonId, sort: { field: 'appliedOn', direction: 'asc' } }); assert.equal(rows.at(-1).id, 'A');
  rows[0].company = '污染'; const d = await r.applications.getDetail(rows[0].id); assert.notEqual(d.application.company, '污染'); d.stageEvents.length = 0; assert.ok((await r.applications.getDetail(rows[0].id)).stageEvents.length);
});
test('完成日程不推进面试；日程按 UTC 时间排序且删除岗位级联清理', async () => {
  const r = setup(); const input = { applicationId: 'B', type: 'interview', title: '一面', startsAt: '2026-09-17T02:00:00.000Z', status: 'pending', notes: '' };
  const later = await r.schedules.save(input); const earlier = await r.schedules.save({ ...input, startsAt: '2026-09-16T02:00:00.000Z' });
  assert.deepEqual((await r.schedules.list({ seasonId })).map(s => s.id), [earlier.id, later.id]);
  await r.schedules.save({ ...later, status: 'completed' }); assert.equal((await r.applications.getDetail('B')).application.currentStage, 'submitted');
  await r.applications.remove('B'); assert.equal(await r.applications.getDetail('B'), null); assert.equal((await r.schedules.list({ seasonId })).length, 0); assert.ok(!r.snapshot().stageEvents.some(e => e.applicationId === 'B'));
});
test('招聘季创建切换归档、目标校验与设置时区校验', async () => {
  const r = createMemoryRepositories(); const s = await r.workspace.saveSeason({ name: '秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 100, archivedAt: null }); assert.equal((await r.workspace.get()).workspace.activeSeasonId, s.id);
  for (const targetCount of [0, -1, 1.5, NaN]) assert.throws(() => validateSeason({ ...s, targetCount }), code('VALIDATION'));
  await r.workspace.saveSeason({ ...s, archivedAt: '2026-12-31T00:00:00.000Z' }); await r.workspace.setActiveSeason(s.id);
  const before = r.snapshot(); await assert.rejects(r.workspace.saveSettings({ name: '不应写入', timeZone: 'Invalid/Zone' }), code('VALIDATION')); assert.deepEqual(r.snapshot(), before);
});
test('订阅仅在成功写入后通知，取消订阅后停止；未知记录有明确错误', async () => {
  const r = setup(); const changes = []; const unsubscribe = r.events.subscribe(e => changes.push(e));
  await assert.rejects(r.applications.update('missing', { expectedUpdatedAt: '', company: '新公司' }), code('NOT_FOUND')); assert.equal(changes.length, 0);
  await move(r, 'B', { kind: 'stage', stage: 'assessment' }); assert.deepEqual(changes, [{ scope: 'applications', id: 'B' }]); unsubscribe(); await r.applications.remove('B'); assert.equal(changes.length, 1);
});
test('Mock 初始化拒绝孤立关联、重复 ID 与不一致历史', () => {
  const bad = acceptanceSnapshot(); bad.applications[1].appliedOn = '2026-09-11'; assert.throws(() => createMemoryRepositories(bad), code('VALIDATION'));
  const duplicate = acceptanceSnapshot(); duplicate.applications.push(duplicate.applications[0]); assert.throws(() => createMemoryRepositories(duplicate), code('VALIDATION'));
  const orphan = emptySnapshot(); orphan.stageEvents.push(acceptanceSnapshot().stageEvents[0]); assert.throws(() => createMemoryRepositories(orphan), code('VALIDATION'));
});
test('非法 URL 与非真实 UTC 时刻统一返回 VALIDATION', async () => {
  const r = setup(); await assert.rejects(r.applications.create({ seasonId, company: '公司', role: '岗位', jobUrl: 'not a url' }), code('VALIDATION'));
  await assert.rejects(r.schedules.save({ applicationId: 'B', type: 'interview', title: '面试', startsAt: '2026-09-16T24:00:00Z', status: 'pending', notes: '' }), code('VALIDATION'));
});
test('历史无效事件不可再次纠正；移除唯一 submitted 可恢复草稿', async () => {
  const r = setup(); const d = await r.applications.getDetail('B'); const input = { id: 'B', expectedUpdatedAt: d.application.updatedAt, kind: 'stage', eventId: d.stageEvents[0].id, replacement: null };
  const fixed = await r.applications.correctHistory(input); assert.equal(fixed.application.currentStage, 'draft'); assert.equal(fixed.application.appliedOn, null);
  await assert.rejects(r.applications.correctHistory({ ...input, expectedUpdatedAt: fixed.application.updatedAt }), code('VALIDATION'));
});
