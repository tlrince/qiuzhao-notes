import type { Channel } from '../types.js';
import { validateDate, validateInstant } from '../validation.js';
import { DomainError } from '../errors.js';
import { defaultR1Definitions } from './definitions.js';
import { appendProgressEvent, createProgressRecord } from './progress.js';
import { syncApplicationWithProgress, validateV2Snapshot, type ApplicationV2, type DataSnapshotV2 } from './snapshot.js';
import type { ProgressEvent, ProgressRecord, R1DefinitionsSnapshot, StatusSemantic } from './types.js';
import { validateExternalUrl } from '../../platform/validation.js';

type RawStatusMapping = {
  statusId: string;
  phase: ProgressEvent['phase'];
  failedAt?: 'unknown';
};

/**
 * Explicit mappings for the user's older JSON vocabulary. Unknown labels are
 * rejected during preview; they are never silently replaced with a default.
 */
export const RAW_STATUS_MAPPINGS: Readonly<Record<string, RawStatusMapping>> = {
  '待投递': { statusId: 'draft', phase: 'unknown' },
  '已投递': { statusId: 'submitted', phase: 'unknown' },
  '筛选中': { statusId: 'screening', phase: 'unknown' },
  '笔试': { statusId: 'written_test_active', phase: 'in_progress' },
  '测评中': { statusId: 'assessment_active', phase: 'in_progress' },
  '一面': { statusId: 'interview_1_active', phase: 'in_progress' },
  '二面': { statusId: 'interview_2_active', phase: 'in_progress' },
  '三面': { statusId: 'interview_3_active', phase: 'in_progress' },
  '四面': { statusId: 'interview_4_active', phase: 'in_progress' },
  '五面': { statusId: 'interview_extra_active', phase: 'in_progress' },
  'Offer': { statusId: 'offer_received', phase: 'unknown' },
  '泡池': { statusId: 'pool', phase: 'unknown' },
  '挂掉': { statusId: 'failed_unknown', phase: 'unknown', failedAt: 'unknown' },
};

export interface RawImportIssue {
  index: number;
  sourceId: string | null;
  field: string;
  message: string;
}

export interface ImportedApplicationV2 {
  /** Stable source key for duplicate detection and later reconciliation. */
  sourceId: string;
  sourceStatus: string;
  /** The complete parsed source row is retained for a caller's import preview/archive. */
  sourceRecord: Record<string, unknown>;
  application: ApplicationV2;
  progress: ProgressRecord;
}

export interface RawImportResult {
  totalCount: number;
  applications: ImportedApplicationV2[];
  issues: RawImportIssue[];
}

export interface RawImportOptions {
  seasonId: string;
  channels: Channel[];
  definitions?: R1DefinitionsSnapshot;
  /** Allows a future import UI to choose collision-free IDs without changing mapping rules. */
  applicationId?: (sourceId: string, index: number) => string;
  eventId?: (sourceId: string, index: number, sequence: number) => string;
}

interface ParsedSourceRow {
  sourceId: string;
  company: string;
  position: string;
  city: string;
  channelName: string;
  jobUrl: string;
  applyDate: string | null;
  sourceStatus: string;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  note: string;
  isStarred: boolean;
  notes: string;
  sourceRecord: Record<string, unknown>;
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 缺失`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} 不是有效时间`);
  const normalized = date.toISOString();
  validateInstant(normalized);
  return normalized;
}

function businessDateFromInstant(instant: string): string {
  const values = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => values.find(item => item.type === type)?.value;
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  validateDate(date);
  return date;
}

function extraNotes(row: Record<string, unknown>, note: string, unlinkedText: string): string {
  const metadata: Array<[string, string]> = [
    ['源记录 ID', text(row.id)],
    ['原链接文本', unlinkedText],
    ['原优先级', text(row.priority)],
    ['原公司分组', text(row.companyGroup)],
    ['薪资', text(row.salary)],
    ['内推人', text(row.referrer)],
    ['内推码', text(row.referralCode)],
    ['原面试时间', text(row.interviewTime)],
    ['原始投递日期', text(row.status) === '待投递' ? text(row.applyDate) : ''],
  ].filter((entry): entry is [string, string] => !!entry[1]);
  const appended = metadata.length
    ? `导入字段：${metadata.map(([name, value]) => `${name}=${value}`).join('；')}`
    : '';
  return [note, appended].filter(Boolean).join('\n');
}

