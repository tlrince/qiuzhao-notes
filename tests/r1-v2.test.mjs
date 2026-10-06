import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendProgressEvent,
  addStageAnnotation,
  createDefinitionRepository,
  createProgressRecord,
  createR1MockCases,
  defaultR1Definitions,
  correctProgressEvent,
  invalidateProgressEvent,
  projectProgress,
  removeStageAnnotation,
  validateProgressRecord,
} from '../dist/domain/v2/index.js';

const definitions = defaultR1Definitions();
const code = expected => error => error.code === expected;
const context = (() => { let id = 0; return () => ({ now: '2026-09-17T12:00:00.000Z', id: () => `test-${++id}` }); })();
const record = id => createProgressRecord(id);
function append(current, input, defs = definitions) { return appendProgressEvent(current, defs, input, context()); }
function enter(current, commandId, statusId, occurredOn, rest = {}) { return append(current, { commandId, statusId, occurredOn, ...rest }); }

test('默认状态模板可定制，但创建模板本身不创建招聘事件', () => {
  assert.ok(definitions.stages.some(stage => stage.id === 'interview_4'));
  assert.ok(definitions.statuses.some(status => status.id === 'ai_active'));
  assert.equal(projectProgress(record('empty'), definitions, '2026-09-17').events.length, 0);
  const customized = createDefinitionRepository(definitions, { id: () => 'unused', isStatusUsed: () => false });
  assert.equal(customized.snapshot().statuses.length, definitions.statuses.length);
});

test('可新增无模板环节与自定义状态；配置失败时定义快照不发生部分修改', () => {
  const repo = createDefinitionRepository(definitions, { isStatusUsed: () => false });
  repo.createStage({ id: 'manager_talk', name: '主管沟通', category: 'custom', sortOrder: 15, countsAsInterview: true });
  const created = repo.createStatus({ id: 'manager_waiting', name: '待主管沟通', color: '#aa9988', sortOrder: 15, semantic: 'custom', stageId: 'manager_talk', defaultPhase: 'waiting', statisticsCategory: 'manager_chat' });
  const used = append(record('custom-state'), { commandId: 'manager-event', statusId: created.id, occurredOn: '2026-09-05' }, repo.snapshot());
  assert.equal(used.event.semantics.stageNameSnapshot, '主管沟通');
  const before = repo.snapshot();
  assert.throws(() => repo.updateStatusSemantics('manager_waiting', { semantic: 'offer_declined', stageId: 'manager_talk', defaultPhase: 'unknown', statisticsCategory: 'declined' }), code('VALIDATION'));
  assert.deepEqual(repo.snapshot(), before);
  repo.archiveStage('manager_talk', '2026-09-17T12:00:00.000Z');
  assert.throws(() => append(used.record, { commandId: 'manager-later', statusId: 'manager_waiting', occurredOn: '2026-09-06' }, repo.snapshot()), code('VALIDATION'));
  assert.equal(projectProgress(used.record, repo.snapshot(), '2026-09-17').currentEvent.statusNameSnapshot, '待主管沟通');
});

test('用户跳到二面只记录二面，事件顺序按用户动作而不是固定阶段排名', () => {
  let r = record('direct');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'interview', 'interview_2_active', '2026-09-03').record;
  const view = projectProgress(r, definitions, '2026-09-17');
  assert.deepEqual(view.events.map(event => event.statusId), ['submitted', 'interview_2_active']);
  assert.equal(view.stages.find(stage => stage.stageId === 'interview_1').visits, 0);
  assert.equal(view.stages.find(stage => stage.stageId === 'interview_2').visits, 1);
});

