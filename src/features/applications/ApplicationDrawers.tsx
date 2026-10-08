import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ApplicationV2 } from '../../domain/v2/snapshot.js';
import type { Schedule } from '../../domain/types.js';
import type { ProgressEvent } from '../../domain/v2/types.js';
import { createProgressRecord } from '../../domain/v2/progress.js';
import type { CreateApplicationCommandInput, EditableApplicationFields } from '../../repositories/v2/application-commands.js';
import { usePlatform } from '../../app/PlatformContext.js';
import { useV2Data } from '../../app/V2DataContext.js';
import { ConfirmDialog, Drawer } from '../../shared/ui/Dialog.js';
import { ProgressStatusEditor } from './ProgressStatusEditor.js';
import { localBusinessDate, type ProgressStatusEditorCommand } from './progress-status-editor.js';
import { ProgressHistory } from '../progress/ProgressHistory.js';
import { CityTagsInput } from '../../shared/ui/CityTagsInput.js';
import { splitCities } from '../../domain/v2/cities.js';
import { groupQuickStatusOptions, quickStatusOptions } from '../progress/quick-status.js';
import { normalizeUrlInput, safeExternalHttpUrl, sameRoleApplications } from './applications-page-model.js';
import './ApplicationsV2Page.css';

export type NoticeTone = 'success' | 'error';
/** An optional follow-up offered with a notice, such as undoing a deletion. */
export interface NoticeAction {
  label: string;
  run: () => void | Promise<void>;
}
export type Notice = (message: string, tone?: NoticeTone, action?: NoticeAction) => void;
type ScheduleFields = Pick<Schedule, 'type' | 'title' | 'startsAt' | 'notes'>;

const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

