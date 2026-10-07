import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import type { ApplicationV2 } from '../../domain/v2/snapshot.js';
import { usePlatform } from '../../app/PlatformContext.js';
import { useV2Data } from '../../app/V2DataContext.js';
import { ConfirmDialog } from '../../shared/ui/Dialog.js';
import { filterApplicationsForSeason } from './applications-page-model.js';
import { ApplicationDetailDrawer, CreateApplicationDrawer, ExternalLink, useApplicationActions, type NoticeAction, type NoticeTone } from './ApplicationDrawers.js';
import { parseRawApplicationsImport, planRawImportSync, requireCleanRawImport, type RawImportResult, type RawImportSyncPlan } from '../../domain/v2/raw-import.js';
import './ApplicationsV2Page.css';

interface ImportPreview {
  seasonId: string;
  text: string;
  sync: RawImportSyncPlan;
  replace: RawImportResult;
}

export function ApplicationsV2Page({ seasonId }: { seasonId: string | null }) {
  const { snapshot, runImportCommand } = useV2Data();
  const { platform } = usePlatform();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; tone: NoticeTone; action?: NoticeAction } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [confirmImport, setConfirmImport] = useState<'sync' | 'replace' | null>(null);
  const notice = useCallback((message: string, tone: NoticeTone = 'success', action?: NoticeAction) => setFeedback({ message, tone, ...(action ? { action } : {}) }), []);
  const actions = useApplicationActions(notice);
  const season = seasonId ? snapshot.seasons.find(item => item.id === seasonId && item.archivedAt === null) ?? null : null;
  const applications = useMemo(
    () => seasonId ? filterApplicationsForSeason(snapshot.applications, seasonId, query) : [],
    [snapshot.applications, seasonId, query],
  );
  const activeChannels = snapshot.channels.filter(channel => channel.archivedAt === null);
  const importTargetSeason = importPreview ? snapshot.seasons.find(item => item.id === importPreview.seasonId) ?? null : null;
  const existingTargetCount = importPreview ? snapshot.applications.filter(item => item.seasonId === importPreview.seasonId).length : 0;

  useEffect(() => {
    if (selectedId && !snapshot.applications.some(application => application.id === selectedId && application.seasonId === seasonId)) setSelectedId(null);
  }, [selectedId, seasonId, snapshot.applications]);

  const toggleStar = (application: ApplicationV2) => {
    void actions.saveFields(application, { isStarred: !application.isStarred })
      .catch(cause => notice(cause instanceof Error ? cause.message : '保存失败，请重试', 'error'));
  };

  const chooseRawImport = async () => {
    if (!season) { notice('请先选择要导入到的招聘季。', 'error'); return; }
    setFeedback(null); setImportPreview(null); setImportBusy(true);
    try {
      const text = await platform.readBackupFile();
      if (text === null) return;
      setImportPreview({
        seasonId: season.id,
        text,
        sync: planRawImportSync(snapshot, text, { seasonId: season.id }),
        replace: parseRawApplicationsImport(text, { seasonId: season.id, channels: snapshot.channels, definitions: snapshot.definitions }),
      });
    } catch (cause) {
      notice(cause instanceof Error ? cause.message : '无法读取这个原始 JSON 文件。', 'error');
    } finally { setImportBusy(false); }
  };

  const commitSync = async () => {
    if (!importPreview) return;
    setImportBusy(true); setConfirmImport(null);
    try {
      const result = await runImportCommand((commands, expectedRevision) => commands.syncSeasonApplications({ expectedRevision, seasonId: importPreview.seasonId, source: importPreview.text }));
      setImportPreview(null);
      notice(result.changed
        ? `已同步：新增 ${result.plan.additions.length} 条，更新 ${result.plan.statusUpdates.length} 条状态，跳过 ${result.plan.skipped.length} 条；同步前的数据已留作恢复副本。`
        : '文件里没有新的内容，数据未改动。');
    } catch (cause) {
      notice(`${cause instanceof Error ? cause.message : '同步失败'}；当前数据未改动。`, 'error');
    } finally { setImportBusy(false); }
  };

  const commitReplace = async () => {
    if (!importPreview) return;
    setImportBusy(true); setConfirmImport(null);
    try {
      const rows = requireCleanRawImport(importPreview.replace);
      const result = await runImportCommand((commands, expectedRevision) => commands.replaceSeasonApplications({ expectedRevision, seasonId: importPreview.seasonId, applications: rows }));
      const targetName = snapshot.seasons.find(item => item.id === result.seasonId)?.name ?? '所选招聘季';
      setImportPreview(null);
      notice(`已导入 ${result.importedApplicationCount} 条记录到「${targetName}」；替换前的 ${result.removedApplicationCount} 条记录已保留为恢复副本。`);
    } catch (cause) {
      notice(cause instanceof Error ? `${cause.message}；当前数据未被部分替换。` : '导入失败，当前数据未被部分替换。', 'error');
    } finally { setImportBusy(false); }
  };

  const openRowOnKey = (event: KeyboardEvent<HTMLTableRowElement>, applicationId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(applicationId);
    }
  };

  const sync = importPreview?.sync;
  const replace = importPreview?.replace;
  const replaceStatusCounts = replace?.applications.reduce((counts, item) => counts.set(item.sourceStatus, (counts.get(item.sourceStatus) ?? 0) + 1), new Map<string, number>());

  return <section className="applications-v2" aria-label="v2 投递管理">
    <header className="applications-v2__header">
      <div>
        <p className="applications-v2__eyebrow">秋招看板 · 投递管理</p>
        <h1>投递记录</h1>
        {season && <p className="applications-v2__season">{season.name}</p>}
      </div>
      <div className="applications-v2__header-actions">
        <button type="button" onClick={() => void chooseRawImport()} disabled={!season || importBusy}>{importBusy ? '正在读取…' : '导入原始 JSON'}</button>
        <Link className="applications-v2__header-link" to="/settings">管理招聘季</Link>
        <button type="button" onClick={() => { setFeedback(null); setCreating(true); }} disabled={!season || activeChannels.length === 0} title={activeChannels.length === 0 ? '需要先配置投递渠道' : undefined}>＋ 新增投递</button>
      </div>
    </header>

    {feedback && <p className={`applications-v2__feedback${feedback.tone === 'error' ? ' applications-v2__feedback--error' : ''}`} role="status"><span>{feedback.message}{feedback.action && <button type="button" className="applications-v2__feedback-action" onClick={() => { const action = feedback.action!; setFeedback(null); void action.run(); }}>{feedback.action.label}</button>}</span><button type="button" aria-label="关闭提示" onClick={() => setFeedback(null)}>×</button></p>}

    {importPreview && sync && replace && <section className="applications-v2__import-preview" aria-label="原始 JSON 导入预览">
      <div className="applications-v2__import-preview-heading"><div><h2>原始 JSON 导入预览</h2><p>目标招聘季：{importTargetSeason?.name ?? '已不存在'}。确认前不会修改任何记录。</p></div>
        <button type="button" className="applications-v2__secondary-button" onClick={() => setImportPreview(null)}>关闭预览</button>
      </div>
      <p>文件共有 {sync.totalCount} 条。按「同步」处理：新增 <strong>{sync.additions.length}</strong> 条，更新状态 <strong>{sync.statusUpdates.length}</strong> 条，无变化 {sync.unchangedCount} 条，跳过 {sync.skipped.length} 条。同步只追加，不会删除任何记录。</p>
      {(sync.statusUpdates.length > 0 || sync.additions.length > 0 || sync.skipped.length > 0) && <details className="applications-v2__import-details">
        <summary>查看明细</summary>
        <ul>
          {sync.statusUpdates.map(item => <li key={`u-${item.applicationId}`}>更新：{item.company} · {item.role}：{item.fromStatusName} → {item.sourceStatus}（{item.occurredOn}）</li>)}
          {sync.additions.map(item => <li key={`a-${item.application.id}`}>新增：{item.application.company} · {item.application.role}（{item.sourceStatus}）</li>)}
          {sync.skipped.map(item => <li key={`s-${item.sourceId}`}>跳过：{item.company} · {item.role}：{item.reason}</li>)}
        </ul>
      </details>}
      {sync.issues.length > 0 && <div className="applications-v2__import-issues" role="alert"><strong>文件有问题，不会导入任何记录。</strong><ul>{sync.issues.slice(0, 8).map(issue => <li key={`${issue.index}-${issue.field}-${issue.sourceId ?? ''}`}>{issue.index < 0 ? issue.message : `第 ${issue.index + 1} 条${issue.sourceId ? `（${issue.sourceId}）` : ''}：${issue.message}`}</li>)}</ul>{sync.issues.length > 8 && <p>另有 {sync.issues.length - 8} 个问题未展开。</p>}</div>}
      <div className="applications-v2__import-actions">
        <button type="button" disabled={importBusy || sync.issues.length > 0 || (!sync.additions.length && !sync.statusUpdates.length) || !importTargetSeason} onClick={() => setConfirmImport('sync')}>确认同步</button>
        <details className="applications-v2__import-replace">
          <summary>改为整体替换这个招聘季…</summary>
          <p className="applications-v2__import-warning">整体替换会删除「{importTargetSeason?.name ?? '当前招聘季'}」现有的 {existingTargetCount} 条投递及其进度、日程，再按文件重建 {replace.applications.length} 条；其他招聘季不变，替换前的数据会留作恢复副本。</p>
          {replace.applications.length > 0 && <ul className="applications-v2__import-statuses" aria-label="预览状态统计">
            {[...replaceStatusCounts!.entries()].map(([statusName, count]) => <li key={statusName}><span>{statusName}</span><strong>{count}</strong></li>)}
          </ul>}
          <button type="button" className="applications-v2__secondary-button" disabled={importBusy || replace.issues.length > 0 || replace.applications.length === 0 || !importTargetSeason} onClick={() => setConfirmImport('replace')}>确认替换并导入 {replace.applications.length} 条</button>
        </details>
      </div>
    </section>}

    {!season ? <section className="applications-v2__empty" aria-label="没有可用招聘季">
      <h2>{seasonId ? '这个招聘季不可用' : '先选择一个招聘季'}</h2>
      <p>{seasonId ? '招聘季可能已被归档或不存在。' : '投递记录会按招聘季分开显示。'}可以在「数据与设置」中创建或切换招聘季。</p>
      <Link className="applications-v2__header-link" to="/settings">前往数据与设置</Link>
    </section> : <>
      <div className="applications-v2__toolbar">
        <label><span className="applications-v2__sr-only">搜索公司、岗位、城市</span><input type="search" placeholder="搜索公司、岗位、城市" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <span>{applications.length} 条投递</span>
      </div>
      {activeChannels.length === 0 && <p className="applications-v2__notice" role="note">尚无可用投递渠道，暂时无法新增投递。</p>}
      <div className="applications-v2__table-wrap">
        <table className="applications-v2__table">
          <caption>{season.name}的投递记录</caption>
          <thead><tr>
            <th scope="col">公司 / 岗位</th><th scope="col">城市 / 渠道</th><th scope="col">投递状态</th><th scope="col">投递日期</th><th scope="col">关注</th><th scope="col">投递进度</th><th scope="col">岗位 JD</th>
          </tr></thead>
          <tbody>
            {applications.map(application => {
              const progress = snapshot.progressRecords.find(record => record.applicationId === application.id);
              const status = snapshot.definitions.statuses.find(item => item.id === application.currentStatusId);
              const channel = snapshot.channels.find(item => item.id === application.channelId);
              return <tr key={application.id} tabIndex={0} onClick={() => setSelectedId(application.id)} onKeyDown={event => openRowOnKey(event, application.id)} aria-label={`${application.company}，${application.role}，点击查看详情`}>
                <th scope="row"><button type="button" className="applications-v2__identity" onClick={event => { event.stopPropagation(); setSelectedId(application.id); }}><strong>{application.company}</strong><span>{application.role}</span></button></th>
                <td><span>{application.city || '未填写城市'}</span><small>{channel?.name ?? '未知渠道'}</small></td>
                <td><button type="button" className="applications-v2__status" onClick={event => { event.stopPropagation(); setSelectedId(application.id); }}><span className={`applications-v2__status-dot${status?.semantic === 'failed' ? ' applications-v2__status-dot--failed' : status?.semantic.startsWith('offer_') ? ' applications-v2__status-dot--offer' : ''}`} style={status ? { backgroundColor: status.color } : undefined} /><span className="applications-v2__status-text">{status?.name ?? '未知状态'}{!progress?.events.some(event => event.invalidatedAt === null) && <small>未记录进度</small>}</span></button></td>
                <td>{progress?.appliedOn ?? application.appliedOn ?? <span className="applications-v2__muted">未投递</span>}</td>
                <td><button type="button" className={`applications-v2__star${application.isStarred ? ' applications-v2__star--active' : ''}`} aria-pressed={application.isStarred} aria-label={application.isStarred ? '取消关注' : '关注这条投递'} onClick={event => { event.stopPropagation(); toggleStar(application); }}>{application.isStarred ? '★' : '☆'}</button></td>
                <td onClick={event => event.stopPropagation()}><ExternalLink value={application.trackingUrl} label="打开进度页" onOpen={url => void actions.openUrl(url)} /></td>
                <td onClick={event => event.stopPropagation()}><ExternalLink value={application.jobUrl} label="打开 JD" onOpen={url => void actions.openUrl(url)} /></td>
              </tr>;
            })}
            {applications.length === 0 && <tr><td colSpan={7} className="applications-v2__empty-row"><h2>{query.trim() ? '没有匹配结果' : '这个招聘季还没有投递'}</h2><p>{query.trim() ? '试试其他公司、岗位或城市关键词。' : '新增一条投递，记录公司、岗位和当前状态。'}</p>{!query.trim() && <button type="button" onClick={() => setCreating(true)} disabled={activeChannels.length === 0}>＋ 新增投递</button>}</td></tr>}
          </tbody>
        </table>
      </div>
    </>}

    <ConfirmDialog open={confirmImport === 'sync'} onCancel={() => setConfirmImport(null)} onConfirm={() => void commitSync()} title="同步这个文件？" description={`将在「${importTargetSeason?.name ?? '所选招聘季'}」新增 ${sync?.additions.length ?? 0} 条投递，并为 ${sync?.statusUpdates.length ?? 0} 条投递追加最新状态。不会删除任何记录；同步前的数据会留作恢复副本。`} confirmLabel="确认同步" cancelLabel="再检查一下" />
    <ConfirmDialog open={confirmImport === 'replace'} onCancel={() => setConfirmImport(null)} onConfirm={() => void commitReplace()} title="替换这个招聘季的全部记录？" description={`将用原始文件的 ${replace?.applications.length ?? 0} 条记录替换「${importTargetSeason?.name ?? '所选招聘季'}」当前的 ${existingTargetCount} 条记录。进度状态会按源文件保留；其他招聘季不变，替换前的完整工作空间会保留为恢复副本。`} confirmLabel="替换并导入" cancelLabel="再检查一下" />
    <CreateApplicationDrawer open={creating} seasonId={season?.id ?? null} onClose={() => setCreating(false)} notice={notice} />
    <ApplicationDetailDrawer applicationId={selectedId} onClose={() => setSelectedId(null)} notice={notice} />
  </section>;
}
