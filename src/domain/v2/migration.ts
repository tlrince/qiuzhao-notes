import { DomainError } from '../errors.js';
import { validateDate, validateInstant } from '../validation.js';
import type { DataSnapshot, Outcome, OutcomeEvent, Stage, StageEvent } from '../types.js';
import { defaultR1Definitions } from './definitions.js';
import type { ProgressEvent, ProgressRecord, R1DefinitionsSnapshot, StageDefinition, StatusDefinition, StatusSemanticsVersion, StatusSemantic, TerminalOutcome } from './types.js';
import { validateV2Snapshot, type ApplicationV2, type DataSnapshotV2, type LegacyHistoryRecord } from './snapshot.js';

interface SourceEvent {
  kind: 'stage' | 'outcome';
  raw: StageEvent | OutcomeEvent;
  sourceIndex: number;
  statusId: string;
  semantic: StatusSemantic;
  stageId: string | null;
  terminalOutcome: TerminalOutcome;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const copy = <T>(value: T): T => structuredClone(value);
const reopenableLegacyOutcomes = new Set<TerminalOutcome>(['failed', 'offer_accepted', 'offer_declined', 'withdrawn']);

function statusDefinition(id: string, name: string, semantic: StatusSemantic, stageId: string | null, sortOrder: number, definitions: R1DefinitionsSnapshot, archivedAt: string): StatusDefinition {
  const stage = stageId === null ? null : definitions.stages.find(item => item.id === stageId) ?? null;
  const countsAsInterview = stage?.countsAsInterview ?? false;
  const revision: StatusSemanticsVersion = {
    version: 1,
    semantic,
    stageId,
    stageCategory: stage?.category ?? null,
    defaultPhase: 'unknown',
    statisticsCategory: 'legacy',
    countsAsInterview,
  };
  return { id, name, semantic, stageId, sortOrder, color: '#9b8f83', defaultPhase: 'unknown', statisticsCategory: 'legacy', archivedAt, version: 1, semanticsHistory: [revision] };
}

function addLegacyDefinitions(definitions: R1DefinitionsSnapshot, archivedAt: string): void {
  if (!definitions.stages.some(item => item.id === 'legacy_interview_3_plus')) {
    const legacyStage: StageDefinition = { id: 'legacy_interview_3_plus', name: '三面及以上·待确认', category: 'interview', sortOrder: 75, archivedAt, countsAsInterview: true };
    definitions.stages.push(legacyStage);
  }
  const additions: Array<[string, string, StatusSemantic, string | null, number]> = [
    ['legacy_assessment_unknown', '旧记录·笔试结果未知', 'stage', 'written_test', 24],
    ['legacy_interview_1_unknown', '旧记录·一面结果未知', 'stage', 'interview_1', 54],
    ['legacy_interview_2_unknown', '旧记录·二面结果未知', 'stage', 'interview_2', 64],
    ['legacy_interview_3_plus_unknown', '三面及以上·待确认', 'stage', 'legacy_interview_3_plus', 74],
    ['legacy_active', '旧记录·流程继续', 'custom', null, 1000],
  ];
  for (const [id, name, semantic, stageId, order] of additions) {
    if (!definitions.statuses.some(item => item.id === id)) definitions.statuses.push(statusDefinition(id, name, semantic, stageId, order, definitions, archivedAt));
  }
}

function oldStageMapping(stage: Stage): { statusId: string; stageId: string | null; semantic: StatusSemantic; terminalOutcome: TerminalOutcome } {
  if (stage === 'submitted') return { statusId: 'submitted', stageId: null, semantic: 'submitted', terminalOutcome: 'active' };
  if (stage === 'assessment') return { statusId: 'legacy_assessment_unknown', stageId: 'written_test', semantic: 'stage', terminalOutcome: 'active' };
  if (stage === 'interview_1') return { statusId: 'legacy_interview_1_unknown', stageId: 'interview_1', semantic: 'stage', terminalOutcome: 'active' };
  if (stage === 'interview_2') return { statusId: 'legacy_interview_2_unknown', stageId: 'interview_2', semantic: 'stage', terminalOutcome: 'active' };
  if (stage === 'interview_3_plus') return { statusId: 'legacy_interview_3_plus_unknown', stageId: 'legacy_interview_3_plus', semantic: 'stage', terminalOutcome: 'active' };
  throw new DomainError('BACKUP_INCOMPATIBLE', `无法迁移旧阶段：${String(stage)}`);
}

function oldOutcomeMapping(outcome: Outcome): { statusId: string; stageId: string | null; semantic: StatusSemantic; terminalOutcome: TerminalOutcome } {
  if (outcome === 'active') return { statusId: 'legacy_active', stageId: null, semantic: 'custom', terminalOutcome: 'active' };
  if (outcome === 'rejected') return { statusId: 'failed_unknown', stageId: null, semantic: 'failed', terminalOutcome: 'failed' };
  if (outcome === 'offer') return { statusId: 'offer_received', stageId: 'offer', semantic: 'offer_received', terminalOutcome: 'offer_received' };
  if (outcome === 'withdrawn') return { statusId: 'withdrawn', stageId: null, semantic: 'withdrawn', terminalOutcome: 'withdrawn' };
  throw new DomainError('BACKUP_INCOMPATIBLE', `无法迁移旧结果：${String(outcome)}`);
}

function mapSourceEvent(kind: 'stage' | 'outcome', raw: StageEvent | OutcomeEvent, sourceIndex: number): SourceEvent {
  const mapping = kind === 'stage' ? oldStageMapping((raw as StageEvent).stage) : oldOutcomeMapping((raw as OutcomeEvent).outcome);
  return { kind, raw, sourceIndex, ...mapping };
}

/** Merge two old logical streams without using createdAt. Within-stream array order is authoritative. */
function mergeSourceEvents(stages: SourceEvent[], outcomes: SourceEvent[], finalOutcomeId?: string): { ordered: SourceEvent[]; uncertainPairs: Array<[SourceEvent, SourceEvent]> } {
  const ordered: SourceEvent[] = [];
  const uncertainPairs: Array<[SourceEvent, SourceEvent]> = [];
  let si = 0, oi = 0;
  while (si < stages.length || oi < outcomes.length) {
    if (si >= stages.length) { ordered.push(outcomes[oi++]!); continue; }
    if (oi >= outcomes.length) { ordered.push(stages[si++]!); continue; }
    const stage = stages[si]!, outcome = outcomes[oi]!;
    if (outcome.raw.id === finalOutcomeId && stages.slice(si).some(item => !item.raw.supersededAt)) {
      ordered.push(stage); si += 1;
      continue;
    }
    const stageDate = stage.raw.occurredOn, outcomeDate = outcome.raw.occurredOn;
    if (stageDate === outcomeDate) {
      const before = ordered.at(-1);
      ordered.push(stage); si += 1;
      if (before && before.kind !== stage.kind && before.raw.occurredOn === stageDate) uncertainPairs.push([before, stage]);
      ordered.push(outcome); oi += 1;
      uncertainPairs.push([stage, outcome]);
    } else if (stageDate < outcomeDate) {
      const before = ordered.at(-1); ordered.push(stage); si += 1;
      if (before && before.kind !== stage.kind && before.raw.occurredOn > stageDate) uncertainPairs.push([before, stage]);
    } else {
      const before = ordered.at(-1); ordered.push(outcome); oi += 1;
      if (before && before.kind !== outcome.kind && before.raw.occurredOn > outcomeDate) uncertainPairs.push([before, outcome]);
    }
  }
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!, current = ordered[i]!;
    if (current.raw.occurredOn < previous.raw.occurredOn || (previous.kind !== current.kind && previous.raw.occurredOn === current.raw.occurredOn)) {
      if (!uncertainPairs.some(([a, b]) => a === previous && b === current)) uncertainPairs.push([previous, current]);
    }
  }
  return { ordered, uncertainPairs };
}

