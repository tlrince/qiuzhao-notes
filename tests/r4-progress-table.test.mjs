import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampProgressTableColumnWidth,
  getProgressTableColumnWidth,
  moveProgressStageColumn,
  parseProgressTableColumnPreferences,
  progressTableStageColumnKey,
  PROGRESS_TABLE_COLUMN_WIDTH_LIMITS,
  resizeProgressTableColumnWidth,
  resolveProgressTableColumns,
  serializeProgressTableColumnPreferences,
} from '../src/features/progress/table-layout.ts';
import {
  isValidProgressDate,
  moveProgressEditableCell,
  moveProgressTableFocus,
  parseSingleTsvCell,
  progressTableKeyIsOwnedByEditor,
  serializeTsvCell,
} from '../src/features/progress/table-keyboard.ts';

const projection = {
  columns: [
    { id: 'screening', name: '筛选', sortOrder: 10, category: 'screening', archived: false },
    { id: 'interview_1', name: '一面', sortOrder: 50, category: 'interview', archived: false },
    { id: 'offer', name: 'Offer', sortOrder: 110, category: 'offer', archived: false },
  ],
  rows: [],
};

test('默认列顺序来自投影，新动态列追加且隐藏状态不改变列顺序', () => {
  const layout = resolveProgressTableColumns(projection, { stageOrder: ['offer', 'stale', 'offer'], hiddenStageIds: ['interview_1', 'stale'] });
  assert.deepEqual(layout.stageOrder, ['offer', 'screening', 'interview_1']);
  assert.deepEqual(layout.hiddenStageIds, ['interview_1']);
  assert.deepEqual(layout.visibleColumns.map(column => column.id), ['offer', 'screening']);
});

test('新出现的动态环节保留用户次序并追加到末尾', () => {
  const base = resolveProgressTableColumns(projection, { stageOrder: ['interview_1', 'screening'], hiddenStageIds: [] });
  const extended = resolveProgressTableColumns({ ...projection, columns: [...projection.columns, { id: 'custom', name: '主管沟通', sortOrder: 70, category: 'custom', archived: false }] }, base);
  assert.deepEqual(extended.stageOrder, ['interview_1', 'screening', 'offer', 'custom']);
});

test('列排序可上移/下移，并在未知列或边界处安全保持', () => {
  const original = ['screening', 'interview_1', 'offer'];
  assert.deepEqual(moveProgressStageColumn(original, 'interview_1', -1), ['interview_1', 'screening', 'offer']);
  assert.deepEqual(moveProgressStageColumn(original, 'interview_1', 1), ['screening', 'offer', 'interview_1']);
  assert.deepEqual(moveProgressStageColumn(original, 'screening', -1), original);
  assert.deepEqual(moveProgressStageColumn(original, 'absent', 1), original);
  assert.deepEqual(original, ['screening', 'interview_1', 'offer']);
});

test('工作空间列偏好可往返保存，损坏或非文本值安全回到默认', () => {
  const preferences = { stageOrder: ['offer', 'screening', 'offer'], hiddenStageIds: ['interview_1', 'interview_1'] };
  const serialized = serializeProgressTableColumnPreferences(preferences);
  assert.deepEqual(parseProgressTableColumnPreferences(serialized), { stageOrder: ['offer', 'screening'], hiddenStageIds: ['interview_1'], columnWidths: {} });
  assert.deepEqual(parseProgressTableColumnPreferences('{bad'), { stageOrder: [], hiddenStageIds: [], columnWidths: {} });
  assert.deepEqual(parseProgressTableColumnPreferences({ stageOrder: ['offer'], hiddenStageIds: [] }), { stageOrder: [], hiddenStageIds: [], columnWidths: {} });
});

test('基础列和动态环节列宽在偏好 JSON 中往返保存，旧格式和坏值安全兼容', () => {
  const preferences = {
    stageOrder: ['screening'],
    hiddenStageIds: [],
    columnWidths: { identity: 305, notes: 410, 'stage:screening': 247 },
  };
  const restored = parseProgressTableColumnPreferences(serializeProgressTableColumnPreferences(preferences));
  assert.deepEqual(restored, preferences);
  assert.deepEqual(parseProgressTableColumnPreferences('{"stageOrder":["screening"],"hiddenStageIds":[]}'), {
    stageOrder: ['screening'], hiddenStageIds: [], columnWidths: {},
  });

  const corrupted = parseProgressTableColumnPreferences(JSON.stringify({
    stageOrder: ['screening'],
    hiddenStageIds: [],
    columnWidths: { identity: -4, 'stage:screening': 9999, 'stage:': 180, missing: 190, notes: 'wide' },
  }));
  assert.deepEqual(corrupted.columnWidths, {
    identity: PROGRESS_TABLE_COLUMN_WIDTH_LIMITS.identity.min,
    'stage:screening': PROGRESS_TABLE_COLUMN_WIDTH_LIMITS.stage.max,
  });
  assert.equal(getProgressTableColumnWidth(corrupted, 'current'), 150);
  assert.equal(getProgressTableColumnWidth(corrupted, progressTableStageColumnKey('future-stage')), 168);
});