test('反复筛选与反复泡池子产生独立 visit，阶段列保留重复次数', () => {
  const cases = createR1MockCases();
  const screening = projectProgress(cases.records.repeatScreening, cases.definitions, '2026-09-17');
  assert.equal(screening.visits.filter(visit => visit.stageId === 'screening').length, 2);
  assert.deepEqual(screening.events.map(event => event.statusId), ['submitted', 'screening', 'written_test_active', 'screening', 'ai_active']);
  assert.equal(screening.stages.find(stage => stage.stageId === 'interview_1').visits, 0);
  const pool = projectProgress(cases.records.repeatPool, cases.definitions, '2026-09-17');
  assert.equal(pool.visits.filter(visit => visit.stageId === 'pool').length, 2);
  assert.equal(pool.stages.find(stage => stage.stageId === 'pool').visits, 2);
  assert.equal(pool.stages.find(stage => stage.stageId === 'pool').daysInCurrentVisit, null);
  assert.equal(pool.visits.filter(visit => visit.countAsInterview).length, 3);
});

test('同一面试 visit 的等待、进行中、待结果、通过沿用 visitId', () => {
  let r = record('phase');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'wait', 'interview_1_waiting', '2026-09-02').record;
  const visitId = r.events.at(-1).visitId;
  for (const [commandId, statusId, occurredOn, phase] of [
    ['start', 'interview_1_active', '2026-09-03', 'in_progress'],
    ['result', 'interview_1_result', '2026-09-03', 'awaiting_result'],
    ['pass', 'interview_1_passed', '2026-09-04', 'passed'],
  ]) r = enter(r, commandId, statusId, occurredOn, { mode: 'continue_visit', phase }).record;
  const visit = projectProgress(r, definitions, '2026-09-17').visits.find(item => item.id === visitId);
  assert.equal(visit.events.length, 4);
  assert.equal(visit.countAsInterview, true);
});

test('同状态的显式再次进入不是 no-op，并且必须创建新 visit', () => {
  let r = record('repeat-same');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'screen-1', 'screening', '2026-09-02').record;
  const oldVisit = r.events.at(-1).visitId;
  r = enter(r, 'screen-2', 'screening', '2026-09-03').record;
  assert.equal(r.events.length, 3);
  assert.notEqual(r.events.at(-1).visitId, oldVisit);
});

test('幂等命令重试不追加；相同 commandId 的不同请求冲突', () => {
  const r = enter(record('idempotent'), 'screen-1', 'screening', '2026-09-02').record;
  const replay = enter(r, 'screen-1', 'screening', '2026-09-02');
  assert.equal(replay.duplicate, true);
  assert.equal(replay.record.events.length, 1);
  assert.equal(replay.event.id, r.events[0].id);
  assert.throws(() => enter(r, 'screen-1', 'pool', '2026-09-02'), code('CONFLICT'));
  const second = enter(r, 'screen-2', 'screening', '2026-09-03');
  assert.equal(second.record.events.length, 2);
});

test('失败必须归因到明确环节或 unknown，失败/拒绝 Offer/主动退出语义分开', () => {
  let failed = record('failed');
  failed = enter(failed, 'submit', 'submitted', '2026-09-01').record;
  assert.throws(() => enter(failed, 'fail-without-cause', 'interview_2_failed', '2026-09-05'), code('VALIDATION'));
  failed = enter(failed, 'failed-known', 'interview_2_failed', '2026-09-05', { failedAt: { stageId: 'interview_2' } }).record;
  assert.equal(projectProgress(failed, definitions, '2026-09-17').failedAt.stageNameSnapshot, '二面');
  assert.throws(() => enter(record('no-offer'), 'decline', 'offer_declined', '2026-09-12'), code('VALIDATION'));
  const declined = createR1MockCases().records.offerDeclined;
  const declineView = projectProgress(declined, definitions, '2026-09-17');
  assert.equal(declineView.offerCount, 1);
  assert.equal(declineView.failedAt, null);
  assert.equal(declineView.currentEvent.semantics.terminalOutcome, 'offer_declined');
  const unknown = projectProgress(createR1MockCases().records.unknownFailure, definitions, '2026-09-17');
  assert.equal(unknown.failedAt, 'unknown');
});

