import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateV2Analytics } from '../dist/domain/v2/analytics.js';

const stages = [
  { id: 'screening', name: '简历筛选', category: 'screening', sortOrder: 10, archivedAt: null, countsAsInterview: false },
  { id: 'written_test', name: '笔试', category: 'written_test', sortOrder: 20, archivedAt: null, countsAsInterview: false },
  { id: 'interview_1', name: '一面', category: 'interview', sortOrder: 30, archivedAt: null, countsAsInterview: true, interviewRound: 1 },
  { id: 'interview_2', name: '二面', category: 'interview', sortOrder: 40, archivedAt: null, countsAsInterview: true, interviewRound: 2 },
  { id: 'ai', name: 'AI 面', category: 'ai_interview', sortOrder: 50, archivedAt: null, countsAsInterview: false },
  { id: 'pool', name: '泡池子', category: 'pool', sortOrder: 60, archivedAt: null, countsAsInterview: false },
  { id: 'offer', name: 'Offer', category: 'offer', sortOrder: 70, archivedAt: null, countsAsInterview: false },
];

function event(id, semantic, stageId, stageCategory, phase, outcome = 'active', options = {}) {
  return {
    id, applicationId: options.applicationId ?? '', commandId: id, statusId: `${semantic}-${stageId ?? 'none'}`,
    statusNameSnapshot: options.name ?? id, definitionVersion: 1,
    semantics: {
      semantic, stageId, stageCategory, stageNameSnapshot: stageId ? (stages.find(item => item.id === stageId)?.name ?? stageId) : null,
      countsAsInterview: options.countsAsInterview ?? stageCategory === 'interview', statisticsCategory: null, terminalOutcome: outcome,
    },
    phase, occurredOn: options.date ?? '2026-09-01', createdAt: `${options.date ?? '2026-09-01'}T12:00:00.000Z`,
    sequence: options.sequence ?? 1, previousEventId: options.previousEventId ?? null, visitId: options.visitId ?? `visit-${id}`,
    source: 'entered', visitAction: 'new', insertedBeforeEventId: null, reopenReason: null, reopensEventId: null,
    correctionOfEventId: null, failedAt: options.failedAt ?? null, contextStageId: null, notes: '', invalidatedAt: options.invalidatedAt ?? null,
    ...(options.migrationMeta ? { migrationMeta: options.migrationMeta } : {}),
  };
}

function progress(applicationId, entries, migrationReview = undefined) {
  return { applicationId, appliedOn: entries.find(item => item.semantics.semantic === 'submitted' && item.invalidatedAt === null)?.occurredOn ?? null, events: entries.map((item, index) => ({ ...item, applicationId, sequence: index + 1, previousEventId: index ? entries[index - 1].id : null })), annotations: [], ...(migrationReview ? { migrationReview } : {}) };
}