function parseRow(value: unknown, index: number): ParsedSourceRow {
  const row = recordFrom(value);
  if (!row) throw new Error('每条记录必须是对象');
  const sourceId = text(row.id);
  if (!sourceId) throw new Error('id 必填');
  const company = text(row.company);
  if (!company) throw new Error('company 必填');
  const position = text(row.position);
  if (!position) throw new Error('position 必填');
  const sourceStatus = text(row.status);
  if (!sourceStatus) throw new Error('status 必填');
  if (!Object.hasOwn(RAW_STATUS_MAPPINGS, sourceStatus)) throw new Error(`不支持的状态“${sourceStatus}”，请先补充明确映射`);
  const channelName = text(row.channel);
  if (!channelName) throw new Error('channel 必填');
  const rawApplyDate = text(row.applyDate);
  let applyDate: string | null = null;
  if (rawApplyDate) {
    validateDate(rawApplyDate);
    applyDate = rawApplyDate;
  }
  if (sourceStatus !== '待投递' && !applyDate) throw new Error('非待投递状态必须提供 applyDate');
  const createdAt = normalizedInstant(row.createdAt, 'createdAt');
  const updatedAt = normalizedInstant(row.updatedAt, 'updatedAt');
  const statusUpdatedAt = row.statusUpdatedAt === undefined || row.statusUpdatedAt === null || row.statusUpdatedAt === ''
    ? updatedAt
    : normalizedInstant(row.statusUpdatedAt, 'statusUpdatedAt');
  const link = text(row.link);
  let jobUrl = '';
  let unlinkedText = '';
  if (link) {
    try { jobUrl = validateExternalUrl(link); }
    catch { unlinkedText = link; }
  }
  const note = text(row.note);
  const isStarred = text(row.priority) === '高';
  return {
    sourceId, company, position, city: text(row.location), channelName, jobUrl,
    applyDate, sourceStatus, createdAt, updatedAt, statusUpdatedAt,
    note, isStarred, notes: extraNotes(row, note, unlinkedText), sourceRecord: structuredClone(row),
  };
}

function defaultApplicationId(sourceId: string): string {
  return `raw-import-${sourceId}`;
}