test('每个失败环节独立呈现，只有真实面试 visit 才算面试触达', () => {
  for (const stageId of ['screening', 'written_test', 'assessment', 'ai_interview', 'interview_1', 'interview_2', 'interview_3', 'interview_4', 'interview_extra']) {
    let r = record(`fail-${stageId}`);
    r = enter(r, 'submit', 'submitted', '2026-09-01').record;
    r = enter(r, `fail-${stageId}`, `${stageId}_failed`, '2026-09-04', { failedAt: { stageId } }).record;
    const view = projectProgress(r, definitions, '2026-09-17');
    assert.equal(view.failedAt.stageId, stageId);
    assert.equal(view.visits.filter(visit => visit.countAsInterview).length, 0);
  }
});

test('接受 Offer 保留累计 Offer 语义；主动退出独立于失败和 Offer 拒绝', () => {
  let received = record('accepted');
  received = enter(received, 'submit', 'submitted', '2026-09-01').record;
  received = enter(received, 'offer', 'offer_received', '2026-09-10').record;
  received = enter(received, 'accept', 'offer_accepted', '2026-09-12').record;
  const accepted = projectProgress(received, definitions, '2026-09-17');
  assert.equal(accepted.offerCount, 1);
  assert.equal(accepted.currentEvent.semantics.terminalOutcome, 'offer_accepted');
  assert.equal(accepted.failedAt, null);
  let withdrawn = record('withdrawn');
  withdrawn = enter(withdrawn, 'submit', 'submitted', '2026-09-01').record;
  withdrawn = enter(withdrawn, 'withdraw', 'withdrawn', '2026-09-08').record;
  assert.equal(projectProgress(withdrawn, definitions, '2026-09-17').currentEvent.semantics.terminalOutcome, 'withdrawn');
});

test('失败后必须显式重新开启；历史失败保留且当前投影恢复为进行中', () => {
  let r = record('revive');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'fail', 'interview_2_failed', '2026-09-04', { failedAt: { stageId: 'interview_2' } }).record;
  assert.throws(() => enter(r, 'without-reopen', 'pool', '2026-09-05'), code('VALIDATION'));
  r = enter(r, 'reopen', 'pool', '2026-09-05', { mode: 'reopen', reopenReason: '重新开启招聘流程' }).record;
  const view = projectProgress(r, definitions, '2026-09-17');
  assert.equal(view.events.filter(event => event.semantics.terminalOutcome === 'failed').length, 1);
  assert.equal(view.currentEvent.statusId, 'pool');
  assert.equal(view.failedAt, null);
});

test('补录用 anchor 明确同日先后，重连链后不倒退当前状态', () => {
  let r = record('backfill');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'i2', 'interview_2_active', '2026-09-05').record;
  const next = enter(r, 'screen-backfill', 'screening', '2026-09-05', { mode: 'backfill', beforeEventId: r.events.at(-1).id });
  const view = projectProgress(next.record, definitions, '2026-09-17');
  assert.deepEqual(view.events.map(event => event.statusId), ['submitted', 'screening', 'interview_2_active']);
  assert.equal(view.currentEvent.id, r.events.at(-1).id);
  assert.equal(view.events.at(-1).previousEventId, view.events[1].id);
});

test('纠正保留失效历史并重连后续事件，不用 createdAt 重排', () => {
  let r = record('correction');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'screen', 'screening', '2026-09-02').record;
  r = enter(r, 'test', 'written_test_active', '2026-09-03').record;
  const invalid = r.events[1];
  r = invalidateProgressEvent(r, definitions, invalid.id, '2026-09-17T15:00:00.000Z');
  const view = projectProgress(r, definitions, '2026-09-17');
  assert.equal(r.events.find(event => event.id === invalid.id).invalidatedAt, '2026-09-17T15:00:00.000Z');
  assert.deepEqual(view.events.map(event => event.statusId), ['submitted', 'written_test_active']);
  assert.equal(view.events[1].previousEventId, view.events[0].id);
  assert.equal(view.currentEvent.statusId, 'written_test_active');
});

