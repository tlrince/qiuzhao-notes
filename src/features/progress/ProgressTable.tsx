import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type ChangeEvent as ReactChangeEvent, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { ProgressTableProjection, ProgressTableRow } from '../../domain/v2/table.js';
import type { R1DefinitionsSnapshot } from '../../domain/v2/types.js';
import {
  clampProgressTableColumnWidth,
  getProgressTableColumnWidth,
  moveProgressStageColumn,
  progressTableStageColumnKey,
  PROGRESS_TABLE_COLUMN_WIDTH_LIMITS,
  resizeProgressTableColumnWidth,
  resolveProgressTableColumns,
  type ProgressTableColumnKey,
  type ProgressTableColumnPreferences,
} from './table-layout.js';
import {
  isValidProgressDate,
  moveProgressEditableCell,
  moveProgressTableFocus,
  parseSingleTsvCell,
  progressTableKeyIsOwnedByEditor,
  serializeTsvCell,
  type EditableProgressCell,
  type EditableProgressField,
  type ProgressTableArrowKey,
} from './table-keyboard.js';
import './ProgressTable.css';

export interface ProgressTableProps {
  projection: ProgressTableProjection;
  definitions: R1DefinitionsSnapshot;
  /** Controlled workspace preference. The parent owns persistence. */
  columnPreferences?: ProgressTableColumnPreferences;
  onColumnPreferencesChange?: (next: ProgressTableColumnPreferences) => void;
  /** Opens the shared state editor; this component does not write progress itself. */
  onRequestStatusChange?: (row: ProgressTableRow) => void;
  /** Opens the tracking URL editor; trackingUrl/jobUrl selection is displayed here. */
  onEditTrackingUrl?: (row: ProgressTableRow) => void;
  /** Persists one plain application field; dates use null to clear the application date. */
  onSaveApplicationField?: (row: ProgressTableRow, field: EditableProgressField, value: string | null) => void | Promise<void>;
  /** Lets desktop hosts open links through their platform service. */
  onOpenUrl?: (url: string, row: ProgressTableRow) => void;
  /** Opens the event history, optionally focused on one stage. */
  onViewHistory?: (row: ProgressTableRow, stageId: string | null) => void;
  /** Opens the application's base detail. */
  onSelectApplication?: (row: ProgressTableRow) => void;
  /** Business-local date or instant, used only to label overdue pending schedules. */
  now?: string;
  ariaLabel?: string;
}

interface EditingProgressCell extends EditableProgressCell {
  initialValue: string;
  value: string;
  saving: boolean;
  error: string | null;
}

function columnWidthStyle(width: number): CSSProperties {
  const size = `${width}px`;
  return { width: size, minWidth: size, maxWidth: size };
}

function ColumnResizeHandle({
  columnKey,
  label,
  width,
  disabled,
  onDraft,
  onCommit,
}: {
  columnKey: ProgressTableColumnKey;
  label: string;
  width: number;
  disabled: boolean;
  onDraft: (columnKey: ProgressTableColumnKey, width: number) => void;
  onCommit: (columnKey: ProgressTableColumnKey, width: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const limits = columnKey.startsWith('stage:')
    ? PROGRESS_TABLE_COLUMN_WIDTH_LIMITS.stage
    : PROGRESS_TABLE_COLUMN_WIDTH_LIMITS[columnKey as 'identity' | 'current' | 'applied' | 'url' | 'notes'];

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onDraft(columnKey, clampProgressTableColumnWidth(columnKey, drag.startWidth + event.clientX - drag.startX));
  };
  const finishPointerResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const nextWidth = clampProgressTableColumnWidth(columnKey, drag.startWidth + event.clientX - drag.startX);
    onDraft(columnKey, nextWidth);
    onCommit(columnKey, nextWidth);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const step = event.shiftKey ? 40 : 16;
    const nextWidth = clampProgressTableColumnWidth(columnKey, width + (event.key === 'ArrowRight' ? step : -step));
    if (nextWidth !== width) onCommit(columnKey, nextWidth);
  };

  return <div
    className="progress-table__resize-handle"
    role="separator"
    aria-orientation="vertical"
    aria-label={`调整${label}列宽`}
    aria-valuemin={limits.min}
    aria-valuemax={limits.max}
    aria-valuenow={width}
    aria-valuetext={`${width} 像素`}
    aria-disabled={disabled}
    tabIndex={disabled ? -1 : 0}
    data-column-resizer={columnKey}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={finishPointerResize}
    onPointerCancel={finishPointerResize}
    onKeyDown={handleKeyDown}
  />;
}

function getEditableValue(row: ProgressTableRow, field: EditableProgressField): string {
  if (field === 'appliedOn') return row.application.appliedOn ?? '';
  return row.application[field];
}