function validateV1Shape(value: unknown): asserts value is DataSnapshot {
  if (!isObject(value) || !isObject(value.settings) || value.settings.schemaVersion !== 1) throw new DomainError('BACKUP_INCOMPATIBLE', '只支持从 v1 快照迁移');
  for (const key of ['workspace', 'seasons', 'channels', 'applications', 'stageEvents', 'outcomeEvents', 'schedules']) if (!(key in value)) throw new DomainError('BACKUP_INCOMPATIBLE', `旧快照缺少字段：${key}`);
  for (const key of ['seasons', 'channels', 'applications', 'stageEvents', 'outcomeEvents', 'schedules']) if (!Array.isArray(value[key])) throw new DomainError('BACKUP_INCOMPATIBLE', `旧快照字段无效：${key}`);
  if (!isObject(value.workspace)) throw new DomainError('BACKUP_INCOMPATIBLE', '旧工作空间数据无效');
}

/** Loss-preserving v1 migration. Cross-stream same-day order stays explicitly reviewable. */
export function migrateV1Snapshot(value: unknown, options: { migratedAt: string }): DataSnapshotV2 {
  validateV1Shape(value);
  validateInstant(options.migratedAt);
  const source = value;
  const definitions = defaultR1Definitions();
  addLegacyDefinitions(definitions, options.migratedAt);
  const warnings: string[] = [];
  const stageEventsByApplication = new Map<string, StageEvent[]>();
  const outcomeEventsByApplication = new Map<string, OutcomeEvent[]>();
  for (const event of source.stageEvents) {
    if (!stageEventsByApplication.has(event.applicationId)) stageEventsByApplication.set(event.applicationId, []);
    stageEventsByApplication.get(event.applicationId)!.push(event);
  }
  for (const event of source.outcomeEvents) {
    if (!outcomeEventsByApplication.has(event.applicationId)) outcomeEventsByApplication.set(event.applicationId, []);
    outcomeEventsByApplication.get(event.applicationId)!.push(event);
  }

  const progressRecords: ProgressRecord[] = [];
  const applications: ApplicationV2[] = [];
  const legacyHistory: LegacyHistoryRecord[] = [];
  for (const application of source.applications) {
    const rawStages = stageEventsByApplication.get(application.id) ?? [];
    const rawOutcomes = outcomeEventsByApplication.get(application.id) ?? [];
    const stageSources = rawStages.map((raw, index) => { validateDate(raw.occurredOn); validateInstant(raw.createdAt); if (raw.supersededAt) validateInstant(raw.supersededAt); return mapSourceEvent('stage', raw, index); });
    const outcomeSources = rawOutcomes.map((raw, index) => { validateDate(raw.occurredOn); validateInstant(raw.createdAt); if (raw.supersededAt) validateInstant(raw.supersededAt); return mapSourceEvent('outcome', raw, index); });
    const latestActiveOutcome = [...outcomeSources].filter(item => !item.raw.supersededAt).at(-1);
    const finalOutcomeId = latestActiveOutcome && latestActiveOutcome.terminalOutcome === (application.outcome === 'rejected' ? 'failed' : application.outcome === 'offer' ? 'offer_received' : application.outcome) ? latestActiveOutcome.raw.id : undefined;
    const merged = mergeSourceEvents(stageSources, outcomeSources, finalOutcomeId);
    const progressEvents: ProgressEvent[] = [];
    let priorActive: ProgressEvent | null = null;
    let activeSequence = 0;
    merged.ordered.forEach((item, index) => {
      const status = definitions.statuses.find(candidate => candidate.id === item.statusId);
      if (!status) throw new DomainError('BACKUP_INCOMPATIBLE', `迁移状态不存在：${item.statusId}`);
      const revision = status.semanticsHistory.at(-1)!;
      const stage = revision.stageId === null ? null : definitions.stages.find(candidate => candidate.id === revision.stageId)!;
      const active = !item.raw.supersededAt;
      if (active) activeSequence += 1;
      const contextStageId = item.stageId === null && item.semantic !== 'submitted' ? priorActive?.semantics.stageId ?? priorActive?.contextStageId ?? null : null;
      const event: ProgressEvent = {
        id: item.raw.id,
        applicationId: application.id,
        commandId: `migration:${item.kind}:${item.raw.id}`,
        statusId: item.statusId,
        statusNameSnapshot: status.name,
        definitionVersion: status.version,
        semantics: { semantic: revision.semantic, stageId: revision.stageId, stageCategory: revision.stageCategory, stageNameSnapshot: stage?.name ?? null, countsAsInterview: revision.countsAsInterview, statisticsCategory: revision.statisticsCategory, terminalOutcome: item.terminalOutcome },
        phase: 'unknown',
        occurredOn: item.raw.occurredOn,
        createdAt: item.raw.createdAt,
        sequence: active ? activeSequence : index + 1,
        previousEventId: active ? priorActive?.id ?? null : null,
        visitId: `legacy-visit:${item.raw.id}`,
        source: 'entered',
        visitAction: 'new',
        insertedBeforeEventId: null,
        reopenReason: null,
        reopensEventId: null,
        correctionOfEventId: null,
        failedAt: item.semantic === 'failed' ? 'unknown' : null,
        contextStageId,
        notes: '',
        invalidatedAt: item.raw.supersededAt,
        migrationMeta: { legacyKind: item.kind, legacyEventId: item.raw.id, ...(item.kind === 'stage' && (item.raw as StageEvent).source ? { legacySource: (item.raw as StageEvent).source } : {}), ...(item.stageId === null ? {} : { legacyReached: true }), ...(active && priorActive && reopenableLegacyOutcomes.has(priorActive.semantics.terminalOutcome) ? { legacyContinuationOfEventId: priorActive.id } : {}), rawEvent: copy(item.raw) as unknown as Record<string, unknown> },
      };
      progressEvents.push(event);
      if (active) priorActive = event;
    });
    const sourceSubmitted = progressEvents.find(event => event.invalidatedAt === null && event.semantics.semantic === 'submitted');
    if ((sourceSubmitted?.occurredOn ?? null) !== application.appliedOn) throw new DomainError('BACKUP_INCOMPATIBLE', `投递 ${application.id} 的投递日期与旧历史不一致；原数据已保留，请先修复旧记录`);
    if (application.appliedOn !== null) validateDate(application.appliedOn);
    const uncertainEdges = merged.uncertainPairs.map(([from, to]) => ({ fromEventId: from.raw.id, toEventId: to.raw.id, reason: from.raw.occurredOn === to.raw.occurredOn ? '同一业务日期的两个历史流无法判断先后' : '旧数组顺序与发生日期存在冲突' }));
    const activeSequenceEvents = progressEvents.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
    for (let index = 1; index < activeSequenceEvents.length; index += 1) {
      const prior = activeSequenceEvents[index - 1]!, next = activeSequenceEvents[index]!;
      if (next.migrationMeta?.legacyContinuationOfEventId === prior.id) uncertainEdges.push({ fromEventId: prior.id, toEventId: next.id, reason: '旧模型未记录明确的重新开启动作' });
    }
    if (uncertainEdges.length) warnings.push(`投递 ${application.id} 有 ${uncertainEdges.length} 条历史连接待确认`);
    const record: ProgressRecord = {
      applicationId: application.id,
      appliedOn: application.appliedOn,
      events: progressEvents,
      annotations: [],
      migrationReview: { status: uncertainEdges.length ? 'needs_confirmation' : 'confirmed', uncertainEdges },
    };
    progressRecords.push(record);

    const lastActive = [...progressEvents].filter(event => event.invalidatedAt === null).at(-1) ?? null;
    const desiredStatusId = application.outcome === 'active'
      ? (lastActive?.statusId === 'legacy_active' ? 'legacy_active' : application.currentStage === 'draft' ? 'draft' : oldStageMapping(application.currentStage).statusId)
      : oldOutcomeMapping(application.outcome).statusId;
    if (lastActive?.statusId !== desiredStatusId && !(lastActive === null && desiredStatusId === 'draft')) {
      throw new DomainError('BACKUP_INCOMPATIBLE', `投递 ${application.id} 的当前状态与旧历史不一致；原数据已保留，请先修复旧记录`);
    }
    if (lastActive?.semantics.semantic === 'failed') warnings.push(`投递 ${application.id} 的失败环节保留为未知，可在新版中确认`);
    const projectedOutcome = lastActive?.semantics.terminalOutcome ?? 'active';
    const projectedStageId = lastActive?.semantics.stageId ?? lastActive?.contextStageId ?? null;
    applications.push({
      ...copy(application),
      currentStage: projectedStageId,
      currentStatusId: lastActive?.statusId ?? 'draft',
      trackingUrl: '',
      phase: lastActive?.phase ?? 'unknown',
      outcome: projectedOutcome,
      failedAt: lastActive?.failedAt ?? null,
      currentEventId: lastActive?.id ?? null,
    });
    legacyHistory.push({ applicationId: application.id, stageEvents: copy(rawStages), outcomeEvents: copy(rawOutcomes), orderStatus: uncertainEdges.length ? 'needs_confirmation' : 'confirmed', uncertainEventIds: [...new Set(uncertainEdges.flatMap(edge => [edge.fromEventId, edge.toEventId]))] });
  }

  const orphanIds = [...new Set([...source.stageEvents, ...source.outcomeEvents].map(event => event.applicationId).filter(id => !source.applications.some(application => application.id === id)))];
  if (orphanIds.length) throw new DomainError('BACKUP_INCOMPATIBLE', `旧历史引用不存在的投递：${orphanIds.join(', ')}`);
  const migrated: DataSnapshotV2 = {
    schemaVersion: 2,
    workspace: copy(source.workspace),
    seasons: copy(source.seasons),
    channels: copy(source.channels),
    settings: { ...copy(source.settings), schemaVersion: 2 },
    applications,
    schedules: copy(source.schedules),
    definitions,
    progressRecords,
    legacyHistory,
    migration: { sourceSchemaVersion: 1, migratedAt: options.migratedAt, warnings },
  };
  validateV2Snapshot(migrated);
  return migrated;
}