test('状态改名、重排与归档不新增事件；语义变更递增版本且旧事件保留快照', () => {
  let r = record('definition-snapshot');
  r = enter(r, 'screen', 'screening', '2026-09-02').record;
  const repo = createDefinitionRepository(definitions, { isStatusUsed: () => false });
  repo.renameStatus('screening', '简历初筛');
  repo.reorderStatus('screening', 999);
  repo.archiveStatus('screening', '2026-09-17T12:00:00.000Z');
  const archived = repo.snapshot();
  assert.equal(r.events[0].statusNameSnapshot, '筛选中');
  assert.equal(projectProgress(r, archived, '2026-09-17').currentEvent.statusNameSnapshot, '筛选中');
  assert.throws(() => append(r, { commandId: 'new-screen', statusId: 'screening', occurredOn: '2026-09-03' }, archived), code('VALIDATION'));
  const activeRepo = createDefinitionRepository(definitions, { isStatusUsed: () => false });
  const changed = activeRepo.updateStatusSemantics('screening', { semantic: 'custom', stageId: 'screening', defaultPhase: 'unknown', statisticsCategory: 'custom-review' });
  assert.equal(changed.version, 2);
  const newEvent = append(r, { commandId: 'new-screen', statusId: 'screening', occurredOn: '2026-09-03' }, activeRepo.snapshot()).event;
  assert.equal(r.events[0].semantics.statisticsCategory, 'screening');
  assert.equal(newEvent.semantics.statisticsCategory, 'custom-review');
});

test('归档历史状态仍可显示；被引用状态只能归档不能硬删', () => {
  const r = enter(record('referenced'), 'screen', 'screening', '2026-09-02').record;
  const used = new Set(r.events.map(event => event.statusId));
  const repo = createDefinitionRepository(definitions, { isStatusUsed: id => used.has(id) });
  repo.archiveStatus('screening', '2026-09-17T12:00:00.000Z');
  assert.throws(() => repo.deleteStatus('screening'), code('VALIDATION'));
  assert.equal(projectProgress(r, repo.snapshot(), '2026-09-17').currentEvent.statusNameSnapshot, '筛选中');
});

test('跳过注记只影响表格，不会生成触达；实际录入前须清除跳过标记', () => {
  let r = record('skipped');
  const created = addStageAnnotation(r, definitions, { commandId: 'skip-write', stageId: 'written_test', notes: '该岗位无笔试' }, context());
  r = created.record;
  const projection = projectProgress(r, definitions, '2026-09-17');
  assert.equal(r.events.length, 0);
  assert.equal(projection.stages.find(stage => stage.stageId === 'written_test').skipped, true);
  assert.throws(() => enter(r, 'write', 'written_test_active', '2026-09-03'), code('VALIDATION'));
  r = removeStageAnnotation(r, definitions, created.annotation.id, '2026-09-17T13:00:00.000Z');
  r = enter(r, 'write', 'written_test_active', '2026-09-03').record;
  assert.equal(projectProgress(r, definitions, '2026-09-17').stages.find(stage => stage.stageId === 'written_test').skipped, false);
});

test('篡改显式 previousEventId 或 sequence 时拒绝无效链', () => {
  let r = record('invalid-chain');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'screen', 'screening', '2026-09-02').record;
  const corrupted = structuredClone(r); corrupted.events[1].previousEventId = null;
  assert.throws(() => validateProgressRecord(corrupted, definitions), code('VALIDATION'));
});