/** Single cities already used, most frequent first, offered while typing. */
function citySuggestions(applications: readonly ApplicationV2[]): string[] {
  const counts = new Map<string, number>();
  for (const application of applications) for (const city of splitCities(application.city)) counts.set(city, (counts.get(city) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([city]) => city);
}

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

export function scheduleTypeName(type: Schedule['type']): string {
  return ({ assessment: '测评', interview: '面试', follow_up: '跟进', other: '其他' })[type];
}

export function scheduleStatusName(status: Schedule['status']): string {
  return ({ pending: '待办', completed: '已完成', cancelled: '已取消' })[status];
}

/** Commands shared by every page that edits an application; each reports through `notice`. */
export function useApplicationActions(notice: Notice) {
  const { runCommand, runScheduleCommand } = useV2Data();
  const { platform } = usePlatform();
  return useMemo(() => ({
    async openUrl(url: string) {
      try { await platform.openExternal(url); }
      catch (cause) { notice(errorText(cause, '无法打开外部网址'), 'error'); }
    },
    async createApplication(input: Omit<CreateApplicationCommandInput, 'expectedRevision'>) {
      const result = await runCommand((commands, expectedRevision) => commands.createApplication({ ...input, expectedRevision }));
      notice(`已添加「${result.value.company} · ${result.value.role}」`);
      return result.value;
    },
    async saveFields(application: ApplicationV2, patch: EditableApplicationFields) {
      await runCommand((commands, expectedRevision) => commands.updateFields({ applicationId: application.id, expectedRevision, patch }));
      notice('基本信息已保存');
    },
    async removeProgressEvent(applicationId: string, event: ProgressEvent) {
      await runCommand((commands, expectedRevision) => commands.invalidateProgress({ applicationId, expectedRevision, eventId: event.id }));
      notice(`已删除「${event.statusNameSnapshot}」这条进展`);
    },
    async applyProgressCommand(command: ProgressStatusEditorCommand) {
      await runCommand(commands => command.kind === 'append' ? commands.appendProgress(command.input) : commands.correctProgress(command.input));
      notice('进度已保存');
    },
    async deleteApplication(application: ApplicationV2) {
      const result = await runCommand((commands, expectedRevision) => commands.deleteApplication({ applicationId: application.id, expectedRevision }));
      const name = `${application.company} · ${application.role}`;
      notice(`已删除「${name}」`, 'success', {
        label: '撤销',
        run: () => runCommand((commands, expectedRevision) => commands.restoreDeletedApplication({ expectedRevision, removed: result.value.removed }))
          .then(() => notice(`已恢复「${name}」`), cause => notice(errorText(cause, '撤销失败'), 'error')),
      });
    },
    async createSchedule(applicationId: string, fields: ScheduleFields) {
      await runScheduleCommand((commands, expectedRevision) => commands.createSchedule({ applicationId, expectedRevision, ...fields }));
      notice('日程已添加');
    },
    async updateSchedule(scheduleId: string, patch: Partial<ScheduleFields>) {
      await runScheduleCommand((commands, expectedRevision) => commands.updateSchedule({ scheduleId, expectedRevision, patch }));
      notice('日程已更新');
    },
    async setScheduleStatus(scheduleId: string, status: Schedule['status']) {
      await runScheduleCommand((commands, expectedRevision) => commands.setScheduleStatus({ scheduleId, expectedRevision, status }));
      notice(`日程已标记为${scheduleStatusName(status)}`);
    },
    /** Returns the removed schedule so the caller can offer an undo next to the list. */
    async deleteSchedule(scheduleId: string): Promise<Schedule> {
      const result = await runScheduleCommand((commands, expectedRevision) => commands.deleteSchedule({ scheduleId, expectedRevision }));
      return result.value.removed;
    },
    async restoreSchedule(schedule: Schedule) {
      await runScheduleCommand((commands, expectedRevision) => commands.restoreSchedule({ expectedRevision, schedule }));
      notice('日程已恢复');
    },
  }), [notice, platform, runCommand, runScheduleCommand]);
}

export type ApplicationActions = ReturnType<typeof useApplicationActions>;

function ScheduleForm({ schedule, onSave, onCancel }: { schedule: Schedule | null; onSave: (fields: ScheduleFields) => Promise<void>; onCancel: () => void }) {
  const [type, setType] = useState<Schedule['type']>(schedule?.type ?? 'interview');
  const [title, setTitle] = useState(schedule?.title ?? '');
  const [startsAt, setStartsAt] = useState(schedule ? toLocalDateTime(schedule.startsAt) : toLocalDateTime(new Date().toISOString()));
  const [notes, setNotes] = useState(schedule?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setSaving(true);
    try { await onSave({ type, title: title.trim(), startsAt: fromLocalDateTime(startsAt), notes }); }
    catch (cause) { setError(errorText(cause, '保存日程失败，请重试。')); }
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

function ApplicationScheduleSection({ application, schedules, actions }: { application: ApplicationV2; schedules: Schedule[]; actions: ApplicationActions }) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  // The section lives inside a modal drawer, so its undo has to be offered here.
  const [lastDeleted, setLastDeleted] = useState<Schedule | null>(null);
  const rows = [...schedules].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const invoke = async (id: string, action: () => Promise<void>) => {
    setError(''); setBusyId(id);
    try { await action(); }
    catch (cause) { setError(errorText(cause, '日程操作失败，请重试。')); }
    finally { setBusyId(null); }
  };
  return <section className="applications-v2__detail-section applications-v2__schedules" aria-label="日程管理">
    <div className="applications-v2__section-heading"><h3>日程</h3><button type="button" onClick={() => { setCreating(true); setEditingId(null); }}>＋ 添加日程</button></div>
    {error && <p className="applications-v2__error" role="alert">{error}</p>}
    {lastDeleted && <p className="applications-v2__undo" role="status">已删除日程「{lastDeleted.title}」<button type="button" disabled={busyId === lastDeleted.id} onClick={() => void invoke(lastDeleted.id, async () => { await actions.restoreSchedule(lastDeleted); setLastDeleted(null); })}>撤销</button></p>}
    {rows.length === 0 && !creating && <p className="applications-v2__muted">还没有安排日程。</p>}
    {creating && <ScheduleForm schedule={null} onSave={fields => invoke('new', async () => { await actions.createSchedule(application.id, fields); setCreating(false); })} onCancel={() => setCreating(false)} />}
    <ul className="applications-v2__schedule-list">
      {rows.map(schedule => <li key={schedule.id}>
        {editingId === schedule.id
          ? <ScheduleForm schedule={schedule} onSave={fields => invoke(schedule.id, async () => { await actions.updateSchedule(schedule.id, fields); setEditingId(null); })} onCancel={() => setEditingId(null)} />
          : <>
            <div className="applications-v2__schedule-copy"><strong>{schedule.title}</strong><span>{scheduleTypeName(schedule.type)} · {new Date(schedule.startsAt).toLocaleString()} · {scheduleStatusName(schedule.status)}</span>{schedule.notes && <small>{schedule.notes}</small>}</div>
            <div className="applications-v2__schedule-actions">
              <button type="button" disabled={busyId === schedule.id} onClick={() => { setEditingId(schedule.id); setCreating(false); }}>编辑</button>
              {schedule.status === 'pending' ? <><button type="button" disabled={busyId === schedule.id} onClick={() => void invoke(schedule.id, () => actions.setScheduleStatus(schedule.id, 'completed'))}>完成</button><button type="button" disabled={busyId === schedule.id} onClick={() => void invoke(schedule.id, () => actions.setScheduleStatus(schedule.id, 'cancelled'))}>取消日程</button></> : <button type="button" disabled={busyId === schedule.id} onClick={() => void invoke(schedule.id, () => actions.setScheduleStatus(schedule.id, 'pending'))}>恢复待办</button>}
              <button type="button" disabled={busyId === schedule.id} onClick={() => setDeleting(schedule)}>删除</button>
            </div>
          </>}
      </li>)}
    </ul>
    <ConfirmDialog open={!!deleting} onCancel={() => setDeleting(null)} onConfirm={() => { if (deleting) void invoke(deleting.id, async () => { const removed = await actions.deleteSchedule(deleting.id); setDeleting(null); setLastDeleted(removed); }); }} title="删除这条日程？" description={`“${deleting?.title ?? ''}”将从招聘季和总览中移除。`} confirmLabel="删除日程" cancelLabel="保留日程" />
  </section>;
}

interface FieldValues {
  company: string;
  role: string;
  city: string;
  channelId: string;
  jobUrl: string;
  trackingUrl: string;
  isStarred: boolean;
  notes: string;
}

const fieldValues = (application: ApplicationV2): FieldValues => ({
  company: application.company, role: application.role, city: application.city, channelId: application.channelId,
  jobUrl: application.jobUrl, trackingUrl: application.trackingUrl, isStarred: application.isStarred, notes: application.notes,
});
const fieldKeys: ReadonlyArray<keyof FieldValues> = ['company', 'role', 'city', 'channelId', 'jobUrl', 'trackingUrl', 'isStarred', 'notes'];

function ApplicationFieldsForm({ application, onSave }: { application: ApplicationV2; onSave: (patch: EditableApplicationFields) => Promise<void> }) {
  const { snapshot } = useV2Data();
  const [fields, setFields] = useState(() => fieldValues(application));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const baseline = useRef({ id: application.id, values: fieldValues(application) });
  const adoptSaved = useRef(false);
  const channels = snapshot.channels.filter(channel => channel.archivedAt === null || channel.id === application.channelId);

  useEffect(() => {
    const previous = baseline.current;
    const latest = fieldValues(application);
    baseline.current = { id: application.id, values: latest };
    if (previous.id !== application.id || adoptSaved.current) {
      adoptSaved.current = false;
      setFields(latest);
      return;
    }
    // Other saves (progress, schedules, another window) must not wipe unsaved edits:
    // only fields the user has not touched follow the stored value.
    setFields(current => Object.fromEntries(fieldKeys.map(key => [key, current[key] === previous.values[key] ? latest[key] : current[key]])) as unknown as FieldValues);
  }, [application]);

  const stored = fieldValues(application);
  const changedKeys = fieldKeys.filter(key => fields[key] !== stored[key]);
  const update = <K extends keyof FieldValues>(key: K, value: FieldValues[K]) => setFields(current => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const patch: EditableApplicationFields = {};
    for (const key of changedKeys) {
      const value = key === 'jobUrl' || key === 'trackingUrl' ? normalizeUrlInput(fields[key]) : fields[key];
      Object.assign(patch, { [key]: value });
    }
    setSaving(true);
    adoptSaved.current = true;
    try { await onSave(patch); }
    catch (cause) { adoptSaved.current = false; setError(errorText(cause, '保存失败，请重试')); }
    finally { setSaving(false); }
  };

  return <form className="applications-v2__form" onSubmit={submit} aria-label="编辑投递基本信息">
    <label><span>公司</span><input required maxLength={160} value={fields.company} onChange={event => update('company', event.target.value)} /></label>
    <label><span>岗位</span><input required maxLength={160} value={fields.role} onChange={event => update('role', event.target.value)} /></label>
    <div className="applications-v2__field"><span>城市</span><CityTagsInput label="城市" value={fields.city} onChange={value => update('city', value)} suggestions={citySuggestions(snapshot.applications)} /></div>
    <label><span>投递渠道</span><select required value={fields.channelId} onChange={event => update('channelId', event.target.value)}>
      {channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}{channel.archivedAt ? '（已归档）' : ''}</option>)}
    </select></label>
    <label><span>投递进度链接（状态页）</span><input inputMode="url" placeholder="https://…" value={fields.trackingUrl} onChange={event => update('trackingUrl', event.target.value)} /></label>
    <label><span>岗位 JD 链接</span><input inputMode="url" placeholder="https://…" value={fields.jobUrl} onChange={event => update('jobUrl', event.target.value)} /></label>
    <label className="applications-v2__check"><input type="checkbox" checked={fields.isStarred} onChange={event => update('isStarred', event.target.checked)} /><span>关注这条投递</span></label>
    <label className="applications-v2__notes"><span>备注</span><textarea rows={3} value={fields.notes} onChange={event => update('notes', event.target.value)} /></label>
    {error && <p className="applications-v2__error" role="alert">{error}</p>}
    <div className="applications-v2__form-actions">
      <button type="submit" disabled={!changedKeys.length || saving}>{saving ? '保存中…' : '保存信息'}</button>
      <button type="button" className="applications-v2__secondary" onClick={() => { setFields(stored); setError(''); }} disabled={saving || !changedKeys.length}>放弃修改</button>
    </div>
  </form>;
}