function makeImportedRow(
  source: ParsedSourceRow,
  index: number,
  options: RawImportOptions,
  definitions: R1DefinitionsSnapshot,
  /** A re-used source row can carry a status time from before its new apply date. */
  clampStatusDate = false,
): ImportedApplicationV2 {
  const mapping = RAW_STATUS_MAPPINGS[source.sourceStatus]!;
  const channel = options.channels.find(item => item.name.trim().toLocaleLowerCase() === source.channelName.toLocaleLowerCase());
  if (!channel) throw new Error(`找不到名称为“${source.channelName}”的渠道`);
  const status = definitions.statuses.find(item => item.id === mapping.statusId);
  if (!status || status.archivedAt !== null) throw new Error(`状态定义“${mapping.statusId}”不存在或已归档`);
  if (source.sourceStatus === '挂掉' && status.semantic !== 'failed') throw new Error('“挂掉”映射必须指向失败语义');

  const id = options.applicationId?.(source.sourceId, index) ?? defaultApplicationId(source.sourceId);
  if (!id.trim()) throw new Error('生成的投递 ID 不能为空');
  const initialStatus = definitions.statuses.find(item => item.id === 'draft');
  if (!initialStatus) throw new Error('缺少初始草稿状态定义');
  const application: ApplicationV2 = {
    id,
    seasonId: options.seasonId,
    company: source.company,
    role: source.position,
    city: source.city,
    channelId: channel.id,
    jobUrl: source.jobUrl,
    trackingUrl: '',
    appliedOn: null,
    currentStatusId: initialStatus.id,
    currentStage: null,
    phase: 'unknown',
    outcome: 'active',
    failedAt: null,
    currentEventId: null,
    isStarred: source.isStarred,
    notes: source.notes,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  let progress = createProgressRecord(id);
  let eventSequence = 0;
  const newEventId = () => options.eventId?.(source.sourceId, index, ++eventSequence)
    ?? `${id}:import-event:${++eventSequence}`;
  const append = (statusId: string, occurredOn: string, createdAt: string, commandSuffix: string, failedAt?: 'unknown') => {
    const result = appendProgressEvent(progress, definitions, {
      commandId: `${id}:import:${commandSuffix}`,
      statusId,
      occurredOn,
      ...(statusId === mapping.statusId ? { phase: mapping.phase } : {}),
      ...(failedAt ? { failedAt } : {}),
      notes: commandSuffix === 'current' ? source.note : '',
    }, { now: createdAt, id: newEventId });
    progress = result.record;
    const storedEvent = progress.events.find(item => item.id === result.event.id)!;
    // Keep the exact legacy label while retaining the mapped, validated v2 semantics.
    storedEvent.statusNameSnapshot = commandSuffix === 'current' || source.sourceStatus === '已投递'
      ? source.sourceStatus
      : storedEvent.statusNameSnapshot;
    application.currentEventId = storedEvent.id;
    application.currentStatusId = storedEvent.statusId;
    application.currentStage = storedEvent.semantics.stageId ?? storedEvent.contextStageId;
    application.phase = storedEvent.phase;
    application.outcome = storedEvent.semantics.terminalOutcome;
    application.failedAt = storedEvent.failedAt;
    if (storedEvent.semantics.semantic === 'submitted') application.appliedOn = storedEvent.occurredOn;
  };

  if (source.sourceStatus !== '待投递') {
    if (!source.applyDate) throw new Error('已投递记录缺少 applyDate');
    append('submitted', source.applyDate, source.createdAt, 'submitted');
    application.appliedOn = source.applyDate;
    if (mapping.statusId !== 'submitted') {
      let statusDate = businessDateFromInstant(source.statusUpdatedAt);
      if (statusDate < source.applyDate) {
        if (!clampStatusDate) throw new Error('statusUpdatedAt 早于 applyDate，无法生成可信的状态顺序');
        statusDate = source.applyDate;
      }
      append(mapping.statusId, statusDate, source.statusUpdatedAt, 'current', mapping.failedAt);
    }
  }
  if (source.sourceStatus === '待投递') {
    // The source date remains available on sourceRecord; v2 drafts cannot have appliedOn.
    application.appliedOn = null;
    application.currentStatusId = 'draft';
    application.currentStage = null;
    application.phase = 'unknown';
    application.outcome = 'active';
    application.failedAt = null;
    application.currentEventId = null;
  }
  return { sourceId: source.sourceId, sourceStatus: source.sourceStatus, sourceRecord: source.sourceRecord, application, progress };
}

/** Parse legacy JSON and produce validated v2 applications plus their initial event chains. */
/** Accepts JSON text, a record array, or an object wrapping `applications`. */
function sourceRows(input: unknown): unknown[] | RawImportIssue {
  let value = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input) as unknown; }
    catch (error) { return { index: -1, sourceId: null, field: '$', message: error instanceof Error ? `JSON 格式无效：${error.message}` : 'JSON 格式无效' }; }
  }
  const root = recordFrom(value);
  const rows = Array.isArray(value) ? value : root && Array.isArray(root.applications) ? root.applications : null;
  return rows ?? { index: -1, sourceId: null, field: '$', message: '文件必须是记录数组或包含 applications 数组的对象' };
}

