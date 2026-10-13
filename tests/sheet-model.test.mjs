import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distRoot = process.env.SHEET_MODEL_DIST ?? path.resolve('dist');
const moduleAt = relative => import(pathToFileURL(path.join(distRoot, relative)).href);
const domain = await moduleAt('domain/v2/index.js');
const sheet = await moduleAt('features/progress/sheet-model.js');

const definitions = domain.defaultR1Definitions();
const channels = [{ id: 'official', name: '官网', archivedAt: null }, { id: 'referral', name: '内推', archivedAt: null }];
let serial = 0;

function application(id, company, role, steps, extra = {}) {
  let record = domain.createProgressRecord(id);
  for (const [statusId, occurredOn, options = {}] of steps) {
    const n = ++serial;
    record = domain.appendProgressEvent(record, definitions, { commandId: `c${n}`, statusId, occurredOn, ...options }, { now: `2026-09-${String(10 + (n % 15)).padStart(2, '0')}T00:00:00.000Z`, id: () => `e${n}` }).record;
  }
  const app = {
    id, seasonId: 's', company, role, city: '上海', channelId: 'official', jobUrl: '', trackingUrl: '', appliedOn: null,
    currentStatusId: 'draft', currentStage: null, phase: 'unknown', outcome: 'active', failedAt: null, currentEventId: null,
    isStarred: false, notes: '', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
  };
  domain.syncApplicationWithProgress(app, record);
  return { app, record };
}

function items(today = '2026-10-06') {
  const data = [
    application('a', '星河科技', 'AI全栈开发工程师', [['submitted', '2026-08-20'], ['failed_unknown', '2026-09-01', { failedAt: 'unknown' }]]),
    application('b', '星河科技', 'AI全栈开发工程师', [['submitted', '2026-09-11'], ['screening', '2026-09-15']], { createdAt: '2026-09-11T00:00:00.000Z', notes: '正式批\n导入字段：源记录 ID=x' }),
    application('c', '网易游戏互娱', 'AI应用工程师', [['submitted', '2026-09-20'], ['pool', '2026-09-22']], { channelId: 'referral', updatedAt: '2026-09-22T00:00:00.000Z' }),
    application('d', '远山电子', 'AI应用工程师', [['submitted', '2026-09-01'], ['interview_1_active', '2026-10-01']]),
    application('e', '待定公司', '实习生', []),
  ];
  const projection = domain.projectProgressTable({ applications: data.map(item => item.app), progressRecords: data.map(item => item.record), definitions, now: today });
  return sheet.buildSheetItems(projection.rows, data.map(item => item.record), channels, today);
}

test('stale reminder covers only rows waiting on a status for 14+ days', () => {
  const byId = Object.fromEntries(items().map(item => [item.row.application.id, item]));
  assert.equal(byId.b.staleDays, 21, '筛选中 9/15 → 10/06');
  assert.equal(byId.d.staleDays, 5);
  assert.equal(byId.a.staleDays, null, '挂掉不提醒');
  assert.equal(byId.c.staleDays, null, '泡池子不提醒');
  assert.equal(byId.e.staleDays, null, '草稿不提醒');
  assert.ok(byId.b.staleDays >= sheet.STALE_DAYS);
});

test('search, channel and status chips filter like offer.html, with chip counts after search', () => {
  const all = items();
  assert.equal(sheet.filterSheetItems(all, { search: '星河科技', channelId: sheet.ALL, stageKey: sheet.ALL, outcome: sheet.ALL, city: sheet.ALL }).length, 2);
  assert.equal(sheet.filterSheetItems(all, { search: '正式批', channelId: sheet.ALL, stageKey: sheet.ALL, outcome: sheet.ALL, city: sheet.ALL }).length, 1, '搜索备注');
  assert.deepEqual(sheet.filterSheetItems(all, { search: '', channelId: 'referral', stageKey: sheet.ALL, outcome: sheet.ALL, city: sheet.ALL }).map(item => item.row.application.id), ['c']);
  assert.deepEqual(sheet.filterSheetItems(all, { search: '', channelId: sheet.ALL, stageKey: 'failed', outcome: sheet.ALL, city: sheet.ALL }).map(item => item.row.application.id), ['a']);
  const chips = sheet.sheetStatusChips(all, definitions, sheet.ALL);
  assert.deepEqual(chips.map(chip => [chip.label, chip.count]), [['待投递', 1], ['简历筛选', 1], ['一面', 1], ['泡池子', 1], ['挂掉（环节未知）', 1]]);
  assert.deepEqual(sheet.sheetStatusChips(all.filter(item => item.row.application.company === '远山电子'), definitions, 'failed').map(chip => [chip.key, chip.count]), [['stage:interview_1', 1], ['failed', 0]], '选中的状态即使为 0 也保留');
});

