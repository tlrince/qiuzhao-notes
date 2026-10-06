import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendProgressEvent,
  createProgressRecord,
  defaultR1Definitions,
  invalidateProgressEvent,
  projectProgressTable,
} from '../dist/domain/v2/index.js';

const definitions = defaultR1Definitions();
const NOW = '2026-09-17';
let serial = 0;

function makeRecord(id, inputs = [], defs = definitions) {
  let record = createProgressRecord(id);
  for (const input of inputs) {
    const call = ++serial;
    record = appendProgressEvent(record, defs, input, {
      now: `2026-09-17T12:${String(call % 60).padStart(2, '0')}:00.000Z`,
      id: () => `r3-${id}-${call}-${++serial}`,
    }).record;
  }
  return record;
}

function applicationFor(record, overrides = {}) {
  const events = record.events.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
  const current = events.at(-1) ?? null;
  return {
    id: record.applicationId,
    seasonId: 'season-1',
    company: `公司 ${record.applicationId}`,
    role: '工程师',
    city: '上海',
    channelId: 'channel-1',
    jobUrl: '',
    trackingUrl: '',
    appliedOn: record.appliedOn,
    currentStatusId: current?.statusId ?? 'draft',
    currentStage: current?.semantics.stageId ?? current?.contextStageId ?? null,
    phase: current?.phase ?? 'unknown',
    outcome: current?.semantics.terminalOutcome ?? 'active',
    failedAt: current?.semantics.terminalOutcome === 'failed' ? structuredClone(current.failedAt) : null,
    currentEventId: current?.id ?? null,
    isStarred: false,
    notes: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-17T12:00:00.000Z',
    ...overrides,
  };
}

function table(entries, options = {}) {
  return projectProgressTable({
    applications: entries.map(entry => entry.application ?? applicationFor(entry.record)),
    progressRecords: entries.map(entry => entry.record),
    definitions: options.definitions ?? definitions,
    schedules: options.schedules ?? [],
    now: options.now ?? NOW,
    pinnedStageIds: options.pinnedStageIds ?? [],
    ...(options.filters ? { filters: options.filters } : {}),
  });
}

function enter(id, statusId, occurredOn, extra = {}) {
  return { commandId: `${id}-${statusId}-${occurredOn}-${++serial}`, statusId, occurredOn, ...extra };
}

function cell(row, stageId) {
  assert.ok(row.stageCells[stageId], `expected a projected cell for ${stageId}`);
  return row.stageCells[stageId];
}

test('空历史 draft 保持“待投递”，没有虚构环节经历', () => {
  const record = makeRecord('draft');
  const result = table([{ record }]);
  const row = result.rows[0];
  assert.equal(row.current.statusId, 'draft');
  assert.equal(row.current.statusName, '待投递');
  assert.equal(row.current.stageId, null);
  assert.equal(row.current.outcome, 'active');
  assert.equal(row.current.occurredOn, null);
  assert.equal(row.currentStayDays, null);
  assert.deepEqual(row.events, []);
  assert.deepEqual(result.columns, []);
  assert.deepEqual(Object.keys(row.stageCells), []);
  assert.equal(row.hasHistoricalFailure, false);
});

test('列由实际经历和固定列生成，跳到二面不补前置环节，筛选不改变列集合或顺序', () => {
  const screening = makeRecord('screening', [enter('screening', 'screening', '2026-09-02')]);
  const directInterview = makeRecord('direct-i2', [enter('direct-i2', 'interview_2_active', '2026-09-03')]);
  const entries = [
    { record: screening },
    { record: directInterview },
  ];
  const unfiltered = table(entries, { pinnedStageIds: ['assessment'] });
  const filtered = table(entries, { pinnedStageIds: ['assessment'], filters: { currentStatusIds: ['interview_2_active'] } });
  const ids = unfiltered.columns.map(column => column.id);
  assert.deepEqual(ids, filtered.columns.map(column => column.id));
  assert.ok(ids.includes('screening'));
  assert.ok(ids.includes('interview_2'));
  assert.ok(ids.includes('assessment'));
  assert.ok(!ids.includes('interview_1'));
  assert.deepEqual(unfiltered.columns.map(column => column.sortOrder), [...unfiltered.columns].map(column => column.sortOrder).sort((a, b) => a - b));
  assert.deepEqual(filtered.rows.map(row => row.application.id), ['direct-i2']);
  assert.equal(cell(filtered.rows[0], 'interview_2').visitCount, 1);
  assert.equal(filtered.rows[0].stageCells.interview_1?.visitCount ?? 0, 0);
});