export function parseRawApplicationsImport(input: unknown, options: RawImportOptions): RawImportResult {
  const rows = sourceRows(input);
  if (!Array.isArray(rows)) return { totalCount: 0, applications: [], issues: [rows] };
  if (!options.seasonId.trim()) return { totalCount: rows.length, applications: [], issues: [{ index: -1, sourceId: null, field: 'seasonId', message: '必须选择招聘季' }] };
  const definitions = options.definitions ?? defaultR1Definitions();
  const applications: ImportedApplicationV2[] = [];
  const issues: RawImportIssue[] = [];
  const seenSourceIds = new Set<string>();
  const seenApplicationIds = new Set<string>();
  rows.forEach((rawRow, index) => {
    let sourceId: string | null = recordFrom(rawRow) ? text((rawRow as Record<string, unknown>).id) || null : null;
    try {
      const row = parseRow(rawRow, index);
      sourceId = row.sourceId;
      if (seenSourceIds.has(sourceId)) throw new Error(`重复的源记录 id“${sourceId}”`);
      seenSourceIds.add(sourceId);
      const imported = makeImportedRow(row, index, options, definitions);
      if (seenApplicationIds.has(imported.application.id)) throw new Error(`生成的投递 ID“${imported.application.id}”重复`);
      seenApplicationIds.add(imported.application.id);
      applications.push(imported);
    } catch (error) {
      issues.push({ index, sourceId, field: 'record', message: error instanceof Error ? error.message : '记录无效' });
    }
  });
  return { totalCount: rows.length, applications, issues };
}

/** Utility for callers that need a valid target channel list from a v2 snapshot. */
export function rawImportChannels(snapshot: Pick<DataSnapshotV2, 'channels'>): Channel[] {
  return structuredClone(snapshot.channels);
}

export function requireCleanRawImport(result: RawImportResult): ImportedApplicationV2[] {
  if (result.issues.length) {
    throw new DomainError('VALIDATION', `导入预览有 ${result.issues.length} 条错误，不能继续`);
  }
  return structuredClone(result.applications);
}

export interface RawImportSyncStatusUpdate {
  applicationId: string;
  sourceId: string;
  company: string;
  role: string;
  fromStatusName: string;
  sourceStatus: string;
  occurredOn: string;
  /** When the source changed status; it becomes the synced event's createdAt. */
  changedAt: string;
  /** Set when the application has no submission yet; recorded before the new status. */
  submittedOn: string | null;
  reopen: boolean;
}

export interface RawImportSyncSkip {
  sourceId: string;
  company: string;
  role: string;
  applicationId: string | null;
  reason: string;
}

export interface RawImportSyncPlan {
  seasonId: string;
  totalCount: number;
  unchangedCount: number;
  additions: ImportedApplicationV2[];
  statusUpdates: RawImportSyncStatusUpdate[];
  skipped: RawImportSyncSkip[];
  issues: RawImportIssue[];
}

export const RAW_IMPORT_SYNC_REOPEN_REASON = '同步原始 JSON 中的最新状态';
const IMPORTED_ID_PREFIX = 'raw-import-';
const reopenableSemantics = new Set<StatusSemantic>(['failed', 'offer_accepted', 'offer_declined', 'withdrawn']);

/** Coarse position in the process; finer phases of one stage count as the same place. */
function progressKey(semantic: StatusSemantic, stageId: string | null): string {
  if (semantic === 'draft' || semantic === 'submitted' || semantic === 'failed' || semantic === 'withdrawn') return semantic;
  if (semantic === 'offer_received' || semantic === 'offer_accepted' || semantic === 'offer_declined') return 'offer';
  return stageId ?? semantic;
}

const sameText = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/**
 * Compare a re-exported legacy JSON file with the current snapshot without changing it.
 * Imported rows are matched by source id and position; a different position under a
 * reused source id is a separate application. Status changes are appended only when the
 * source changed after the application's latest recorded event; nothing is deleted.
 */
