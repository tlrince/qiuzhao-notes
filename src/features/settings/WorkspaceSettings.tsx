import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Channel, Season } from '../../domain/types.js';
import { useV2Data } from '../../app/V2DataContext.js';
import { Button, EmptyState } from '../../shared/ui/components.js';
import { ConfirmDialog } from '../../shared/ui/Dialog.js';
import './WorkspaceSettings.css';

const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

function SeasonEditor({ season, onDone }: { season: Season; onDone: (message: string) => void }) {
  const { runWorkspaceCommand } = useV2Data();
  const [name, setName] = useState(season.name);
  const [startDate, setStartDate] = useState(season.startDate);
  const [endDate, setEndDate] = useState(season.endDate);
  const [targetCount, setTargetCount] = useState(String(season.targetCount));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch: Partial<Pick<Season, 'name' | 'startDate' | 'endDate' | 'targetCount'>> = {};
    if (name.trim() !== season.name) patch.name = name.trim();
    if (startDate !== season.startDate) patch.startDate = startDate;
    if (endDate !== season.endDate) patch.endDate = endDate;
    if (Number(targetCount) !== season.targetCount) patch.targetCount = Number(targetCount);
    if (!Object.keys(patch).length) { onDone(''); return; }
    setSaving(true); setError('');
    try {
      await runWorkspaceCommand((commands, expectedRevision) => commands.updateSeason({ expectedRevision, seasonId: season.id, patch }));
      onDone(`已保存「${name.trim()}」${patch.targetCount ? `，投递目标改为 ${patch.targetCount} 份` : ''}`);
    } catch (cause) { setError(errorText(cause, '保存失败，请重试')); }
    finally { setSaving(false); }
  };
  return <form className="workspace-settings__editor" onSubmit={save} aria-label={`编辑招聘季 ${season.name}`}>
    <label>名称<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>开始日期<input type="date" required value={startDate} onChange={event => setStartDate(event.target.value)} /></label>
    <label>结束日期<input type="date" required value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
    <label>投递目标<input type="number" min="1" step="1" required autoFocus value={targetCount} onChange={event => setTargetCount(event.target.value)} /></label>
    <div className="workspace-settings__editor-actions">
      <Button type="button" variant="ghost" disabled={saving} onClick={() => onDone('')}>取消</Button>
      <Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</Button>
    </div>
    {error ? <p className="workspace-settings__error" role="alert">{error}</p> : null}
  </form>;
}

/** Live seasons with inline editing, plus the archived ones so they can be brought back. */
export function SeasonList({ onMessage }: { onMessage: (message: string) => void }) {
  const { snapshot, runWorkspaceCommand } = useV2Data();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSeasonId = snapshot.workspace.activeSeasonId;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toArchive, setToArchive] = useState<Season | null>(null);
  const live = snapshot.seasons.filter(season => season.archivedAt === null);
  const archived = snapshot.seasons.filter(season => season.archivedAt !== null);

  // The sidebar goal card links here with ?edit=season to open the current season's editor.
  useEffect(() => {
    if (searchParams.get('edit') !== 'season') return;
    if (activeSeasonId) setEditingId(activeSeasonId);
    setSearchParams(params => { params.delete('edit'); return params; }, { replace: true });
  }, [activeSeasonId, searchParams, setSearchParams]);

  const run = async (action: Parameters<typeof runWorkspaceCommand>[0], message: string, fallback: string) => {
    setBusy(true); onMessage('');
    try { await runWorkspaceCommand(action); onMessage(message); }
    catch (cause) { onMessage(errorText(cause, fallback)); }
    finally { setBusy(false); }
  };

  return <>
    {live.length ? <ul className="overview-list workspace-settings__list">{live.map(season => <li key={season.id}>
      {editingId === season.id
        ? <SeasonEditor season={season} onDone={text => { setEditingId(null); if (text) onMessage(text); }} />
        : <>
          <div><strong>{season.name}{season.id === activeSeasonId ? ' · 当前' : ''}</strong><span>{season.startDate} 至 {season.endDate} · 目标 {season.targetCount} 份</span></div>
          <div className="page-actions">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditingId(season.id)}>编辑</Button>
            <Button type="button" variant="secondary" disabled={busy || season.id === activeSeasonId} onClick={() => void run((commands, expectedRevision) => commands.setActiveSeason({ expectedRevision, seasonId: season.id }), '当前招聘季已切换。', '切换招聘季失败。')}>设为当前</Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setToArchive(season)}>归档</Button>
          </div>
        </>}
    </li>)}</ul> : <EmptyState icon="leaf" title="还没有可用的招聘季" description={archived.length ? '可以从下方「已归档」恢复，或新建一个。' : '创建一个招聘季后，就可以开始记录投递。'} />}
    {archived.length ? <details className="workspace-settings__archived">
      <summary>已归档的招聘季（{archived.length}）</summary>
      <p>归档只是把招聘季收起来：投递和进度都还在，恢复后照常显示。</p>
      <ul>{archived.map(season => <li key={season.id}>
        <span><strong>{season.name}</strong> · {season.startDate} 至 {season.endDate} · {snapshot.applications.filter(application => application.seasonId === season.id).length} 条投递</span>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void run((commands, expectedRevision) => commands.unarchiveSeason({ expectedRevision, seasonId: season.id }), `已恢复「${season.name}」。`, '恢复招聘季失败。')}>恢复</Button>
      </li>)}</ul>
    </details> : null}
    <ConfirmDialog
      open={toArchive !== null}
      onCancel={() => setToArchive(null)}
      onConfirm={() => { const season = toArchive; setToArchive(null); if (season) void run((commands, expectedRevision) => commands.archiveSeason({ expectedRevision, seasonId: season.id }), `「${season.name}」已归档，可以在「已归档的招聘季」里恢复。`, '归档招聘季失败。'); }}
      title={`归档「${toArchive?.name ?? ''}」？`}
      description="归档后这个招聘季会从切换列表里收起，投递和进度都会保留；之后可以在本页「已归档的招聘季」里恢复。"
      confirmLabel="归档"
      cancelLabel="取消"
    />
  </>;
}

