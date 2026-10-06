import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultR1Definitions } from '../dist/domain/v2/definitions.js';
import { applyRawImportSync, parseRawApplicationsImport, planRawImportSync, RAW_IMPORT_SYNC_REOPEN_REASON, RAW_STATUS_MAPPINGS } from '../dist/domain/v2/raw-import.js';
import { appendProgressEvent, validateProgressRecord } from '../dist/domain/v2/progress.js';
import { syncApplicationWithProgress, validateV2Snapshot } from '../dist/domain/v2/snapshot.js';

const channels = [{ id: 'official', name: '官网', archivedAt: null }];
const definitions = defaultR1Definitions();

function sourceRow(id, status, overrides = {}) {
  return {
    id,
    company: `公司 ${id}`,
    companyGroup: '集团一',
    position: '后端工程师',
    link: 'https://jobs.example.com/apply?id=123',
    channel: '官网',
    applyDate: '2026-09-01',
    status,
    interviewTime: '',
    referrer: '同学甲',
    referralCode: 'REF-01',
    location: '上海',
    salary: '25k-35k',
    priority: '高',
    note: `源备注 ${id}`,
    createdAt: '2026-09-01T09:00:00+08:00',
    updatedAt: '2026-09-03T10:00:00+08:00',
    statusUpdatedAt: '2026-09-03T10:00:00+08:00',
    ...overrides,
  };
}

function parse(rows, overrides = {}) {
  return parseRawApplicationsImport(rows, {
    seasonId: 'season-2026', channels, definitions,
    applicationId: sourceId => `app-${sourceId}`,
    ...overrides,
  });
}

test('明确映射并保留七种原始状态，挂掉状态归因未知而不推测环节', () => {
  const labels = ['待投递', '已投递', '筛选中', '笔试', '测评中', '一面', '挂掉'];
  const result = parse(labels.map((label, index) => sourceRow(`r${index}`, label)));
  assert.deepEqual(result.issues, []);
  assert.equal(result.totalCount, labels.length);
  assert.equal(result.applications.length, labels.length);

  for (const imported of result.applications) {
    const expected = RAW_STATUS_MAPPINGS[imported.sourceStatus];
    const { application, progress } = imported;
    assert.equal(application.currentStatusId, expected.statusId, imported.sourceStatus);
    assert.equal(application.outcome, imported.sourceStatus === '挂掉' ? 'failed' : 'active');
    if (imported.sourceStatus === '待投递') {
      assert.equal(application.currentEventId, null);
      assert.equal(application.appliedOn, null);
      assert.equal(progress.events.length, 0);
      continue;
    }
    assert.equal(progress.events[0].statusId, 'submitted');
    assert.equal(progress.events[0].semantics.semantic, 'submitted');
    assert.equal(progress.appliedOn, '2026-09-01');
    const current = progress.events.at(-1);
    assert.equal(current.statusNameSnapshot, imported.sourceStatus);
    if (imported.sourceStatus === '已投递') assert.equal(progress.events.length, 1);
    else assert.equal(progress.events.length, 2);
    if (imported.sourceStatus === '挂掉') {
      assert.equal(current.semantics.semantic, 'failed');
      assert.equal(current.failedAt, 'unknown');
      assert.equal(application.failedAt, 'unknown');
      assert.equal(current.semantics.stageId, null);
    }
    validateProgressRecord(progress, definitions);
  }
});

test('阶段状态映射到对应环节与当前 phase，保留源状态快照文本', () => {
  const result = parse(['筛选中', '笔试', '测评中', '一面'].map((status, index) => sourceRow(`stage${index}`, status)));
  const current = Object.fromEntries(result.applications.map(item => [item.sourceStatus, item.progress.events.at(-1)]));
  assert.deepEqual(result.issues, []);
  assert.equal(current['筛选中'].semantics.stageId, 'screening');
  assert.equal(current['笔试'].semantics.stageId, 'written_test');
  assert.equal(current['笔试'].phase, 'in_progress');
  assert.equal(current['测评中'].semantics.stageId, 'assessment');
  assert.equal(current['一面'].semantics.stageId, 'interview_1');
  assert.equal(current['一面'].phase, 'in_progress');
});

test('关键字段、原始记录与状态更新时间被保留或规范映射', () => {
  const result = parse([sourceRow('full', '一面')]);
  assert.deepEqual(result.issues, []);
  const { application, progress, sourceRecord } = result.applications[0];
  assert.equal(application.company, '公司 full');
  assert.equal(application.role, '后端工程师');
  assert.equal(application.city, '上海');
  assert.equal(application.channelId, 'official');
  assert.equal(application.jobUrl, 'https://jobs.example.com/apply?id=123');
  assert.equal(application.isStarred, true);
  assert.match(application.notes, /源备注 full/);
  assert.match(application.notes, /源记录 ID=full/);
  assert.match(application.notes, /原优先级=高/);
  assert.match(application.notes, /原公司分组=集团一/);
  assert.match(application.notes, /内推码=REF-01/);
  assert.equal(application.createdAt, '2026-09-01T01:00:00.000Z');
  assert.equal(application.updatedAt, '2026-09-03T02:00:00.000Z');
  assert.equal(progress.events.at(-1).occurredOn, '2026-09-03');
  assert.equal(progress.events.at(-1).createdAt, '2026-09-03T02:00:00.000Z');
  assert.equal(sourceRecord.salary, '25k-35k');
  assert.equal(sourceRecord.status, '一面');
});