export function planRawImportSync(snapshot: DataSnapshotV2, input: unknown, options: { seasonId: string }): RawImportSyncPlan {
  const plan: RawImportSyncPlan = { seasonId: options.seasonId, totalCount: 0, unchangedCount: 0, additions: [], statusUpdates: [], skipped: [], issues: [] };
  const rows = sourceRows(input);
  if (!Array.isArray(rows)) { plan.issues.push(rows); return plan; }
  plan.totalCount = rows.length;
  const season = snapshot.seasons.find(item => item.id === options.seasonId);
  if (!season || season.archivedAt !== null) {
    plan.issues.push({ index: -1, sourceId: null, field: 'seasonId', message: '必须选择一个未归档的招聘季' });
    return plan;
  }
  const { definitions } = snapshot;
  const records = new Map(snapshot.progressRecords.map(record => [record.applicationId, record]));
  const takenIds = new Set(snapshot.applications.map(application => application.id));
  const manualApplications = snapshot.applications.filter(application => application.seasonId === options.seasonId && !application.id.startsWith(IMPORTED_ID_PREFIX));
  const seenSourceIds = new Set<string>();
  const activeEvents = (applicationId: string) => {
    const record = records.get(applicationId);
    if (!record) throw new Error(`投递 ${applicationId} 缺少进度记录`);
    return record.events.filter(event => event.invalidatedAt === null).sort((left, right) => left.sequence - right.sequence);
  };

  rows.forEach((rawRow, index) => {
    let sourceId: string | null = recordFrom(rawRow) ? text((rawRow as Record<string, unknown>).id) || null : null;
    try {
      const source = parseRow(rawRow, index);
      sourceId = source.sourceId;
      if (seenSourceIds.has(sourceId)) throw new Error(`重复的源记录 id“${sourceId}”`);
      seenSourceIds.add(sourceId);
      const mapping = RAW_STATUS_MAPPINGS[source.sourceStatus]!;
      const status = definitions.statuses.find(item => item.id === mapping.statusId);
      if (!status || status.archivedAt !== null) throw new Error(`状态定义“${mapping.statusId}”不存在或已归档`);
      const sourceKey = progressKey(status.semantic, status.stageId);

      const baseId = `${IMPORTED_ID_PREFIX}${sourceId}`;
      const candidates = snapshot.applications.filter(application => application.id === baseId || application.id.startsWith(`${baseId}--`));
      const match = candidates.find(application => sameText(application.role, source.position));
      if (!match) {
        if (!candidates.length) {
          const duplicate = manualApplications.find(application => {
            if (!sameText(application.company, source.company) || application.appliedOn !== source.applyDate) return false;
            const current = activeEvents(application.id).at(-1);
            return sameText(application.role, source.position) || (current ? progressKey(current.semantics.semantic, current.semantics.stageId) : 'draft') === sourceKey;
          });
          if (duplicate) {
            plan.skipped.push({ sourceId, company: source.company, role: source.position, applicationId: duplicate.id, reason: `与 App 中手动新建的「${duplicate.company} · ${duplicate.role}」重复（公司、投递日期和状态一致）` });
            return;
          }
        }
        let applicationId = baseId;
        for (let suffix = 2; takenIds.has(applicationId); suffix += 1) applicationId = `${baseId}--${suffix}`;
        takenIds.add(applicationId);
        plan.additions.push(makeImportedRow(source, index, { seasonId: options.seasonId, channels: snapshot.channels, applicationId: () => applicationId }, definitions, candidates.length > 0));
        return;
      }

      const events = activeEvents(match.id);
      const last = events.at(-1) ?? null;
      if ((last ? progressKey(last.semantics.semantic, last.semantics.stageId) : 'draft') === sourceKey) {
        plan.unchangedCount += 1;
        return;
      }
      const skip = (reason: string) => plan.skipped.push({ sourceId: source.sourceId, company: match.company, role: match.role, applicationId: match.id, reason });
      const lastChange = events.reduce((latest, event) => event.createdAt > latest ? event.createdAt : latest, '');
      if (source.statusUpdatedAt <= lastChange) return skip(`App 中的「${last?.statusNameSnapshot ?? '待投递'}」更新更晚，保留 App 的状态`);
      const submitted = events.some(event => event.semantics.semantic === 'submitted');
      if (status.semantic === 'draft' || (status.semantic === 'submitted' && submitted)) return skip(`源文件把状态改回了「${source.sourceStatus}」，App 已有更后的进度，未同步`);
      // A missing submission is inserted first; it cannot be dated after existing history.
      const firstDate = events[0]?.occurredOn;
      const submittedOn = submitted ? null : firstDate && firstDate < source.applyDate! ? firstDate : source.applyDate!;
      // Event dates must not run backwards behind the existing chain or the new submission.
      const earliest = [businessDateFromInstant(source.statusUpdatedAt), last?.occurredOn ?? '', submittedOn ?? ''].sort().at(-1)!;
      plan.statusUpdates.push({
        applicationId: match.id,
        sourceId: source.sourceId,
        company: match.company,
        role: match.role,
        fromStatusName: last?.statusNameSnapshot ?? '待投递',
        sourceStatus: source.sourceStatus,
        occurredOn: earliest,
        changedAt: source.statusUpdatedAt,
        submittedOn,
        reopen: !!last && reopenableSemantics.has(last.semantics.semantic) && !reopenableSemantics.has(status.semantic),
      });
    } catch (error) {
      plan.issues.push({ index, sourceId, field: 'record', message: error instanceof Error ? error.message : '记录无效' });
    }
  });
  return plan;
}