test('sorting by apply date keeps drafts last; stats count companies like offer.html', () => {
  assert.deepEqual(sheet.sortSheetItems(items(), 'apply-desc').map(item => item.row.application.id), ['c', 'b', 'd', 'a', 'e']);
  assert.deepEqual(sheet.sortSheetItems(items(), 'apply-asc').map(item => item.row.application.id), ['a', 'd', 'b', 'c', 'e']);
  assert.deepEqual(sheet.sheetStats(items()), { total: 4, drafts: 1, companies: 3, active: 2, offers: 0, pool: 1, failed: 1, offerRate: 0 });
  assert.equal(sheet.companyGroupName('网易游戏雷火'), '网易');
  assert.equal(sheet.companyGroupName('阿里巴巴（淘天）'), '阿里巴巴');
  assert.equal(sheet.displayNotes('正式批\n导入字段：源记录 ID=x'), '正式批');
});

test('stage chips count what is still in the stage; failures get their own chips, with a roll-up', () => {
  const data = [
    application('w', '甲', '工程师', [['submitted', '2026-09-01'], ['interview_1_waiting', '2026-09-02']], { city: '北京、上海' }),
    application('x', '乙', '工程师', [['submitted', '2026-09-01'], ['interview_1_active', '2026-09-03'], ['interview_1_failed', '2026-09-05', { failedAt: { stageId: 'interview_1' } }]], { city: '上海' }),
    application('y', '丙', '工程师', [['submitted', '2026-09-01'], ['screening', '2026-09-02']], { city: '' }),
    application('r1', '丁', '工程师', [['submitted', '2026-09-01'], ['screening_failed', '2026-09-03', { failedAt: { stageId: 'screening' } }]]),
    application('r2', '戊', '工程师', [['submitted', '2026-09-01'], ['screening_failed', '2026-09-03', { failedAt: { stageId: 'screening' } }]]),
    application('u', '己', '工程师', [['submitted', '2026-09-01'], ['failed_unknown', '2026-09-04', { failedAt: 'unknown' }]]),
  ];
  const projection = domain.projectProgressTable({ applications: data.map(item => item.app), progressRecords: data.map(item => item.record), definitions, now: '2026-10-06' });
  const all = sheet.buildSheetItems(projection.rows, data.map(item => item.record), channels, '2026-10-06');
  const filter = overrides => sheet.filterSheetItems(all, { search: '', channelId: sheet.ALL, stageKey: sheet.ALL, outcome: sheet.ALL, city: sheet.ALL, ...overrides }).map(item => item.row.application.id);
  assert.deepEqual(filter({ stageKey: 'stage:interview_1' }), ['w'], '一面只数还在一面的');
  assert.deepEqual(filter({ stageKey: 'failed:interview_1' }), ['x'], '一面挂单独成组');
  assert.deepEqual(filter({ stageKey: 'failed:screening' }), ['r1', 'r2']);
  assert.deepEqual(filter({ stageKey: 'failed' }), ['u'], '环节未知的挂掉');
  assert.deepEqual(filter({ stageKey: sheet.FAILED_ALL }), ['x', 'r1', 'r2', 'u'], '全部已挂汇总所有挂掉');
  assert.deepEqual(filter({ stageKey: sheet.FAILED_ALL, city: '北京' }), [], '和城市筛选叠加');
  assert.deepEqual(filter({ stageKey: 'failed:interview_1', city: '上海' }), ['x']);
  assert.deepEqual(filter({ stageKey: sheet.FAILED_ALL, outcome: 'active' }), [], '结果选「进行中」时没有挂掉的');
  assert.deepEqual(filter({ city: '上海' }), ['w', 'x', 'r1', 'r2', 'u']);

  const chips = sheet.sheetStatusChips(all, definitions, sheet.ALL);
  assert.deepEqual(chips.map(chip => [chip.label, chip.count, chip.failed]), [
    ['简历筛选', 1, false], ['一面', 1, false],
    ['全部已挂', 4, true], ['简历挂', 2, true], ['一面挂', 1, true], ['挂掉（环节未知）', 1, true],
  ]);
  const roll = chips.find(chip => chip.key === sheet.FAILED_ALL);
  assert.equal(chips.filter(chip => chip.key !== sheet.FAILED_ALL).reduce((sum, chip) => sum + chip.count, 0), all.length, '除汇总外的标签加起来等于总数');
  assert.equal(roll.count, chips.filter(chip => chip.failed && chip.key !== sheet.FAILED_ALL).reduce((sum, chip) => sum + chip.count, 0));

  // With only one kind of failure the roll-up would repeat it, so it is left out (unless selected).
  const onlyOne = all.filter(item => ['w', 'x'].includes(item.row.application.id));
  assert.deepEqual(sheet.sheetStatusChips(onlyOne, definitions, sheet.ALL).map(chip => chip.label), ['一面', '一面挂']);
  assert.deepEqual(sheet.sheetStatusChips(onlyOne, definitions, sheet.FAILED_ALL).map(chip => [chip.label, chip.count]), [['一面', 1], ['全部已挂', 1], ['一面挂', 1]]);
  assert.deepEqual(sheet.sheetCities(all), [{ city: '上海', count: 5 }, { city: '北京', count: 1 }]);
});