test('待投递保留源 applyDate，但不会让草稿违反 v2 无投递日期规则', () => {
  const result = parse([sourceRow('draft', '待投递')]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.applications[0].sourceRecord.applyDate, '2026-09-01');
  assert.equal(result.applications[0].application.appliedOn, null);
  assert.match(result.applications[0].application.notes, /原始投递日期=2026-09-01/);
  assert.equal(result.applications[0].progress.appliedOn, null);
});

test('非 HTTP 原链接文本安全保留在备注中，不伪造成可点击网址或丢弃整条记录', () => {
  const result = parse([sourceRow('text-link', '已投递', { link: '微信公众号' })]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.applications[0].application.jobUrl, '');
  assert.match(result.applications[0].application.notes, /原链接文本=微信公众号/);
  assert.equal(result.applications[0].sourceRecord.link, '微信公众号');
});

test('未知状态、缺少渠道、重复源 ID 或坏时间都明确报告且不会降级成其他状态', () => {
  const result = parse([
    sourceRow('unknown', '流程中'),
    sourceRow('no-channel', '已投递', { channel: '未知渠道' }),
    sourceRow('bad-time', '筛选中', { statusUpdatedAt: 'not-a-date' }),
    sourceRow('duplicate', '已投递'),
    sourceRow('duplicate', '挂掉'),
  ]);
  assert.equal(result.applications.length, 1);
  assert.equal(result.issues.length, 4);
  assert.match(result.issues[0].message, /不支持的状态/);
  assert.match(result.issues[1].message, /找不到名称/);
  assert.match(result.issues[2].message, /statusUpdatedAt/);
  assert.match(result.issues[3].message, /重复的源记录 id/);
});

