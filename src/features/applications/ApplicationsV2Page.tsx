import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ApplicationV2 } from '../../domain/v2/snapshot.js';
import type { Schedule } from '../../domain/types.js';
import type { ProgressRecord } from '../../domain/v2/types.js';
import type { EditableApplicationFields } from '../../repositories/v2/application-commands.js';
import { usePlatform } from '../../app/PlatformContext.js';
import { useV2Data } from '../../app/V2DataContext.js';
import { ConfirmDialog, Drawer } from '../../shared/ui/Dialog.js';
import { ProgressStatusEditor } from './ProgressStatusEditor.js';
import type { ProgressStatusEditorCommand } from './progress-status-editor.js';
import { ProgressHistory } from '../progress/ProgressHistory.js';
import { filterApplicationsForSeason, safeExternalHttpUrl } from './applications-page-model.js';
import { parseRawApplicationsImport, requireCleanRawImport, type RawImportResult } from '../../domain/v2/raw-import.js';
import './ApplicationsV2Page.css';

type ScheduleFields = Pick<Schedule, 'type' | 'title' | 'startsAt' | 'notes'>;

function toLocalDateTime(instant: string): string {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalDateTime(value: string): string {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error('请选择有效的日程时间。');
  return date.toISOString();
}

function scheduleTypeName(type: Schedule['type']): string {
  return ({ assessment: '测评', interview: '面试', follow_up: '跟进', other: '其他' })[type];
}

function scheduleStatusName(status: Schedule['status']): string {
  return ({ pending: '待办', completed: '已完成', cancelled: '已取消' })[status];
}

function ScheduleForm({
  schedule,
  onSave,
  onCancel,
}: {
  schedule: Schedule | null;
  onSave: (fields: ScheduleFields) => Promise<void>;
  onCancel: () => void;
}) {
  const [type, setType] = useState<Schedule['type']>(schedule?.type ?? 'interview');
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [startsAt, setStartsAt] = useState(schedule ? toLocalDateTime(schedule.startsAt) : toLocalDateTime(new Date().toISOString()));
  const [notes, setNotes] = useState(schedule?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setSaving(true);
    try { await onSave({ type, title: title.trim(), startsAt: fromLocalDateTime(startsAt), notes }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存日程失败，请重试。'); }
    finally { setSaving(false); }
  };
  return <form className="applications-v2__schedule-form" onSubmit={submit} aria-label={schedule ? '编辑日程' : '添加日程'}>
    <label><span>类型</span><select value={type} onChange={event => setType(event.target.value as Schedule['type'])}><option value="assessment">测评</option><option value="interview">面试</option><option value="follow_up">跟进</option><option value="other">其他</option></select></label>
    <label><span>标题</span><input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：技术一面" /></label>
    <label><span>开始时间</span><input required type="datetime-local" value={startsAt} onChange={event => setStartsAt(event.target.value)} /></label>
    <label><span>备注</span><textarea rows={2} maxLength={4000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
    {error && <p className="applications-v2__error" role="alert">{error}</p>}
    <div className="applications-v2__form-actions"><button type="submit" disabled={saving || !title.trim()}>{saving ? '保存中…' : schedule ? '保存日程' : '添加日程'}</button><button type="button" className="applications-v2__secondary" onClick={onCancel} disabled={saving}>取消</button></div>
  </form>;
}

function ApplicationScheduleSection({
  application,
  schedules,
  onCreate,
  onUpdate,
  onSetStatus,
  onDelete,
}: {
  application: ApplicationV2;
  schedules: Schedule[];
  onCreate: (applicationId: string, fields: ScheduleFields) => Promise<void>;
  onUpdate: (scheduleId: string, patch: Partial<ScheduleFields>) => Promise<void>;
  onSetStatus: (scheduleId: string, status: Schedule['status']) => Promise<void>;
  onDelete: (scheduleId: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rows = [...schedules].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const invoke = async (id: string, action: () => Promise<void>) => {
    setError(''); setBusyId(id);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '日程操作失败，请重试。'); }
    finally { setBusyId(null); }
  };
  return <section className="applications-v2__detail-section applications-v2__schedules" aria-label="日程管理">
    <div className="applications-v2__section-heading"><h3>日程</h3><button type="button" onClick={() => { setCreating(true); setEditingId(null); }}>＋ 添加日程</button></div>
    {error && <p className="applications-v2__error" role="alert">{error}</p>}
    {rows.length === 0 && !creating && <p className="applications-v2__muted">还没有安排日程。</p>}
    {creating && <ScheduleForm schedule={null} onSave={fields => invoke('new', async () => { await onCreate(application.id, fields); setCreating(false); })} onCancel={() => setCreating(false)} />}
    <ul className="applications-v2__schedule-list">
      {rows.map(schedule => <li key={schedule.id}>
        {editingId === schedule.id
          ? <ScheduleForm schedule={schedule} onSave={fields => invoke(schedule.id, async () => { await onUpdate(schedule.id, fields); setEditingId(null); })} onCancel={() => setEditingId(null)} />
          : <>
            <div className="applications-v2__schedule-copy"><strong>{schedule.title}</strong><span>{scheduleTypeName(schedule.type)} · {new Date(schedule.startsAt).toLocaleString()} · {scheduleStatusName(schedule.status)}</span>{schedule.notes && <small>{schedule.notes}</small>}</div>
            <div className="applications-v2__schedule-actions">
              <button type="button" disabled={busyId === schedule.id} onClick={() => { setEditingId(schedule.id); setCreating(false); }}>编辑</button>
              {schedule.status === 'pending' ? <><button type="button" disabled={busyId === schedule.id} onClick={() => void invoke(schedule.id, () => onSetStatus(schedule.id, 'completed'))}>完成</button><button type="button" disabled={busyId === schedule.id} onClick={() => void invoke(schedule.id, () => onSetStatus(schedule.id, 'cancelled'))}>取消日程</button></> : <button type="button" disabled={busyId === schedule.id} onClick={() => void invoke(schedule.id, () => onSetStatus(schedule.id, 'pending'))}>恢复待办</button>}
              <button type="button" disabled={busyId === schedule.id} onClick={() => setDeleting(schedule)}>删除</button>
            </div>
          </>}
      </li>)}
    </ul>
    <ConfirmDialog open={!!deleting} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void invoke(deleting.id, async () => { await onDelete(deleting.id); setDeleting(null); }); }} title="删除这条日程？" description={`“${deleting?.title ?? ''}”将从招聘季和总览中移除。`} confirmLabel="删除日程" cancelLabel="保留日程" />
  </section>;
}

interface ApplicationDraftFields {
  company: string;
  role: string;
  city: string;
  channelId: string;
  jobUrl: string;
  trackingUrl: string;
}

const emptyFields = (channelId = ''): ApplicationDraftFields => ({ company: '', role: '', city: '', channelId, jobUrl: '', trackingUrl: '' });

function ApplicationFieldsForm({
  application,
  onSave,
  onCancel,
}: {
  application: ApplicationV2;
  onSave: (patch: EditableApplicationFields) => Promise<void>;
  onCancel: () => void;
}) {
  const { snapshot } = useV2Data();
  const [fields, setFields] = useState<ApplicationDraftFields>(() => ({
    company: application.company,
    role: application.role,
    city: application.city,
    channelId: application.channelId,
    jobUrl: application.jobUrl,
    trackingUrl: application.trackingUrl,
  }));
  const [isStarred, setIsStarred] = useState(application.isStarred);
  const [notes, setNotes] = useState(application.notes);
  const [saving, setSaving] = useState(false);
  const channels = snapshot.channels.filter(channel => channel.archivedAt === null || channel.id === application.channelId);

  useEffect(() => {
    setFields({ company: application.company, role: application.role, city: application.city, channelId: application.channelId, jobUrl: application.jobUrl, trackingUrl: application.trackingUrl });
    setIsStarred(application.isStarred);
    setNotes(application.notes);
  }, [application.id, application.updatedAt]);

  const changed = fields.company !== application.company
    || fields.role !== application.role
    || fields.city !== application.city
    || fields.channelId !== application.channelId
    || fields.jobUrl !== application.jobUrl
    || fields.trackingUrl !== application.trackingUrl
    || isStarred !== application.isStarred
    || notes !== application.notes;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const patch: EditableApplicationFields = {};
    if (fields.company !== application.company) patch.company = fields.company;
    if (fields.role !== application.role) patch.role = fields.role;
    if (fields.city !== application.city) patch.city = fields.city;
    if (fields.channelId !== application.channelId) patch.channelId = fields.channelId;
    if (fields.jobUrl !== application.jobUrl) patch.jobUrl = fields.jobUrl;
    if (fields.trackingUrl !== application.trackingUrl) patch.trackingUrl = fields.trackingUrl;
    if (isStarred !== application.isStarred) patch.isStarred = isStarred;
    if (notes !== application.notes) patch.notes = notes;
    setSaving(true);
    try {
      await onSave(patch);
    } finally {
      setSaving(false);
    }
  };

  return <form className="applications-v2__form" onSubmit={submit} aria-label="编辑投递基本信息">
    <label><span>公司</span><input required maxLength={160} value={fields.company} onChange={event => setFields(current => ({ ...current, company: event.target.value }))} /></label>
    <label><span>岗位</span><input required maxLength={160} value={fields.role} onChange={event => setFields(current => ({ ...current, role: event.target.value }))} /></label>
    <label><span>城市</span><input maxLength={100} value={fields.city} onChange={event => setFields(current => ({ ...current, city: event.target.value }))} /></label>
    <label><span>投递渠道</span><select required value={fields.channelId} onChange={event => setFields(current => ({ ...current, channelId: event.target.value }))}>
      {channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}{channel.archivedAt ? '（已归档）' : ''}</option>)}
    </select></label>
    <label><span>职位页 URL</span><input type="url" placeholder="https://…" value={fields.jobUrl} onChange={event => setFields(current => ({ ...current, jobUrl: event.target.value }))} /></label>
    <label><span>招聘系统跟踪 URL</span><input type="url" placeholder="https://…" value={fields.trackingUrl} onChange={event => setFields(current => ({ ...current, trackingUrl: event.target.value }))} /></label>
    <label className="applications-v2__check"><input type="checkbox" checked={isStarred} onChange={event => setIsStarred(event.target.checked)} /><span>关注这条投递</span></label>
    <label className="applications-v2__notes"><span>备注</span><textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} /></label>
    <div className="applications-v2__form-actions">
      <button type="submit" disabled={!changed || saving}>{saving ? '保存中…' : '保存信息'}</button>
      <button type="button" className="applications-v2__secondary" onClick={onCancel} disabled={saving}>取消</button>
    </div>
  </form>;
}