test('appliedOn 与唯一首次已投递事件双向同步，纠正或作废也同步回滚', () => {
  let r = record('applied-on');
  assert.equal(r.appliedOn, null);
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  assert.equal(r.appliedOn, '2026-09-01');
  const missingDate = structuredClone(r); missingDate.appliedOn = null;
  assert.throws(() => validateProgressRecord(missingDate, definitions), code('VALIDATION'));
  const dateWithoutSubmit = record('invalid-date'); dateWithoutSubmit.appliedOn = '2026-09-01';
  assert.throws(() => validateProgressRecord(dateWithoutSubmit, definitions), code('VALIDATION'));
  r = invalidateProgressEvent(r, definitions, r.events[0].id, '2026-09-17T14:00:00.000Z');
  assert.equal(r.appliedOn, null);
});

test('Offer 决定只消费一个待决定 Offer，拒绝和接受不能重复结算同一 Offer', () => {
  let r = record('one-offer');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'offer', 'offer_received', '2026-09-05').record;
  r = enter(r, 'accept', 'offer_accepted', '2026-09-06').record;
  r = enter(r, 'reopen', 'screening', '2026-09-07', { mode: 'reopen', reopenReason: '恢复并行招聘流程' }).record;
  assert.throws(() => enter(r, 'decline-again', 'offer_declined', '2026-09-08'), code('VALIDATION'));
  assert.equal(projectProgress(r, definitions, '2026-09-17').offerCount, 1);
});

test('所有结束结果继续流程都必须显式重开并填写原因', () => {
  const cases = [
    { statusId: 'failed_unknown', failedAt: 'unknown' },
    { statusId: 'offer_accepted' },
    { statusId: 'offer_declined' },
    { statusId: 'withdrawn' },
  ];
  for (const [index, ending] of cases.entries()) {
    let r = record(`reopen-${index}`);
    r = enter(r, 'submit', 'submitted', '2026-09-01').record;
    if (ending.statusId === 'offer_accepted' || ending.statusId === 'offer_declined') r = enter(r, 'offer', 'offer_received', '2026-09-02').record;
    r = enter(r, 'end', ending.statusId, '2026-09-03', { ...(ending.failedAt ? { failedAt: ending.failedAt } : {}) }).record;
    assert.throws(() => enter(r, 'skip-reason', 'screening', '2026-09-04', { mode: 'reopen' }), code('VALIDATION'));
    r = enter(r, 'reopen', 'screening', '2026-09-04', { mode: 'reopen', reopenReason: '恢复招聘' }).record;
    assert.equal(projectProgress(r, definitions, '2026-09-17').currentEvent.statusId, 'screening');
  }
});

test('状态版本快照防止语义篡改；阶段结果必须匹配状态定义', () => {
  let r = enter(record('versioned'), 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'write', 'written_test_active', '2026-09-02').record;
  const corrupted = structuredClone(r); corrupted.events[0].semantics.semantic = 'failed';
  assert.throws(() => validateProgressRecord(corrupted, definitions), code('VALIDATION'));
  assert.throws(() => enter(record('wrong-phase'), 'waiting-as-passed', 'interview_1_waiting', '2026-09-02', { phase: 'passed' }), code('VALIDATION'));

  const repo = createDefinitionRepository(definitions, { isStatusUsed: () => false });
  repo.updateStatusSemantics('written_test_active', { semantic: 'stage', stageId: 'written_test', defaultPhase: 'waiting', statisticsCategory: 'written_test' });
  assert.doesNotThrow(() => validateProgressRecord(r, repo.snapshot()));
  const next = append(r, { commandId: 'new-version', statusId: 'written_test_active', occurredOn: '2026-09-03' }, repo.snapshot());
  assert.equal(r.events[1].phase, 'in_progress');
  assert.equal(next.event.phase, 'waiting');
  assert.equal(next.event.definitionVersion, 2);
});