const dateShort = (value: string | null): string => value ? value.slice(5, 10).replace('-', '/') : '—';
const PHASE_LABEL: Record<string, string> = {
  waiting: '待安排',
  in_progress: '进行中',
  awaiting_result: '待结果',
  passed: '通过',
  unknown: '',
};

function outcomeTone(row: ProgressTableRow, semantic?: string): string {
  if (row.current.outcome === 'failed') return 'failure';
  if (row.current.outcome === 'offer_received') return 'offer';
  if (row.current.outcome === 'offer_accepted') return 'success';
  if (row.current.outcome === 'offer_declined' || row.current.outcome === 'withdrawn') return 'neutral';
  if (semantic === 'pool') return 'waiting';
  if (row.current.phase === 'waiting' || row.current.phase === 'awaiting_result') return 'waiting';
  return row.current.phase === 'passed' ? 'success' : 'neutral';
}

function eventTone(outcome: ProgressTableRow['current']['outcome'] | null, phase: ProgressTableRow['current']['phase'] | null, semantic?: string): string {
  if (outcome === 'failed') return 'failure';
  if (outcome === 'offer_received') return 'offer';
  if (outcome === 'offer_accepted') return 'success';
  if (outcome === 'offer_declined' || outcome === 'withdrawn') return 'neutral';
  if (semantic === 'pool') return 'waiting';
  if (phase === 'passed') return 'success';
  if (phase === 'waiting' || phase === 'awaiting_result') return 'waiting';
  return 'neutral';
}

