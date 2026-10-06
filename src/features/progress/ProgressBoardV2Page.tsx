import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { ProgressTableRow } from '../../domain/v2/table.js';
import { projectProgressTable } from '../../domain/v2/table.js';
import { Drawer } from '../../shared/ui/Dialog.js';
import { Button, PageHeader } from '../../shared/ui/components.js';
import { usePlatform } from '../../app/PlatformContext.js';
import { useV2Data } from '../../app/V2DataContext.js';
import type { ProgressStatusEditorCommand } from '../applications/progress-status-editor.js';
import { ProgressHistory } from './ProgressHistory.js';
import { ProgressHistoryEditor, type ProgressHistoryAction } from './ProgressHistoryEditor.js';
import { ProgressTable, type ProgressTableProps } from './ProgressTable.js';
import { parseProgressTableColumnPreferences, serializeProgressTableColumnPreferences, type ProgressTableColumnPreferences } from './table-layout.js';
import { localBusinessDate } from '../applications/progress-status-editor.js';

type DrawerState =
  | { applicationId: string; mode: 'history' }
  | { applicationId: string; mode: 'status'; action: ProgressHistoryAction }
  | { applicationId: string; mode: 'tracking-url' };
const COLUMN_PREFERENCE_KEY = 'progress-table.columns.v1';

function BoardEmpty({ seasonId }: { seasonId: string | null }) {
  return <div className="board-empty-card">
    <h2>{seasonId ? '这个招聘季还没有投递记录' : '还没有招聘季'}</h2>
    <p>{seasonId ? '新增一条投递后，进度表会按真实记录展示状态和历史。' : '先在数据与设置中创建招聘季，再开始记录机会。'}</p>
  </div>;
}

