import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { joinCities, splitCities } from '../../domain/v2/cities.js';
import type { ProgressTableColumn, ProgressTableStageCell } from '../../domain/v2/table.js';
import type { ProgressEvent, R1DefinitionsSnapshot } from '../../domain/v2/types.js';
import { CityTagsInput } from '../../shared/ui/CityTagsInput.js';
import { Icon } from '../../shared/ui/Icon.js';
import { ProgressHistory } from './ProgressHistory.js';
import type { ProgressHistoryAction } from './ProgressHistoryEditor.js';
import { groupQuickStatusOptions, quickStatusOptions, quickStatusTone, type QuickStatusOption } from './quick-status.js';
import { displayNotes, STALE_DAYS, type SheetItem } from './sheet-model.js';
import { isValidProgressDate } from './table-keyboard.js';
import './ApplicationSheet.css';

export interface ApplicationSheetProps {
  items: readonly SheetItem[];
  definitions: R1DefinitionsSnapshot;
  /** Stage columns of the season projection; shown inside an expanded row. */
  columns: readonly ProgressTableColumn[];
  busyIds: ReadonlySet<string>;
  expandedIds: ReadonlySet<string>;
  now: number;
  emptyMessage: ReactNode;
  onToggleExpand: (applicationId: string) => void;
  onStatusChange: (item: SheetItem, option: QuickStatusOption) => void;
  onSaveAppliedOn: (item: SheetItem, value: string | null) => Promise<void>;
  onSaveNotes: (item: SheetItem, value: string) => Promise<void>;
  onSaveCity: (item: SheetItem, value: string) => Promise<void>;
  /** Cities already in use, offered while typing. */
  citySuggestions: readonly string[];
  onOpenUrl: (url: string) => void;
  onCopy: (text: string, label: string) => void;
  onEdit: (item: SheetItem) => void;
  onDelete: (item: SheetItem) => void;
  onHistoryAction: (item: SheetItem, action: ProgressHistoryAction) => void;
  onDeleteEvent: (item: SheetItem, event: ProgressEvent) => void;
}

const monthDay = (date: string) => { const [, month, day] = date.split('-'); return `${Number(month)}月${Number(day)}日`; };
const shortDate = (date: string | null) => date ? date.slice(5).replace('-', '/') : '';
const pad = (value: number) => String(value).padStart(2, '0');