test('拖动和键盘列宽变化使用安全 clamp，且不改变其他偏好', () => {
  const initial = {
    stageOrder: ['screening', 'interview_1'],
    hiddenStageIds: ['interview_1'],
    columnWidths: { identity: 305, 'stage:screening': 210 },
  };
  assert.equal(clampProgressTableColumnWidth('identity', Number.POSITIVE_INFINITY), 220);
  assert.equal(clampProgressTableColumnWidth('notes', 1), PROGRESS_TABLE_COLUMN_WIDTH_LIMITS.notes.min);
  assert.equal(clampProgressTableColumnWidth('stage:screening', 9999), PROGRESS_TABLE_COLUMN_WIDTH_LIMITS.stage.max);

  const resized = resizeProgressTableColumnWidth(initial, 'identity', 520);
  const keyboardAdjusted = resizeProgressTableColumnWidth(resized, 'stage:screening', 242);
  assert.deepEqual(keyboardAdjusted, {
    stageOrder: ['screening', 'interview_1'],
    hiddenStageIds: ['interview_1'],
    columnWidths: { identity: PROGRESS_TABLE_COLUMN_WIDTH_LIMITS.identity.max, 'stage:screening': 242 },
  });
  assert.equal(initial.columnWidths.identity, 305);
});

test('方向键按可见表格坐标移动焦点，边界和无效坐标不产生目标', () => {
  assert.deepEqual(moveProgressTableFocus({ row: 0, column: 0 }, 'ArrowRight', 2, 5), { row: 0, column: 1 });
  assert.deepEqual(moveProgressTableFocus({ row: 1, column: 4 }, 'ArrowUp', 2, 5), { row: 0, column: 4 });
  assert.equal(moveProgressTableFocus({ row: 0, column: 0 }, 'ArrowLeft', 2, 5), null);
  assert.equal(moveProgressTableFocus({ row: 1, column: 4 }, 'ArrowDown', 2, 5), null);
  assert.equal(moveProgressTableFocus({ row: 3, column: 0 }, 'ArrowRight', 2, 5), null);
  assert.equal(moveProgressTableFocus({ row: 0, column: 0 }, 'ArrowRight', 0, 5), null);
});

test('表格方向键不抢占文本编辑、下拉选择或输入法组合输入', () => {
  assert.equal(progressTableKeyIsOwnedByEditor({ tagName: 'input' }), true);
  assert.equal(progressTableKeyIsOwnedByEditor({ tagName: 'TEXTAREA' }), true);
  assert.equal(progressTableKeyIsOwnedByEditor({ tagName: 'select' }), true);
  assert.equal(progressTableKeyIsOwnedByEditor({ isContentEditable: true }), true);
  assert.equal(progressTableKeyIsOwnedByEditor({ isComposing: true }), true);
  assert.equal(progressTableKeyIsOwnedByEditor({ keyCode: 229 }), true);
  assert.equal(progressTableKeyIsOwnedByEditor({ tagName: 'BUTTON' }), false);
});

test('Tab 在可编辑字段间前进和反向移动，首尾循环到相邻投递', () => {
  const ids = ['app-a', 'app-b'];
  assert.deepEqual(moveProgressEditableCell(ids, { applicationId: 'app-a', field: 'appliedOn' }, 1), { applicationId: 'app-a', field: 'trackingUrl' });
  assert.deepEqual(moveProgressEditableCell(ids, { applicationId: 'app-b', field: 'notes' }, 1), { applicationId: 'app-a', field: 'appliedOn' });
  assert.deepEqual(moveProgressEditableCell(ids, { applicationId: 'app-a', field: 'appliedOn' }, -1), { applicationId: 'app-b', field: 'notes' });
  assert.equal(moveProgressEditableCell([], { applicationId: 'missing', field: 'notes' }, 1), null);
});

test('TSV 编解码只接受单格，不将多行或多列数据扩散到其他记录', () => {
  for (const value of ['', '普通文本', '含\t制表', '含\n换行', '带"引号"']) {
    assert.equal(parseSingleTsvCell(serializeTsvCell(value)), value);
  }
  assert.equal(parseSingleTsvCell('日期\t备注'), null);
  assert.equal(parseSingleTsvCell('第一行\n第二行'), null);
  assert.equal(parseSingleTsvCell('"引号未闭合'), null);
  assert.equal(parseSingleTsvCell('"完整引号"尾随'), null);
});

test('日期单元格只接受真实 ISO 日历日期', () => {
  assert.equal(isValidProgressDate('2024-02-29'), true);
  assert.equal(isValidProgressDate('2026-09-17'), true);
  assert.equal(isValidProgressDate('2026-02-29'), false);
  assert.equal(isValidProgressDate('2026-13-01'), false);
  assert.equal(isValidProgressDate('2026-9-01'), false);
});
