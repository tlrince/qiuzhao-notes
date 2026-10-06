import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { projectProgressTable } from '../../domain/v2/table.js';
import { Drawer, ConfirmDialog } from '../../shared/ui/Dialog.js';
import { Button, PageHeader } from '../../shared/ui/components.js';
import { Icon, type IconName } from '../../shared/ui/Icon.js';
import { ToastRegion, useToasts } from '../../shared/ui/Toast.js';
import { useV2Data } from '../../app/V2DataContext.js';
import { ApplicationDetailDrawer, CreateApplicationDrawer, useApplicationActions, type NoticeAction, type NoticeTone } from '../applications/ApplicationDrawers.js';
import { localBusinessDate } from '../applications/progress-status-editor.js';
import { ApplicationSheet } from './ApplicationSheet.js';
import { ProgressHistoryEditor, type ProgressHistoryAction } from './ProgressHistoryEditor.js';
import { buildQuickStatusChange, quickStatusTone, type QuickStatusOption, type QuickStatusResult } from './quick-status.js';
import { ALL, buildSheetItems, filterSheetItems, matchesSearchAndChannel, sheetStats, sheetStatusChips, sortSheetItems, type SheetItem, type SheetSort } from './sheet-model.js';
import './ProgressBoard.css';

const SORTS: Array<[SheetSort, string]> = [
  ['apply-desc', '投递日期 · 新 → 旧'],
  ['apply-asc', '投递日期 · 旧 → 新'],
  ['update-desc', '最近更新'],
  ['create-desc', '最新创建'],
  ['company', '公司名排序'],
];

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // WebKit views may refuse the async clipboard; fall back to a selection copy.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('复制失败，请手动复制');
  }
}

function BoardEmpty({ seasonId, onCreate }: { seasonId: string | null; onCreate: () => void }) {
  return <div className="board-empty-card">
    <h2>{seasonId ? '这个招聘季还没有投递记录' : '还没有招聘季'}</h2>
    <p>{seasonId ? '新增一条投递，记录公司、岗位和当前状态。' : '先在数据与设置中创建招聘季，再开始记录机会。'}</p>
    {seasonId && <Button onClick={onCreate}><Icon name="plus" size={16} />新增第一条投递</Button>}
  </div>;
}