function localStamp(instant: string): string {
  const date = new Date(instant);
  return Number.isFinite(date.getTime()) ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` : '—';
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return value;
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Click to edit; Enter (⌘/Ctrl+Enter for notes) or leaving the cell saves, Esc cancels. */
function EditableCell({ value, display, kind, label, onSave }: { value: string; display: ReactNode; kind: 'date' | 'notes'; label: string; onSave: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Enter, Esc and blur can all end an edit; only the first one counts.
  const settled = useRef(false);
  const finish = async (next: string) => {
    settled.current = true;
    if (next === value) { setDraft(null); setError(''); return; }
    if (kind === 'date' && next !== '' && !isValidProgressDate(next)) { settled.current = false; setError('请输入有效日期'); return; }
    setSaving(true); setError('');
    try { await onSave(next); setDraft(null); }
    catch (cause) { settled.current = false; setError(cause instanceof Error ? cause.message : '保存失败，请重试'); }
    finally { setSaving(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || settled.current) return;
    if (event.key === 'Escape') { event.preventDefault(); settled.current = true; setDraft(null); setError(''); }
    else if (event.key === 'Enter' && (kind === 'date' || event.metaKey || event.ctrlKey)) { event.preventDefault(); void finish(draft ?? value); }
  };
  if (draft === null) {
    return <button type="button" className="sheet__editable" aria-label={`编辑${label}`} onClick={() => { settled.current = false; setError(''); setDraft(value); }}>{display}</button>;
  }
  const common = { value: draft, disabled: saving, autoFocus: true, 'aria-label': label, onKeyDown, onBlur: () => { if (!settled.current) void finish(draft); } };
  return <div className="sheet__editor">
    {kind === 'date'
      ? <input type="date" {...common} onChange={event => setDraft(event.target.value)} />
      : <textarea rows={3} {...common} onChange={event => setDraft(event.target.value)} />}
    {saving ? <span className="sheet__editor-note">保存中…</span> : error ? <span className="sheet__editor-error" role="alert">{error}</span> : kind === 'notes' ? <span className="sheet__editor-note">⌘/Ctrl+Enter 保存 · Esc 取消</span> : null}
  </div>;
}

/**
 * The work-location cell: click to edit as city tags. Enter on an empty input, 保存 or clicking
 * elsewhere saves (text still being typed counts as a tag); Esc cancels.
 */
function CityCell({ item, suggestions, onSave }: { item: SheetItem; suggestions: readonly string[]; onSave: (value: string) => Promise<void> }) {
  const company = item.row.application.company;
  const stored = joinCities(splitCities(item.row.application.city));
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef('');
  const settled = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const editing = draft !== null;

  const close = () => { settled.current = true; pending.current = ''; setDraft(null); setError(''); };
  const finish = useCallback(async () => {
    if (settled.current || draft === null) return;
    settled.current = true;
    const next = joinCities([...splitCities(draft), ...splitCities(pending.current)]);
    if (next === stored) { pending.current = ''; setDraft(null); setError(''); return; }
    setSaving(true); setError('');
    try { await onSave(next); pending.current = ''; setDraft(null); }
    catch (cause) { settled.current = false; setError(cause instanceof Error ? cause.message : '保存失败，请重试'); }
    finally { setSaving(false); }
  }, [draft, onSave, stored]);

  // A click anywhere outside the editor saves. This runs on pointerdown, before the input loses focus,
  // so it also works in WebKit, where clicking a button doesn't move focus to it.
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) void finish(); };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [editing, finish]);

  if (draft === null) {
    const cities = splitCities(stored);
    return <button type="button" className="sheet__editable sheet__editable--cities" aria-label={`编辑${company}的工作地点`} onClick={() => { settled.current = false; pending.current = ''; setError(''); setDraft(stored); }}>
      {cities.length ? cities.map(city => <span key={city} className="sheet__city">{city}</span>) : <span className="sheet__muted">＋ 地点</span>}
    </button>;
  }
  return <div className="sheet__city-editor" ref={box}>
    <CityTagsInput
      inlineMenu autoFocus
      label={`${company}的工作地点`}
      value={draft}
      onChange={setDraft}
      suggestions={suggestions}
      onDraftChange={text => { pending.current = text; }}
      onSubmit={() => void finish()}
      onCancel={close}
    />
    {saving ? <span className="sheet__editor-note">保存中…</span> : error ? <span className="sheet__editor-error" role="alert">{error}</span> : <span className="sheet__editor-note">回车添加，空着回车保存 · Esc 取消</span>}
    <div className="sheet__city-actions">
      <button type="button" className="sheet__mini" disabled={saving} onClick={() => void finish()}>保存</button>
      <button type="button" className="sheet__mini" disabled={saving} onClick={close}>取消</button>
    </div>
  </div>;
}

function stageSummary(cell: ProgressTableStageCell): string | null {
  const receipt = cell.offerReceipts.at(-1);
  if (receipt) return `${receipt.statusName} ${shortDate(receipt.receivedOn)}${receipt.decision === 'accepted' ? ' · 已接受' : receipt.decision === 'declined' ? ' · 已拒绝' : ' · 待决定'}`;
  if (!cell.latestStatusName && !cell.skipped) return null;
  if (!cell.latestStatusName) return '跳过';
  const parts = [`${cell.latestStatusName} ${shortDate(cell.latestOccurredOn)}`.trim()];
  if (cell.visitCount > 1) parts.push(`共 ${cell.visitCount} 次`);
  if (cell.stayDays !== null) parts.push(`${cell.current ? '已停留' : '停留'} ${cell.stayDays} 天`);
  return parts.join(' · ');
}

function SheetRow({ item, props }: { item: SheetItem; props: ApplicationSheetProps }) {
  const { application, current, nextSchedule } = item.row;
  const id = application.id;
  const expanded = props.expandedIds.has(id);
  const busy = props.busyIds.has(id);
  const options = quickStatusOptions(props.definitions, item.record);
  const tone = quickStatusTone(item.statusKey, props.definitions);
  const link = application.trackingUrl.trim() || application.jobUrl.trim();
  const href = link ? safeHttpUrl(link) : null;
  const notes = displayNotes(application.notes);
  const scheduleTime = nextSchedule ? Date.parse(nextSchedule.startsAt) : Number.NaN;
  const overdue = Number.isFinite(scheduleTime) && scheduleTime < props.now;
  const stale = item.staleDays !== null && item.staleDays >= STALE_DAYS;
  const stages = props.columns.flatMap(column => {
    const cell = item.row.stageCells[column.id];
    const summary = cell ? stageSummary(cell) : null;
    return summary ? [{ id: column.id, name: column.name, summary, failed: cell!.failureEvents.length > 0 }] : [];
  });

  // The whole row toggles the flow, except where a click means something else: controls, editors, links,
  // and dragging to select text. Keyboard users have the arrow button, which carries aria-expanded.
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="combobox"], [role="listbox"], .sheet__editor, .sheet__city-editor')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim() && event.currentTarget.contains(selection.anchorNode)) return;
    props.onToggleExpand(id);
  };

  return <>
    <tr className={`sheet__row${expanded ? ' sheet__row--expanded' : ''}`} onClick={onRowClick}>
      <td className="sheet__company">
        <div className="sheet__company-inner">
          <button type="button" className={`sheet__expand${expanded ? ' sheet__expand--open' : ''}`} aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}${application.company}的进度流程`} onClick={() => props.onToggleExpand(id)}><Icon name="chevron" size={16} /></button>
          <div className="sheet__co">
            <span>{application.company}</span>
            {application.isStarred && <span className="sheet__star" aria-label="已关注" title="已关注">★</span>}
            
          </div>
        </div>
      </td>
      <td className="sheet__role">{application.role}</td>
      <td><span className="sheet__tag">{item.channelName}</span></td>
      <td className="sheet__date">
        <EditableCell
          value={application.appliedOn ?? ''}
          display={application.appliedOn ? <span title={application.appliedOn}>{monthDay(application.appliedOn)}</span> : <span className="sheet__muted">未投递</span>}
          kind="date"
          label={`${application.company}的投递日期`}
          onSave={value => props.onSaveAppliedOn(item, value || null)}
        />
      </td>
      <td className="sheet__status-cell">
        {/* The pill is sized by its own label; a transparent <select> on top handles the choice,
            so long options in the list don't widen every row. */}
        <span className={`sheet__status${busy ? ' sheet__status--busy' : ''}`} style={{ '--c': tone.color, '--cbg': tone.background } as CSSProperties}>
        <span className="sheet__status-label" aria-hidden="true">{current.statusName}</span>
        <select
          className="sheet__status-select"
          value={item.row.events.at(-1)?.statusId ?? options[0]?.key ?? ''}
          disabled={busy}
          aria-label={`修改${application.company}的状态，当前${current.statusName}`}
          title={current.occurredOn ? `${current.statusName} · ${current.occurredOn}` : current.statusName}
          onChange={event => { const option = options.find(entry => entry.key === event.target.value); if (option) props.onStatusChange(item, option); }}
        >
          {groupQuickStatusOptions(options).map(group => <optgroup key={group.label} label={group.label}>
            {group.options.map(option => <option key={option.key} value={option.key} disabled={option.disabled}>{option.label}</option>)}
          </optgroup>)}
        </select>
        </span>
      </td>
      <td className="sheet__next">{nextSchedule
        ? <span className={overdue ? 'sheet__overdue' : undefined} title={nextSchedule.notes || nextSchedule.title}>{overdue ? '已逾期 · ' : ''}{localStamp(nextSchedule.startsAt).slice(5)} · {nextSchedule.title}</span>
        : stale ? <span className="sheet__stale" title={`「${current.statusName}」已经 ${item.staleDays} 天没有新进展，可以去进度页看看或主动跟进`}>{item.staleDays} 天没进展，可以跟进</span>
          : <span className="sheet__muted">—</span>}</td>
      <td className="sheet__cities"><CityCell item={item} suggestions={props.citySuggestions} onSave={value => props.onSaveCity(item, value)} /></td>
      <td className="sheet__link">{href
        ? <div className="sheet__link-inner"><button type="button" className="sheet__url" title={href} onClick={() => props.onOpenUrl(href)}>{shortUrl(href)}</button><button type="button" className="sheet__mini" onClick={() => props.onCopy(href, '投递链接')}><Icon name="copy" size={12} />复制</button></div>
        : link ? <span className="sheet__muted" title={link}>{link}</span> : <span className="sheet__muted">—</span>}</td>
      <td className="sheet__notes">
        <EditableCell
          value={application.notes}
          display={notes ? <span className="sheet__notes-text" title={notes}>{notes}</span> : <span className="sheet__muted">—</span>}
          kind="notes"
          label={`${application.company}的备注`}
          onSave={value => props.onSaveNotes(item, value)}
        />
      </td>
      <td className="sheet__time" title={`创建：${localStamp(application.createdAt)}\n更新：${localStamp(application.updatedAt)}`}>更新 {localStamp(application.updatedAt).slice(5, 10).replace('-', '/')}</td>
      <td className="sheet__ops">
        <button type="button" className="sheet__icon" title="编辑详情" aria-label={`编辑${application.company}的详情`} onClick={() => props.onEdit(item)}><Icon name="edit" size={15} /></button>
        <button type="button" className="sheet__icon sheet__icon--danger" title="删除" aria-label={`删除${application.company} · ${application.role}`} onClick={() => props.onDelete(item)}><Icon name="trash" size={15} /></button>
      </td>
    </tr>
    {expanded && <tr className="sheet__detail-row">
      <td colSpan={11}>
        <div className="sheet__detail">
          {stages.length > 0 && <div className="sheet__stages" aria-label="各环节记录">{stages.map(stage => <span key={stage.id} className={`sheet__stage${stage.failed ? ' sheet__stage--failed' : ''}`}><b>{stage.name}</b>{stage.summary}</span>)}</div>}
          <ProgressHistory
            events={item.row.events}
            auditEvents={item.record.events}
            uncertainEdges={item.record.migrationReview?.uncertainEdges ?? []}
            title={`进度流程 · ${application.company}`}
            onAppend={() => props.onHistoryAction(item, { kind: 'append' })}
            onBackfill={beforeEventId => props.onHistoryAction(item, { kind: 'backfill', beforeEventId })}
            onCorrect={event => props.onHistoryAction(item, { kind: 'correct', eventId: event.id })}
            onDelete={event => props.onDeleteEvent(item, event)}
          />
          <div className="sheet__detail-links">
            {application.jobUrl && <span>岗位 JD：<button type="button" className="sheet__url" onClick={() => { const url = safeHttpUrl(application.jobUrl); if (url) props.onOpenUrl(url); }}>{shortUrl(application.jobUrl)}</button></span>}
            {application.trackingUrl && <span>进度页：<button type="button" className="sheet__url" onClick={() => { const url = safeHttpUrl(application.trackingUrl); if (url) props.onOpenUrl(url); }}>{shortUrl(application.trackingUrl)}</button></span>}
            <button type="button" className="sheet__mini" onClick={() => props.onEdit(item)}><Icon name="edit" size={12} />编辑详情、日程</button>
          </div>
        </div>
      </td>
    </tr>}
  </>;
}

/** offer.html-style sheet: one row per application with the status editable in place. */
export function ApplicationSheet(props: ApplicationSheetProps) {
  return <section className="sheet" aria-label="投递表格">
    <div className="sheet__scroll" role="region" aria-label="可横向滚动的投递表格" tabIndex={0}>
      <table className="sheet__table">
        <thead><tr>
          <th scope="col">公司</th><th scope="col">岗位</th><th scope="col">渠道</th><th scope="col">投递日期</th><th scope="col">状态</th><th scope="col">下次安排</th><th scope="col">工作地点</th><th scope="col">投递链接</th><th scope="col">备注</th><th scope="col">记录时间</th><th scope="col"><span className="sheet__sr-only">操作</span></th>
        </tr></thead>
        <tbody>
          {props.items.map(item => <SheetRow key={item.row.application.id} item={item} props={props} />)}
          {props.items.length === 0 && <tr><td colSpan={11} className="sheet__empty">{props.emptyMessage}</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}
