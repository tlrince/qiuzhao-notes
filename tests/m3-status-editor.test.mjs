import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.M3_STATUS_EDITOR_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const domain = await moduleAt('domain/v2/index.js');
const editor = await moduleAt('features/applications/progress-status-editor.js');

const definitions = domain.defaultR1Definitions();
const record = id => domain.createProgressRecord(id);
let serial = 0;
function append(current, statusId, occurredOn = '2026-09-17', options = {}, defs = definitions) {
  let idSerial = 0;
  const result = domain.appendProgressEvent(current, defs, {
    commandId: `domain-${++serial}`,
    statusId,
    occurredOn,
    ...options,
  }, { now: '2026-09-17T12:00:00.000Z', id: () => `event-${serial}-${++idSerial}` });
  return result.record;
}
function draft(overrides = {}) {
  return {
    mode: 'append',
    statusId: 'submitted',
    occurredOn: '2026-09-17',
    phase: '',
    failedAt: '',
    eventId: '',
    notes: '',
    reopenReason: '',
    ...overrides,
  };
}
function build(current, progressDraft, overrides = {}) {
  return editor.buildProgressStatusEditorCommand({
    definitions,
    record: current,
    expectedRevision: 5,
    draft: progressDraft,
    today: '2026-09-17',
    commandId: 'ui-command',
    ...overrides,
  });
}

test('active status options exclude archived states and states linked to archived stages', () => {
  const customized = structuredClone(definitions);
  customized.stages.find(item => item.id === 'interview_1').archivedAt = '2026-09-17T00:00:00.000Z';
  customized.statuses.find(item => item.id === 'submitted').archivedAt = '2026-09-17T00:00:00.000Z';
  const ids = editor.activeProgressStatuses(customized).map(item => item.id);
  assert.equal(ids.includes('submitted'), false);
  assert.equal(ids.includes('interview_1_active'), false);
  assert.equal(ids.includes('written_test_active'), true);
});

test('Offer decisions stay unavailable until a valid pending Offer exists', () => {
  const current = append(record('offers'), 'submitted');
  let choices = editor.allowedProgressStatuses(definitions, current, { mode: 'append', eventId: '' }).map(item => item.id);
  assert.equal(choices.includes('offer_accepted'), false);
  assert.equal(choices.includes('offer_declined'), false);
  assert.throws(() => build(current, draft({ statusId: 'offer_declined' })), /请选择可用状态/);

  const withOffer = append(current, 'offer_received', '2026-09-18');
  assert.equal(editor.pendingOfferCountForDraft(withOffer, { mode: 'append', eventId: '' }), 1);
  choices = editor.allowedProgressStatuses(definitions, withOffer, { mode: 'append', eventId: '' }).map(item => item.id);
  assert.equal(choices.includes('offer_accepted'), true);
  assert.equal(choices.includes('offer_declined'), true);
  const decline = build(withOffer, draft({ statusId: 'offer_declined', occurredOn: '2026-09-19' }));
  assert.equal(decline.kind, 'append');
  assert.equal(decline.input.command.statusId, 'offer_declined');
  assert.equal(editor.pendingOfferCountForDraft(append(withOffer, 'offer_declined', '2026-09-19'), { mode: 'append', eventId: '' }), 0);
});

test('failed status requires an explicit live stage or unknown attribution', () => {
  const current = record('failure');
  assert.throws(() => build(current, draft({ statusId: 'interview_2_failed' })), /必须选择失败环节/);
  assert.throws(() => build(current, draft({ statusId: 'interview_2_failed', failedAt: 'unknown' })), /不能选择“环节未知”/);
  assert.throws(() => build(current, draft({ statusId: 'interview_2_failed', failedAt: 'stage:interview_1' })), /必须与所选状态一致/);
  const stageFailure = build(current, draft({ statusId: 'interview_2_failed', failedAt: 'stage:interview_2' }));
  assert.deepEqual(stageFailure.input.command.failedAt, { stageId: 'interview_2' });

  const unknownFailure = build(current, draft({ statusId: 'failed_unknown', failedAt: 'unknown' }));
  assert.equal(unknownFailure.input.command.failedAt, 'unknown');
  const attributedFailure = build(current, draft({ statusId: 'failed_unknown', failedAt: 'stage:screening' }));
  assert.deepEqual(attributedFailure.input.command.failedAt, { stageId: 'screening' });
});