function row(id, { city = '上海', channelId = 'referral', appliedOn = null, currentStage = null, outcome = 'active', failedAt = null, events = [] } = {}) {
  const effectiveEvents = events.length ? events : appliedOn === null ? [] : [event(`${id}-submitted`, 'submitted', null, null, 'unknown', 'active', { date: appliedOn })];
  const currentEvent = effectiveEvents.at(-1) ?? null;
  return {
    application: { id, seasonId: 'season', company: `公司${id}`, role: '工程师', city, channelId, jobUrl: '', trackingUrl: '', appliedOn, currentStatusId: currentEvent?.statusId ?? 'draft', currentStage, phase: currentEvent?.phase ?? 'unknown', outcome, failedAt, currentEventId: currentEvent?.id ?? null, isStarred: false, notes: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    progress: progress(id, effectiveEvents),
  };
}

function makeSnapshot(rows, options = {}) {
  const channels = options.channels ?? [{ id: 'referral', name: '内推', archivedAt: null }, { id: 'site', name: '官网', archivedAt: null }];
  return {
    schemaVersion: 2,
    workspace: { id: 'w', name: '工作区', timeZone: options.timeZone ?? 'Asia/Shanghai', activeSeasonId: 'season' },
    seasons: [{ id: 'season', name: '秋招', startDate: options.startDate ?? '2026-09-01', endDate: options.endDate ?? '2026-12-31', targetCount: options.targetCount ?? 20, archivedAt: null }],
    channels, settings: { schemaVersion: 2, lastBackupAt: null, preferences: {} },
    applications: rows.map(item => item.application), schedules: [], definitions: { stages: options.stages ?? stages, statuses: [] },
    progressRecords: rows.map(item => item.progress), legacyHistory: [], migration: null,
  };
}

function submitted(id, date, sequence, previousEventId, options = {}) {
  return event(`${id}-submit`, 'submitted', null, null, 'unknown', 'active', { date, sequence, previousEventId, visitId: `${id}-submission` });
}

function stageEvent(id, stageId, date, sequence, previousEventId, options = {}) {
  const definition = stages.find(item => item.id === stageId);
  return event(id, options.semantic ?? 'stage', stageId, options.stageCategory ?? definition?.category ?? 'custom', options.phase ?? 'in_progress', options.outcome ?? 'active', {
    date, sequence, previousEventId, visitId: options.visitId ?? `${id}-visit`, failedAt: options.failedAt,
    invalidatedAt: options.invalidatedAt, migrationMeta: options.migrationMeta, name: options.name, countsAsInterview: options.countsAsInterview,
  });
}

function sampleSnapshot() {
  const makeRows = [];
  makeRows.push(row('A'));
  makeRows.push(row('B', { appliedOn: '2026-09-14', channelId: 'referral', city: '上海' }));
  const cSubmit = submitted('C', '2026-09-14', 1);
  const cTest = stageEvent('C-test', 'written_test', '2026-09-15', 2, cSubmit.id, { visitId: 'C-test-visit' });
  const cFail = event('C-fail', 'failed', 'written_test', 'written_test', 'unknown', 'failed', { date: '2026-09-16', failedAt: { stageId: 'written_test', stageNameSnapshot: '笔试' } });
  makeRows.push(row('C', { appliedOn: '2026-09-14', channelId: 'site', city: '北京', currentStage: 'written_test', outcome: 'failed', failedAt: cFail.failedAt, events: [cSubmit, cTest, cFail] }));
  const dSubmit = submitted('D', '2026-09-15', 1);
  const dInterview = stageEvent('D-interview', 'interview_1', '2026-09-16', 2, dSubmit.id);
  makeRows.push(row('D', { appliedOn: '2026-09-15', channelId: 'referral', city: '上海', currentStage: 'interview_1', events: [dSubmit, dInterview] }));
  const eSubmit = submitted('E', '2026-09-15', 1);
  const eTest = stageEvent('E-test', 'written_test', '2026-09-15', 2, eSubmit.id);
  const eI1 = stageEvent('E-i1', 'interview_1', '2026-09-16', 3, eTest.id, { visitId: 'E-i1-visit' });
  const eI1Continue = stageEvent('E-i1-waiting-result', 'interview_1', '2026-09-16', 4, eI1.id, { phase: 'awaiting_result', visitId: 'E-i1-visit' });
  const eI2 = stageEvent('E-i2', 'interview_2', '2026-09-16', 5, eI1Continue.id, { visitId: 'E-i2-visit' });
  const eOffer = event('E-offer', 'offer_received', 'offer', 'offer', 'unknown', 'offer_received', { date: '2026-09-17' });
  makeRows.push(row('E', { appliedOn: '2026-09-15', channelId: 'site', city: '杭州', currentStage: 'offer', outcome: 'offer_received', events: [eSubmit, eTest, eI1, eI1Continue, eI2, eOffer] }));
  const fSubmit = submitted('F', '2026-09-16', 1);
  const fInterview = stageEvent('F-interview', 'interview_1', '2026-09-16', 2, fSubmit.id);
  const fWithdraw = event('F-withdrawn', 'withdrawn', null, null, 'unknown', 'withdrawn', { date: '2026-09-17' });
  makeRows.push(row('F', { appliedOn: '2026-09-16', channelId: 'referral', city: '深圳', currentStage: null, outcome: 'withdrawn', events: [fSubmit, fInterview, fWithdraw] }));
  return makeSnapshot(makeRows);
}

const shanghaiClock = { now: '2026-09-17T10:00:00.000Z', timeZone: 'Asia/Shanghai' };

test('fixed M5 sample counts drafts, unique submissions/interviews/offers, and actual stage touches', () => {
  const result = calculateV2Analytics(sampleSnapshot(), { seasonId: 'season' }, shanghaiClock);
  assert.equal(result.recordCount, 6);
  assert.equal(result.submittedCount, 5);
  assert.equal(result.activeCount, 2);
  assert.equal(result.humanInterviewCount, 3);
  assert.equal(result.aiInterviewCount, 0);
  assert.equal(result.offerCount, 1);
  assert.equal(result.interviewRate, 60);
  assert.equal(result.offerRate, 20);
  assert.equal(result.stages.find(stage => stage.stageId === 'submitted').touchCount, 5);
  assert.equal(result.stages.find(stage => stage.stageId === 'written_test').touchCount, 2);
  assert.equal(result.stages.find(stage => stage.stageId === 'interview_1').touchCount, 3);
  assert.equal(result.stages.find(stage => stage.stageId === 'interview_2').touchCount, 1);
  assert.equal(result.stages.find(stage => stage.stageId === 'offer').touchCount, 1);
  assert.equal(result.stages.find(stage => stage.stageId === 'interview_1').visitCount, 3);
  assert.equal(result.target.submittedCount, 5);
  assert.equal(result.target.count, 20);
  assert.equal(result.activity.reduce((sum, item) => sum + item.count, 0), 5);
  assert.equal(result.activity.find(item => item.date === '2026-09-15')?.count, 2, 'same-day submissions aggregate into one calendar day');
  assert.equal(result.thisWeekCount, 5);
  assert.equal(result.failedByStage.find(item => item.stageId === 'written_test')?.count, 1);
  assert.equal(result.channels.reduce((sum, item) => sum + item.submittedCount, 0), 5);
  assert.equal(result.cities.reduce((sum, item) => sum + item.count, 0), 5);
});

test('filtering by applied date excludes drafts and affects every scoped KPI but not season target', () => {
  const result = calculateV2Analytics(sampleSnapshot(), { seasonId: 'season', appliedDateRange: { from: '2026-09-15', to: '2026-09-15' } }, shanghaiClock);
  assert.equal(result.recordCount, 2);
  assert.equal(result.submittedCount, 2);
  assert.equal(result.activeCount, 1);
  assert.equal(result.humanInterviewCount, 2);
  assert.equal(result.offerCount, 1);
  assert.equal(result.target.submittedCount, 5);
  assert.deepEqual(result.activity.map(item => item.date), ['2026-09-15']);
  assert.equal(result.activity[0].count, 2);
});

test('zero submissions return null rates; outcome categories stay separate and receipts deduplicate by job', () => {
  const empty = row('draft');
  const noSubmission = calculateV2Analytics(makeSnapshot([empty], { targetCount: 0 }), { seasonId: 'season' }, shanghaiClock);
  assert.equal(noSubmission.recordCount, 1);
  assert.equal(noSubmission.submittedCount, 0);
  assert.equal(noSubmission.interviewRate, null);
  assert.equal(noSubmission.offerRate, null);
  assert.equal(noSubmission.target.rate, null);
  assert.equal(noSubmission.activity.reduce((sum, item) => sum + item.count, 0), 0);

  const s = submitted('Q', '2026-09-16', 1);
  const offer1 = event('Q-offer-1', 'offer_received', 'offer', 'offer', 'unknown', 'offer_received', { date: '2026-09-16' });
  const offer2 = event('Q-offer-2', 'offer_received', 'offer', 'offer', 'unknown', 'offer_received', { date: '2026-09-17' });
  const declined = event('Q-declined', 'offer_declined', 'offer', 'offer', 'unknown', 'offer_declined', { date: '2026-09-17' });
  const q = row('Q', { appliedOn: '2026-09-16', currentStage: 'offer', outcome: 'offer_declined', events: [s, offer1, offer2, declined] });
  const acceptedSubmit = submitted('R', '2026-09-16', 1);
  const acceptedOffer = event('R-offer', 'offer_received', 'offer', 'offer', 'unknown', 'offer_received', { date: '2026-09-17' });
  const accepted = event('R-accepted', 'offer_accepted', 'offer', 'offer', 'unknown', 'offer_accepted', { date: '2026-09-17' });
  const r = row('R', { appliedOn: '2026-09-16', currentStage: 'offer', outcome: 'offer_accepted', events: [acceptedSubmit, acceptedOffer, accepted] });
  const result = calculateV2Analytics(makeSnapshot([q, r]), { seasonId: 'season' }, shanghaiClock);
  assert.equal(result.offerCount, 2);
  assert.equal(result.offerDeclinedCount, 1);
  assert.equal(result.failedCount, 0);
});

test('current failures are counted once in their failedAt group, with unknown kept distinct', () => {
  const makeFailure = (id, failedAt) => {
    const s = submitted(id, '2026-09-10', 1);
    const failure = event(`${id}-failed`, 'failed', failedAt === 'unknown' ? null : failedAt.stageId, failedAt === 'unknown' ? null : 'written_test', 'unknown', 'failed', { date: '2026-09-11', failedAt });
    return row(id, { appliedOn: '2026-09-10', currentStage: failure.semantics.stageId, outcome: 'failed', failedAt, events: [s, failure] });
  };
  const result = calculateV2Analytics(makeSnapshot([
    makeFailure('Known', { stageId: 'written_test', stageNameSnapshot: '笔试' }),
    makeFailure('Unknown', 'unknown'),
  ]), { seasonId: 'season' }, shanghaiClock);
  assert.equal(result.failedCount, 2);
  assert.deepEqual(result.failedByStage.map(item => [item.stageId, item.count]), [['written_test', 1], ['unknown', 1]]);
});

test('actual interview and stage touches count even when the job has no submitted event or applied date', () => {
  const interview = stageEvent('Late-interview', 'interview_1', '2026-09-11', 1, null);
  const direct = row('Late', { city: '北京', appliedOn: null, currentStage: 'interview_1', events: [interview] });
  const result = calculateV2Analytics(makeSnapshot([direct]), { seasonId: 'season' }, shanghaiClock);
  assert.equal(result.recordCount, 1);
  assert.equal(result.submittedCount, 0);
  assert.equal(result.humanInterviewCount, 1);
  assert.equal(result.interviewRate, null);
  assert.equal(result.stages.find(item => item.stageId === 'interview_1').touchCount, 1);
  assert.equal(result.channels.reduce((sum, channel) => sum + channel.interviewCount, 0), 1);
  assert.equal(result.cities.length, 0, 'city distribution only includes submitted jobs');
});

test('AI, custom human interview, repeated visits, scheduled waiting, and failure-only events follow visit semantics', () => {
  const customStages = [...stages, { id: 'manager_talk', name: '主管沟通', category: 'custom', sortOrder: 80, archivedAt: null, countsAsInterview: true }];
  const s = submitted('M', '2026-09-10', 1);
  const waiting = stageEvent('M-waiting', 'interview_1', '2026-09-11', 2, s.id, { phase: 'waiting', visitId: 'M-i1-wait' });
  const failed = event('M-fail', 'failed', 'interview_2', 'interview', 'unknown', 'failed', { date: '2026-09-12', failedAt: { stageId: 'interview_2', stageNameSnapshot: '二面' } });
  const offer = event('M-offer-invalid', 'offer_received', 'offer', 'offer', 'unknown', 'offer_received', { date: '2026-09-12', invalidatedAt: '2026-09-13T00:00:00.000Z' });
  const r = row('M', { appliedOn: '2026-09-10', currentStage: 'interview_2', outcome: 'failed', failedAt: failed.failedAt, events: [s, waiting, failed, offer] });

  const u = submitted('U', '2026-09-10', 1);
  const ai = stageEvent('U-ai', 'ai', '2026-09-11', 2, u.id);
  const human = stageEvent('U-manager', 'manager_talk', '2026-09-12', 3, ai.id, { countsAsInterview: true });
  const repeated = stageEvent('U-manager-again', 'manager_talk', '2026-09-13', 4, human.id, { visitId: 'U-manager-second', countsAsInterview: true });
  const uRow = row('U', { appliedOn: '2026-09-10', currentStage: 'manager_talk', events: [u, ai, human, repeated] });

  const result = calculateV2Analytics(makeSnapshot([r, uRow], { stages: customStages }), { seasonId: 'season' }, shanghaiClock);
  assert.equal(result.humanInterviewCount, 1);
  assert.equal(result.aiInterviewCount, 1);
  assert.equal(result.stages.find(item => item.stageId === 'interview_1').touchCount, 0, 'waiting-only visit is not actual touch');
  assert.equal(result.stages.find(item => item.stageId === 'interview_2').touchCount, 0, 'failure cause alone does not infer an interview');
  assert.equal(result.stages.find(item => item.stageId === 'manager_talk').touchCount, 1);
  assert.equal(result.stages.find(item => item.stageId === 'manager_talk').visitCount, 2);
  assert.equal(result.offerCount, 0, 'invalidated offer is not historical offer');
});

test('legacy reached unknown-phase stage events count, while same visit status updates deduplicate', () => {
  const s = submitted('L', '2026-09-10', 1);
  const legacy = stageEvent('L-old', 'interview_1', '2026-09-11', 2, s.id, {
    phase: 'unknown', visitId: 'L-old-visit', migrationMeta: { legacyKind: 'stage', legacyEventId: 'old-stage', legacyReached: true, rawEvent: {} },
  });
  const legacyUpdate = stageEvent('L-old-update', 'interview_1', '2026-09-11', 3, legacy.id, {
    phase: 'unknown', visitId: 'L-old-visit', migrationMeta: { legacyKind: 'stage', legacyEventId: 'old-stage-update', legacyReached: true, rawEvent: {} },
  });
  const rowL = row('L', { appliedOn: '2026-09-10', currentStage: 'interview_1', events: [s, legacy, legacyUpdate] });
  const result = calculateV2Analytics(makeSnapshot([rowL]), { seasonId: 'season' }, shanghaiClock);
  assert.equal(result.humanInterviewCount, 1);
  assert.equal(result.stages.find(item => item.stageId === 'interview_1').touchCount, 1);
  assert.equal(result.stages.find(item => item.stageId === 'interview_1').visitCount, 1);
});

test('weekly count uses Monday in workspace timezone across UTC date boundaries', () => {
  const mon = row('Mon', { appliedOn: '2026-09-14' });
  const sun = row('Sun', { appliedOn: '2026-09-13' });
  const result = calculateV2Analytics(makeSnapshot([mon, sun]), { seasonId: 'season' }, { now: '2026-09-13T16:30:00.000Z', timeZone: 'Asia/Shanghai' });
  assert.equal(result.thisWeekCount, 1, 'Shanghai local date has crossed to Monday even though UTC is Sunday');
  assert.equal(result.activityWindow.to, '2026-09-14');
});

test('pool visit durations deduplicate continued events and return null across uncertain links', () => {
  const s = submitted('P', '2026-09-01', 1);
  const p1 = stageEvent('P-pool-1', 'pool', '2026-09-02', 2, s.id, { semantic: 'pool', phase: 'unknown', visitId: 'P-pool-a' });
  const p1Update = stageEvent('P-pool-1-update', 'pool', '2026-09-03', 3, p1.id, { semantic: 'pool', phase: 'unknown', visitId: 'P-pool-a' });
  const next = stageEvent('P-interview', 'interview_1', '2026-09-05', 4, p1Update.id);
  const p2 = stageEvent('P-pool-2', 'pool', '2026-09-06', 5, next.id, { semantic: 'pool', phase: 'unknown', visitId: 'P-pool-b' });
  const current = row('P', { appliedOn: '2026-09-01', currentStage: 'pool', events: [s, p1, p1Update, next, p2] });
  const result = calculateV2Analytics(makeSnapshot([current]), { seasonId: 'season' }, { now: '2026-09-10T04:00:00.000Z', timeZone: 'Asia/Shanghai' });
  assert.equal(result.currentPoolCount, 1);
  assert.deepEqual(result.poolVisits.map(item => [item.visitId, item.durationDays, item.current]), [['P-pool-a', 3, false], ['P-pool-b', 4, true]]);
  assert.equal(result.poolDuration.averageDays, 3.5);

  const uncertain = row('P', { appliedOn: '2026-09-01', currentStage: 'pool', outcome: 'active', events: [s, p1, p1Update, next, p2] });
  uncertain.progress.migrationReview = { status: 'needs_confirmation', uncertainEdges: [{ fromEventId: p1Update.id, toEventId: next.id, reason: '旧数据先后待确认' }] };
  const uncertainResult = calculateV2Analytics(makeSnapshot([uncertain]), { seasonId: 'season' }, { now: '2026-09-10T04:00:00.000Z', timeZone: 'Asia/Shanghai' });
  assert.equal(uncertainResult.poolVisits[0].durationDays, null);
});

test('heatmap window is independently marked, groups remain unique, and invalid ranges/timezones reject', () => {
  const snapshot = sampleSnapshot();
  const result = calculateV2Analytics(snapshot, { seasonId: 'season', heatmapWindow: { from: '2026-09-15', to: '2026-09-16' } }, shanghaiClock);
  assert.deepEqual(result.activityWindow, { from: '2026-09-15', to: '2026-09-16' });
  assert.equal(result.activity.reduce((sum, item) => sum + item.count, 0), 3);
  assert.equal(result.activeDayCount, 2);
  assert.equal(result.channels.reduce((sum, item) => sum + item.interviewCount, 0), 3);
  assert.equal(result.cities.reduce((sum, item) => sum + item.count, 0), result.submittedCount);
  assert.throws(() => calculateV2Analytics(snapshot, { seasonId: 'season', appliedDateRange: { from: '2026-09-31', to: '2026-10-01' } }, shanghaiClock), /有效日期/);
  assert.throws(() => calculateV2Analytics(snapshot, { seasonId: 'season' }, { ...shanghaiClock, timeZone: 'Not/AZone' }), RangeError);
});

test('default heatmap is the latest 84 local calendar days intersected with season and date filter', () => {
  const application = row('CrossYear', { appliedOn: '2026-12-20' });
  const snapshot = makeSnapshot([application], { startDate: '2026-11-15', endDate: '2027-03-31' });
  const clock = { now: '2027-01-04T16:30:00.000Z', timeZone: 'Asia/Shanghai' }; // local 2027-01-05
  const result = calculateV2Analytics(snapshot, {
    seasonId: 'season', appliedDateRange: { from: '2026-10-01', to: '2027-01-20' },
  }, clock);
  assert.deepEqual(result.activityWindow, { from: '2026-11-15', to: '2027-01-05' });
  assert.equal(result.activity.length, 52);
  assert.equal(result.activity[0].date, '2026-11-15');
  assert.equal(result.activity.at(-1).date, '2027-01-05');
  assert.equal(result.activity.reduce((sum, item) => sum + item.count, 0), 1);

  const explicit = calculateV2Analytics(snapshot, {
    seasonId: 'season',
    appliedDateRange: { from: '2026-12-01', to: '2027-01-20' },
    heatmapWindow: { from: '2026-10-01', to: '2027-03-01' },
  }, clock);
  assert.deepEqual(explicit.activityWindow, { from: '2026-12-01', to: '2027-01-05' });
});

test('empty heatmap intersection returns no dates and a null display window', () => {
  const snapshot = makeSnapshot([], { startDate: '2026-09-01', endDate: '2026-12-31' });
  const result = calculateV2Analytics(snapshot, {
    seasonId: 'season', heatmapWindow: { from: '2026-10-01', to: '2026-10-31' },
  }, shanghaiClock);
  assert.equal(result.activityWindow, null);
  assert.deepEqual(result.activity, []);
  assert.equal(result.activeDayCount, 0);
});

test('a posting open in several cities counts once for each city, never as a combined label', async () => {
  const { splitCities, joinCities } = await import('../dist/domain/v2/cities.js');
  assert.deepEqual(splitCities('北京、上海, 杭州 / 北京'), ['北京', '上海', '杭州']);
  assert.equal(joinCities(['深圳', ' 深圳 ', '广州']), '深圳、广州');
  const snapshot = sampleSnapshot();
  snapshot.applications.find(item => item.id === 'B').city = '上海、北京';
  const result = calculateV2Analytics(snapshot, { seasonId: 'season' }, shanghaiClock);
  assert.ok(!result.cities.some(item => item.city.includes('、')));
  assert.equal(result.cities.find(item => item.city === '北京').count, 2);
});