export function ExternalLink({ value, label, onOpen }: { value: string; label: string; onOpen: (url: string) => void }) {
  if (!value.trim()) return <span className="applications-v2__muted">未填写</span>;
  const url = safeExternalHttpUrl(value);
  return url
    ? <button type="button" className="applications-v2__link" onClick={() => onOpen(url)}>{label}</button>
    : <span className="applications-v2__invalid-url">网址无效</span>;
}

/** Full detail: base fields, status editor, history, schedules and deletion. */
export function ApplicationDetailDrawer({ applicationId, onClose, notice }: { applicationId: string | null; onClose: () => void; notice: Notice }) {
  const { snapshot, revision } = useV2Data();
  const actions = useApplicationActions(notice);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const application = applicationId ? snapshot.applications.find(item => item.id === applicationId) ?? null : null;
  const progress = application ? snapshot.progressRecords.find(record => record.applicationId === application.id) ?? null : null;
  const channel = application ? snapshot.channels.find(item => item.id === application.channelId) : null;
  const status = application ? snapshot.definitions.statuses.find(item => item.id === application.currentStatusId) : null;

  return <Drawer open={!!application} onClose={onClose} title={application?.company ?? '投递详情'} {...(application ? { description: `${application.role}${application.city ? ` · ${application.city}` : ''}` } : {})}>
    {application && progress ? <div className="applications-v2 applications-v2--embedded"><div className="applications-v2__detail">
      <section className="applications-v2__detail-summary" aria-label="投递概览">
        <div><span>当前状态</span><strong>{status?.name ?? '未知状态'}</strong></div>
        <div><span>投递日期</span><strong>{progress.appliedOn ?? '尚未投递'}</strong></div>
        <div><span>渠道</span><strong>{channel?.name ?? '未知渠道'}</strong></div>
        <div><span>投递进度页</span><ExternalLink value={application.trackingUrl} label="打开进度页" onOpen={url => void actions.openUrl(url)} /></div>
        <div><span>岗位 JD</span><ExternalLink value={application.jobUrl} label="打开 JD" onOpen={url => void actions.openUrl(url)} /></div>
      </section>
      <section className="applications-v2__detail-section">
        <h3>基本信息</h3>
        <ApplicationFieldsForm application={application} onSave={patch => actions.saveFields(application, patch)} />
      </section>
      <section className="applications-v2__detail-section">
        <h3>记录进度</h3>
        <ProgressStatusEditor
          key={`${application.id}-${revision}-${progress.events.at(-1)?.id ?? 'draft'}`}
          definitions={snapshot.definitions}
          record={progress}
          expectedRevision={revision}
          onSubmit={command => actions.applyProgressCommand(command)}
        />
      </section>
      <section className="applications-v2__detail-section">
        <ProgressHistory
          events={progress.events.filter(event => event.invalidatedAt === null)}
          auditEvents={progress.events}
          uncertainEdges={progress.migrationReview?.uncertainEdges ?? []}
          title="有效进度历史"
          onDelete={event => void actions.removeProgressEvent(progress.applicationId, event).catch(cause => notice(cause instanceof Error ? cause.message : '删除失败', 'error'))}
        />
        {progress.events.some(event => event.invalidatedAt !== null) && <details className="applications-v2__audit">
          <summary>查看已纠正的审计记录（{progress.events.filter(event => event.invalidatedAt !== null).length}）</summary>
          <ol>{progress.events.filter(event => event.invalidatedAt !== null).sort((left, right) => left.sequence - right.sequence).map(event => <li key={event.id}>
            <span>{event.occurredOn} · {event.statusNameSnapshot}</span>
            <span>已作废{event.correctionOfEventId ? '（已纠正）' : ''}</span>
          </li>)}</ol>
        </details>}
      </section>
      <ApplicationScheduleSection application={application} schedules={snapshot.schedules.filter(schedule => schedule.applicationId === application.id)} actions={actions} />
      <section className="applications-v2__pending-actions" aria-label="投递操作">
        <button type="button" onClick={() => setConfirmDelete(true)}>删除投递</button>
        {deleteError && <p className="applications-v2__error" role="alert">{deleteError}</p>}
      </section>
      <ConfirmDialog
        open={confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setDeleteError('');
          setDeleting(true);
          void actions.deleteApplication(application)
            .then(() => { setConfirmDelete(false); onClose(); })
            .catch(cause => setDeleteError(errorText(cause, '删除失败，请重试。')))
            .finally(() => setDeleting(false));
        }}
        title="删除这条投递？"
        description={`将删除「${application.company} · ${application.role}」及其全部进度历史和日程。删除后可以在提示里立即撤销。`}
        confirmLabel={deleting ? '删除中…' : '删除投递'}
        cancelLabel="保留投递"
      />
    </div></div> : null}
  </Drawer>;
}