test('导入预览的映射结果可组成完整且有效的 v2 快照', () => {
  const rows = ['待投递', '已投递', '筛选中', '笔试', '测评中', '一面', '挂掉']
    .map((status, index) => sourceRow(`snapshot${index}`, status));
  const result = parse(rows);
  assert.deepEqual(result.issues, []);
  const snapshot = {
    schemaVersion: 2,
    workspace: { id: 'workspace', name: '本地', timeZone: 'Asia/Shanghai', activeSeasonId: 'season-2026' },
    seasons: [{ id: 'season-2026', name: '2026 秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 100, archivedAt: null }],
    channels,
    settings: { schemaVersion: 2, lastBackupAt: null, preferences: {} },
    applications: result.applications.map(item => item.application),
    schedules: [], definitions, progressRecords: result.applications.map(item => item.progress),
    legacyHistory: [], migration: null,
  };
  assert.doesNotThrow(() => validateV2Snapshot(snapshot));
});

test('接受用户 JSON 文本和 applications 包装对象，并对错误 JSON 返回预览问题', () => {
  const row = sourceRow('wrapped', '已投递');
  assert.equal(parse(JSON.stringify({ applications: [row] })).applications.length, 1);
  const invalid = parse('{ broken json');
  assert.equal(invalid.applications.length, 0);
  assert.match(invalid.issues[0].message, /JSON 格式无效/);
});

function importedSnapshot(rows) {
  const result = parseRawApplicationsImport(rows, { seasonId: 'season-2026', channels, definitions });
  assert.deepEqual(result.issues, []);
  return {
    schemaVersion: 2,
    workspace: { id: 'workspace', name: '本地', timeZone: 'Asia/Shanghai', activeSeasonId: 'season-2026' },
    seasons: [{ id: 'season-2026', name: '2026 秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 100, archivedAt: null }],
    channels,
    settings: { schemaVersion: 2, lastBackupAt: null, preferences: {} },
    applications: result.applications.map(item => item.application),
    schedules: [], definitions, progressRecords: result.applications.map(item => item.progress),
    legacyHistory: [], migration: null,
  };
}

function appendInApp(snapshot, applicationId, statusId, occurredOn, now) {
  const index = snapshot.progressRecords.findIndex(record => record.applicationId === applicationId);
  const record = appendProgressEvent(snapshot.progressRecords[index], definitions, { commandId: `app-${statusId}-${now}`, statusId, occurredOn }, { now, id: () => `app-event-${now}` }).record;
  snapshot.progressRecords[index] = record;
  const application = snapshot.applications.find(item => item.id === applicationId);
  syncApplicationWithProgress(application, record);
  application.updatedAt = now;
}

test('同步再次导出的原始 JSON：只追加更晚的状态、新增记录，并识别重复与改投岗位', () => {
  const at = day => `2026-09-${day}T10:00:00+08:00`;
  const first = [
    sourceRow('same', '筛选中', { statusUpdatedAt: at('03') }),
    sourceRow('failed-later', '筛选中', { statusUpdatedAt: at('03') }),
    sourceRow('app-newer', '已投递', { statusUpdatedAt: at('03') }),
    sourceRow('reused', '筛选中', { position: '后端工程师', statusUpdatedAt: at('03') }),
    sourceRow('was-failed', '挂掉', { statusUpdatedAt: at('03') }),
  ];
  const snapshot = importedSnapshot(first);
  appendInApp(snapshot, 'raw-import-app-newer', 'written_test_active', '2026-09-20', '2026-09-20T08:00:00.000Z');
  snapshot.applications.push({ ...structuredClone(snapshot.applications[0]), id: 'manual-1', company: '手动公司', role: '实习生', appliedOn: null, currentEventId: null, currentStatusId: 'draft', currentStage: null, phase: 'unknown', outcome: 'active', failedAt: null });
  snapshot.progressRecords.push({ applicationId: 'manual-1', appliedOn: null, events: [], annotations: [] });
  appendInApp(snapshot, 'manual-1', 'submitted', '2026-09-17', '2026-09-17T09:00:00.000Z');
  appendInApp(snapshot, 'manual-1', 'assessment_active', '2026-09-17', '2026-09-17T09:01:00.000Z');
  validateV2Snapshot(snapshot);

  const latest = [
    sourceRow('same', '筛选中', { statusUpdatedAt: at('03') }),
    sourceRow('failed-later', '挂掉', { statusUpdatedAt: at('22'), updatedAt: at('22') }),
    sourceRow('app-newer', '筛选中', { statusUpdatedAt: at('10') }),
    sourceRow('reused', '筛选中', { position: '全栈工程师', applyDate: '2026-09-23', statusUpdatedAt: at('03'), updatedAt: at('23') }),
    sourceRow('was-failed', '泡池', { statusUpdatedAt: at('21') }),
    sourceRow('brand-new', '笔试', { applyDate: '2026-09-21', createdAt: at('21'), updatedAt: at('21'), statusUpdatedAt: at('21') }),
    sourceRow('dup-of-manual', '测评中', { company: '手动公司', position: '工程师', applyDate: '2026-09-17', statusUpdatedAt: at('17') }),
  ];
  const plan = planRawImportSync(snapshot, JSON.stringify(latest), { seasonId: 'season-2026' });
  assert.deepEqual(plan.issues, []);
  assert.equal(plan.totalCount, 7);
  assert.equal(plan.unchangedCount, 1);
  assert.deepEqual(plan.statusUpdates.map(item => [item.sourceId, item.sourceStatus, item.occurredOn, item.reopen]), [
    ['failed-later', '挂掉', '2026-09-22', false],
    ['was-failed', '泡池', '2026-09-21', true],
  ]);
  assert.deepEqual(plan.additions.map(item => item.application.id), ['raw-import-reused--2', 'raw-import-brand-new']);
  assert.deepEqual(plan.skipped.map(item => item.sourceId), ['app-newer', 'dup-of-manual']);
  assert.match(plan.skipped[0].reason, /更新更晚/);
  assert.match(plan.skipped[1].reason, /重复/);

  const next = applyRawImportSync(snapshot, plan, { id: (() => { let n = 0; return () => `sync-${++n}`; })() });
  assert.doesNotThrow(() => validateV2Snapshot(next));
  assert.equal(next.applications.length, snapshot.applications.length + 2);
  const failed = next.applications.find(item => item.id === 'raw-import-failed-later');
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.failedAt, 'unknown');
  const failedEvents = next.progressRecords.find(record => record.applicationId === failed.id).events;
  assert.equal(failedEvents.length, 3, '原有历史保留，只追加一条');
  assert.equal(failedEvents.at(-1).statusNameSnapshot, '挂掉');
  const reopened = next.progressRecords.find(record => record.applicationId === 'raw-import-was-failed').events.at(-1);
  assert.equal(reopened.source, 'reopened');
  assert.equal(reopened.reopenReason, RAW_IMPORT_SYNC_REOPEN_REASON);
  const reused = next.applications.find(item => item.id === 'raw-import-reused--2');
  assert.equal(reused.role, '全栈工程师');
  assert.equal(reused.appliedOn, '2026-09-23');
  assert.equal(next.applications.find(item => item.id === 'raw-import-reused').role, '后端工程师');
  assert.equal(next.applications.find(item => item.id === 'raw-import-app-newer').currentStatusId, 'written_test_active');

  const again = planRawImportSync(next, latest, { seasonId: 'season-2026' });
  assert.equal(again.statusUpdates.length, 0, '同一文件再次同步不会重复追加');
  assert.equal(again.additions.length, 0);
});