function CreateDraftForm({
  seasonId,
  defaultChannelId,
  onCreate,
  onCancel,
}: {
  seasonId: string;
  defaultChannelId: string;
  onCreate: (fields: ApplicationDraftFields) => Promise<void>;
  onCancel: () => void;
}) {
  const { snapshot } = useV2Data();
  const [fields, setFields] = useState(() => emptyFields(defaultChannelId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const update = (key: keyof ApplicationDraftFields, value: string) => setFields(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onCreate(fields);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建失败，请重试');
    } finally {
      setSaving(false);
    }
  };
  return <form className="applications-v2__form" onSubmit={submit} aria-label="新建投递草稿">
    <p className="applications-v2__form-note">保存后会建立一条尚未记录进度的草稿；公司和岗位必填。</p>
    <input type="hidden" name="seasonId" value={seasonId} />
    <label><span>公司</span><input required autoFocus maxLength={160} value={fields.company} onChange={event => update('company', event.target.value)} /></label>
    <label><span>岗位</span><input required maxLength={160} value={fields.role} onChange={event => update('role', event.target.value)} /></label>
    <label><span>城市</span><input maxLength={100} value={fields.city} onChange={event => update('city', event.target.value)} /></label>
    <label><span>投递渠道</span><select required value={fields.channelId} onChange={event => update('channelId', event.target.value)}>
      <option value="">选择渠道</option>
      {/* The caller guarantees at least one active channel before opening this form. */}
      {snapshot.channels.filter(channel => channel.archivedAt === null).map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
    </select></label>
    <label><span>职位页 URL</span><input type="url" placeholder="https://…" value={fields.jobUrl} onChange={event => update('jobUrl', event.target.value)} /></label>
    <label><span>招聘系统跟踪 URL</span><input type="url" placeholder="https://…" value={fields.trackingUrl} onChange={event => update('trackingUrl', event.target.value)} /></label>
    {error && <p className="applications-v2__error" role="alert">{error}</p>}
    <div className="applications-v2__form-actions">
      <button type="submit" disabled={saving || !fields.channelId}>{saving ? '创建中…' : '创建空进度草稿'}</button>
      <button type="button" className="applications-v2__secondary" onClick={onCancel} disabled={saving}>取消</button>
    </div>
  </form>;
}

function ExternalLink({ value, label, onOpen }: { value: string; label: string; onOpen: (url: string) => void }) {
  if (!value.trim()) return <span className="applications-v2__muted">未填写</span>;
  const url = safeExternalHttpUrl(value);
  return url
    ? <button type="button" className="applications-v2__link" onClick={() => onOpen(url)}>{label}</button>
    : <span className="applications-v2__invalid-url">网址无效</span>;
}

function ApplicationDetailDrawer({
  application,
  progress,
  revision,
  onClose,
  onSaveFields,
  onProgressCommand,
  onDeleteApplication,
  onCreateSchedule,
  onUpdateSchedule,
  onSetScheduleStatus,
  onDeleteSchedule,
  onOpenUrl,
}: {
  application: ApplicationV2 | null;
  progress: ProgressRecord | null;
  revision: number;
  onClose: () => void;
  onSaveFields: (application: ApplicationV2, patch: EditableApplicationFields) => Promise<void>;
  onProgressCommand: (command: ProgressStatusEditorCommand) => Promise<void>;
  onDeleteApplication: (application: ApplicationV2) => Promise<void>;
  onCreateSchedule: (applicationId: string, fields: ScheduleFields) => Promise<void>;
  onUpdateSchedule: (scheduleId: string, patch: Partial<ScheduleFields>) => Promise<void>;
  onSetScheduleStatus: (scheduleId: string, status: Schedule['status']) => Promise<void>;
  onDeleteSchedule: (scheduleId: string) => Promise<void>;
  onOpenUrl: (url: string) => void;
}) {
  const { snapshot } = useV2Data();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const channel = application ? snapshot.channels.find(item => item.id === application.channelId) : null;
  const status = application ? snapshot.definitions.statuses.find(item => item.id === application.currentStatusId) : null;
  return <Drawer open={!!application} onClose={onClose} title={application?.company ?? '投递详情'} {...(application ? { description: `${application.role}${application.city ? ` · ${application.city}` : ''}` } : {})}>
    {application && progress ? <div className="applications-v2__detail">
      <section className="applications-v2__detail-summary" aria-label="投递概览">
        <div><span>当前状态</span><strong>{status?.name ?? '未知状态'}</strong></div>
        <div><span>投递日期</span><strong>{progress.appliedOn ?? '尚未投递'}</strong></div>
        <div><span>渠道</span><strong>{channel?.name ?? '未知渠道'}</strong></div>
        <div><span>职位页</span><ExternalLink value={application.jobUrl} label="打开职位页" onOpen={onOpenUrl} /></div>
        <div><span>招聘系统跟踪页</span><ExternalLink value={application.trackingUrl} label="打开跟踪页" onOpen={onOpenUrl} /></div>
      </section>
      <section className="applications-v2__detail-section">
        <h3>基本信息</h3>
        <ApplicationFieldsForm application={application} onSave={patch => onSaveFields(application, patch)} onCancel={onClose} />
      </section>
      <section className="applications-v2__detail-section">
        <h3>记录进度</h3>
        <ProgressStatusEditor
          key={`${application.id}-${revision}-${progress.events.at(-1)?.id ?? 'draft'}`}
          definitions={snapshot.definitions}
          record={progress}
          expectedRevision={revision}
          onSubmit={onProgressCommand}
        />
      </section>
      <section className="applications-v2__detail-section">
        <ProgressHistory
          events={progress.events.filter(event => event.invalidatedAt === null)}
          auditEvents={progress.events}
          uncertainEdges={progress.migrationReview?.uncertainEdges ?? []}
          title="有效进度历史"
        />
        {progress.events.some(event => event.invalidatedAt !== null) && <details className="applications-v2__audit">
          <summary>查看已纠正的审计记录（{progress.events.filter(event => event.invalidatedAt !== null).length}）</summary>
          <ol>{progress.events.filter(event => event.invalidatedAt !== null).sort((left, right) => left.sequence - right.sequence).map(event => <li key={event.id}>
            <span>{event.occurredOn} · {event.statusNameSnapshot}</span>
            <span>已作废{event.correctionOfEventId ? '（已纠正）' : ''}</span>
          </li>)}</ol>
        </details>}
      </section>
      <ApplicationScheduleSection
        application={application}
        schedules={snapshot.schedules.filter(schedule => schedule.applicationId === application.id)}
        onCreate={onCreateSchedule}
        onUpdate={onUpdateSchedule}
        onSetStatus={onSetScheduleStatus}
        onDelete={onDeleteSchedule}
      />
      <section className="applications-v2__pending-actions" aria-label="投递操作">
        <button type="button" onClick={() => setConfirmDelete(true)}>删除投递</button>
        {deleteError && <p className="applications-v2__error" role="alert">{deleteError}</p>}
        <p>当前页面只编辑所选招聘季内的投递；可在设置中管理招聘季。</p>
      </section>
      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setDeleteError('');
          setDeleting(true);
          void onDeleteApplication(application).then(() => setConfirmDelete(false)).catch(cause => setDeleteError(cause instanceof Error ? cause.message : '删除失败，请重试。')).finally(() => setDeleting(false));
        }}
        title="删除这条投递？"
        description={`将删除「${application.company} · ${application.role}」及其全部进度历史、日程和旧历史副本。其他投递不受影响；删除前的完整快照会被保留。`}
        confirmLabel={deleting ? '删除中…' : '删除投递'}
        cancelLabel="保留投递"
      />
    </div> : null}
  </Drawer>;
}