interface CreateFields {
  company: string;
  role: string;
  city: string;
  channelId: string;
  statusKey: string;
  appliedOn: string;
  statusOn: string;
  jobUrl: string;
  trackingUrl: string;
  notes: string;
  isStarred: boolean;
}

/** One-step creation: base fields plus the current status and its dates (default 已投递 · today). */
export function CreateApplicationDrawer({ open, seasonId, onClose, notice, onCreated }: { open: boolean; seasonId: string | null; onClose: () => void; notice: Notice; onCreated?: (application: ApplicationV2) => void }) {
  const { snapshot } = useV2Data();
  const actions = useApplicationActions(notice);
  const season = seasonId ? snapshot.seasons.find(item => item.id === seasonId && item.archivedAt === null) ?? null : null;
  const activeChannels = snapshot.channels.filter(channel => channel.archivedAt === null);
  // The full grouped list, so an application found late can start at e.g. 一面待结果; outcomes that
  // need an earlier event (接受 / 拒绝 Offer, 主动退出) are left to the board.
  const statusOptions = useMemo(() => quickStatusOptions(snapshot.definitions, createProgressRecord('new-application'))
    .filter(option => !['withdrawn', 'offer_accepted', 'offer_declined'].includes(snapshot.definitions.statuses.find(status => status.id === option.statusId)?.semantic ?? '')), [snapshot.definitions]);
  const semanticOf = (statusId: string) => snapshot.definitions.statuses.find(status => status.id === statusId)?.semantic;
  const submittedKey = statusOptions.find(option => semanticOf(option.statusId) === 'submitted')?.key ?? '';
  const blank = (): CreateFields => {
    const today = localBusinessDate();
    return { company: '', role: '', city: '', channelId: activeChannels[0]?.id ?? '', statusKey: submittedKey, appliedOn: today, statusOn: today, jobUrl: '', trackingUrl: '', notes: '', isStarred: false };
  };
  const [fields, setFields] = useState<CreateFields>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (open) { setFields(blank()); setError(''); } }, [open]);

  const update = <K extends keyof CreateFields>(key: K, value: CreateFields[K]) => setFields(current => ({ ...current, [key]: value }));
  const option = statusOptions.find(item => item.key === fields.statusKey);
  const recordsSubmission = semanticOf(fields.statusKey) !== 'draft';
  const laterStatus = recordsSubmission && fields.statusKey !== submittedKey;
  const earlier = season ? sameRoleApplications(snapshot.applications, season.id, fields.company, fields.role) : [];

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!season) return;
    setError('');
    if (recordsSubmission && !fields.appliedOn) { setError('请填写投递日期；还没投递可以把状态选为「待投递」。'); return; }
    if (laterStatus && fields.statusOn < fields.appliedOn) { setError('状态日期不能早于投递日期。'); return; }
    const failedStatus = option ? snapshot.definitions.statuses.find(status => status.id === option.statusId && status.semantic === 'failed') : undefined;
    setSaving(true);
    try {
      const created = await actions.createApplication({
        seasonId: season.id,
        company: fields.company,
        role: fields.role,
        city: fields.city,
        channelId: fields.channelId,
        jobUrl: normalizeUrlInput(fields.jobUrl),
        trackingUrl: normalizeUrlInput(fields.trackingUrl),
        notes: fields.notes,
        isStarred: fields.isStarred,
        ...(recordsSubmission ? {
          initialProgress: {
            submittedOn: fields.appliedOn,
            ...(laterStatus && option ? { statusId: option.statusId, occurredOn: fields.statusOn } : {}),
            ...(failedStatus ? { failedAt: failedStatus.stageId ? { stageId: failedStatus.stageId } : 'unknown' as const } : {}),
          },
        } : {}),
      });
      onCreated?.(created);
      onClose();
    } catch (cause) {
      setError(errorText(cause, '新建失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  return <Drawer open={open} onClose={onClose} title="新增投递" {...(season ? { description: season.name } : {})}>
    <div className="applications-v2 applications-v2--embedded">
      {!season ? <p>请先在「数据与设置」中创建并选择一个招聘季。</p>
        : !activeChannels.length ? <p>新增投递需要至少一个可用的投递渠道。</p>
          : <form className="applications-v2__form" onSubmit={submit} aria-label="新增投递">
            <label><span>公司 *</span><input required autoFocus maxLength={160} value={fields.company} onChange={event => update('company', event.target.value)} placeholder="如：字节跳动" /></label>
            <label><span>岗位 *</span><input required maxLength={160} value={fields.role} onChange={event => update('role', event.target.value)} placeholder="如：后端开发工程师" /></label>
            {earlier.length > 0 && <p className="applications-v2__form-note">这家公司的同名岗位已有 {earlier.length} 条记录；不同时期的投递可以继续保存为新的一条。</p>}
            <label><span>当前状态</span><select value={fields.statusKey} onChange={event => update('statusKey', event.target.value)}>
              {groupQuickStatusOptions(statusOptions).map(group => <optgroup key={group.label} label={group.label}>
                {group.options.map(item => <option key={item.key} value={item.key}>{semanticOf(item.statusId) === 'draft' ? `${item.label}（先存草稿）` : item.label}</option>)}
              </optgroup>)}
            </select></label>
            {recordsSubmission && <label><span>投递日期</span><input type="date" required value={fields.appliedOn} onChange={event => update('appliedOn', event.target.value)} /></label>}
            {laterStatus && <label><span>「{option?.label}」的日期</span><input type="date" required value={fields.statusOn} onChange={event => update('statusOn', event.target.value)} /><small>会依次记录「已投递」和「{option?.label}」两条进度。</small></label>}
            <div className="applications-v2__field"><span>城市</span><CityTagsInput label="城市" value={fields.city} onChange={value => update('city', value)} suggestions={citySuggestions(snapshot.applications)} /></div>
            <label><span>投递渠道</span><select required value={fields.channelId} onChange={event => update('channelId', event.target.value)}>
              {activeChannels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
            </select></label>
            <label><span>投递进度链接（状态页）</span><input inputMode="url" placeholder="官网个人中心 / 投递记录页 https://…" value={fields.trackingUrl} onChange={event => update('trackingUrl', event.target.value)} /></label>
            <label><span>岗位 JD 链接（可选）</span><input inputMode="url" placeholder="https://…" value={fields.jobUrl} onChange={event => update('jobUrl', event.target.value)} /></label>
            <label className="applications-v2__notes"><span>备注</span><textarea rows={3} value={fields.notes} onChange={event => update('notes', event.target.value)} placeholder="面试进展、笔试题型、联系人、复盘……" /></label>
            <label className="applications-v2__check"><input type="checkbox" checked={fields.isStarred} onChange={event => update('isStarred', event.target.checked)} /><span>关注这条投递</span></label>
            {error && <p className="applications-v2__error" role="alert">{error}</p>}
            <div className="applications-v2__form-actions">
              <button type="submit" disabled={saving || !fields.channelId}>{saving ? '保存中…' : '保存'}</button>
              <button type="button" className="applications-v2__secondary" onClick={onClose} disabled={saving}>取消</button>
            </div>
          </form>}
    </div>
  </Drawer>;
}