test('同一 visit 多个 phase 只计一次，首日、最近状态日与实际日期分开', () => {
  let record = makeRecord('phase', [enter('phase', 'interview_1_waiting', '2026-09-02')]);
  const visitId = record.events.at(-1).visitId;
  record = appendProgressEvent(record, definitions, { ...enter('phase', 'interview_1_active', '2026-09-04'), mode: 'continue_visit' }, { now: '2026-09-17T12:00:00.000Z', id: () => `phase-${++serial}` }).record;
  record = appendProgressEvent(record, definitions, { ...enter('phase', 'interview_1_result', '2026-09-05'), mode: 'continue_visit' }, { now: '2026-09-17T12:01:00.000Z', id: () => `phase-${++serial}` }).record;
  const row = table([{ record }]).rows[0];
  const interview = cell(row, 'interview_1');
  assert.equal(interview.visitCount, 1);
  assert.equal(interview.visits.length, 1);
  assert.equal(interview.visits[0].id, visitId);
  assert.equal(interview.visits[0].enteredOn, '2026-09-02');
  assert.equal(interview.visits[0].latestOn, '2026-09-05');
  assert.equal(interview.visits[0].actualOn, '2026-09-05');
  assert.equal(interview.latestStatusId, 'interview_1_result');
  assert.equal(interview.latestPhase, 'awaiting_result');
  assert.equal(interview.latestOccurredOn, '2026-09-05');
  assert.equal(interview.latestActualOn, '2026-09-05');
  assert.equal(interview.current, true);
  assert.equal(row.currentStayDays, 15);
  assert.ok(interview.stayBasis);
});

test('重复筛选保留两个 visit 和各自日期，不按阶段顺序折叠', () => {
  const record = makeRecord('repeat-screen', [
    enter('repeat-screen', 'submitted', '2026-09-01'),
    enter('repeat-screen', 'screening', '2026-09-02'),
    enter('repeat-screen', 'written_test_active', '2026-09-03'),
    enter('repeat-screen', 'screening', '2026-09-04'),
    enter('repeat-screen', 'ai_active', '2026-09-05'),
  ]);
  const screening = cell(table([{ record }]).rows[0], 'screening');
  assert.equal(screening.visitCount, 2);
  assert.deepEqual(screening.visits.map(visit => visit.enteredOn), ['2026-09-02', '2026-09-04']);
  assert.deepEqual(screening.visits.map(visit => visit.latestOn), ['2026-09-02', '2026-09-04']);
  assert.equal(screening.latestOccurredOn, '2026-09-04');
  assert.equal(screening.current, false);
});

test('离开环节后用下一事件日期算最近 visit 停留；当前 visit 从进入日算到 now', () => {
  const closedRecord = makeRecord('closed', [
    enter('closed', 'screening', '2026-09-02'),
    enter('closed', 'written_test_active', '2026-09-06'),
  ]);
  const currentRecord = makeRecord('current-stay', [enter('current-stay', 'interview_2_active', '2026-09-10')]);
  const result = table([{ record: closedRecord }, { record: currentRecord }]);
  const closed = result.rows.find(row => row.application.id === 'closed');
  const current = result.rows.find(row => row.application.id === 'current-stay');
  assert.equal(cell(closed, 'screening').visits[0].durationDays, 4);
  assert.equal(cell(closed, 'screening').stayDays, 4);
  assert.equal(cell(closed, 'screening').current, false);
  assert.equal(current.currentStayDays, 7);
  assert.equal(cell(current, 'interview_2').visits[0].durationDays, 7);
  assert.equal(cell(current, 'interview_2').stayDays, 7);
  assert.equal(cell(current, 'interview_2').current, true);
});

test('当前状态筛选与曾经历筛选独立；当前停留范围使用当前 visit 天数', () => {
  const leftScreening = makeRecord('left-screening', [
    enter('left-screening', 'screening', '2026-09-01'),
    enter('left-screening', 'written_test_active', '2026-09-03'),
  ]);
  const stillScreening = makeRecord('still-screening', [enter('still-screening', 'screening', '2026-09-13')]);
  const entries = [{ record: leftScreening }, { record: stillScreening }];
  assert.deepEqual(table(entries, { filters: { currentStatusIds: ['screening'] } }).rows.map(row => row.application.id), ['still-screening']);
  assert.deepEqual(table(entries, { filters: { historyStatusIds: ['screening'] } }).rows.map(row => row.application.id), ['left-screening', 'still-screening']);
  assert.deepEqual(table(entries, { filters: { minCurrentStayDays: 5 } }).rows.map(row => row.application.id), ['left-screening']);
  assert.deepEqual(table(entries, { filters: { maxCurrentStayDays: 4 } }).rows.map(row => row.application.id), ['still-screening']);
});