test('失败环节与挂点状态一致；环节统计属性变更会增加状态定义版本', () => {
  let r = enter(record('failure-attribution'), 'submit', 'submitted', '2026-09-01').record;
  assert.throws(() => enter(r, 'wrong-fail', 'interview_2_failed', '2026-09-02', { failedAt: { stageId: 'interview_1' } }), code('VALIDATION'));
  r = enter(r, 'i1', 'interview_1_active', '2026-09-02').record;
  const repo = createDefinitionRepository(definitions, { isStatusUsed: () => false });
  const oldEvent = r.events.at(-1);
  repo.updateStage('interview_1', { category: 'ai_interview', countsAsInterview: false, interviewRound: 1 });
  assert.doesNotThrow(() => validateProgressRecord(r, repo.snapshot()));
  const next = append(r, { commandId: 'i1-new-definition', statusId: 'interview_1_active', occurredOn: '2026-09-03' }, repo.snapshot());
  assert.equal(oldEvent.semantics.countsAsInterview, true);
  assert.equal(oldEvent.semantics.stageCategory, 'interview');
  assert.equal(next.event.semantics.countsAsInterview, false);
  assert.equal(next.event.semantics.stageCategory, 'ai_interview');
  assert.equal(next.event.definitionVersion, 2);
  const recolored = repo.updateStatusColor('interview_1_active', '#123456');
  assert.equal(recolored.color, '#123456');
});

test('改名后同时提供当前状态名称与事件录入时名称', () => {
  const r = enter(record('renamed-view'), 'screen', 'screening', '2026-09-02').record;
  const repo = createDefinitionRepository(definitions, { isStatusUsed: () => false });
  repo.renameStatus('screening', '简历初筛');
  const view = projectProgress(r, repo.snapshot(), '2026-09-17');
  assert.equal(view.currentStatusName, '简历初筛');
  assert.equal(view.currentEvent.statusNameSnapshot, '筛选中');
  assert.equal(view.visits[0].statusName, '简历初筛');
  assert.equal(view.visits[0].statusNameSnapshot, '筛选中');
});

test('原子纠正可替换失败事件并更新后续 reopen 引用，重试不会重复纠正', () => {
  let r = record('correct-failure');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'wrong-fail', 'interview_2_failed', '2026-09-04', { failedAt: { stageId: 'interview_2' } }).record;
  r = enter(r, 'reopen', 'pool', '2026-09-05', { mode: 'reopen', reopenReason: '录入后继续跟进' }).record;
  const oldFailed = r.events[1];
  const input = { commandId: 'corrected-fail', statusId: 'interview_1_failed', occurredOn: '2026-09-04', failedAt: { stageId: 'interview_1' }, notes: '实际在一面结束' };
  const corrected = correctProgressEvent(r, definitions, oldFailed.id, input, context());
  const view = projectProgress(corrected.record, definitions, '2026-09-17');
  assert.equal(corrected.record.events.find(event => event.id === oldFailed.id).invalidatedAt, '2026-09-17T12:00:00.000Z');
  assert.equal(view.failedAt, null);
  assert.deepEqual(view.events.map(event => event.statusId), ['submitted', 'interview_1_failed', 'pool']);
  assert.equal(view.events[1].failedAt.stageId, 'interview_1');
  assert.equal(view.events[2].reopensEventId, view.events[1].id);
  const retry = correctProgressEvent(corrected.record, definitions, oldFailed.id, input, context());
  assert.equal(retry.duplicate, true);
  assert.equal(retry.record.events.length, corrected.record.events.length);
});

test('有后续 reopen 时不能单独纠正掉原结束结果；重开事件不能变成终态', () => {
  let r = record('dependent-reopen');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'fail', 'interview_2_failed', '2026-09-04', { failedAt: { stageId: 'interview_2' } }).record;
  r = enter(r, 'reopen', 'pool', '2026-09-05', { mode: 'reopen', reopenReason: '继续跟进' }).record;
  const failureId = r.events[1].id;
  assert.throws(() => correctProgressEvent(r, definitions, failureId, { commandId: 'erase-failure', statusId: 'interview_1_active', occurredOn: '2026-09-04' }, context()), code('VALIDATION'));
  assert.equal(r.events.find(event => event.id === failureId).invalidatedAt, null);
  assert.throws(() => correctProgressEvent(r, definitions, r.events[2].id, { commandId: 'terminal-reopen', statusId: 'withdrawn', occurredOn: '2026-09-05' }, context()), code('VALIDATION'));
});