test('append builder defaults an empty date, trims notes, and emits an ApplicationCommands-compatible input', () => {
  const result = build(record('append'), draft({ statusId: 'interview_1_waiting', occurredOn: '', phase: '', notes: '  等待招聘方安排  ' }));
  assert.equal(result.kind, 'append');
  assert.deepEqual(result.input, {
    applicationId: 'append',
    expectedRevision: 5,
    command: {
      commandId: 'ui-command',
      statusId: 'interview_1_waiting',
      occurredOn: '2026-09-17',
      notes: '等待招聘方安排',
    },
  });
  const explicitPhase = build(record('phase'), draft({ statusId: 'interview_1_waiting', phase: 'waiting' }));
  assert.equal(explicitPhase.input.command.phase, 'waiting');
});

test('correction requires an active target and preserves it as the ApplicationCommands eventId', () => {
  const current = append(record('correct'), 'submitted', '2026-09-01');
  const eventId = current.events[0].id;
  assert.throws(() => build(current, draft({ mode: 'correct', statusId: 'interview_1_active' })), /请选择一条有效进度事件/);
  const result = build(current, draft({ mode: 'correct', eventId, statusId: 'interview_1_active', occurredOn: '2026-09-02', notes: '  更正  ' }));
  assert.equal(result.kind, 'correct');
  assert.equal(result.input.eventId, eventId);
  assert.equal(result.input.command.notes, '更正');
  assert.equal(result.input.expectedRevision, 5);
  assert.throws(() => build(current, draft({ mode: 'correct', eventId: 'missing-event', statusId: 'submitted' })), /请选择一条有效进度事件/);
});

test('append after a terminal outcome requires an explicit reopen reason and a non-terminal next status', () => {
  const current = append(record('reopen'), 'failed_unknown', '2026-09-01', { failedAt: 'unknown' });
  assert.throws(() => build(current, draft({ statusId: 'pool' })), /重新开启流程必须记录原因/);
  assert.throws(() => build(current, draft({ statusId: 'failed_unknown', failedAt: 'unknown', reopenReason: '继续面试' })), /必须选择一个进行中的状态/);
  const reopened = build(current, draft({ statusId: 'pool', reopenReason: '招聘方恢复流程' }));
  assert.equal(reopened.input.command.mode, 'reopen');
  assert.equal(reopened.input.command.reopenReason, '招聘方恢复流程');
});

test('validates the optional phase, command identifier, date, and revision before producing input', () => {
  const current = record('validation');
  assert.throws(() => build(current, draft({ statusId: 'interview_1_waiting', phase: 'passed' })), /必须与所选状态定义一致/);
  assert.throws(() => build(current, draft({ occurredOn: '2026-02-31' })), /日期/);
  assert.throws(() => build(current, draft(), { commandId: '  ' }), /commandId 必填/);
  assert.throws(() => build(current, draft(), { expectedRevision: -1 }), /快照版本无效/);
});

test('defaults dates in the plan’s Asia/Shanghai business timezone', () => {
  assert.equal(editor.localBusinessDate(new Date('2026-09-16T16:30:00.000Z')), '2026-09-17');
});

test('forward progress inside one active stage continues the visit unless the user starts a new round', () => {
  const current = append(append(record('visit'), 'submitted', '2026-09-01'), 'written_test_active', '2026-09-02');
  const forward = build(current, draft({ statusId: 'written_test_passed', occurredOn: '2026-09-03' }));
  assert.equal(forward.input.command.mode, 'continue_visit');
  const applied = domain.appendProgressEvent(current, definitions, forward.input.command, { now: '2026-09-17T12:00:00.000Z', id: () => 'visit-event' }).record;
  const visits = domain.projectProgress(applied, definitions, '2026-09-17').visits.filter(visit => visit.stageId === 'written_test');
  assert.equal(visits.length, 1, '笔试中 → 笔试通过 是同一轮');

  assert.equal(build(current, draft({ statusId: 'written_test_passed', visitChoice: 'new' })).input.command.mode, undefined);
  assert.equal(build(current, draft({ statusId: 'written_test_waiting' })).input.command.mode, undefined, '退回待笔试默认是新的一轮');
  assert.equal(build(current, draft({ statusId: 'interview_1_waiting' })).input.command.mode, undefined, '换环节不续接');
  assert.throws(() => build(current, draft({ statusId: 'interview_1_waiting', visitChoice: 'continue' })), /同一环节内仍在进行/);

  const screening = append(append(record('screen'), 'submitted', '2026-09-01'), 'screening', '2026-09-02');
  assert.equal(build(screening, draft({ statusId: 'screening' })).input.command.mode, undefined, '再次筛选是新的一轮');
  const failed = append(current, 'written_test_failed', '2026-09-04', { failedAt: { stageId: 'written_test' } });
  assert.deepEqual(editor.visitContinuation(definitions, failed, 'written_test_passed'), { possible: false, suggested: false });
});