test('失败归因不会伪造实际面试日期；复活后当前失败和历史失败筛选分开', () => {
  const failureOnly = makeRecord('failure-only', [
    enter('failure-only', 'submitted', '2026-09-01'),
    enter('failure-only', 'interview_2_failed', '2026-09-05', { failedAt: { stageId: 'interview_2' } }),
  ]);
  let revived = makeRecord('revived', [
    enter('revived', 'submitted', '2026-09-01'),
    enter('revived', 'interview_2_failed', '2026-09-05', { failedAt: { stageId: 'interview_2' } }),
  ]);
  revived = appendProgressEvent(revived, definitions, { ...enter('revived', 'pool', '2026-09-08'), mode: 'reopen', reopenReason: '继续招聘流程' }, { now: '2026-09-17T12:00:00.000Z', id: () => `revived-${++serial}` }).record;
  const entries = [{ record: failureOnly }, { record: revived }];
  const failedRow = table([entries[0]]).rows[0];
  assert.equal(failedRow.current.outcome, 'failed');
  assert.equal(failedRow.current.failedAt.stageId, 'interview_2');
  const failedInterview = cell(failedRow, 'interview_2');
  assert.equal(failedInterview.visitCount, 0);
  assert.equal(failedInterview.failureEvents.length, 1);
  assert.equal(failedInterview.failureEvents[0].semantics.terminalOutcome, 'failed');
  assert.equal(failedInterview.failureEvents[0].failedAt.stageId, 'interview_2');
  assert.equal(failedInterview.latestActualOn, null);
  assert.deepEqual(table(entries, { filters: { currentFailureAt: 'interview_2' } }).rows.map(row => row.application.id), ['failure-only']);
  assert.deepEqual(table(entries, { filters: { currentFailureAt: ['interview_2'] } }).rows.map(row => row.application.id), ['failure-only']);
  assert.deepEqual(table(entries, { filters: { currentOutcomes: ['active'] } }).rows.map(row => row.application.id), ['revived']);
  assert.deepEqual(table(entries, { filters: { historyOutcomes: ['failed'] } }).rows.map(row => row.application.id), ['failure-only', 'revived']);
  assert.equal(table([entries[1]]).rows[0].hasHistoricalFailure, true);
});

test('Offer 决定不增加获得次数，拒绝 Offer 不算失败且保留获得日期', () => {
  const record = makeRecord('offer-declined', [
    enter('offer-declined', 'submitted', '2026-09-01'),
    enter('offer-declined', 'offer_received', '2026-09-10'),
    enter('offer-declined', 'offer_declined', '2026-09-12'),
  ]);
  const row = table([{ record }]).rows[0];
  const offer = cell(row, 'offer');
  assert.equal(row.current.outcome, 'offer_declined');
  assert.equal(row.current.failedAt, null);
  assert.equal(offer.visitCount, 1);
  assert.equal(offer.offerReceipts.length, 1);
  const receipt = offer.offerReceipts[0];
  assert.equal(receipt.occurredOn ?? receipt.receivedOn ?? receipt.date, '2026-09-10');
  assert.equal(offer.latestOutcome, 'offer_declined');
  assert.deepEqual(table([{ record }], { filters: { currentOutcomes: ['failed'] } }).rows, []);
});

test('未来 pending 日程独立呈现，不作为实际环节日期或状态变更', () => {
  const record = makeRecord('scheduled', [
    enter('scheduled', 'submitted', '2026-09-01'),
    enter('scheduled', 'interview_2_waiting', '2026-09-12'),
  ]);
  const schedules = [
    { id: 'later', applicationId: 'scheduled', type: 'interview', title: '二面', startsAt: '2026-09-21T10:00:00.000Z', status: 'pending', notes: '' },
    { id: 'soon', applicationId: 'scheduled', type: 'interview', title: '二面加面', startsAt: '2026-09-18T10:00:00.000Z', status: 'pending', notes: '' },
    { id: 'completed', applicationId: 'scheduled', type: 'interview', title: '已完成历史日程', startsAt: '2026-09-15T10:00:00.000Z', status: 'completed', notes: '' },
    { id: 'cancelled', applicationId: 'scheduled', type: 'interview', title: '已取消', startsAt: '2026-09-16T10:00:00.000Z', status: 'cancelled', notes: '' },
    { id: 'other-app', applicationId: 'another', type: 'interview', title: '其他岗位', startsAt: '2026-09-18T09:00:00.000Z', status: 'pending', notes: '' },
  ];
  const row = table([{ record }], { schedules }).rows[0];
  assert.equal(row.nextSchedule.id, 'soon');
  assert.deepEqual(row.pendingSchedules.map(schedule => schedule.id), ['soon', 'later']);
  const interview = cell(row, 'interview_2');
  assert.equal(interview.latestPhase, 'waiting');
  assert.equal(interview.latestActualOn, null);
  assert.equal(interview.visits[0].actualOn, null);
  assert.equal(interview.visits[0].enteredOn, '2026-09-12');
});

