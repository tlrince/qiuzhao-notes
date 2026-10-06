import { DomainError, requireRule } from '../errors.js';
import { validateDate, validateInstant } from '../validation.js';
import type { Application as ApplicationV1, Channel, OutcomeEvent, Schedule, Season, StageEvent, Workspace } from '../types.js';
import { validateDefinitions } from './definitions.js';
import { validateProgressRecord } from './progress.js';
import type { FailedAt, ProgressPhase, ProgressRecord, R1DefinitionsSnapshot, TerminalOutcome } from './types.js';

export interface SettingsV2 {
  schemaVersion: 2;
  lastBackupAt: string | null;
  preferences: Record<string, string | number | boolean>;
}

export interface ApplicationV2 extends Omit<ApplicationV1, 'currentStage' | 'outcome'> {
  trackingUrl: string;
  currentStatusId: string;
  currentStage: string | null;
  phase: ProgressPhase;
  outcome: TerminalOutcome;
  failedAt: FailedAt | null;
  currentEventId: string | null;
}

export interface LegacyHistoryRecord {
  applicationId: string;
  stageEvents: StageEvent[];
  outcomeEvents: OutcomeEvent[];
  orderStatus: 'confirmed' | 'needs_confirmation';
  uncertainEventIds: string[];
}

export interface DataSnapshotV2 {
  schemaVersion: 2;
  workspace: Workspace;
  seasons: Season[];
  channels: Channel[];
  settings: SettingsV2;
  applications: ApplicationV2[];
  schedules: Schedule[];
  definitions: R1DefinitionsSnapshot;
  progressRecords: ProgressRecord[];
  /** Retained byte-for-byte as parsed JSON so users can review or retry migration. */
  legacyHistory: LegacyHistoryRecord[];
  migration: { sourceSchemaVersion: 1; migratedAt: string; warnings: string[] } | null;
}

export interface BackupEnvelopeV2 {
  format: 'autumn-applications';
  schemaVersion: 2;
  exportedAt: string;
  data: DataSnapshotV2;
}

/** Copies the effective chain tail onto the application's denormalized current-state fields. */
export function syncApplicationWithProgress(application: ApplicationV2, progress: ProgressRecord): void {
  const current = progress.events
    .filter(event => event.invalidatedAt === null)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1) ?? null;

  application.appliedOn = progress.appliedOn;
  application.currentEventId = current?.id ?? null;
  if (!current) {
    application.currentStatusId = 'draft';
    application.currentStage = null;
    application.phase = 'unknown';
    application.outcome = 'active';
    application.failedAt = null;
    return;
  }

  application.currentStatusId = current.statusId;
  application.currentStage = current.semantics.stageId ?? current.contextStageId;
  application.phase = current.phase;
  application.outcome = current.semantics.terminalOutcome;
  application.failedAt = current.semantics.terminalOutcome === 'failed' ? structuredClone(current.failedAt) : null;
}