/** Applies a clean sync plan to a copy of the snapshot and validates the complete result. */
export function applyRawImportSync(snapshot: DataSnapshotV2, plan: RawImportSyncPlan, context: { id: () => string }): DataSnapshotV2 {
  if (plan.issues.length) throw new DomainError('VALIDATION', `同步预览有 ${plan.issues.length} 条错误，不能继续`);
  const next = structuredClone(snapshot);
  for (const update of plan.statusUpdates) {
    const application = next.applications.find(item => item.id === update.applicationId);
    const recordIndex = next.progressRecords.findIndex(record => record.applicationId === update.applicationId);
    if (!application || recordIndex < 0) throw new DomainError('NOT_FOUND', `投递 ${update.applicationId} 已不存在，请重新预览`);
    const mapping = RAW_STATUS_MAPPINGS[update.sourceStatus];
    if (!mapping) throw new DomainError('VALIDATION', `不支持的状态“${update.sourceStatus}”`);
    let record = next.progressRecords[recordIndex]!;
    const appendSynced = (statusId: string, occurredOn: string, commandId: string, extra: Partial<Parameters<typeof appendProgressEvent>[2]>) => {
      const result = appendProgressEvent(record, next.definitions, { commandId, statusId, occurredOn, ...extra }, { now: update.changedAt, id: context.id });
      record = result.record;
      // Keep the source wording for the synced status, as the original import does.
      if (statusId !== 'submitted') record.events.find(event => event.id === result.event.id)!.statusNameSnapshot = update.sourceStatus;
    };
    if (update.submittedOn) {
      const first = record.events.filter(event => event.invalidatedAt === null).sort((left, right) => left.sequence - right.sequence)[0];
      appendSynced('submitted', update.submittedOn, `sync:${update.sourceId}:submitted`, first ? { mode: 'backfill', beforeEventId: first.id } : {});
    }
    if (mapping.statusId !== 'submitted') {
      appendSynced(mapping.statusId, update.occurredOn, `sync:${update.sourceId}:${update.changedAt}`, {
        ...(mapping.failedAt ? { failedAt: mapping.failedAt } : {}),
        ...(update.reopen ? { mode: 'reopen' as const, reopenReason: RAW_IMPORT_SYNC_REOPEN_REASON } : {}),
      });
    }
    next.progressRecords[recordIndex] = record;
    syncApplicationWithProgress(application, record);
    if (update.changedAt > application.updatedAt) application.updatedAt = update.changedAt;
  }
  for (const addition of plan.additions) {
    if (next.applications.some(item => item.id === addition.application.id)) throw new DomainError('CONFLICT', `投递 ID 已存在：${addition.application.id}，请重新预览`);
    if (addition.application.seasonId !== plan.seasonId) throw new DomainError('VALIDATION', '新增投递不属于所选招聘季');
    next.applications.push(structuredClone(addition.application));
    next.progressRecords.push(structuredClone(addition.progress));
  }
  validateV2Snapshot(next);
  return next;
}