function ChannelRow({ channel, usage, busy, onRename, onArchive }: { channel: Channel; usage: number; busy: boolean; onRename: (name: string) => Promise<boolean>; onArchive: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(channel.name);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === channel.name) { setEditing(false); return; }
    if (await onRename(name)) setEditing(false);
  };
  if (editing) return <li><form className="workspace-settings__inline" onSubmit={submit} aria-label={`重命名渠道 ${channel.name}`}>
    <input aria-label="渠道新名字" required autoFocus maxLength={40} value={name} onChange={event => setName(event.target.value)} />
    <Button type="submit" disabled={busy}>保存</Button>
    <Button type="button" variant="ghost" onClick={() => { setName(channel.name); setEditing(false); }}>取消</Button>
  </form></li>;
  return <li>
    <span><strong>{channel.name}</strong> · {usage} 条投递</span>
    <span className="page-actions workspace-settings__row-actions">
      <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>改名</Button>
      <Button type="button" variant="ghost" disabled={busy} onClick={onArchive}>归档</Button>
    </span>
  </li>;
}

/** Add, rename, archive and restore channels; archived ones stay on the applications that use them. */
export function ChannelSettings({ onMessage }: { onMessage: (message: string) => void }) {
  const { snapshot, runWorkspaceCommand } = useV2Data();
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const usage = (channelId: string) => snapshot.applications.filter(application => application.channelId === channelId).length;
  const live = snapshot.channels.filter(channel => channel.archivedAt === null);
  const archived = snapshot.channels.filter(channel => channel.archivedAt !== null);
  const run = async (action: Parameters<typeof runWorkspaceCommand>[0], message: string): Promise<boolean> => {
    setBusy(true); onMessage('');
    try { await runWorkspaceCommand(action); onMessage(message); return true; }
    catch (cause) { onMessage(errorText(cause, '渠道保存失败。')); return false; }
    finally { setBusy(false); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (await run((commands, expectedRevision) => commands.createChannel({ expectedRevision, name }), `已新增渠道「${name}」。`)) setNewName('');
  };
  return <div className="workspace-settings__channels">
    <ul className="workspace-settings__rows" aria-label="可用渠道">{live.map(channel => <ChannelRow key={channel.id} channel={channel} usage={usage(channel.id)} busy={busy}
      onRename={name => run((commands, expectedRevision) => commands.renameChannel({ expectedRevision, channelId: channel.id, name }), `渠道已改名为「${name.trim()}」。`)}
      onArchive={() => void run((commands, expectedRevision) => commands.archiveChannel({ expectedRevision, channelId: channel.id }), `「${channel.name}」已归档，已有投递仍显示这个渠道。`)} />)}</ul>
    <form className="workspace-settings__inline" onSubmit={create} aria-label="新增渠道">
      <input aria-label="要新增的渠道" required maxLength={40} value={newName} onChange={event => setNewName(event.target.value)} placeholder="如：牛客、实习僧、学长内推" />
      <Button type="submit" disabled={busy}>新增渠道</Button>
    </form>
    {archived.length ? <details className="workspace-settings__archived">
      <summary>已归档的渠道（{archived.length}）</summary>
      <ul>{archived.map(channel => <li key={channel.id}>
        <span><strong>{channel.name}</strong> · {usage(channel.id)} 条投递</span>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void run((commands, expectedRevision) => commands.unarchiveChannel({ expectedRevision, channelId: channel.id }), `已恢复渠道「${channel.name}」。`)}>恢复</Button>
      </li>)}</ul>
    </details> : null}
  </div>;
}