test('作废历史不进入单元格、events 或历史状态筛选', () => {
  let record = makeRecord('invalidated', [
    enter('invalidated', 'submitted', '2026-09-01'),
    enter('invalidated', 'screening', '2026-09-02'),
    enter('invalidated', 'written_test_active', '2026-09-03'),
  ]);
  const screeningEvent = record.events.find(event => event.statusId === 'screening');
  record = invalidateProgressEvent(record, definitions, screeningEvent.id, '2026-09-17T12:00:00.000Z');
  const result = table([{ record }]);
  const row = result.rows[0];
  assert.deepEqual(row.events.map(event => event.statusId), ['submitted', 'written_test_active']);
  assert.equal(row.stageCells.screening?.visitCount ?? 0, 0);
  assert.deepEqual(table([{ record }], { filters: { historyStatusIds: ['screening'] } }).rows, []);
});

test('迁移标记为 uncertain 的连接不产生精确停留时长', () => {
  const record = makeRecord('uncertain', [
    enter('uncertain', 'screening', '2026-09-02'),
    enter('uncertain', 'written_test_active', '2026-09-08'),
  ]);
  const [from, to] = record.events;
  record.migrationReview = {
    status: 'needs_confirmation',
    uncertainEdges: [{ fromEventId: from.id, toEventId: to.id, reason: '旧历史跨数组顺序待确认' }],
  };
  const row = table([{ record }]).rows[0];
  assert.equal(cell(row, 'screening').visits[0].durationDays, null);
  assert.equal(cell(row, 'screening').stayDays, null);
  assert.equal(row.currentStayDays, null);
  assert.match(String(cell(row, 'screening').visits[0].stayBasis), /uncertain|needs_confirmation|待确认/i);
});

test('投影不修改调用方的岗位、事件或日程数据', () => {
  const record = makeRecord('immutable', [
    enter('immutable', 'submitted', '2026-09-01'),
    enter('immutable', 'screening', '2026-09-02'),
  ]);
  const application = applicationFor(record);
  const schedule = { id: 'immutable-schedule', applicationId: 'immutable', type: 'follow_up', title: '跟进', startsAt: '2026-09-18T00:00:00.000Z', status: 'pending', notes: '' };
  const before = structuredClone({ application, record, schedule });
  table([{ application, record }], { schedules: [schedule] });
  assert.deepEqual({ application, record, schedule }, before);
});

test('currentStage 不能仅指向与当前语义环节不同的 contextStageId', () => {
  const record = makeRecord('stage-context-mismatch', [
    enter('stage-context-mismatch', 'interview_2_failed', '2026-09-05', {
      failedAt: { stageId: 'interview_2' },
      contextStageId: 'interview_1',
    }),
  ]);
  const application = applicationFor(record, { currentStage: 'interview_1' });
  assert.throws(() => table([{ record, application }]));
});

test('投递日期与进度记录 appliedOn 不一致时拒绝投影', () => {
  const record = makeRecord('applied-on-mismatch', [enter('applied-on-mismatch', 'submitted', '2026-09-01')]);
  const application = applicationFor(record, { appliedOn: '2026-09-02' });
  assert.throws(() => table([{ record, application }]));
});

test('多笔 Offer 未决定时只有一条拒绝结果，receipt 不猜测对应关系', () => {
  const record = makeRecord('ambiguous-offers', [
    enter('ambiguous-offers', 'submitted', '2026-09-01'),
    enter('ambiguous-offers', 'offer_received', '2026-09-10'),
    enter('ambiguous-offers', 'offer_received', '2026-09-11'),
    enter('ambiguous-offers', 'offer_declined', '2026-09-12'),
  ]);
  const offer = cell(table([{ record }]).rows[0], 'offer');
  assert.equal(offer.offerReceipts.length, 2);
  assert.deepEqual(offer.offerReceipts.map(receipt => receipt.decision), ['needs_confirmation', 'needs_confirmation']);
});