test('补录可并入已有环节 visit；unknown 挂点保留最后已知上下文', () => {
  let r = record('backfill-continue');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'i1-active', 'interview_1_active', '2026-09-02').record;
  const visitId = r.events.at(-1).visitId;
  r = enter(r, 'i1-passed', 'interview_1_passed', '2026-09-04', { mode: 'continue_visit' }).record;
  r = enter(r, 'i1-result-backfill', 'interview_1_result', '2026-09-03', { mode: 'backfill', beforeEventId: r.events.at(-1).id, continueVisit: true }).record;
  const view = projectProgress(r, definitions, '2026-09-17');
  assert.equal(view.events[2].visitId, visitId);
  assert.equal(view.events[2].source, 'backfilled');
  assert.equal(view.visits.filter(visit => visit.stageId === 'interview_1').length, 1);

  let failed = record('unknown-context');
  failed = enter(failed, 'submit', 'submitted', '2026-09-01').record;
  failed = enter(failed, 'i2', 'interview_2_active', '2026-09-02').record;
  failed = enter(failed, 'unknown-fail', 'failed_unknown', '2026-09-03', { failedAt: 'unknown' }).record;
  assert.equal(failed.events.at(-1).contextStageId, 'interview_2');
});

test('语义默认值变更后，旧 commandId 重试仍保持幂等', () => {
  let r = record('phase-retry');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  const input = { commandId: 'waiting', statusId: 'written_test_waiting', occurredOn: '2026-09-02' };
  r = append(r, input).record;
  const repo = createDefinitionRepository(definitions, { isStatusUsed: () => false });
  repo.updateStatusSemantics('written_test_waiting', { semantic: 'stage', stageId: 'written_test', defaultPhase: 'in_progress', statisticsCategory: 'written_test' });
  const retry = append(r, input, repo.snapshot());
  assert.equal(retry.duplicate, true);
  assert.equal(retry.event.phase, 'waiting');
});

test('删除误录的进展：后续同一轮的记录并回前一轮，经历次数回到一次', () => {
  let r = record('remove-mistake');
  r = enter(r, 'submit', 'submitted', '2026-09-01').record;
  r = enter(r, 'wait', 'interview_1_waiting', '2026-09-02').record;
  r = enter(r, 'again', 'interview_1_waiting', '2026-09-03').record;
  r = enter(r, 'active', 'interview_1_active', '2026-09-04', { mode: 'continue_visit' }).record;
  const visits = current => new Set(current.events.filter(event => event.invalidatedAt === null && event.semantics.stageId === 'interview_1').map(event => event.visitId)).size;
  const id = commandId => r.events.find(event => event.commandId === commandId).id;
  assert.equal(visits(r), 2);

  const cleaned = invalidateProgressEvent(r, definitions, id('again'), '2026-09-17T15:00:00.000Z');
  const active = cleaned.events.filter(event => event.invalidatedAt === null);
  assert.deepEqual(active.map(event => [event.commandId, event.sequence]), [['submit', 1], ['wait', 2], ['active', 3]]);
  assert.equal(visits(cleaned), 1);

  // With nothing of the same stage before it, the continuing record opens its own visit.
  const onlyActive = invalidateProgressEvent(cleaned, definitions, id('wait'), '2026-09-17T15:01:00.000Z');
  const orphan = onlyActive.events.find(event => event.id === id('active'));
  assert.equal(orphan.visitAction, 'new');
  assert.equal(orphan.source, 'entered');
  assert.equal(visits(onlyActive), 1);
});