function currentDetail(row: ProgressTableRow): string | null {
  if (row.current.outcome === 'failed') {
    if (row.current.failedAt === 'unknown') return '失败环节待确认';
    if (row.current.failedAt) return `失败于${row.current.failedAt.stageNameSnapshot}`;
  }
  if (row.current.outcome === 'offer_received') return '等待 Offer 决定';
  if (row.current.outcome === 'offer_accepted') return 'Offer 已接受';
  if (row.current.outcome === 'offer_declined') return 'Offer 已拒绝';
  if (row.current.outcome === 'withdrawn') return '已主动退出';
  return PHASE_LABEL[row.current.phase] || null;
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function HistoryAction({ row, stageId, onViewHistory }: { row: ProgressTableRow; stageId: string | null; onViewHistory?: ProgressTableProps['onViewHistory'] }) {
  if (!onViewHistory) return null;
  return <button className="progress-table__cell-action" type="button" data-grid-primary={stageId ? '' : undefined} onClick={() => onViewHistory(row, stageId)}>{stageId ? '历史' : '查看历史'}</button>;
}

function CurrentStateCell({ row, now, status, onRequestStatusChange, onViewHistory }: {
  row: ProgressTableRow;
  now: string;
  status: R1DefinitionsSnapshot['statuses'][number] | undefined;
  onRequestStatusChange?: ProgressTableProps['onRequestStatusChange'];
  onViewHistory?: ProgressTableProps['onViewHistory'];
}) {
  const detail = currentDetail(row);
  const schedule = row.nextSchedule;
  const scheduleTime = schedule ? Date.parse(schedule.startsAt) : Number.NaN;
  const nowTime = Date.parse(now);
  const overdue = !!schedule && Number.isFinite(scheduleTime) && Number.isFinite(nowTime) && scheduleTime < nowTime;
  const stateContent = <span className={`progress-table__state progress-table__state--${outcomeTone(row, status?.semantic)}`} style={status ? { '--progress-status-color': status.color } as CSSProperties : undefined}>{row.current.statusName}</span>;
  return <div className="progress-table__cell-lines">
    <div className="progress-table__cell-main">
      {onRequestStatusChange
        ? <button className="progress-table__cell-action" type="button" data-grid-primary aria-label={`修改${row.application.company}的状态，当前${row.current.statusName}`} onClick={() => onRequestStatusChange(row)}>{stateContent}</button>
        : stateContent}
    </div>
    {(detail || row.current.occurredOn || row.currentStayDays !== null) && <div className="progress-table__cell-meta">
      {detail && <span>{detail}</span>}
      {row.current.occurredOn && <time dateTime={row.current.occurredOn} aria-label={`状态日期 ${row.current.occurredOn}`}>{dateShort(row.current.occurredOn)}</time>}
      {row.currentStayDays !== null && <span>已停留 {row.currentStayDays} 天</span>}
      {row.events.length > 0 && <HistoryAction row={row} stageId={null} onViewHistory={onViewHistory} />}
    </div>}
    {schedule && <span className={`progress-table__schedule${overdue ? ' progress-table__schedule--overdue' : ''}`}>
      <span aria-hidden="true">{overdue ? '⚠ ' : '◷ '}</span>{overdue ? '已超期 · ' : '待安排 · '}约 {dateShort(schedule.startsAt)}{schedule.title ? ` · ${schedule.title}` : ''}
    </span>}
  </div>;
}

function StageCell({ row, stageId, onViewHistory }: {
  row: ProgressTableRow;
  stageId: string;
  onViewHistory?: ProgressTableProps['onViewHistory'];
}) {
  const cell = row.stageCells[stageId];
  if (!cell) return <span className="progress-table__empty" aria-label="尚无记录">—</span>;
  const latestOffer = cell.offerReceipts.at(-1);
  const hasAny = cell.visitCount > 0 || !!cell.latestStatusName || cell.skipped || cell.failureEvents.length > 0 || cell.offerReceipts.length > 0;
  if (!hasAny) return <span className="progress-table__empty" aria-label="尚无记录">—</span>;

  let label = cell.latestStatusName;
  const latestEvent = [...row.events].reverse().find(event => event.statusId === cell.latestStatusId && event.occurredOn === cell.latestOccurredOn);
  let tone = eventTone(cell.latestOutcome, cell.latestPhase, latestEvent?.semantics.semantic);
  let date = cell.latestOccurredOn;
  if (latestOffer) {
    label = `Offer · ${latestOffer.decision === 'pending' ? '待决定' : latestOffer.decision === 'accepted' ? '已接受' : latestOffer.decision === 'declined' ? '已拒绝' : '决定待确认'}`;
    tone = latestOffer.decision === 'accepted' ? 'success' : latestOffer.decision === 'declined' || latestOffer.decision === 'needs_confirmation' ? 'neutral' : 'offer';
    date = latestOffer.receivedOn;
  } else if (!label && cell.skipped) {
    label = '跳过';
    tone = 'neutral';
  }

  const stay = cell.stayBasis === 'needs_confirmation'
    ? '停留待确认'
    : cell.stayDays !== null
      ? `${cell.current ? '已停留' : '最近停留'} ${cell.stayDays} 天`
      : null;
  return <div className="progress-table__cell-lines">
    <div className="progress-table__cell-main">
      {label ? <span className={`progress-table__state progress-table__state--${tone}`}>{label}</span> : <span>跳过</span>}
      {cell.visitCount > 1 && <span className="progress-table__cell-badge" aria-label={`${cell.visitCount} 次经历`}>×{cell.visitCount}</span>}
    </div>
    <div className="progress-table__cell-meta">
      {date && <time dateTime={date} aria-label={`最近状态日期 ${date}`}>{dateShort(date)}</time>}
      {latestOffer?.decidedOn && <time dateTime={latestOffer.decidedOn} aria-label={`Offer 决定日期 ${latestOffer.decidedOn}`}>决定 {dateShort(latestOffer.decidedOn)}</time>}
      {!latestOffer && cell.latestActualOn && cell.latestActualOn !== date && <time dateTime={cell.latestActualOn} aria-label={`最近实际日期 ${cell.latestActualOn}`}>实 {dateShort(cell.latestActualOn)}</time>}
      {stay && <span>{stay}</span>}
      {cell.skipped && label !== '跳过' && <span title={cell.annotationNotes.join('；')}>含跳过标记</span>}
      <HistoryAction row={row} stageId={stageId} onViewHistory={onViewHistory} />
    </div>
  </div>;
}

function UrlCell({ row, onEditTrackingUrl, onOpenUrl, onBeginEdit }: {
  row: ProgressTableRow;
  onEditTrackingUrl?: ProgressTableProps['onEditTrackingUrl'];
  onOpenUrl?: ProgressTableProps['onOpenUrl'];
  onBeginEdit: (() => void) | undefined;
}) {
  const { trackingUrl, jobUrl } = row.application;
  const value = trackingUrl.trim() || jobUrl.trim();
  const isTracking = !!trackingUrl.trim();
  const href = value ? safeHttpUrl(value) : null;
  return <div className="progress-table__cell-lines">
    {href
      ? onOpenUrl
        ? <button className="progress-table__cell-action" type="button" data-grid-primary onClick={() => onOpenUrl(href, row)}>{isTracking ? '查看进度' : '职位页'}</button>
        : <a className="progress-table__link" href={href} target="_blank" rel="noopener noreferrer" data-grid-primary>{isTracking ? '查看进度' : '职位页'}</a>
      : <span className={value ? 'progress-table__muted' : 'progress-table__empty'}>{value ? '网址格式无效' : '添加网址'}</span>}
    {onBeginEdit
      ? <button className="progress-table__cell-action" type="button" onClick={onBeginEdit}>{trackingUrl ? '编辑跟踪网址' : '添加跟踪网址'}</button>
      : onEditTrackingUrl && <button className="progress-table__cell-action" type="button" data-grid-primary={!href ? '' : undefined} onClick={() => onEditTrackingUrl(row)}>{trackingUrl ? '编辑网址' : '添加跟踪网址'}</button>}
  </div>;
}

function InlineEditor({ state, onChange, onKeyDown }: {
  state: EditingProgressCell;
  onChange: (value: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}) {
  const common = {
    value: state.value,
    disabled: state.saving,
    'aria-label': state.field === 'appliedOn' ? '编辑投递日期' : state.field === 'notes' ? '编辑备注' : '编辑跟踪网址',
    'aria-invalid': !!state.error,
    'data-progress-editor': '',
    onChange: (event: ReactChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.currentTarget.value),
    onKeyDown,
    autoFocus: true,
  };
  return <div className="progress-table__editor-wrap">
    {state.field === 'notes'
      ? <textarea {...common} rows={2} />
      : <input {...common} type={state.field === 'appliedOn' ? 'date' : 'url'} />}
    {state.saving && <span className="progress-table__editor-status" role="status">保存中…</span>}
    {state.error && <span className="progress-table__editor-error" role="alert">{state.error}</span>}
  </div>;
}

export function ProgressTable({
  projection,
  definitions,
  columnPreferences,
  onColumnPreferencesChange,
  onRequestStatusChange,
  onEditTrackingUrl,
  onSaveApplicationField,
  onOpenUrl,
  onViewHistory,
  onSelectApplication,
  now = new Date().toISOString(),
  ariaLabel = '投递进度表',
}: ProgressTableProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selectedEditableCellRef = useRef<EditableProgressCell | null>(null);
  const [editingCell, setEditingCell] = useState<EditingProgressCell | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [draftColumnWidths, setDraftColumnWidths] = useState<Partial<Record<ProgressTableColumnKey, number>>>({});
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editingLock = useRef(false);
  const findEditableCell = (selection: EditableProgressCell): HTMLElement | null => scrollerRef.current?.querySelector<HTMLElement>(
    `[data-progress-application-id="${CSS.escape(selection.applicationId)}"][data-editable-field="${CSS.escape(selection.field)}"]`,
  ) ?? null;
  const applySelectedEditableCell = (selection: EditableProgressCell | null) => {
    const previous = scrollerRef.current?.querySelector<HTMLElement>('.progress-table__cell--selected');
    previous?.classList.remove('progress-table__cell--selected');
    previous?.setAttribute('aria-selected', 'false');
    selectedEditableCellRef.current = selection;
    if (!selection) return;
    const next = findEditableCell(selection);
    next?.classList.add('progress-table__cell--selected');
    next?.setAttribute('aria-selected', 'true');
  };
  useLayoutEffect(() => {
    applySelectedEditableCell(selectedEditableCellRef.current);
  });
  useEffect(() => {
    const clearSelectionOutsideTable = (event: PointerEvent) => {
      if (editingCell || !(event.target instanceof Node) || scrollerRef.current?.contains(event.target)) return;
      applySelectedEditableCell(null);
    };
    document.addEventListener('pointerdown', clearSelectionOutsideTable, true);
    return () => document.removeEventListener('pointerdown', clearSelectionOutsideTable, true);
  }, [editingCell]);
  const layout = useMemo(() => resolveProgressTableColumns(projection, columnPreferences), [projection, columnPreferences]);
  const effectivePreferences: ProgressTableColumnPreferences = {
    stageOrder: layout.stageOrder,
    hiddenStageIds: layout.hiddenStageIds,
    columnWidths: columnPreferences?.columnWidths ?? {},
  };
  const preferencesEditable = !!onColumnPreferencesChange;
  const statuses = new Map(definitions.statuses.map(status => [status.id, status]));

  const updatePreferences = (next: ProgressTableColumnPreferences) => onColumnPreferencesChange?.({
    stageOrder: [...next.stageOrder],
    hiddenStageIds: [...new Set(next.hiddenStageIds)],
    columnWidths: { ...next.columnWidths },
  });
  const getDisplayedColumnWidth = (columnKey: ProgressTableColumnKey) => draftColumnWidths[columnKey] ?? getProgressTableColumnWidth(effectivePreferences, columnKey);
  const setDraftColumnWidth = (columnKey: ProgressTableColumnKey, width: number) => {
    setDraftColumnWidths(current => ({ ...current, [columnKey]: width }));
  };
  const commitColumnWidth = (columnKey: ProgressTableColumnKey, width: number) => {
    setDraftColumnWidths(current => {
      const next = { ...current };
      delete next[columnKey];
      return next;
    });
    updatePreferences(resizeProgressTableColumnWidth(effectivePreferences, columnKey, width));
  };
  const tableWidthStyle = {
    '--progress-identity-width': `${getDisplayedColumnWidth('identity')}px`,
    '--progress-current-width': `${getDisplayedColumnWidth('current')}px`,
    '--progress-applied-width': `${getDisplayedColumnWidth('applied')}px`,
    '--progress-url-width': `${getDisplayedColumnWidth('url')}px`,
  } as CSSProperties;
  const setStageHidden = (stageId: string, hidden: boolean) => {
    const hiddenIds = new Set(effectivePreferences.hiddenStageIds);
    if (hidden) hiddenIds.add(stageId); else hiddenIds.delete(stageId);
    updatePreferences({ ...effectivePreferences, hiddenStageIds: [...hiddenIds] });
  };
  const moveStage = (stageId: string, direction: -1 | 1) => updatePreferences({
    ...effectivePreferences,
    stageOrder: moveProgressStageColumn(effectivePreferences.stageOrder, stageId, direction),
  });
  const focusEditableCell = (selection: EditableProgressCell) => {
    requestAnimationFrame(() => {
      findEditableCell(selection)?.focus();
    });
  };
  const selectEditableCell = (row: ProgressTableRow, field: EditableProgressField) => {
    applySelectedEditableCell({ applicationId: row.application.id, field });
    setClipboardNotice(null);
  };
  const beginEditing = (row: ProgressTableRow, field: EditableProgressField) => {
    if (!onSaveApplicationField) return;
    const value = getEditableValue(row, field);
    const selection = { applicationId: row.application.id, field };
    applySelectedEditableCell(selection);
    setEditingCell({ ...selection, initialValue: value, value, saving: false, error: null });
    setClipboardNotice(null);
  };
  const finishWithoutSave = (selection: EditableProgressCell) => {
    setEditingCell(null);
    applySelectedEditableCell(selection);
    focusEditableCell(selection);
  };
  const commitValue = async (
    row: ProgressTableRow,
    field: EditableProgressField,
    initialValue: string,
    value: string,
    nextSelection: EditableProgressCell = { applicationId: row.application.id, field },
  ) => {
    if (!onSaveApplicationField || editingLock.current) return;
    if (field === 'appliedOn' && value !== '' && !isValidProgressDate(value)) {
      setEditingCell({ applicationId: row.application.id, field, initialValue, value, saving: false, error: '日期必须是有效的 YYYY-MM-DD 日历日期。' });
      return;
    }
    if (value === initialValue) {
      finishWithoutSave(nextSelection);
      return;
    }
    editingLock.current = true;
    applySelectedEditableCell({ applicationId: row.application.id, field });
    setEditingCell({ applicationId: row.application.id, field, initialValue, value, saving: true, error: null });
    try {
      await onSaveApplicationField(row, field, field === 'appliedOn' ? (value || null) : value);
      setEditingCell(null);
      applySelectedEditableCell(nextSelection);
      setClipboardNotice(null);
      focusEditableCell(nextSelection);
    } catch (error) {
      setEditingCell({ applicationId: row.application.id, field, initialValue, value, saving: false, error: error instanceof Error ? error.message : '保存失败，请重试。' });
    } finally {
      editingLock.current = false;
    }
  };
  const rowForCell = (cell: EditableProgressCell) => projection.rows.find(row => row.application.id === cell.applicationId);
  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, row: ProgressTableRow, state: EditingProgressCell) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finishWithoutSave(state);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const next = moveProgressEditableCell(projection.rows.map(item => item.application.id), state, event.shiftKey ? -1 : 1);
      if (next) void commitValue(row, state.field, state.initialValue, state.value, next);
      return;
    }
    if (event.key === 'Enter' && (state.field !== 'notes' || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      void commitValue(row, state.field, state.initialValue, state.value);
    }
  };
  const handleTableCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('[data-progress-editor]')) return;
    const selectedEditableCell = selectedEditableCellRef.current;
    if (!selectedEditableCell) return;
    const row = rowForCell(selectedEditableCell);
    if (!row) return;
    event.clipboardData.setData('text/plain', serializeTsvCell(getEditableValue(row, selectedEditableCell.field)));
    event.preventDefault();
  };
  const handleTablePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const target = event.target;
    const editingTarget = target instanceof HTMLElement && !!target.closest('[data-progress-editor]');
    const activeCell = editingTarget && editingCell ? editingCell : selectedEditableCellRef.current;
    if (!activeCell) return;
    event.preventDefault();
    const value = parseSingleTsvCell(event.clipboardData.getData('text/plain'));
    if (value === null) {
      setClipboardNotice('只支持粘贴单个日期或文本单元格，不能批量粘贴多行或多列。');
      return;
    }
    if (activeCell.field === 'appliedOn' && value !== '' && !isValidProgressDate(value)) {
      setClipboardNotice('投递日期必须是有效的 YYYY-MM-DD 日历日期。');
      return;
    }
    setClipboardNotice(null);
    if (editingTarget && editingCell) {
      setEditingCell({ ...editingCell, value, error: null });
      return;
    }
    const row = rowForCell(activeCell);
    if (!row || !onSaveApplicationField) {
      setClipboardNotice('该单元格当前不可保存。');
      return;
    }
    void commitValue(row, activeCell.field, getEditableValue(row, activeCell.field), value);
  };
  const handleCellDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('button, a, input, textarea')) return;
    const cell = target.closest<HTMLElement>('[data-editable-field][data-progress-application-id]');
    if (!cell) return;
    const field = cell.dataset.editableField as EditableProgressField;
    const row = projection.rows.find(item => item.application.id === cell.dataset.progressApplicationId);
    if (row) beginEditing(row, field);
  };
  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cell = target.closest<HTMLElement>('[data-progress-cell]');
    if (!cell) {
      applySelectedEditableCell(null);
      return;
    }
    const field = cell.dataset.editableField as EditableProgressField | undefined;
    const row = projection.rows.find(item => item.application.id === cell.dataset.progressApplicationId);
    if (field && row) {
      selectEditableCell(row, field);
      if (!target.closest('button, a, input, textarea')) cell.focus();
    } else applySelectedEditableCell(null);
  };
  const handleFocusCapture = (event: ReactFocusEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const cell = target.closest<HTMLElement>('[data-progress-cell]');
    if (!cell) {
      applySelectedEditableCell(null);
      return;
    }
    const field = cell.dataset.editableField as EditableProgressField | undefined;
    const row = projection.rows.find(item => item.application.id === cell.dataset.progressApplicationId);
    if (field && row) applySelectedEditableCell({ applicationId: row.application.id, field });
    else applySelectedEditableCell(null);
  };
  const handleTableKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || progressTableKeyIsOwnedByEditor({
      tagName: target.tagName,
      isContentEditable: target.isContentEditable,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    })) return;

    const tableCell = target.closest<HTMLElement>('[data-progress-cell]');
    if (!tableCell || !event.currentTarget.contains(tableCell)) return;
    const table = tableCell.closest('table');
    if (!table) return;
    if (event.key === 'Enter' && target === tableCell) {
      const field = tableCell.dataset.editableField as EditableProgressField | undefined;
      const row = projection.rows.find(item => item.application.id === tableCell.dataset.progressApplicationId);
      if (field && row && onSaveApplicationField) {
        event.preventDefault();
        beginEditing(row, field);
        return;
      }
      const action = tableCell.querySelector<HTMLElement>('[data-grid-primary]');
      if (action && !action.matches(':disabled')) {
        event.preventDefault();
        action.click();
      }
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const row = Number(tableCell.dataset.progressRowIndex);
    const column = Number(tableCell.dataset.progressColumnIndex);
    const bodyRows = table.querySelectorAll('tbody tr[data-progress-row-index]');
    const firstRow = bodyRows[0];
    if (!firstRow) return;
    const columnCount = firstRow.querySelectorAll('[data-progress-cell]').length;
    const destination = moveProgressTableFocus({ row, column }, event.key as ProgressTableArrowKey, bodyRows.length, columnCount);
    if (!destination) return;
    const nextCell = table.querySelector<HTMLElement>(`[data-progress-row-index="${destination.row}"][data-progress-column-index="${destination.column}"]`);
    if (!nextCell) return;
    event.preventDefault();
    const nextField = nextCell.dataset.editableField as EditableProgressField | undefined;
    const nextRow = projection.rows.find(item => item.application.id === nextCell.dataset.progressApplicationId);
    if (nextField && nextRow) applySelectedEditableCell({ applicationId: nextRow.application.id, field: nextField });
    else applySelectedEditableCell(null);
    const action = nextCell.querySelector<HTMLElement>('[data-grid-primary]');
    (nextCell.dataset.editableField ? nextCell : action && !action.matches(':disabled') ? action : nextCell).focus();
  };
  const cellPosition = (rowIndex: number, columnIndex: number, applicationId: string, field?: EditableProgressField) => ({
    'data-progress-cell': '',
    'data-progress-row-index': rowIndex,
    'data-progress-column-index': columnIndex,
    'data-progress-application-id': applicationId,
    'data-editable-field': field,
    tabIndex: rowIndex === 0 && columnIndex === 0 ? 0 : -1,
  });
  const renderEditor = (row: ProgressTableRow, field: EditableProgressField) => {
    const state = editingCell?.applicationId === row.application.id && editingCell.field === field ? editingCell : null;
    if (!state) return null;
    return <InlineEditor
      state={state}
      onChange={value => setEditingCell(current => current?.applicationId === row.application.id && current.field === field ? { ...current, value, error: null } : current)}
      onKeyDown={event => handleEditorKeyDown(event, row, state)}
    />;
  };
  const editableCellClass = (base: string) => base;

  return <section className="progress-table" aria-label={ariaLabel}>
    <div className="progress-table__toolbar">
      <details className="progress-table__column-settings" open={settingsOpen} onToggle={event => setSettingsOpen(event.currentTarget.open)}>
        <summary>列设置</summary>
        <div className="progress-table__column-options" aria-label="环节列设置">
          {layout.stageOrder.map((stageId, index) => {
            const column = projection.columns.find(item => item.id === stageId);
            if (!column) return null;
            const hidden = effectivePreferences.hiddenStageIds.includes(stageId);
            return <div className="progress-table__column-option" key={stageId}>
              <label><input type="checkbox" checked={!hidden} disabled={!preferencesEditable} onChange={event => setStageHidden(stageId, !event.target.checked)} />{column.name}</label>
              <button type="button" aria-label={`将${column.name}列上移`} disabled={!preferencesEditable || index === 0} onClick={() => moveStage(stageId, -1)}>上移</button>
              <button type="button" aria-label={`将${column.name}列下移`} disabled={!preferencesEditable || index === layout.stageOrder.length - 1} onClick={() => moveStage(stageId, 1)}>下移</button>
            </div>;
          })}
          {!preferencesEditable && <p className="progress-table__preference-note">列偏好由上层页面管理。</p>}
        </div>
      </details>
    </div>
    {clipboardNotice && <p className="progress-table__clipboard-notice" role="status">{clipboardNotice}</p>}
    <div ref={scrollerRef} className="progress-table__scroller" role="region" aria-label="可横向滚动的进度表" tabIndex={0} onKeyDown={handleTableKeyDown} onClickCapture={handleClickCapture} onFocusCapture={handleFocusCapture} onDoubleClick={handleCellDoubleClick} onCopy={handleTableCopy} onPaste={handleTablePaste}>
      <table className="progress-table__table" style={tableWidthStyle}>
        <caption>{ariaLabel}，固定基础信息列，环节列可横向滚动</caption>
        <colgroup>
          <col className="progress-table__identity" style={columnWidthStyle(getDisplayedColumnWidth('identity'))} />
          <col className="progress-table__current" style={columnWidthStyle(getDisplayedColumnWidth('current'))} />
          <col className="progress-table__applied" style={columnWidthStyle(getDisplayedColumnWidth('applied'))} />
          <col className="progress-table__url" style={columnWidthStyle(getDisplayedColumnWidth('url'))} />
          <col className="progress-table__notes" style={columnWidthStyle(getDisplayedColumnWidth('notes'))} />
          {layout.visibleColumns.map(column => {
            const columnKey = progressTableStageColumnKey(column.id);
            return <col className="progress-table__stage" key={column.id} style={columnWidthStyle(getDisplayedColumnWidth(columnKey))} />;
          })}
        </colgroup>
        <thead><tr>
          <th className="progress-table__identity" scope="col" style={columnWidthStyle(getDisplayedColumnWidth('identity'))}>
            公司 / 岗位
            <ColumnResizeHandle columnKey="identity" label="公司 / 岗位" width={getDisplayedColumnWidth('identity')} disabled={!preferencesEditable} onDraft={setDraftColumnWidth} onCommit={commitColumnWidth} />
          </th>
          <th className="progress-table__current" scope="col" style={columnWidthStyle(getDisplayedColumnWidth('current'))}>
            当前状态
            <ColumnResizeHandle columnKey="current" label="当前状态" width={getDisplayedColumnWidth('current')} disabled={!preferencesEditable} onDraft={setDraftColumnWidth} onCommit={commitColumnWidth} />
          </th>
          <th className="progress-table__applied" scope="col" style={columnWidthStyle(getDisplayedColumnWidth('applied'))}>
            投递日期
            <ColumnResizeHandle columnKey="applied" label="投递日期" width={getDisplayedColumnWidth('applied')} disabled={!preferencesEditable} onDraft={setDraftColumnWidth} onCommit={commitColumnWidth} />
          </th>
          <th className="progress-table__url" scope="col" style={columnWidthStyle(getDisplayedColumnWidth('url'))}>
            投递网址
            <ColumnResizeHandle columnKey="url" label="投递网址" width={getDisplayedColumnWidth('url')} disabled={!preferencesEditable} onDraft={setDraftColumnWidth} onCommit={commitColumnWidth} />
          </th>
          <th className="progress-table__notes" scope="col" style={columnWidthStyle(getDisplayedColumnWidth('notes'))}>
            备注
            <ColumnResizeHandle columnKey="notes" label="备注" width={getDisplayedColumnWidth('notes')} disabled={!preferencesEditable} onDraft={setDraftColumnWidth} onCommit={commitColumnWidth} />
          </th>
          {layout.visibleColumns.map(column => {
            const columnKey = progressTableStageColumnKey(column.id);
            const width = getDisplayedColumnWidth(columnKey);
            return <th className="progress-table__stage" scope="col" key={column.id} style={columnWidthStyle(width)}>
              {column.name}{column.archived && <span className="progress-table__cell-badge"> · 已归档</span>}
              <ColumnResizeHandle columnKey={columnKey} label={column.name} width={width} disabled={!preferencesEditable} onDraft={setDraftColumnWidth} onCommit={commitColumnWidth} />
            </th>;
          })}
        </tr></thead>
        <tbody>
          {projection.rows.map((row, rowIndex) => {
            const status = statuses.get(row.current.statusId);
            return <tr key={row.application.id} data-progress-row-index={rowIndex}>
              <th className="progress-table__identity" scope="row" style={columnWidthStyle(getDisplayedColumnWidth('identity'))} {...cellPosition(rowIndex, 0, row.application.id)}>
                <div className="progress-table__identity-content">
                  {onSelectApplication
                    ? <button type="button" data-grid-primary onClick={() => onSelectApplication(row)} title={`${row.application.company} · ${row.application.role}`}>{row.application.isStarred ? '★ ' : ''}{row.application.company || '未填写公司'}</button>
                    : <span>{row.application.isStarred ? '★ ' : ''}{row.application.company || '未填写公司'}</span>}
                  <span className="progress-table__role">{row.application.role || '未填写岗位'}</span>
                </div>
              </th>
              <td className="progress-table__current" data-status-id={row.current.statusId} style={columnWidthStyle(getDisplayedColumnWidth('current'))} {...cellPosition(rowIndex, 1, row.application.id)}>
                <CurrentStateCell row={row} now={now} status={status} onRequestStatusChange={onRequestStatusChange} onViewHistory={onViewHistory} />
                {status?.archivedAt && <span className="progress-table__cell-badge">状态已归档</span>}
              </td>
              <td className={editableCellClass('progress-table__applied')} style={columnWidthStyle(getDisplayedColumnWidth('applied'))} aria-selected="false" {...cellPosition(rowIndex, 2, row.application.id, 'appliedOn')}>
                {renderEditor(row, 'appliedOn') ?? (row.application.appliedOn
                  ? <time dateTime={row.application.appliedOn} aria-label={`投递日期 ${row.application.appliedOn}`}>{dateShort(row.application.appliedOn)}</time>
                  : <span className="progress-table__empty">未投递</span>)}
              </td>
              <td className={editableCellClass('progress-table__url')} style={columnWidthStyle(getDisplayedColumnWidth('url'))} aria-selected="false" {...cellPosition(rowIndex, 3, row.application.id, 'trackingUrl')}>
                {renderEditor(row, 'trackingUrl') ?? <UrlCell row={row} onEditTrackingUrl={onEditTrackingUrl} onOpenUrl={onOpenUrl} onBeginEdit={onSaveApplicationField ? () => beginEditing(row, 'trackingUrl') : undefined} />}
              </td>
              <td className={editableCellClass('progress-table__notes')} style={columnWidthStyle(getDisplayedColumnWidth('notes'))} aria-selected="false" {...cellPosition(rowIndex, 4, row.application.id, 'notes')}>
                {renderEditor(row, 'notes') ?? <span className={row.application.notes ? '' : 'progress-table__empty'} title={row.application.notes || undefined}>{row.application.notes || '—'}</span>}
              </td>
              {layout.visibleColumns.map((column, index) => {
                const columnKey = progressTableStageColumnKey(column.id);
                return <td className="progress-table__stage" key={column.id} style={columnWidthStyle(getDisplayedColumnWidth(columnKey))} {...cellPosition(rowIndex, index + 5, row.application.id)}><StageCell row={row} stageId={column.id} onViewHistory={onViewHistory} /></td>;
              })}
            </tr>;
          })}
          {projection.rows.length === 0 && <tr><td colSpan={5 + layout.visibleColumns.length} className="progress-table__empty">没有匹配的投递记录</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}