export function validateV2Snapshot(value: unknown): asserts value is DataSnapshotV2 {
  requireRule(typeof value === 'object' && value !== null && !Array.isArray(value), 'v2 快照必须是对象');
  const snapshot = value as Partial<DataSnapshotV2>;
  requireRule(snapshot.schemaVersion === 2 && snapshot.settings?.schemaVersion === 2, '不支持的快照版本');
  requireRule(!!snapshot.workspace && Array.isArray(snapshot.seasons) && Array.isArray(snapshot.channels) && Array.isArray(snapshot.applications) && Array.isArray(snapshot.schedules) && Array.isArray(snapshot.progressRecords) && Array.isArray(snapshot.legacyHistory) && !!snapshot.settings && !!snapshot.definitions, 'v2 快照缺少必要字段');
  requireRule(typeof snapshot.workspace.id === 'string' && typeof snapshot.workspace.name === 'string' && typeof snapshot.workspace.timeZone === 'string', '工作空间数据无效');
  if (snapshot.settings.lastBackupAt !== null) validateInstant(snapshot.settings.lastBackupAt);
  requireRule(typeof snapshot.settings.preferences === 'object' && snapshot.settings.preferences !== null && !Array.isArray(snapshot.settings.preferences), '偏好设置无效');
  if (snapshot.migration) {
    requireRule(snapshot.migration.sourceSchemaVersion === 1 && Array.isArray(snapshot.migration.warnings), '迁移元数据无效');
    validateInstant(snapshot.migration.migratedAt);
  }
  validateDefinitions(snapshot.definitions);

  const applicationIds = new Set<string>();
  const seasonIds = new Set(snapshot.seasons.map(item => item.id));
  const channelIds = new Set(snapshot.channels.map(item => item.id));
  for (const application of snapshot.applications) {
    requireRule(!!application.id && !applicationIds.has(application.id), '投递 ID 必须唯一'); applicationIds.add(application.id);
    requireRule(seasonIds.has(application.seasonId) && channelIds.has(application.channelId), '投递关联的招聘季或渠道不存在');
    requireRule(typeof application.company === 'string' && typeof application.role === 'string' && typeof application.jobUrl === 'string' && typeof application.trackingUrl === 'string', '投递信息无效');
    if (application.appliedOn !== null) validateDate(application.appliedOn);
    validateInstant(application.createdAt); validateInstant(application.updatedAt);
    requireRule(['unknown', 'waiting', 'in_progress', 'awaiting_result', 'passed'].includes(application.phase), '当前进度阶段无效');
    requireRule(['active', 'failed', 'offer_received', 'offer_accepted', 'offer_declined', 'withdrawn'].includes(application.outcome), '当前结果无效');
    requireRule(snapshot.definitions.statuses.some(status => status.id === application.currentStatusId), '投递当前状态不存在');
    requireRule(application.currentStage === null || snapshot.definitions.stages.some(stage => stage.id === application.currentStage), '投递当前环节不存在');
    const failedAt = application.failedAt;
    if (failedAt !== null && failedAt !== 'unknown') requireRule(snapshot.definitions.stages.some(stage => stage.id === failedAt.stageId), '失败环节不存在');
  }

  const records = new Map<string, ProgressRecord>();
  for (const record of snapshot.progressRecords) {
    requireRule(applicationIds.has(record.applicationId) && !records.has(record.applicationId), '进度记录投递关联无效或重复');
    validateProgressRecord(record, snapshot.definitions);
    records.set(record.applicationId, record);
  }
  requireRule(records.size === applicationIds.size, '每个投递都必须有一条进度记录');
  for (const application of snapshot.applications) {
    const record = records.get(application.id)!;
    const active = record.events.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
    const current = active.at(-1) ?? null;
    requireRule((application.currentEventId ?? null) === (current?.id ?? null), '当前进度事件必须指向有效事件链尾');
    if (!current) requireRule(application.currentStatusId === 'draft' && application.currentStage === null && application.phase === 'unknown' && application.outcome === 'active' && application.failedAt === null, '空历史投递必须保持草稿状态');
    else {
      const projectedStage = current.semantics.stageId ?? current.contextStageId;
      const stageMatches = application.currentStage === projectedStage;
      requireRule(current.statusId === application.currentStatusId && stageMatches && current.phase === application.phase && current.semantics.terminalOutcome === application.outcome, '投递当前状态与进度历史不一致');
      const expectedFailure = current.semantics.terminalOutcome === 'failed' ? current.failedAt : null;
      const failureMatches = application.failedAt === expectedFailure || (typeof application.failedAt === 'object' && application.failedAt !== null && typeof expectedFailure === 'object' && expectedFailure !== null && application.failedAt.stageId === expectedFailure.stageId && application.failedAt.stageNameSnapshot === expectedFailure.stageNameSnapshot);
      requireRule(failureMatches, '当前失败归因与进度历史不一致');
    }
    requireRule(record.appliedOn === application.appliedOn, '投递日期与进度历史不一致');
  }
  for (const schedule of snapshot.schedules) requireRule(applicationIds.has(schedule.applicationId), '日程关联的投递不存在');
  for (const legacy of snapshot.legacyHistory) requireRule(applicationIds.has(legacy.applicationId) && ['confirmed', 'needs_confirmation'].includes(legacy.orderStatus), '旧历史副本无效');
}

export function assertV2Backup(value: unknown): asserts value is BackupEnvelopeV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('BACKUP_INCOMPATIBLE', '备份结构无效');
  const envelope = value as Partial<BackupEnvelopeV2>;
  if (envelope.format !== 'autumn-applications' || envelope.schemaVersion !== 2 || typeof envelope.exportedAt !== 'string') throw new DomainError('BACKUP_INCOMPATIBLE', '备份格式或版本不受支持');
  validateInstant(envelope.exportedAt);
  validateV2Snapshot(envelope.data);
}