/** offer.html-style board over the shared v2 snapshot; every write goes through commands. */
export function ProgressBoardV2Page({ seasonId }: { seasonId: string | null }) {
  const { snapshot, revision, runCommand } = useV2Data();
  const { toasts, show, dismiss } = useToasts();
  const notice = useCallback((message: string, tone: NoticeTone = 'success', action?: NoticeAction) => show(message, tone, action), [show]);
  const actions = useApplicationActions(notice);
  const [search, setSearch] = useState('');
  const [channelId, setChannelId] = useState(ALL);
  const [statusKey, setStatusKey] = useState(ALL);
  const [sort, setSort] = useState<SheetSort>('apply-desc');
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ applicationId: string; action: ProgressHistoryAction } | null>(null);
  const [pendingSubmission, setPendingSubmission] = useState<{ item: SheetItem; option: QuickStatusOption } | null>(null);
  const [deleting, setDeleting] = useState<SheetItem | null>(null);
  const today = localBusinessDate();

  const season = seasonId ? snapshot.seasons.find(item => item.id === seasonId && item.archivedAt === null) ?? null : null;
  const applications = useMemo(() => season ? snapshot.applications.filter(application => application.seasonId === season.id) : [], [snapshot.applications, season]);
  const records = useMemo(() => {
    const ids = new Set(applications.map(application => application.id));
    return snapshot.progressRecords.filter(record => ids.has(record.applicationId));
  }, [applications, snapshot.progressRecords]);
  const projection = useMemo(() => projectProgressTable({ applications, progressRecords: records, definitions: snapshot.definitions, schedules: snapshot.schedules, now: today }), [applications, records, snapshot.definitions, snapshot.schedules, today]);
  const items = useMemo(() => buildSheetItems(projection.rows, records, snapshot.channels, today), [projection.rows, records, snapshot.channels, today]);
  const searched = useMemo(() => items.filter(item => matchesSearchAndChannel(item, { search, channelId })), [items, search, channelId]);
  const visible = useMemo(() => sortSheetItems(filterSheetItems(items, { search, channelId, statusKey }), sort), [items, search, channelId, statusKey, sort]);
  const chips = useMemo(() => sheetStatusChips(searched, snapshot.definitions, statusKey), [searched, snapshot.definitions, statusKey]);
  const stats = useMemo(() => sheetStats(items), [items]);
  const usedChannels = snapshot.channels.filter(channel => channel.archivedAt === null || applications.some(application => application.channelId === channel.id));
  const filtering = search.trim() !== '' || channelId !== ALL || statusKey !== ALL;
  const editorRecord = editor ? snapshot.progressRecords.find(record => record.applicationId === editor.applicationId) ?? null : null;
  const editorApplication = editor ? snapshot.applications.find(application => application.id === editor.applicationId) ?? null : null;

  const setBusy = (applicationId: string, busy: boolean) => setBusyIds(current => {
    const next = new Set(current);
    if (busy) next.add(applicationId); else next.delete(applicationId);
    return next;
  });

  const appendSteps = async (item: SheetItem, result: Extract<QuickStatusResult, { kind: 'append' }>) => {
    const applicationId = item.row.application.id;
    setBusy(applicationId, true);
    try {
      await runCommand((commands, expectedRevision) => commands.appendProgressSteps({ applicationId, expectedRevision, steps: result.steps }));
      notice(`状态已更新为「${result.label}」`);
    } catch (cause) {
      notice(cause instanceof Error ? cause.message : '状态保存失败，请重试', 'error');
    } finally {
      setBusy(applicationId, false);
    }
  };

  const changeStatus = (item: SheetItem, option: QuickStatusOption, withSubmission = false) => {
    const result = buildQuickStatusChange({ definitions: snapshot.definitions, record: item.record, option, today, commandId: globalThis.crypto.randomUUID(), withSubmission });
    if (result.kind === 'noop') return;
    if (result.kind === 'needs-reopen') {
      notice('这条流程已经结束；恢复流程需要写一句原因', 'error');
      setEditor({ applicationId: item.row.application.id, action: { kind: 'append' } });
      return;
    }
    if (result.kind === 'needs-submission') { setPendingSubmission({ item, option }); return; }
    void appendSteps(item, result);
  };

  const saveAppliedOn = async (item: SheetItem, value: string | null) => {
    const { row } = item;
    const applicationId = row.application.id;
    const submittedEvent = row.events.find(event => event.semantics.semantic === 'submitted');
    if (value === null) {
      if (!submittedEvent) return;
      await runCommand((commands, expectedRevision) => commands.invalidateProgress({ applicationId, expectedRevision, eventId: submittedEvent.id }));
    } else if (submittedEvent) {
      await runCommand((commands, expectedRevision) => commands.correctProgress({ applicationId, expectedRevision, eventId: submittedEvent.id, command: { commandId: globalThis.crypto.randomUUID(), statusId: submittedEvent.statusId, occurredOn: value, notes: submittedEvent.notes } }));
    } else {
      const submission = snapshot.definitions.statuses.find(status => status.semantic === 'submitted' && status.archivedAt === null);
      if (!submission) throw new Error('没有可用的「已投递」状态');
      const first = row.events[0];
      if (first && value > first.occurredOn) throw new Error(`投递日期不能晚于第一条进度（${first.occurredOn}）`);
      await runCommand((commands, expectedRevision) => commands.appendProgress({ applicationId, expectedRevision, command: { commandId: globalThis.crypto.randomUUID(), statusId: submission.id, occurredOn: value, ...(first ? { mode: 'backfill' as const, beforeEventId: first.id } : {}) } }));
    }
    notice('投递日期已保存');
  };

  const saveNotes = async (item: SheetItem, value: string) => {
    await runCommand((commands, expectedRevision) => commands.updateFields({ applicationId: item.row.application.id, expectedRevision, patch: { notes: value } }));
    notice('备注已保存');
  };

  const copy = (text: string, label: string) => {
    void copyText(text).then(() => notice(`${label}已复制`), cause => notice(cause instanceof Error ? cause.message : '复制失败', 'error'));
  };

  const toggleExpand = (applicationId: string) => setExpandedIds(current => {
    const next = new Set(current);
    if (next.has(applicationId)) next.delete(applicationId); else next.add(applicationId);
    return next;
  });

  const submitEditor = async (command: Parameters<typeof actions.applyProgressCommand>[0]) => {
    await actions.applyProgressCommand(command);
    setEditor(null);
  };

  const clearFilters = () => { setSearch(''); setChannelId(ALL); setStatusKey(ALL); };
  const statCards: Array<{ label: string; value: string; icon: IconName; color: string; background: string }> = [
    { label: '总投递', value: String(stats.total), icon: 'file', color: '#e8590c', background: '#fdeee1' },
    { label: '投递公司', value: String(stats.companies), icon: 'building', color: '#0f766e', background: '#f0fdfa' },
    { label: '流程中', value: String(stats.active), icon: 'activity', color: '#2563eb', background: '#eff6ff' },
    { label: 'Offer', value: String(stats.offers), icon: 'award', color: '#16a34a', background: '#f0fdf4' },
    { label: '泡池中', value: String(stats.pool), icon: 'clock', color: '#d97706', background: '#fffbeb' },
    { label: '已挂掉', value: String(stats.failed), icon: 'x-circle', color: '#dc2626', background: '#fef2f2' },
    { label: 'Offer 率', value: stats.offerRate === null ? '—' : `${stats.offerRate}%`, icon: 'trend', color: '#7c3aed', background: '#f5f3ff' },
  ];

  return <>
    <PageHeader eyebrow="REAL PROGRESS, CLEARLY SEEN" title="每一段经历，都有迹可循。" description="一行一条投递，状态直接在表格里改；展开一行可以看完整的进度流程。" actions={<Button onClick={() => setCreating(true)} disabled={!season}><Icon name="plus" size={16} />新增投递</Button>} />
    {!season || !applications.length ? <BoardEmpty seasonId={season?.id ?? null} onCreate={() => setCreating(true)} /> : <>
      <section className="board-stats" aria-label="投递概况">
        {statCards.map(card => <div className="board-stat" key={card.label}>
          <span className="board-stat__icon" style={{ color: card.color, background: card.background }}><Icon name={card.icon} size={18} /></span>
          <div><div className="board-stat__value">{card.value}</div><div className="board-stat__label">{card.label}</div></div>
        </div>)}
      </section>
      <section className="board-toolbar" aria-label="筛选与排序">
        <label className="board-search"><Icon name="search" size={15} /><span className="sheet__sr-only">搜索</span><input type="search" placeholder="搜索公司 / 岗位 / 城市 / 备注…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <select className="board-select" aria-label="按渠道筛选" value={channelId} onChange={event => setChannelId(event.target.value)}>
          <option value={ALL}>全部渠道</option>
          {usedChannels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
        </select>
        <select className="board-select" aria-label="排序" value={sort} onChange={event => setSort(event.target.value as SheetSort)}>
          {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="board-count">{filtering
          ? <>显示 {visible.length} 条 / 共 {items.length} 条 <button type="button" className="board-link" onClick={clearFilters}>清除筛选</button></>
          : <>共 {items.length} 条投递 · {stats.companies} 家公司</>}</span>
      </section>
      <nav className="board-chips" aria-label="按状态筛选">
        <button type="button" className={`board-chip${statusKey === ALL ? ' board-chip--on' : ''}`} aria-pressed={statusKey === ALL} onClick={() => setStatusKey(ALL)}>全部 <b>{searched.length}</b></button>
        {chips.map(chip => {
          const tone = quickStatusTone(chip.key, snapshot.definitions);
          return <button type="button" key={chip.key} className={`board-chip${statusKey === chip.key ? ' board-chip--on' : ''}`} aria-pressed={statusKey === chip.key} style={{ '--c': tone.color } as CSSProperties} onClick={() => setStatusKey(statusKey === chip.key ? ALL : chip.key)}><span className="board-chip__dot" />{chip.label} <b>{chip.count}</b></button>;
        })}
      </nav>
      <ApplicationSheet
        items={visible}
        definitions={snapshot.definitions}
        columns={projection.columns}
        busyIds={busyIds}
        expandedIds={expandedIds}
        now={Date.now()}
        emptyMessage={<>没有符合筛选条件的记录　<button type="button" className="board-link" onClick={clearFilters}>清除筛选</button></>}
        onToggleExpand={toggleExpand}
        onStatusChange={changeStatus}
        onSaveAppliedOn={saveAppliedOn}
        onSaveNotes={saveNotes}
        onOpenUrl={url => void actions.openUrl(url)}
        onCopy={copy}
        onEdit={item => setDetailId(item.row.application.id)}
        onDelete={item => setDeleting(item)}
        onHistoryAction={(item, action) => setEditor({ applicationId: item.row.application.id, action })}
      />
    </>}

    <Drawer
      open={!!editor && !!editorRecord && !!editorApplication}
      onClose={() => setEditor(null)}
      title={editor?.action.kind === 'correct' ? '纠正历史事件' : editor?.action.kind === 'backfill' ? '补录历史' : `记录状态 · ${editorApplication?.company ?? ''}`}
      {...(editorApplication ? { description: `${editorApplication.role}${editorApplication.city ? ` · ${editorApplication.city}` : ''}` } : {})}
    >
      {editor && editorRecord ? <ProgressHistoryEditor
        key={`${editor.applicationId}:${editor.action.kind}:${editor.action.kind === 'append' ? '' : editor.action.kind === 'backfill' ? editor.action.beforeEventId : editor.action.eventId}`}
        action={editor.action}
        definitions={snapshot.definitions}
        record={editorRecord}
        expectedRevision={revision}
        onSubmit={submitEditor}
        onCancel={() => setEditor(null)}
      /> : null}
    </Drawer>
    <ConfirmDialog
      open={!!pendingSubmission}
      onCancel={() => setPendingSubmission(null)}
      onConfirm={() => { const pending = pendingSubmission; setPendingSubmission(null); if (pending) changeStatus(pending.item, pending.option, true); }}
      title="这条还没有投递记录"
      description={`要先记录「已投递」（日期为今天 ${today}，之后可以在投递日期列修改），再记录「${pendingSubmission?.option.label ?? ''}」吗？`}
      confirmLabel="记录投递并更新状态"
      cancelLabel="取消"
    />
    <ConfirmDialog
      open={!!deleting}
      onCancel={() => setDeleting(null)}
      onConfirm={() => { const target = deleting; setDeleting(null); if (target) void actions.deleteApplication(target.row.application).catch(cause => notice(cause instanceof Error ? cause.message : '删除失败', 'error')); }}
      title="删除这条记录？"
      description={`「${deleting?.row.application.company ?? ''} · ${deleting?.row.application.role ?? ''}」及其进度和日程会被删除；删除后可以在提示里立即撤销。`}
      confirmLabel="删除"
      cancelLabel="取消"
    />
    <CreateApplicationDrawer open={creating} seasonId={season?.id ?? null} onClose={() => setCreating(false)} notice={notice} />
    <ApplicationDetailDrawer applicationId={detailId} onClose={() => setDetailId(null)} notice={notice} />
    <ToastRegion toasts={toasts} onDismiss={dismiss} />
  </>;
}
