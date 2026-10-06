import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { STAGES } from '../domain/types.js';
import { calculateV2Analytics } from '../domain/v2/analytics.js';
import { useV2Data } from './V2DataContext.js';
import { AppShell } from './AppShell.js';
import { Button, ChartCard, EmptyState, MetricCard, PageHeader, SaveIndicator, StageBadge, type SaveStatus } from '../shared/ui/components.js';
import { Icon } from '../shared/ui/Icon.js';
import { ConfirmDialog, Drawer } from '../shared/ui/Dialog.js';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary.js';
import { usePlatform, useUnsavedChanges } from './PlatformContext.js';
import { ApplicationsV2Page } from '../features/applications/ApplicationsV2Page.js';
import { AnalysisV2Page } from '../features/analytics/AnalysisV2Page.js';
import { ProgressBoardV2Page } from '../features/progress/ProgressBoardV2Page.js';
import { DefinitionManager, type DefinitionManagerCommands } from '../features/settings/DefinitionManager.js';
import { ChannelSettings, SeasonList } from '../features/settings/WorkspaceSettings.js';
import { PlatformPreview } from './PlatformPreview.js';
import { useBackupExport } from './useBackupExport.js';
import { MenuActions } from './MenuActions.js';
import { CreateApplicationDrawer } from '../features/applications/ApplicationDrawers.js';
import { ToastRegion, useToasts } from '../shared/ui/Toast.js';
import type { BackupRestorePreview } from '../repositories/v2/backup-commands.js';
import type { RecoverySnapshotInfo } from '../repositories/storage-v2-contract.js';
const SetupLink = () => <Link className="button button--secondary" to="/settings">了解工作空间<Icon name="arrow" size={16} /></Link>;
function ScaffoldPage({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <><PageHeader eyebrow={eyebrow} title={title} description={description} />{children}</>;
}
function Overview() {
  const { snapshot } = useV2Data();
  const seasonId = snapshot.workspace.activeSeasonId;
  const season = snapshot.seasons.find(item => item.id === seasonId && item.archivedAt === null);
  const analytics = season ? calculateV2Analytics(snapshot, { seasonId: season.id }, { now: new Date().toISOString(), timeZone: snapshot.workspace.timeZone }) : null;
  const seasonApplications = season ? snapshot.applications.filter(item => item.seasonId === season.id) : [];
  const applicationIds = new Set(seasonApplications.map(item => item.id));
  const now = Date.now();
  const pending = snapshot.schedules.filter(item => applicationIds.has(item.applicationId) && item.status === 'pending').sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  // Overdue items still need a follow-up, so they stay visible ahead of upcoming ones.
  const overdue = pending.filter(item => Date.parse(item.startsAt) < now).slice(-5);
  const schedules = [...overdue, ...pending.filter(item => Date.parse(item.startsAt) >= now).slice(0, 5)];
  const recent = [...seasonApplications].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const companyByApplication = new Map(seasonApplications.map(item => [item.id, item.company]));
  return <ScaffoldPage eyebrow="A LITTLE PROGRESS, EVERY DAY" title="每一步，都算数。" description="看看近期安排与最新进展，决定接下来的一步。">
    <div className="welcome-strip"><div className="welcome-art"><Icon name="leaf" size={46} /></div><div><span className="eyebrow">YOUR NEXT CHAPTER</span><h2>{season ? `${season.name}，继续向前。` : '给新的可能，留一个位置。'}</h2><p>{season ? '你的投递和进展已保存于当前工作空间。' : '先创建招聘季，再逐条记录心仪的岗位与投递进度。'}</p></div></div>
    <div className="metrics-grid"><MetricCard label="累计投递" value={String(analytics?.submittedCount ?? 0)} note={season?.name ?? '尚未选择招聘季'} icon="file" /><MetricCard label="流程进行中" value={String(analytics?.activeCount ?? 0)} note="仍在等待下一步进展" icon="clock" /><MetricCard label="推进至面试" value={String(analytics?.humanInterviewCount ?? 0)} note="按真实面试触达统计" icon="board" /><MetricCard label="累计获得 Offer" value={String(analytics?.offerCount ?? 0)} note="包含后续已拒绝的 Offer" icon="leaf" accent /></div>
    <div className="two-column">
      <ChartCard title="近期日程" subtitle="已逾期的待办排在前面，其次是即将开始的安排">{schedules.length ? <ul className="overview-list">{schedules.map(item => <li key={item.id}><div><strong>{item.title}</strong><span>{companyByApplication.get(item.applicationId) ?? '未知公司'}</span></div><time dateTime={item.startsAt}>{overdue.includes(item) && <span className="overview-overdue">已逾期 · </span>}{new Date(item.startsAt).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}</time></li>)}</ul> : <EmptyState icon="calendar" title="近期没有待处理日程" description={season ? '为笔试、面试或跟进安排时间。' : '创建招聘季后，这里会汇总近期日程。'} action={!season ? <SetupLink /> : undefined} />}</ChartCard>
      <ChartCard title="最近投递" subtitle="按最近一次修改排列">{recent.length ? <ul className="overview-list">{recent.map(item => <li key={item.id}><div><strong>{item.company}</strong><span>{item.role}</span></div><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleDateString('zh-CN')}</time></li>)}</ul> : <EmptyState icon="file" title="当前招聘季还没有记录" description="从投递管理添加第一条机会。" action={<Link className="button button--secondary" to="/applications">前往投递管理<Icon name="arrow" size={16} /></Link>} />}</ChartCard>
    </div>
  </ScaffoldPage>;
}
function Settings() {
  const { snapshot, revision, runWorkspaceCommand, backupCommands, runBackupCommand } = useV2Data();
  const { platform } = usePlatform();
  const { exportBackup: exportFullBackup } = useBackupExport();
  const [name, setName] = useState('2026 秋招');
  const [startDate, setStartDate] = useState('2026-07-01');
  const [endDate, setEndDate] = useState('2026-12-31');
  const [targetCount, setTargetCount] = useState('100');
  const [busy, setBusy] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [restorePreview, setRestorePreview] = useState<BackupRestorePreview | null>(null);
  const [restoreText, setRestoreText] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [recoverySnapshots, setRecoverySnapshots] = useState<RecoverySnapshotInfo[]>([]);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryToRestore, setRecoveryToRestore] = useState<RecoverySnapshotInfo | null>(null);
  const [confirmRecoveryRestore, setConfirmRecoveryRestore] = useState(false);
  const [recoveryToDelete, setRecoveryToDelete] = useState<RecoverySnapshotInfo | null>(null);
  const [confirmRecoveryDelete, setConfirmRecoveryDelete] = useState(false);
  const recoverySnapshotBytes = recoverySnapshots.reduce((total, item) => total + item.estimatedJsonBytes, 0);
  useEffect(() => {
    let mounted = true;
    void backupCommands.listRecoverySnapshots().then(items => {
      if (mounted) { setRecoverySnapshots(items); setRecoveryError(''); }
    }).catch(cause => {
      if (mounted) setRecoveryError(cause instanceof Error ? cause.message : '恢复副本读取失败');
    });
    return () => { mounted = false; };
  }, [backupCommands, revision]);
  const createSeason = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await runWorkspaceCommand((commands, expectedRevision) => commands.createSeason({ expectedRevision, name, startDate, endDate, targetCount: Number(targetCount), activate: true }));
      setMessage('招聘季已创建并设为当前招聘季。');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '创建招聘季失败。'); }
    finally { setBusy(false); }
  };
  const exportBackup = async () => {
    setBackupBusy(true); setMessage('');
    try { setMessage(await exportFullBackup()); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : '备份导出失败。'); }
    finally { setBackupBusy(false); }
  };
  const chooseBackup = async () => {
    setBackupBusy(true); setMessage(''); setRestorePreview(null); setRestoreText(null);
    try {
      const text = await platform.readBackupFile();
      if (text === null) { setMessage('已取消选择备份文件。'); return; }
      const preview = backupCommands.inspect(text, new Date().toISOString());
      setRestoreText(text); setRestorePreview(preview);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '备份文件无法读取。'); }
    finally { setBackupBusy(false); }
  };
  const restoreBackup = async () => {
    if (restoreText === null) return;
    setBackupBusy(true); setConfirmRestore(false); setMessage('');
    try {
      const result = await runBackupCommand((commands, expectedRevision) => commands.restore(restoreText, expectedRevision, new Date().toISOString()));
      setRestorePreview(null); setRestoreText(null);
      setMessage(`已从 v${result.preview.sourceSchemaVersion} 备份恢复 ${result.preview.seasonCount} 个招聘季、${result.preview.applicationCount} 条投递。恢复前的数据已保留为本机恢复副本。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '备份恢复失败，当前数据未替换。'); }
    finally { setBackupBusy(false); }
  };
  const restoreSavedCopy = async () => {
    if (!recoveryToRestore) return;
    setBackupBusy(true); setConfirmRecoveryRestore(false); setMessage('');
    try {
      const result = await runBackupCommand((commands, expectedRevision) => commands.restoreRecoverySnapshot(recoveryToRestore.id, expectedRevision));
      setMessage(`已恢复「${result.recovery.seasonNames.join('、') || result.recovery.workspaceName}」的 v${result.recovery.sourceSchemaVersion} 恢复副本（存储修订 ${result.recovery.sourceRevision}）。回滚前的当前数据已另存为新的恢复副本。`);
      setRecoveryToRestore(null);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '恢复副本失败，当前数据未替换。'); }
    finally { setBackupBusy(false); }
  };
  const deleteSavedCopy = async () => {
    if (!recoveryToDelete) return;
    const selected = recoveryToDelete;
    setBackupBusy(true); setConfirmRecoveryDelete(false); setMessage('');
    try {
      await runBackupCommand((commands, expectedRevision) => commands.deleteRecoverySnapshot(selected.id, expectedRevision));
      setRecoverySnapshots(items => items.filter(item => item.id !== selected.id));
      setRecoveryToDelete(null);
      if (recoveryToRestore?.id === selected.id) setRecoveryToRestore(null);
      setMessage(`已删除恢复副本「${selected.seasonNames.join('、') || selected.workspaceName}」（修订 ${selected.sourceRevision}）。其他副本和当前数据未改动。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '删除恢复副本失败，副本仍保留。'); }
    finally { setBackupBusy(false); }
  };
  const [searchParams, setSearchParams] = useSearchParams();
  const menuRestore = searchParams.get('action') === 'restore';
  useEffect(() => {
    if (!menuRestore) return;
    setSearchParams(params => { params.delete('action'); return params; }, { replace: true });
    void chooseBackup();
  }, [menuRestore]); // chooseBackup only reads stable services; run once per menu request.
  const totalBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  return <ScaffoldPage eyebrow="A SPACE OF YOUR OWN" title="管理你的工作空间。" description="创建招聘季、设置目标，查看当前本地数据状态。">
    {message && <p className="quiet-note" role="status">{message}</p>}
    <div className="two-column settings-grid">
      <ChartCard title="我的招聘季" subtitle="名称、日期范围与投递目标，点「编辑」可以修改">
        <SeasonList onMessage={setMessage} />
        <form className="application-form settings-season-form" onSubmit={createSeason}>
          <h3>新建招聘季</h3>
          <label>名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
          <div className="two-column"><label>开始日期<input type="date" required value={startDate} onChange={event => setStartDate(event.target.value)} /></label><label>结束日期<input type="date" required value={endDate} onChange={event => setEndDate(event.target.value)} /></label></div>
          <label>投递目标<input type="number" min="1" step="1" required value={targetCount} onChange={event => setTargetCount(event.target.value)} /></label>
          <Button type="submit" disabled={busy}>{busy ? '保存中…' : '创建并设为当前'}</Button>
        </form>
      </ChartCard>
      <ChartCard title="数据，由你保管" subtitle="平台数据彼此独立，可在本地离线使用"><div className="settings-info"><Icon name="shield" size={32} />
        <h3>{platform.kind === 'macos' ? '保存在本机应用数据库' : '保存在当前浏览器'}</h3>
        <p>{platform.kind === 'macos' ? '记录已保存到应用专属数据目录；替换应用程序不会清除数据库。' : '记录已保存在此浏览器的本站点数据中；更换浏览器或清理站点数据不会自动迁移。'}</p>
        <p>当前数据：{snapshot.seasons.length} 个招聘季、{snapshot.applications.length} 条投递、约 {(totalBytes / 1024).toFixed(1)} KB。</p>
        <p>最近备份 / 下载发起：{snapshot.settings.lastBackupAt ? new Date(snapshot.settings.lastBackupAt).toLocaleString('zh-CN') : '尚未备份'}。Web 端只记录浏览器收到下载请求的时间。</p>
        <span className="card-tag">数据层已启用 · 快照版本 {revision}</span>
      </div></ChartCard>
    </div>
    <div className="settings-backup-section">
      <ChartCard title="投递渠道" subtitle="新增、改名或归档渠道。归档的渠道不再出现在新建投递的选项里，已有投递照常显示。">
        <ChannelSettings onMessage={setMessage} />
      </ChartCard>
    </div>
    <div className="settings-backup-section">
      <ChartCard title="完整数据备份" subtitle="备份包含所有招聘季、投递、进度历史、状态配置与设置，不受页面筛选影响。">
        <div className="page-actions">
          <Button type="button" disabled={busy || backupBusy} onClick={() => void exportBackup()}>{backupBusy ? '处理中…' : '导出完整备份'}</Button>
          <Button type="button" variant="secondary" disabled={busy || backupBusy} onClick={() => void chooseBackup()}>选择备份并预览</Button>
        </div>
        {restorePreview && <div className="restore-preview" role="status">
          <h3>备份预览</h3>
          <p>工作空间：{restorePreview.workspaceName}</p>
          <p>来源版本 v{restorePreview.sourceSchemaVersion} · 导出时间 {new Date(restorePreview.exportedAt).toLocaleString('zh-CN')}</p>
          <p>{restorePreview.seasonCount} 个招聘季 · {restorePreview.applicationCount} 条投递 · {restorePreview.progressEventCount} 条进度记录 · {restorePreview.scheduleCount} 个日程</p>
          {restorePreview.seasonNames.length > 0 && <p>招聘季：{restorePreview.seasonNames.slice(0, 6).join('、')}{restorePreview.seasonNames.length > 6 ? ` 等 ${restorePreview.seasonNames.length} 个` : ''}</p>}
          <p>确认后会整体替换当前数据；恢复前的数据会在同一事务中保留为本机恢复副本。</p>
          <Button type="button" disabled={busy || backupBusy} onClick={() => setConfirmRestore(true)}>确认整体恢复</Button>
        </div>}
      </ChartCard>
    </div>
    <div className="settings-backup-section">
      <ChartCard title="本机恢复副本" subtitle="整体恢复、导入或同步前会自动保留一份快照，只保留最近 5 份，更早的会自动清理。删除单条投递或日程不占用副本，删除后可以在提示里立即撤销。">
        {recoveryError && <p className="platform-error" role="alert">{recoveryError}</p>}
        {!recoveryError && <div className="recovery-capacity" data-testid="recovery-capacity"><strong>恢复副本 {recoverySnapshots.length} 份 · JSON UTF-8 序列化估算合计 {recoverySnapshotBytes.toLocaleString('zh-CN')} 字节</strong><span>每份按保存数据序列化为 JSON 后的 UTF-8 大小估算，不等于 IndexedDB 或 SQLite 的实际磁盘占用。</span></div>}
        {recoverySnapshots.length ? <ul className="overview-list recovery-list">{recoverySnapshots.map(item => <li key={item.id}>
          <div><strong>{item.seasonNames.length ? `${item.seasonNames.slice(0, 3).join('、')}${item.seasonNames.length > 3 ? ` 等 ${item.seasonNames.length} 个招聘季` : ''}` : item.workspaceName} · v{item.sourceSchemaVersion}</strong><span>修订 {item.sourceRevision} · {item.seasonCount} 个招聘季 · {item.applicationCount} 条投递</span><span>JSON UTF-8 序列化估算：{item.estimatedJsonBytes.toLocaleString('zh-CN')} 字节</span></div>
          <div className="page-actions"><Button type="button" variant="secondary" disabled={busy || backupBusy} onClick={() => { setRecoveryToRestore(item); setConfirmRecoveryRestore(true); }}>预览并恢复</Button><Button type="button" variant="ghost" disabled={busy || backupBusy} onClick={() => { setRecoveryToDelete(item); setConfirmRecoveryDelete(true); }}>删除此副本…</Button></div>
        </li>)}</ul> : !recoveryError ? <EmptyState compact icon="shield" title="还没有恢复副本" description="完成一次整体恢复、导入或同步后，之前的数据会作为副本列在这里。" /> : null}
        {recoveryToRestore && <div className="restore-preview" role="status"><h3>恢复副本预览</h3><p>{recoveryToRestore.seasonNames.join('、') || recoveryToRestore.workspaceName} · 来源 v{recoveryToRestore.sourceSchemaVersion} · 修订 {recoveryToRestore.sourceRevision}</p><p>{recoveryToRestore.seasonCount} 个招聘季 · {recoveryToRestore.applicationCount} 条投递</p><p>恢复后，当前快照会在同一事务中另存为新的恢复副本。</p><Button type="button" disabled={busy || backupBusy} onClick={() => setConfirmRecoveryRestore(true)}>确认恢复此副本</Button></div>}
      </ChartCard>
    </div>
    <div className="page-actions"><Link className="button button--secondary" to="/settings/definitions">管理状态与环节<Icon name="arrow" size={16} /></Link></div>
    <ConfirmDialog open={confirmRestore} onCancel={() => setConfirmRestore(false)} onConfirm={() => void restoreBackup()} title="整体替换当前工作空间？" description={`将用「${restorePreview?.workspaceName ?? '未知工作空间'}」中的 ${restorePreview?.seasonNames.join('、') || `${restorePreview?.seasonCount ?? 0} 个招聘季`} 替换目前 ${snapshot.seasons.length} 个招聘季和 ${snapshot.applications.length} 条投递。备份内包含 ${restorePreview?.applicationCount ?? 0} 条投递、${restorePreview?.progressEventCount ?? 0} 条进度记录和 ${restorePreview?.scheduleCount ?? 0} 个日程；当前数据会由存储层保留为恢复副本。`} confirmLabel="整体恢复" cancelLabel="返回检查" />
    <ConfirmDialog open={confirmRecoveryRestore} onCancel={() => setConfirmRecoveryRestore(false)} onConfirm={() => void restoreSavedCopy()} title="用这个恢复副本替换当前数据？" description={recoveryToRestore ? `将恢复「${recoveryToRestore.seasonNames.join('、') || recoveryToRestore.workspaceName}」v${recoveryToRestore.sourceSchemaVersion}（修订 ${recoveryToRestore.sourceRevision}），包含 ${recoveryToRestore.seasonCount} 个招聘季和 ${recoveryToRestore.applicationCount} 条投递。当前快照会在同一事务中另存为一个新副本。` : ''} confirmLabel="恢复此副本" cancelLabel="返回检查" />
    <ConfirmDialog open={confirmRecoveryDelete} onCancel={() => { setConfirmRecoveryDelete(false); setRecoveryToDelete(null); }} onConfirm={() => void deleteSavedCopy()} title="永久删除这份恢复副本？" description={recoveryToDelete ? `将只删除「${recoveryToDelete.seasonNames.join('、') || recoveryToDelete.workspaceName}」v${recoveryToDelete.sourceSchemaVersion}（恢复副本 ID：${recoveryToDelete.id}；来源修订 ${recoveryToDelete.sourceRevision}），包含 ${recoveryToDelete.seasonCount} 个招聘季和 ${recoveryToDelete.applicationCount} 条投递。删除后无法从本机恢复；当前数据和其他恢复副本不受影响。` : ''} confirmLabel="永久删除此副本" cancelLabel="保留此副本" />
  </ScaffoldPage>;
}
function DefinitionSettings() {
  const { snapshot, runDefinitionCommand } = useV2Data();
  const workspaceId = snapshot.workspace.id;
  const onCommand = useMemo<DefinitionManagerCommands>(() => ({
    onCreateStage: input => runDefinitionCommand((commands, expectedRevision) => commands.createStage({ workspaceId, expectedRevision, ...input })),
    onUpdateStage: input => runDefinitionCommand((commands, expectedRevision) => commands.updateStage({ workspaceId, expectedRevision, ...input })),
    onArchiveStage: stageId => runDefinitionCommand((commands, expectedRevision) => commands.archiveStage({ workspaceId, expectedRevision, stageId })),
    onUnarchiveStage: stageId => runDefinitionCommand((commands, expectedRevision) => commands.unarchiveStage({ workspaceId, expectedRevision, stageId })),
    onCreateStatus: input => runDefinitionCommand((commands, expectedRevision) => commands.createStatus({ workspaceId, expectedRevision, ...input })),
    onUpdateStatus: input => runDefinitionCommand((commands, expectedRevision) => commands.updateStatus({ workspaceId, expectedRevision, ...input })),
    onArchiveStatus: statusId => runDefinitionCommand((commands, expectedRevision) => commands.archiveStatus({ workspaceId, expectedRevision, statusId })),
    onUnarchiveStatus: statusId => runDefinitionCommand((commands, expectedRevision) => commands.unarchiveStatus({ workspaceId, expectedRevision, statusId })),
  }), [runDefinitionCommand, workspaceId]);
  return <DefinitionManager definitions={snapshot.definitions} onCommand={onCommand} />;
}
function DesignSystem({ onPreviewChange, preview }: { onPreviewChange: (value: boolean) => void; preview: boolean }) {
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState(false), [notes, setNotes] = useState('');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { platform } = usePlatform();
  useUnsavedChanges(open && notes.length > 0, () => { setOpen(false); setConfirm(false); setNotes(''); });
  useEffect(() => {
    if (!open && !confirm) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  }, [open, confirm]);
  const requestClose = () => notes ? setConfirm(true) : setOpen(false);
  return <ScaffoldPage eyebrow="DESIGN FOUNDATIONS" title="细节，让记录更从容。" description="这里是独立的组件预览，不会创建或保存真实业务数据。">
    <div className="component-panel"><h2>工作空间与保存状态</h2><label className="checkbox-row"><input type="checkbox" checked={preview} onChange={event => onPreviewChange(event.target.checked)} />显示示例招聘季</label><p className="muted">仅检查招聘季切换和目标进度的外观，刷新后重置。</p><label className="field-label" htmlFor="save-state">保存状态预览</label><select id="save-state" value={status} onChange={e => setStatus(e.target.value as SaveStatus)}><option value="idle">尚未保存</option><option value="saving">保存中</option><option value="saved">已保存到{platform.storageLabel}</option><option value="error">保存失败</option></select><div className="component-status"><SaveIndicator status={status} storageLabel={platform.storageLabel} /></div></div>
    <div className="component-panel"><h2>按钮与阶段</h2><div className="component-row"><Button ref={triggerRef} onClick={() => { setNotes(''); setOpen(true); }}>打开抽屉预览</Button><Button variant="secondary" onClick={() => setConfirm(true)}>打开确认框预览</Button><Button disabled>不可用操作</Button></div><div className="component-row">{STAGES.map(stage => <StageBadge stage={stage} key={stage} />)}</div></div>
    <PlatformPreview />
    <Drawer open={open} onClose={requestClose} title="抽屉预览" description="检查键盘操作与未保存内容的关闭提醒。" footer={<Button variant="secondary" onClick={requestClose}>关闭预览</Button>}><label className="field-label" htmlFor="preview-notes">预览备注</label><textarea id="preview-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={5} placeholder="试着写下一点内容，再关闭抽屉。" /><p className="muted">此处输入仅用于交互预览，不会保存。</p></Drawer>
    <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); setOpen(false); setNotes(''); }} title="放弃未保存的修改？" description="关闭后，这次预览输入的内容将被清除。" confirmLabel="放弃修改" cancelLabel="继续编辑" />
  </ScaffoldPage>;
}
function AnalyticsRoute({ seasonId, onSeasonChange }: { seasonId: string | null; onSeasonChange: (seasonId: string) => void }) {
  const { exportBackup, busy } = useBackupExport();
  const { toasts, show, dismiss } = useToasts(3200);
  const notice = useCallback((message: string, tone: 'success' | 'error' = 'success') => show(message, tone), [show]);
  const [creating, setCreating] = useState(false);
  const runExport = () => {
    if (busy) return;
    void exportBackup().then(message => notice(message), cause => notice(cause instanceof Error ? cause.message : '备份导出失败。', 'error'));
  };
  return <>
    <AnalysisV2Page seasonId={seasonId} onSeasonChange={value => { if (value) onSeasonChange(value); }} onAddApplication={() => setCreating(true)} onExport={runExport} />
    <CreateApplicationDrawer open={creating} seasonId={seasonId} onClose={() => setCreating(false)} notice={notice} />
    <ToastRegion toasts={toasts} onDismiss={dismiss} />
  </>;
}
function DefaultRoute() { const { search } = useLocation(); return <Navigate to={`/analytics${search}`} replace />; }
function PageError({ error, reset }: { error: Error; reset: () => void }) {
  return <ScaffoldPage eyebrow="SOMETHING WENT WRONG" title="这个页面出了点问题。" description="页面显示失败，但已保存的数据没有被修改。可以重试，或先去导出一份备份。">
    <p className="platform-error" role="alert">错误信息：{error.message}</p>
    <div className="page-actions"><Button onClick={reset}>重试</Button><Button variant="secondary" onClick={() => window.location.reload()}>重新加载</Button><Link className="button button--secondary" to="/settings">前往数据与设置</Link></div>
  </ScaffoldPage>;
}
function seasonSubmittedCount(snapshot: ReturnType<typeof useV2Data>['snapshot'], seasonId: string): number {
  try {
    return calculateV2Analytics(snapshot, { seasonId }, { now: new Date().toISOString(), timeZone: snapshot.workspace.timeZone }).submittedCount;
  } catch (cause) {
    console.error('投递目标统计失败', cause);
    return 0;
  }
}
export function App() {
  const { snapshot, saveStatus, lastError, dismissError, runWorkspaceCommand } = useV2Data();
  const location = useLocation();
  const [preview, setPreview] = useState(false);
  const [workspaceError, setWorkspaceError] = useState('');
  const configuredActiveSeason = snapshot.seasons.find(season => season.id === snapshot.workspace.activeSeasonId && season.archivedAt === null);
  const activeSeasonId = configuredActiveSeason?.id ?? null;
  const activeSeason = snapshot.seasons.find(season => season.id === activeSeasonId && season.archivedAt === null);
  const submittedCount = activeSeason ? seasonSubmittedCount(snapshot, activeSeason.id) : 0;
  const onSeasonChange = (seasonId: string) => {
    setWorkspaceError('');
    void runWorkspaceCommand((commands, expectedRevision) => commands.setActiveSeason({ expectedRevision, seasonId })).catch(cause => setWorkspaceError(cause instanceof Error ? cause.message : '切换招聘季失败'));
  };
  const workspace = { ...snapshot.workspace, activeSeasonId };
  return <AppShell workspace={workspace} seasons={snapshot.seasons.filter(season => season.archivedAt === null)} submittedCount={submittedCount} saveStatus={saveStatus as SaveStatus} saveError={lastError} onDismissSaveError={dismissError} onSeasonChange={onSeasonChange}><MenuActions seasonId={activeSeasonId} />{workspaceError && <p className="platform-error" role="alert">{workspaceError}</p>}<ErrorBoundary resetKey={location.pathname} fallback={(error, reset) => <PageError error={error} reset={reset} />}><Routes><Route path="/" element={<DefaultRoute />} /><Route path="/analytics" element={<AnalyticsRoute seasonId={activeSeasonId} onSeasonChange={onSeasonChange} />} /><Route path="/overview" element={<Overview />} /><Route path="/applications" element={<ApplicationsV2Page seasonId={activeSeasonId} />} /><Route path="/board" element={<ProgressBoardV2Page seasonId={activeSeasonId} />} /><Route path="/settings" element={<Settings />} /><Route path="/settings/definitions" element={<DefinitionSettings />} /><Route path="/design-system" element={<DesignSystem preview={preview} onPreviewChange={setPreview} />} /><Route path="*" element={<ScaffoldPage eyebrow="FIND YOUR WAY" title="这一页，还没有留下记录。" description="页面可能不存在，回到熟悉的工作空间继续吧。"><Link className="button button--primary" to="/analytics">返回深度分析<Icon name="arrow" size={16} /></Link></ScaffoldPage>} /></Routes></ErrorBoundary></AppShell>;
}