/** M4 view over the same v2 snapshot used by M3; writes remain command-only. */
export function ProgressBoardV2Page({ seasonId }: { seasonId: string | null }) {
  const { snapshot, revision, runCommand, runWorkspaceCommand } = useV2Data();
  const { platform } = usePlatform();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [trackingUrl, setTrackingUrl] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);
  const [urlError, setUrlError] = useState('');
  const storedColumnPreferences = snapshot.settings.preferences[COLUMN_PREFERENCE_KEY];
  const [columnPreferences, setColumnPreferences] = useState<ProgressTableColumnPreferences>(() => parseProgressTableColumnPreferences(storedColumnPreferences));

  useEffect(() => {
    setColumnPreferences(parseProgressTableColumnPreferences(storedColumnPreferences));
  }, [storedColumnPreferences]);

  const persistColumnPreferences = (next: ProgressTableColumnPreferences) => {
    setColumnPreferences(next);
    void runWorkspaceCommand((commands, expectedRevision) => commands.setPreference({
      expectedRevision,
      key: COLUMN_PREFERENCE_KEY,
      value: serializeProgressTableColumnPreferences(next),
    })).catch(error => setUrlError(error instanceof Error ? error.message : '保存表格列设置失败'));
  };

  const applications = useMemo(
    () => seasonId ? snapshot.applications.filter(application => application.seasonId === seasonId) : [],
    [snapshot.applications, seasonId],
  );
  const progressRecords = useMemo(() => {
    const applicationIds = new Set(applications.map(application => application.id));
    return snapshot.progressRecords.filter(record => applicationIds.has(record.applicationId));
  }, [applications, snapshot.progressRecords]);
  const projection = useMemo(() => projectProgressTable({
    applications,
    progressRecords,
    definitions: snapshot.definitions,
    schedules: snapshot.schedules,
    now: localBusinessDate(),
    ...(statusFilter ? { filters: { currentStatusIds: [statusFilter] } } : {}),
  }), [applications, progressRecords, snapshot.definitions, snapshot.schedules, statusFilter]);
  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projection.rows;
    return projection.rows.filter(row => `${row.application.company}\n${row.application.role}\n${row.application.city}`.toLocaleLowerCase().includes(normalized));
  }, [projection.rows, query]);
  const visibleProjection = useMemo(() => ({ ...projection, rows: visibleRows }), [projection, visibleRows]);
  const selectedRow = drawer ? projection.rows.find(row => row.application.id === drawer.applicationId) ?? null : null;
  const selectedRecord = drawer ? snapshot.progressRecords.find(record => record.applicationId === drawer.applicationId) ?? null : null;

  const openDrawer = (row: ProgressTableRow, mode: DrawerState['mode']) => {
    if (mode === 'tracking-url') setTrackingUrl(row.application.trackingUrl);
    setUrlError('');
    if (mode === 'status') setDrawer({ applicationId: row.application.id, mode, action: { kind: 'append' } });
    else setDrawer({ applicationId: row.application.id, mode });
  };

  const openUrl: NonNullable<ProgressTableProps['onOpenUrl']> = (url) => {
    void platform.openExternal(url).catch(error => {
      setUrlError(error instanceof Error ? error.message : '无法打开网址');
    });
  };

  const saveTrackingUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRow) return;
    setSavingUrl(true);
    setUrlError('');
    try {
      await runCommand(commands => commands.updateFields({
        applicationId: selectedRow.application.id,
        expectedRevision: revision,
        patch: { trackingUrl: trackingUrl.trim() },
      }));
      setDrawer(null);
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : '保存网址失败');
    } finally {
      setSavingUrl(false);
    }
  };

  const submitProgress = async (request: ProgressStatusEditorCommand) => {
    if (request.kind === 'append') await runCommand(commands => commands.appendProgress(request.input));
    else await runCommand(commands => commands.correctProgress(request.input));
    if (drawer?.mode === 'status') setDrawer({ applicationId: drawer.applicationId, mode: 'history' });
  };

  const saveApplicationField: NonNullable<ProgressTableProps['onSaveApplicationField']> = async (row, field, value) => {
    if (field === 'notes') {
      await runCommand(commands => commands.updateFields({
        applicationId: row.application.id,
        expectedRevision: revision,
        patch: { notes: value ?? '' },
      }));
      return;
    }
    if (field === 'trackingUrl') {
      await runCommand(commands => commands.updateFields({
        applicationId: row.application.id,
        expectedRevision: revision,
        patch: { trackingUrl: value ?? '' },
      }));
      return;
    }

    const submittedEvent = row.events.find(event => event.semantics.semantic === 'submitted');
    if (value === null) {
      if (!submittedEvent) return;
      await runCommand(commands => commands.invalidateProgress({
        applicationId: row.application.id,
        expectedRevision: revision,
        eventId: submittedEvent.id,
      }));
      return;
    }
    if (submittedEvent) {
      await runCommand(commands => commands.correctProgress({
        applicationId: row.application.id,
        expectedRevision: revision,
        eventId: submittedEvent.id,
        command: { commandId: crypto.randomUUID(), statusId: submittedEvent.statusId, occurredOn: value, notes: submittedEvent.notes },
      }));
      return;
    }
    const firstEvent = row.events[0];
    await runCommand(commands => commands.appendProgress({
      applicationId: row.application.id,
      expectedRevision: revision,
      command: {
        commandId: crypto.randomUUID(),
        statusId: 'submitted',
        occurredOn: value,
        mode: firstEvent ? 'backfill' : 'new_visit',
        ...(firstEvent ? { beforeEventId: firstEvent.id } : {}),
      },
    }));
  };

  const onStatus: NonNullable<ProgressTableProps['onRequestStatusChange']> = row => openDrawer(row, 'status');
  const onHistory: NonNullable<ProgressTableProps['onViewHistory']> = row => openDrawer(row, 'history');
  const onTrackingUrl: NonNullable<ProgressTableProps['onEditTrackingUrl']> = row => openDrawer(row, 'tracking-url');
  const onSelect: NonNullable<ProgressTableProps['onSelectApplication']> = row => openDrawer(row, 'history');

  return <>
    <PageHeader eyebrow="REAL PROGRESS, CLEARLY SEEN" title="每一段经历，都有迹可循。" description="表格与历史流程读取同一份有效进度记录。" actions={<Button onClick={() => {
      const first = projection.rows[0];
      if (first) openDrawer(first, 'status');
    }} disabled={!projection.rows.length}>记录状态</Button>} />
    {!seasonId || !applications.length ? <BoardEmpty seasonId={seasonId} /> : <>
      <div className="list-toolbar" aria-label="进度表筛选">
        <input aria-label="搜索公司、岗位或城市" placeholder="搜索公司、岗位或城市" value={query} onChange={event => setQuery(event.target.value)} />
        <select aria-label="当前状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
          <option value="">全部当前状态</option>
          {snapshot.definitions.statuses.map(status => <option key={status.id} value={status.id}>{status.name}{status.archivedAt ? ' · 已归档' : ''}</option>)}
        </select>
      </div>
      {urlError && !drawer ? <p role="alert" className="form-error">{urlError}</p> : null}
      <ProgressTable
        projection={visibleProjection}
        definitions={snapshot.definitions}
        columnPreferences={columnPreferences}
        onColumnPreferencesChange={persistColumnPreferences}
        onSaveApplicationField={saveApplicationField}
        onRequestStatusChange={onStatus}
        onEditTrackingUrl={onTrackingUrl}
        onOpenUrl={openUrl}
        onViewHistory={onHistory}
        onSelectApplication={onSelect}
      />
    </>}

    <Drawer
      open={!!drawer && !!selectedRow && !!selectedRecord}
      onClose={() => setDrawer(null)}
      title={drawer?.mode === 'status' ? `记录状态 · ${selectedRow?.application.company ?? ''}` : drawer?.mode === 'tracking-url' ? '投递网址' : `进度历史 · ${selectedRow?.application.company ?? ''}`}
      {...(selectedRow ? { description: `${selectedRow.application.role} · ${selectedRow.application.city || '城市待补充'}` } : {})}
    >
      {drawer?.mode === 'status' && selectedRecord ? <ProgressHistoryEditor
        key={`${drawer.applicationId}:${drawer.action.kind}:${drawer.action.kind === 'append' ? '' : drawer.action.kind === 'backfill' ? drawer.action.beforeEventId : drawer.action.eventId}`}
        action={drawer.action}
        definitions={snapshot.definitions}
        record={selectedRecord}
        expectedRevision={revision}
        onSubmit={submitProgress}
        onCancel={() => setDrawer({ applicationId: drawer.applicationId, mode: 'history' })}
      /> : null}
      {drawer?.mode === 'history' && selectedRow && selectedRecord ? <>
        <p><strong>当前状态：</strong>{selectedRow.current.statusName}</p>
        <ProgressHistory
          events={selectedRow.events}
          auditEvents={selectedRecord.events}
          {...(selectedRecord.migrationReview ? { uncertainEdges: selectedRecord.migrationReview.uncertainEdges } : {})}
          onAppend={() => setDrawer({ applicationId: selectedRow.application.id, mode: 'status', action: { kind: 'append' } })}
          onBackfill={beforeEventId => setDrawer({ applicationId: selectedRow.application.id, mode: 'status', action: { kind: 'backfill', beforeEventId } })}
          onCorrect={event => setDrawer({ applicationId: selectedRow.application.id, mode: 'status', action: { kind: 'correct', eventId: event.id } })}
        />
      </> : null}
      {drawer?.mode === 'tracking-url' && selectedRow ? <form className="application-form" onSubmit={saveTrackingUrl}>
        <p>跟踪网址优先展示；招聘职位页仍保存在独立的职位链接中。</p>
        <label>招聘系统跟踪网址<input type="url" value={trackingUrl} onChange={event => setTrackingUrl(event.target.value)} placeholder="https://" /></label>
        <p className="muted">职位页：{selectedRow.application.jobUrl || '未填写'}</p>
        {urlError ? <p role="alert" className="form-error">{urlError}</p> : null}
        <div className="page-actions"><Button type="button" variant="secondary" onClick={() => setDrawer(null)}>取消</Button><Button disabled={savingUrl}>{savingUrl ? '保存中…' : '保存网址'}</Button></div>
      </form> : null}
    </Drawer>
  </>;
}
