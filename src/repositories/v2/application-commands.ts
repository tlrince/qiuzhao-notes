import { DomainError, requireRule } from '../../domain/errors.js';
import { validateInstant } from '../../domain/validation.js';
import { validateExternalUrl } from '../../platform/validation.js';
import {
  appendProgressEvent,
  correctProgressEvent,
  createProgressRecord,
  invalidateProgressEvent,
  type AppendProgressInput,
  type CorrectProgressInput,
} from '../../domain/v2/progress.js';
import { syncApplicationWithProgress, validateV2Snapshot, type ApplicationV2, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import type { ProgressEvent, ProgressRecord } from '../../domain/v2/types.js';
import type { SnapshotStoreV2 } from '../storage-v2-contract.js';

export type EditableApplicationFields = Partial<Pick<
  ApplicationV2,
  'seasonId' | 'company' | 'role' | 'city' | 'channelId' | 'jobUrl' | 'trackingUrl' | 'isStarred' | 'notes'
>>;

export interface ApplicationCommandContext {
  now: () => string;
  id: () => string;
}

export interface RevisionedCommandInput {
  applicationId: string;
  expectedRevision: number;
}

export interface CreateApplicationCommandInput {
  expectedRevision: number;
  seasonId: string;
  company: string;
  role: string;
  city?: string;
  channelId: string;
  jobUrl?: string;
  trackingUrl?: string;
  isStarred?: boolean;
  notes?: string;
  /**
   * Optional first progress written in the same transaction: the submission, and
   * optionally a later current status. Omit it to create an empty draft.
   */
  initialProgress?: {
    submittedOn: string;
    statusId?: string;
    occurredOn?: string;
    failedAt?: { stageId: string } | 'unknown';
  };
}

export interface ApplicationCommandResult<T> {
  revision: number;
  value: T;
}

export interface ProgressCommandValue {
  application: ApplicationV2;
  progress: ProgressRecord;
  event: ProgressEvent;
  duplicate: boolean;
}

export interface ApplicationCommands {
  createApplication(input: CreateApplicationCommandInput): Promise<ApplicationCommandResult<ApplicationV2>>;
  updateFields(input: RevisionedCommandInput & { patch: EditableApplicationFields }): Promise<ApplicationCommandResult<ApplicationV2>>;
  appendProgress(input: RevisionedCommandInput & { command: AppendProgressInput }): Promise<ApplicationCommandResult<ProgressCommandValue>>;
  /** Appends several statuses in order within one transaction (for example 已投递 then 笔试中). */
  appendProgressSteps(input: RevisionedCommandInput & { steps: AppendProgressInput[] }): Promise<ApplicationCommandResult<{ application: ApplicationV2; progress: ProgressRecord; changed: boolean }>>;
  correctProgress(input: RevisionedCommandInput & { eventId: string; command: CorrectProgressInput }): Promise<ApplicationCommandResult<ProgressCommandValue & { correctedEventId: string }>>;
  invalidateProgress(input: RevisionedCommandInput & { eventId: string }): Promise<ApplicationCommandResult<{ application: ApplicationV2; progress: ProgressRecord }>>;
  deleteApplication(input: RevisionedCommandInput): Promise<ApplicationCommandResult<{ applicationId: string; removedProgressRecordCount: number; removedScheduleCount: number; removedLegacyHistoryCount: number }>>;
}

const editableKeys = new Set<keyof EditableApplicationFields>([
  'seasonId', 'company', 'role', 'city', 'channelId', 'jobUrl', 'trackingUrl', 'isStarred', 'notes',
]);

function findApplication(snapshot: DataSnapshotV2, applicationId: string): ApplicationV2 {
  const application = snapshot.applications.find(item => item.id === applicationId);
  if (!application) throw new DomainError('NOT_FOUND', '投递不存在');
  return application;
}

function findProgress(snapshot: DataSnapshotV2, applicationId: string): ProgressRecord {
  const progress = snapshot.progressRecords.find(item => item.applicationId === applicationId);
  if (!progress) throw new DomainError('NOT_FOUND', '投递进度记录不存在');
  return progress;
}

function assertExpectedRevision(expectedRevision: number, actualRevision: number): void {
  requireRule(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, '快照版本无效');
  if (expectedRevision !== actualRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
}

function syncApplicationProjection(application: ApplicationV2, progress: ProgressRecord, updatedAt: string): void {
  syncApplicationWithProgress(application, progress);
  application.updatedAt = updatedAt;
}

/**
 * Transactional command layer for a v2 application. Each command works against a
 * private snapshot copy, validates the resulting whole snapshot, then performs one
 * revision-CAS commit. The source event array and its createdAt ordering are left to R1.
 */
export function createApplicationCommands(
  store: SnapshotStoreV2,
  context: Partial<ApplicationCommandContext> = {},
): ApplicationCommands {
  const now = context.now ?? (() => new Date().toISOString());
  const id = context.id ?? (() => globalThis.crypto.randomUUID());

  async function transact<T>(
    expectedRevision: number,
    mutate: (snapshot: DataSnapshotV2, now: string) => T,
    shouldCommit: (value: T) => boolean = () => true,
    retainRecoveryCopy = false,
  ): Promise<ApplicationCommandResult<T>> {
    const stored = await store.read();
    assertExpectedRevision(expectedRevision, stored.revision);
    const operationNow = now();
    validateInstant(operationNow);
    const next = structuredClone(stored.data);
    const value = mutate(next, operationNow);
    validateV2Snapshot(next);
    if (!shouldCommit(value)) {
      // A duplicate command is a read-only success. Recheck the revision so it
      // cannot accidentally accept a stale duplicate after a competing writer.
      const latest = await store.read();
      assertExpectedRevision(expectedRevision, latest.revision);
      return { revision: latest.revision, value: structuredClone(value) };
    }
    const revision = retainRecoveryCopy
      ? await store.restore(expectedRevision, next)
      : await store.commit(expectedRevision, next);
    return { revision, value: structuredClone(value) };
  }

  return {
    createApplication(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        requireRule(!!input.seasonId && snapshot.seasons.some(season => season.id === input.seasonId), '招聘季不存在');
        requireRule(!!input.channelId && snapshot.channels.some(channel => channel.id === input.channelId), '投递渠道不存在');
        requireRule(typeof input.company === 'string' && !!input.company.trim(), '公司名称不能为空');
        requireRule(typeof input.role === 'string' && !!input.role.trim(), '岗位名称不能为空');
        const city = input.city ?? '';
        const jobUrl = input.jobUrl ?? '';
        const trackingUrl = input.trackingUrl ?? '';
        requireRule(typeof city === 'string' && typeof jobUrl === 'string' && typeof trackingUrl === 'string', '投递链接或城市格式无效');
        requireRule(input.isStarred === undefined || typeof input.isStarred === 'boolean', '关注标记必须为布尔值');
        requireRule(input.notes === undefined || typeof input.notes === 'string', '备注必须为文本');
        if (jobUrl) {
          let url: URL;
          try { url = new URL(jobUrl); }
          catch { throw new DomainError('VALIDATION', '招聘链接无效'); }
          requireRule(['http:', 'https:'].includes(url.protocol), '招聘链接仅允许 http/https');
        }
        const normalizedTrackingUrl = trackingUrl === '' ? '' : validateExternalUrl(trackingUrl);
        const applicationId = id();
        requireRule(typeof applicationId === 'string' && !!applicationId.trim(), '投递 ID 无效');
        if (snapshot.applications.some(application => application.id === applicationId)) throw new DomainError('CONFLICT', '投递 ID 已存在');
        const application: ApplicationV2 = {
          id: applicationId,
          seasonId: input.seasonId,
          company: input.company.trim(),
          role: input.role.trim(),
          city: city.trim(),
          channelId: input.channelId,
          jobUrl,
          trackingUrl: normalizedTrackingUrl,
          appliedOn: null,
          currentStatusId: 'draft',
          currentStage: null,
          phase: 'unknown',
          outcome: 'active',
          failedAt: null,
          currentEventId: null,
          isStarred: input.isStarred ?? false,
          notes: input.notes ?? '',
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        let progress = createProgressRecord(applicationId);
        if (input.initialProgress) {
          const initial = input.initialProgress;
          const submittedStatus = snapshot.definitions.statuses
            .filter(status => status.semantic === 'submitted' && status.archivedAt === null)
            .sort((left, right) => left.sortOrder - right.sortOrder)[0];
          requireRule(!!submittedStatus, '没有可用的「已投递」状态，无法记录投递');
          const append = (statusId: string, occurredOn: string, suffix: string, failedAt?: { stageId: string } | 'unknown') => {
            progress = appendProgressEvent(progress, snapshot.definitions, { commandId: `create:${applicationId}:${suffix}`, statusId, occurredOn, ...(failedAt === undefined ? {} : { failedAt }) }, { now: timestamp, id }).record;
          };
          append(submittedStatus.id, initial.submittedOn, 'submitted');
          if (initial.statusId && initial.statusId !== submittedStatus.id) append(initial.statusId, initial.occurredOn ?? initial.submittedOn, 'status', initial.failedAt);
        }
        snapshot.applications.push(application);
        snapshot.progressRecords.push(progress);
        syncApplicationWithProgress(application, progress);
        return application;
      });
    },

    updateFields(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        const application = findApplication(snapshot, input.applicationId);
        requireRule(typeof input.patch === 'object' && input.patch !== null && !Array.isArray(input.patch), '投递字段更新内容无效');
        const keys = Object.keys(input.patch) as Array<keyof EditableApplicationFields>;
        requireRule(keys.length > 0, '至少需要更新一个投递字段');
        for (const key of keys) {
          requireRule(editableKeys.has(key), `不允许直接修改投递字段：${String(key)}`);
          requireRule(input.patch[key] !== undefined, `投递字段不能写入 undefined：${String(key)}`);
        }
        // jobUrl is the job description link; trackingUrl is the separate recruiting system URL.
        Object.assign(application, structuredClone(input.patch));
        if ('company' in input.patch) {
          requireRule(typeof input.patch.company === 'string' && !!input.patch.company.trim(), '公司名称不能为空');
          application.company = input.patch.company.trim();
        }
        if ('role' in input.patch) {
          requireRule(typeof input.patch.role === 'string' && !!input.patch.role.trim(), '岗位名称不能为空');
          application.role = input.patch.role.trim();
        }
        if ('city' in input.patch) {
          requireRule(typeof input.patch.city === 'string', '城市必须为文本');
          application.city = input.patch.city.trim();
        }
        if ('seasonId' in input.patch) requireRule(typeof input.patch.seasonId === 'string' && !!input.patch.seasonId, '招聘季必填');
        if ('channelId' in input.patch) requireRule(typeof input.patch.channelId === 'string' && !!input.patch.channelId, '投递渠道必填');
        if ('isStarred' in input.patch) requireRule(typeof input.patch.isStarred === 'boolean', '关注标记必须为布尔值');
        if ('notes' in input.patch) requireRule(typeof input.patch.notes === 'string', '备注必须为文本');
        if ('jobUrl' in input.patch) {
          requireRule(typeof input.patch.jobUrl === 'string', '招聘链接必须为文本');
          if (input.patch.jobUrl) {
            let url: URL;
            try { url = new URL(input.patch.jobUrl); }
            catch { throw new DomainError('VALIDATION', '招聘链接无效'); }
            requireRule(['http:', 'https:'].includes(url.protocol), '招聘链接仅允许 http/https');
          }
        }
        if ('trackingUrl' in input.patch) {
          requireRule(typeof input.patch.trackingUrl === 'string', '招聘系统链接必须为文本');
          application.trackingUrl = input.patch.trackingUrl === '' ? '' : validateExternalUrl(input.patch.trackingUrl);
        }
        application.updatedAt = timestamp;
        return application;
      });
    },

    appendProgress(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        const application = findApplication(snapshot, input.applicationId);
        const progress = findProgress(snapshot, input.applicationId);
        const result = appendProgressEvent(progress, snapshot.definitions, input.command, { now: timestamp, id });
        snapshot.progressRecords[snapshot.progressRecords.findIndex(item => item.applicationId === input.applicationId)] = result.record;
        syncApplicationProjection(application, result.record, result.duplicate ? application.updatedAt : timestamp);
        return { application, progress: result.record, event: result.event, duplicate: result.duplicate };
      }, value => !value.duplicate);
    },

    appendProgressSteps(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        requireRule(Array.isArray(input.steps) && input.steps.length > 0, '至少需要记录一条进度');
        const application = findApplication(snapshot, input.applicationId);
        let progress = findProgress(snapshot, input.applicationId);
        let changed = false;
        for (const step of input.steps) {
          const result = appendProgressEvent(progress, snapshot.definitions, step, { now: timestamp, id });
          progress = result.record;
          changed ||= !result.duplicate;
        }
        snapshot.progressRecords[snapshot.progressRecords.findIndex(item => item.applicationId === input.applicationId)] = progress;
        syncApplicationProjection(application, progress, changed ? timestamp : application.updatedAt);
        return { application, progress, changed };
      }, value => value.changed);
    },

    correctProgress(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        const application = findApplication(snapshot, input.applicationId);
        const progress = findProgress(snapshot, input.applicationId);
        const result = correctProgressEvent(progress, snapshot.definitions, input.eventId, input.command, { now: timestamp, id });
        snapshot.progressRecords[snapshot.progressRecords.findIndex(item => item.applicationId === input.applicationId)] = result.record;
        syncApplicationProjection(application, result.record, result.duplicate ? application.updatedAt : timestamp);
        return { application, progress: result.record, event: result.event, duplicate: result.duplicate, correctedEventId: result.correctedEventId };
      }, value => !value.duplicate);
    },

    invalidateProgress(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        const application = findApplication(snapshot, input.applicationId);
        const progress = findProgress(snapshot, input.applicationId);
        const nextProgress = invalidateProgressEvent(progress, snapshot.definitions, input.eventId, timestamp);
        snapshot.progressRecords[snapshot.progressRecords.findIndex(item => item.applicationId === input.applicationId)] = nextProgress;
        syncApplicationProjection(application, nextProgress, timestamp);
        return { application, progress: nextProgress };
      });
    },

    deleteApplication(input) {
      return transact(input.expectedRevision, snapshot => {
        findApplication(snapshot, input.applicationId);
        const applicationIds = new Set([input.applicationId]);
        const progressBefore = snapshot.progressRecords.length;
        const schedulesBefore = snapshot.schedules.length;
        const legacyBefore = snapshot.legacyHistory.length;
        snapshot.applications = snapshot.applications.filter(application => !applicationIds.has(application.id));
        snapshot.progressRecords = snapshot.progressRecords.filter(record => !applicationIds.has(record.applicationId));
        snapshot.schedules = snapshot.schedules.filter(schedule => !applicationIds.has(schedule.applicationId));
        snapshot.legacyHistory = snapshot.legacyHistory.filter(record => !applicationIds.has(record.applicationId));
        return {
          applicationId: input.applicationId,
          removedScheduleCount: schedulesBefore - snapshot.schedules.length,
          removedLegacyHistoryCount: legacyBefore - snapshot.legacyHistory.length,
          // Keep this local invariant visible in case the snapshot model changes.
          removedProgressRecordCount: progressBefore - snapshot.progressRecords.length,
        };
      }, () => true, true);
    },
  };
}