export function ApplicationsV2Page({ seasonId }: { seasonId: string | null }) {
  const { snapshot, revision, runCommand, runImportCommand, runScheduleCommand } = useV2Data();
  const { platform } = usePlatform();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importPreview, setImportPreview] = useState<RawImportResult | null>(null);
  const [importTargetSeasonId, setImportTargetSeasonId] = useState<string | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const season = seasonId ? snapshot.seasons.find(item => item.id === seasonId && item.archivedAt === null) ?? null : null;
  const applications = useMemo(
    () => seasonId ? filterApplicationsForSeason(snapshot.applications, seasonId, query) : [],
    [snapshot.applications, seasonId, query],
  );
  const selected = selectedId ? snapshot.applications.find(application => application.id === selectedId && application.seasonId === seasonId) ?? null : null;
  const selectedProgress = selected ? snapshot.progressRecords.find(record => record.applicationId === selected.id) ?? null : null;
  const activeChannels = snapshot.channels.filter(channel => channel.archivedAt === null);
  const importTargetSeason = importTargetSeasonId ? snapshot.seasons.find(item => item.id === importTargetSeasonId) ?? null : null;

  useEffect(() => {
    if (!selected) setSelectedId(null);
  }, [selected]);

  const openUrl = async (url: string) => {
    setError('');
    try { await platform.openExternal(url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法打开外部网址'); }
  };

  const createDraft = async (fields: ApplicationDraftFields) => {
    if (!seasonId) return;
    await runCommand((commands, expectedRevision) => commands.createApplication({
      expectedRevision,
      seasonId,
      company: fields.company,
      role: fields.role,
      city: fields.city,
      channelId: fields.channelId,
      jobUrl: fields.jobUrl,
      trackingUrl: fields.trackingUrl,
    }));
    setCreating(false);
    setError('已创建一条尚未记录进度的草稿。');
  };

  const saveFields = async (application: ApplicationV2, patch: EditableApplicationFields) => {
    await runCommand((commands, expectedRevision) => commands.updateFields({
      applicationId: application.id,
      expectedRevision,
      patch,
    }));
    setError('基本信息已保存。');
  };

  const applyProgressCommand = async (command: ProgressStatusEditorCommand) => {
    await runCommand(commands => command.kind === 'append'
      ? commands.appendProgress(command.input)
      : commands.correctProgress(command.input));
    setError('进度已保存。');
  };

  const deleteApplication = async (application: ApplicationV2) => {
    await runCommand((commands, expectedRevision) => commands.deleteApplication({ applicationId: application.id, expectedRevision }));
    setSelectedId(null);
    setError('投递及关联进度、日程和旧历史已删除；删除前的数据快照已保留。');
  };

  const createSchedule = async (applicationId: string, fields: ScheduleFields) => {
    await runScheduleCommand((commands, expectedRevision) => commands.createSchedule({ applicationId, expectedRevision, ...fields }));
    setError('日程已添加。');
  };

  const updateSchedule = async (scheduleId: string, patch: Partial<ScheduleFields>) => {
    await runScheduleCommand((commands, expectedRevision) => commands.updateSchedule({ scheduleId, expectedRevision, patch }));
    setError('日程已更新。');
  };

  const setScheduleStatus = async (scheduleId: string, status: Schedule['status']) => {
    await runScheduleCommand((commands, expectedRevision) => commands.setScheduleStatus({ scheduleId, expectedRevision, status }));
    setError(`日程已${scheduleStatusName(status)}。`);
  };

  const deleteSchedule = async (scheduleId: string) => {
    await runScheduleCommand((commands, expectedRevision) => commands.deleteSchedule({ scheduleId, expectedRevision }));
    setError('日程已删除，删除前的数据快照已保留。');
  };

  const chooseRawImport = async () => {
    if (!season) { setError('请先选择要导入到的招聘季。'); return; }
    setError(''); setImportPreview(null); setImportTargetSeasonId(season.id); setImportBusy(true);
    try {
      const text = await platform.readBackupFile();
      if (text === null) { setImportTargetSeasonId(null); return; }
      const preview = parseRawApplicationsImport(text, {
        seasonId: season.id,
        channels: snapshot.channels,
        definitions: snapshot.definitions,
      });
      setImportPreview(preview);
      if (preview.issues.length) setError(`导入预览发现 ${preview.issues.length} 个问题；数据尚未修改。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取这个原始 JSON 文件。');
    } finally { setImportBusy(false); }
  };

  const commitRawImport = async () => {
    if (!importPreview || !importTargetSeasonId) return;
    setImportBusy(true); setConfirmImport(false); setError('');
    try {
      const rows = requireCleanRawImport(importPreview);
      const result = await runImportCommand((commands, expectedRevision) => commands.replaceSeasonApplications({
        expectedRevision,
        seasonId: importTargetSeasonId,
        applications: rows,
      }));
      const targetName = snapshot.seasons.find(item => item.id === result.seasonId)?.name ?? '所选招聘季';
      setImportPreview(null); setImportTargetSeasonId(null);
      setError(`已导入 ${result.importedApplicationCount} 条记录到「${targetName}」；替换前的 ${result.removedApplicationCount} 条记录已保留为恢复副本。`);
    } catch (cause) {
      setError(cause instanceof Error ? `${cause.message}；当前数据未被部分替换。` : '导入失败，当前数据未被部分替换。');
    } finally { setImportBusy(false); }
  };

  const importedStatusCounts = importPreview?.applications.reduce((counts, item) => {
    counts.set(item.sourceStatus, (counts.get(item.sourceStatus) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  const existingTargetCount = importTargetSeasonId
    ? snapshot.applications.filter(item => item.seasonId === importTargetSeasonId).length
    : 0;

  const openRowOnKey = (event: KeyboardEvent<HTMLTableRowElement>, applicationId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(applicationId);
    }
  };

  return <section className="applications-v2" aria-label="v2 投递管理">
    <header className="applications-v2__header">
      <div>
        <p className="applications-v2__eyebrow">秋招看板 · v2</p>
        <h1>投递记录</h1>
        {season && <p className="applications-v2__season">{season.name}</p>}
      </div>
      <div className="applications-v2__header-actions">
        <button type="button" onClick={() => void chooseRawImport()} disabled={!season || importBusy}>{importBusy ? '正在读取…' : '从原始 JSON 导入'}</button>
        <button type="button" disabled title="招聘季管理尚未实现">招聘季管理（待实现）</button>
        <button type="button" onClick={() => { setError(''); setCreating(true); }} disabled={!season || activeChannels.length === 0} title={activeChannels.length === 0 ? '需要先配置投递渠道' : undefined}>＋ 新建草稿</button>
      </div>
    </header>

    {error && <p className="applications-v2__feedback" role="status">{error}<button type="button" aria-label="关闭提示" onClick={() => setError('')}>×</button></p>}

    {importPreview && <section className="applications-v2__import-preview" aria-label="原始 JSON 导入预览">
      <div className="applications-v2__import-preview-heading"><div><h2>原始 JSON 导入预览</h2><p>目标招聘季：{importTargetSeason?.name ?? '已不存在'}。确认前不会修改任何记录。</p></div>
        <button type="button" className="applications-v2__secondary-button" onClick={() => { setImportPreview(null); setImportTargetSeasonId(null); }}>关闭预览</button>
      </div>
      <p>文件共有 {importPreview.totalCount} 条；有效 {importPreview.applications.length} 条；问题 {importPreview.issues.length} 条。当前招聘季有 {existingTargetCount} 条，确认后会整体替换为本文件的记录。</p>
      {importPreview.applications.length > 0 && <ul className="applications-v2__import-statuses" aria-label="预览状态统计">
        {[...importedStatusCounts!.entries()].map(([statusName, count]) => <li key={statusName}><span>{statusName}</span><strong>{count}</strong></li>)}
      </ul>}
      {importPreview.issues.length > 0 && <div className="applications-v2__import-issues" role="alert"><strong>有错误时不会导入任何记录。</strong><ul>{importPreview.issues.slice(0, 8).map(issue => <li key={`${issue.index}-${issue.field}-${issue.sourceId ?? ''}`}>{issue.index < 0 ? issue.message : `第 ${issue.index + 1} 条${issue.sourceId ? `（${issue.sourceId}）` : ''}：${issue.message}`}</li>)}</ul>{importPreview.issues.length > 8 && <p>另有 {importPreview.issues.length - 8} 个问题未展开。</p>}</div>}
      <p className="applications-v2__import-warning">导入会替换「{importTargetSeason?.name ?? '当前招聘季'}」的全部投递及其进度、日程；其他招聘季不变。源文件里的状态会按原文保留，例如筛选中、笔试、测评中、一面和挂掉。</p>
      <button type="button" disabled={importBusy || importPreview.issues.length > 0 || importPreview.applications.length === 0 || !importTargetSeason} onClick={() => setConfirmImport(true)}>确认替换并导入 {importPreview.applications.length} 条</button>
    </section>}

    {!season ? <section className="applications-v2__empty" aria-label="没有可用招聘季">
      <h2>{seasonId ? '这个招聘季不可用' : '先选择一个招聘季'}</h2>
      <p>{seasonId ? '招聘季可能已被归档或不存在。招聘季管理入口待实现。' : '投递记录会按招聘季分开显示；请先从应用中的招聘季切换器选择一季。'}</p>
      <button type="button" disabled title="招聘季创建命令尚未实现">新增招聘季（待实现）</button>
    </section> : <>
      <div className="applications-v2__toolbar">
        <label><span className="applications-v2__sr-only">搜索公司、岗位、城市</span><input type="search" placeholder="搜索公司、岗位、城市" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <span>{applications.length} 条投递</span>
      </div>
      {activeChannels.length === 0 && <p className="applications-v2__notice" role="note">尚无可用投递渠道，创建渠道功能待实现，因此暂时无法新建投递。</p>}
      <div className="applications-v2__table-wrap">
        <table className="applications-v2__table">
          <caption>{season.name}的投递记录</caption>
          <thead><tr>
            <th scope="col">公司 / 岗位</th><th scope="col">城市 / 渠道</th><th scope="col">投递状态</th><th scope="col">投递日期</th><th scope="col">关注</th><th scope="col">招聘系统跟踪</th><th scope="col">职位页</th>
          </tr></thead>
          <tbody>
            {applications.map(application => {
              const progress = snapshot.progressRecords.find(record => record.applicationId === application.id);
              const status = snapshot.definitions.statuses.find(item => item.id === application.currentStatusId);
              const channel = snapshot.channels.find(item => item.id === application.channelId);
              return <tr key={application.id} tabIndex={0} onClick={() => setSelectedId(application.id)} onKeyDown={event => openRowOnKey(event, application.id)} aria-label={`${application.company}，${application.role}，点击查看详情`}>
                <th scope="row"><button type="button" className="applications-v2__identity" onClick={event => { event.stopPropagation(); setSelectedId(application.id); }}><strong>{application.company}</strong><span>{application.role}</span></button></th>
                <td><span>{application.city || '未填写城市'}</span><small>{channel?.name ?? '未知渠道'}</small></td>
                <td><button type="button" className="applications-v2__status" onClick={event => { event.stopPropagation(); setSelectedId(application.id); }}><span className={`applications-v2__status-dot${status?.semantic === 'failed' ? ' applications-v2__status-dot--failed' : status?.semantic.startsWith('offer_') ? ' applications-v2__status-dot--offer' : ''}`} style={status ? { backgroundColor: status.color } : undefined} />{status?.name ?? '未知状态'}{!progress?.events.some(event => event.invalidatedAt === null) && <small>空进度</small>}</button></td>
                <td>{progress?.appliedOn ?? application.appliedOn ?? <span className="applications-v2__muted">未投递</span>}</td>
                <td><button type="button" className={`applications-v2__star${application.isStarred ? ' applications-v2__star--active' : ''}`} aria-label={`${application.isStarred ? '已关注' : '未关注'}；点击打开详情修改`} onClick={event => { event.stopPropagation(); setSelectedId(application.id); }}>{application.isStarred ? '★' : '☆'}</button></td>
                <td onClick={event => event.stopPropagation()}><ExternalLink value={application.trackingUrl} label="打开跟踪" onOpen={url => void openUrl(url)} /></td>
                <td onClick={event => event.stopPropagation()}><ExternalLink value={application.jobUrl} label="打开职位页" onOpen={url => void openUrl(url)} /></td>
              </tr>;
            })}
            {applications.length === 0 && <tr><td colSpan={7} className="applications-v2__empty-row"><h2>{query.trim() ? '没有匹配结果' : '这个招聘季还没有投递'}</h2><p>{query.trim() ? '试试其他公司、岗位或城市关键词。' : '新建草稿会创建一条尚未记录进度的投递。'}</p>{!query.trim() && <button type="button" onClick={() => setCreating(true)} disabled={activeChannels.length === 0}>＋ 新建草稿</button>}</td></tr>}
          </tbody>
        </table>
      </div>
    </>}

    <ConfirmDialog open={confirmImport} onCancel={() => setConfirmImport(false)} onConfirm={() => void commitRawImport()} title="替换这个招聘季的全部记录？" description={`将用原始文件的 ${importPreview?.applications.length ?? 0} 条记录替换「${importTargetSeason?.name ?? '所选招聘季'}」当前的 ${existingTargetCount} 条记录。进度状态会按源文件保留；其他招聘季不变，替换前的完整工作空间会保留为恢复副本。`} confirmLabel="替换并导入" cancelLabel="再检查一下" />

    <Drawer open={creating} onClose={() => setCreating(false)} title="新建投递草稿" {...(season ? { description: season.name } : {})}>
      {seasonId && activeChannels.length > 0 && <CreateDraftForm seasonId={seasonId} defaultChannelId={activeChannels[0]!.id} onCreate={createDraft} onCancel={() => setCreating(false)} />}
      {activeChannels.length === 0 && <p>新建投递依赖可用渠道；渠道管理命令待实现。</p>}
    </Drawer>
    <ApplicationDetailDrawer
      application={selected}
      progress={selectedProgress}
      revision={revision}
      onClose={() => setSelectedId(null)}
      onSaveFields={saveFields}
      onProgressCommand={applyProgressCommand}
      onDeleteApplication={deleteApplication}
      onCreateSchedule={createSchedule}
      onUpdateSchedule={updateSchedule}
      onSetScheduleStatus={setScheduleStatus}
      onDeleteSchedule={deleteSchedule}
      onOpenUrl={url => void openUrl(url)}
    />
  </section>;
}
