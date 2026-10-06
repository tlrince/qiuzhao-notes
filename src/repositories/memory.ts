import type * as T from '../domain/types.js';
import type { ApplicationRepository, ScheduleRepository, WorkspaceRepository, RepositoryEvents, RepositoryChange } from './contracts.js';
import { DomainError, requireRule } from '../domain/errors.js';
import { validateDate, validateDetail, validateSeason, validateTimeZone, validateInstant } from '../domain/validation.js';
import { createDetail, transitionDetail, correctDetail } from '../domain/rules.js';
import { emptySnapshot } from '../fixtures/acceptance.js';
/** 仅供模块独立开发。每次实例化为空；不承担 M2 的持久化职责。 */
export function createMemoryRepositories(seed: T.DataSnapshot = emptySnapshot(), options: { now?: () => string; id?: () => string } = {}) {
  let data = structuredClone(seed); const listeners = new Set<(change: RepositoryChange) => void>();
  const id = options.id ?? (() => crypto.randomUUID());
  const now = (previous?: string) => { const raw = (options.now ?? (() => new Date().toISOString()))(); validateInstant(raw); return previous && raw <= previous ? new Date(Date.parse(previous) + 1).toISOString() : raw; };
  const detail = (key: string): T.ApplicationDetail | null => {
    const application = data.applications.find(a => a.id === key); if (!application) return null;
    return structuredClone({ application, stageEvents: data.stageEvents.filter(e => e.applicationId === key), outcomeEvents: data.outcomeEvents.filter(e => e.applicationId === key), schedules: data.schedules.filter(s => s.applicationId === key) });
  };
  const required = (key: string, expected?: string) => { const d = detail(key); if (!d) throw new DomainError('NOT_FOUND', '岗位不存在'); if (expected !== undefined && expected !== d.application.updatedAt) throw new DomainError('CONFLICT', '记录已更新，请重新加载'); return d; };
  const notify = (scope: RepositoryChange['scope'], key: string | null) => { for (const fn of listeners) { try { fn({ scope, id: key }); } catch (error) { console.error('Repository subscriber failed', error); } } };
  const commit = (d: T.ApplicationDetail) => {
    validateDetail(d); requireRule(data.seasons.some(s => s.id === d.application.seasonId), '招聘季不存在'); requireRule(data.channels.some(c => c.id === d.application.channelId), '渠道不存在');
    const key = d.application.id;
    data = { ...data, applications: [...data.applications.filter(a => a.id !== key), structuredClone(d.application)], stageEvents: [...data.stageEvents.filter(e => e.applicationId !== key), ...structuredClone(d.stageEvents)], outcomeEvents: [...data.outcomeEvents.filter(e => e.applicationId !== key), ...structuredClone(d.outcomeEvents)] };
    notify('applications', key); return structuredClone(d);
  };
  for (const s of data.seasons) validateSeason(s);
  validateTimeZone(data.workspace.timeZone);
  requireRule(data.workspace.activeSeasonId === null || data.seasons.some(s => s.id === data.workspace.activeSeasonId), '当前招聘季不存在');
  for (const records of [data.applications, data.seasons, data.channels, data.stageEvents, data.outcomeEvents, data.schedules]) requireRule(new Set(records.map(r => r.id)).size === records.length, 'ID 重复');
  for (const e of [...data.stageEvents, ...data.outcomeEvents, ...data.schedules]) requireRule(data.applications.some(a => a.id === e.applicationId), '关联岗位不存在');
  for (const a of data.applications) { validateDetail(required(a.id)); requireRule(data.seasons.some(s => s.id === a.seasonId) && data.channels.some(c => c.id === a.channelId), '招聘季或渠道不存在'); }
  const applications: ApplicationRepository = {
    async list(q) {
      if (q.appliedDateRange) { validateDate(q.appliedDateRange.from); validateDate(q.appliedDateRange.to); requireRule(q.appliedDateRange.from <= q.appliedDateRange.to, '筛选日期范围无效'); }
      const keyword = q.keyword?.trim().toLocaleLowerCase();
      const rows = data.applications.filter(a => a.seasonId === q.seasonId && (!keyword || `${a.company}\n${a.role}`.toLocaleLowerCase().includes(keyword)) && (!q.stages?.length || q.stages.includes(a.currentStage)) && (!q.outcomes?.length || q.outcomes.includes(a.outcome)) && (q.city === undefined || a.city === q.city) && (q.channelId === undefined || a.channelId === q.channelId) && (!q.appliedDateRange || (a.appliedOn !== null && a.appliedOn >= q.appliedDateRange.from && a.appliedOn <= q.appliedDateRange.to)));
      const { field, direction } = q.sort ?? { field: 'updatedAt', direction: 'desc' };
      rows.sort((a, b) => { const x = a[field], y = b[field]; if (x === null) return y === null ? a.id.localeCompare(b.id) : 1; if (y === null) return -1; return (x.localeCompare(y) * (direction === 'asc' ? 1 : -1)) || a.id.localeCompare(b.id); }); return structuredClone(rows);
    },
    async getDetail(key) { return detail(key); },
    async create(input) { const d = createDetail(input, { now: now(), id }); requireRule(!data.applications.some(a => a.id === d.application.id), '岗位 ID 重复'); return commit(d); },
    async update(key, input) {
      const d = required(key, input.expectedUpdatedAt); const timestamp = now(d.application.updatedAt);
      for (const field of ['company', 'role', 'city', 'channelId', 'jobUrl', 'isStarred', 'notes'] as const) if (input[field] !== undefined) Object.assign(d.application, { [field]: typeof input[field] === 'string' && ['company', 'role', 'city'].includes(field) ? (input[field] as string).trim() : input[field] });
      if (input.appliedOn !== undefined && input.appliedOn !== d.application.appliedOn) {
        requireRule(d.application.currentStage !== 'draft', '草稿请通过阶段命令正式投递');
        const event = d.stageEvents.find(e => !e.supersededAt && e.stage === 'submitted')!;
        const corrected = correctDetail(d, { id: key, expectedUpdatedAt: input.expectedUpdatedAt, eventId: event.id, kind: 'stage', replacement: { stage: 'submitted', occurredOn: input.appliedOn } }, { now: timestamp, id }); return commit(corrected);
      }
      d.application.updatedAt = timestamp; return commit(d);
    },
    async transition(input) { const d = required(input.id, input.expectedUpdatedAt); return commit(transitionDetail(d, input, { now: now(d.application.updatedAt), id })); },
    async correctHistory(input) { const d = required(input.id, input.expectedUpdatedAt); return commit(correctDetail(d, input, { now: now(d.application.updatedAt), id })); },
    async remove(key) { required(key); data = { ...data, applications: data.applications.filter(a => a.id !== key), stageEvents: data.stageEvents.filter(e => e.applicationId !== key), outcomeEvents: data.outcomeEvents.filter(e => e.applicationId !== key), schedules: data.schedules.filter(s => s.applicationId !== key) }; notify('applications', key); },
  };
  const schedules: ScheduleRepository = {
    async list(q) { if (q.startsAtRange) { validateInstant(q.startsAtRange.from); validateInstant(q.startsAtRange.to); requireRule(q.startsAtRange.from <= q.startsAtRange.to, '日程范围无效'); } return structuredClone(data.schedules.filter(s => data.applications.some(a => a.id === s.applicationId && a.seasonId === q.seasonId) && (!q.applicationId || s.applicationId === q.applicationId) && (!q.status || s.status === q.status) && (!q.startsAtRange || (s.startsAt >= q.startsAtRange.from && s.startsAt <= q.startsAtRange.to))).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))); },
    async save(input) { const d = required(input.applicationId); if (input.id) { const old = data.schedules.find(s => s.id === input.id); if (!old) throw new DomainError('NOT_FOUND', '日程不存在'); requireRule(old.applicationId === input.applicationId, '不能移动日程所属岗位'); } const s = { ...input, id: input.id ?? id() }; d.schedules = [...d.schedules.filter(old => old.id !== s.id), s]; validateDetail(d); data.schedules = [...data.schedules.filter(old => old.id !== s.id), structuredClone(s)]; notify('schedules', s.id); return structuredClone(s); },
    async remove(key) { if (!data.schedules.some(s => s.id === key)) throw new DomainError('NOT_FOUND', '日程不存在'); data.schedules = data.schedules.filter(s => s.id !== key); notify('schedules', key); },
  };
  const workspace: WorkspaceRepository = {
    async get() { return structuredClone({ workspace: data.workspace, seasons: data.seasons, channels: data.channels, settings: data.settings }); },
    async saveSeason(input) { if (input.id && !data.seasons.some(s => s.id === input.id)) throw new DomainError('NOT_FOUND', '招聘季不存在'); const s = { ...input, id: input.id ?? id(), name: input.name.trim() }; validateSeason(s); data.seasons = [...data.seasons.filter(old => old.id !== s.id), s]; if (!data.workspace.activeSeasonId) data.workspace.activeSeasonId = s.id; notify('workspace', s.id); return structuredClone(s); },
    async setActiveSeason(key) { if (!data.seasons.some(s => s.id === key)) throw new DomainError('NOT_FOUND', '招聘季不存在'); data.workspace.activeSeasonId = key; notify('workspace', key); },
    async saveSettings(input) { if (input.timeZone !== undefined) validateTimeZone(input.timeZone); if (input.name !== undefined) requireRule(input.name.trim(), '工作空间名称不能为空'); if (input.name !== undefined) data.workspace.name = input.name.trim(); if (input.timeZone !== undefined) data.workspace.timeZone = input.timeZone; if (input.preferences) data.settings.preferences = structuredClone(input.preferences); notify('workspace', null); },
  };
  const events: RepositoryEvents = { subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  return { applications, schedules, workspace, events, snapshot: (): T.DataSnapshot => structuredClone(data) };
}
