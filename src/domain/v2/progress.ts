import { DomainError, requireRule } from '../errors.js';
import { validateDate, validateInstant } from '../validation.js';
import type { ProgressEvent, ProgressPhase, ProgressProjection, ProgressRecord, ProgressSemanticsSnapshot, ProgressView, ProgressVisit, R1DefinitionsSnapshot, StageCellProjection, StatusDefinition, TerminalOutcome } from './types.js';
import { validateDefinitions } from './definitions.js';

export interface AppendProgressInput {
  commandId: string;
  statusId: string;
  occurredOn: string;
  phase?: ProgressPhase;
  mode?: 'new_visit' | 'continue_visit' | 'reopen' | 'backfill';
  /** Required for backfill; optional for a backdated explicit reopen. */
  beforeEventId?: string;
  /** A backfilled phase update can join the visit of the immediately preceding event. */
  continueVisit?: boolean;
  failedAt?: { stageId: string } | 'unknown';
  contextStageId?: string | null;
  reopenReason?: string;
  notes?: string;
}

export type CorrectProgressInput = Omit<AppendProgressInput, 'mode' | 'beforeEventId' | 'continueVisit'>;
export interface ProgressCommandContext { now: string; id: () => string }
export interface AppendProgressResult { record: ProgressRecord; event: ProgressEvent; duplicate: boolean }
export interface CorrectProgressResult extends AppendProgressResult { correctedEventId: string }
export interface AddStageAnnotationInput { commandId: string; stageId: string; notes?: string }
export interface AddStageAnnotationResult { record: ProgressRecord; annotation: ProgressRecord['annotations'][number]; duplicate: boolean }

const reopenableOutcomes = new Set<TerminalOutcome>(['failed', 'offer_accepted', 'offer_declined', 'withdrawn']);
const terminalFor = (semantic: StatusDefinition['semantic']): TerminalOutcome => {
  if (semantic === 'offer_received' || semantic === 'offer_accepted' || semantic === 'offer_declined' || semantic === 'failed' || semantic === 'withdrawn') return semantic;
  return 'active';
};
const sourceForMode = (mode: NonNullable<AppendProgressInput['mode']>): ProgressEvent['source'] => ({ new_visit: 'entered', continue_visit: 'continued', reopen: 'reopened', backfill: 'backfilled' } satisfies Record<NonNullable<AppendProgressInput['mode']>, ProgressEvent['source']>)[mode];
const modeForSource = (source: ProgressEvent['source']): NonNullable<AppendProgressInput['mode']> => ({ entered: 'new_visit', continued: 'continue_visit', reopened: 'reopen', backfilled: 'backfill' } satisfies Record<ProgressEvent['source'], NonNullable<AppendProgressInput['mode']>>)[source];
const requestKey = (input: AppendProgressInput, defaultPhase: ProgressPhase = 'unknown', correctionOfEventId: string | null = null) => JSON.stringify({
  statusId: input.statusId,
  occurredOn: input.occurredOn,
  phase: input.phase ?? defaultPhase,
  mode: input.mode ?? 'new_visit',
  beforeEventId: input.beforeEventId ?? null,
  continueVisit: input.continueVisit ?? false,
  failedAt: input.failedAt === 'unknown' ? 'unknown' : input.failedAt?.stageId ?? null,
  contextStageId: input.contextStageId ?? null,
  reopenReason: input.reopenReason ?? '',
  notes: input.notes ?? '',
  correctionOfEventId,
});
const storedRequest = (event: ProgressEvent) => requestKey({
  commandId: event.commandId,
  statusId: event.statusId,
  occurredOn: event.occurredOn,
  phase: event.phase,
  mode: modeForSource(event.source),
  ...(event.insertedBeforeEventId ? { beforeEventId: event.insertedBeforeEventId } : {}),
  continueVisit: event.visitAction === 'continue' && event.source === 'backfilled',
  ...(event.failedAt === 'unknown' ? { failedAt: 'unknown' as const } : typeof event.failedAt === 'object' && event.failedAt !== null ? { failedAt: { stageId: event.failedAt.stageId } } : {}),
  contextStageId: event.contextStageId,
  reopenReason: event.reopenReason ?? '',
  notes: event.notes,
}, event.phase, event.correctionOfEventId);

function semanticsFor(status: StatusDefinition, definitions: R1DefinitionsSnapshot): ProgressSemanticsSnapshot {
  const revision = status.semanticsHistory.find(item => item.version === status.version)!;
  const stage = revision.stageId === null ? null : definitions.stages.find(item => item.id === revision.stageId)!;
  return {
    semantic: revision.semantic,
    stageId: revision.stageId,
    stageCategory: revision.stageCategory,
    stageNameSnapshot: stage?.name ?? null,
    countsAsInterview: revision.countsAsInterview,
    statisticsCategory: revision.statisticsCategory,
    terminalOutcome: terminalFor(revision.semantic),
  };
}

function failureSnapshot(input: AppendProgressInput | CorrectProgressInput, status: StatusDefinition, definitions: R1DefinitionsSnapshot) {
  if (status.semantic !== 'failed') {
    requireRule(input.failedAt === undefined, '只有挂掉状态可以记录失败归因');
    return null;
  }
  requireRule(input.failedAt !== undefined, '挂掉必须选择失败环节，未知时选择“环节未知”');
  if (input.failedAt === 'unknown') {
    requireRule(status.stageId === null, '已指定失败环节的状态不能选择“环节未知”');
    return 'unknown' as const;
  }
  const failure = input.failedAt;
  const stage = definitions.stages.find(item => item.id === failure.stageId);
  requireRule(!!stage, '失败环节不存在');
  requireRule(status.stageId === null || status.stageId === stage.id, '失败归因环节必须与所选状态一致');
  return { stageId: stage.id, stageNameSnapshot: stage.name };
}

function normalizeActive(record: ProgressRecord): ProgressEvent[] {
  const active = record.events.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
  active.forEach((event, index) => {
    event.sequence = index + 1;
    event.previousEventId = index === 0 ? null : active[index - 1]!.id;
  });
  return active;
}

function syncAppliedOn(record: ProgressRecord): void {
  const submitted = record.events.find(event => event.invalidatedAt === null && event.semantics.semantic === 'submitted');
  record.appliedOn = submitted?.occurredOn ?? null;
}

export function createProgressRecord(applicationId: string): ProgressRecord {
  requireRule(!!applicationId, '投递 ID 必填');
  return { applicationId, appliedOn: null, events: [], annotations: [] };
}

export function validateProgressRecord(record: ProgressRecord, definitions: R1DefinitionsSnapshot): void {
  validateDefinitions(definitions);
  requireRule(!!record.applicationId, '投递 ID 必填');
  if (record.appliedOn !== null) validateDate(record.appliedOn);
  const ids = new Set<string>(), commands = new Set<string>();
  const stageIds = new Set(definitions.stages.map(stage => stage.id));
  for (const annotation of record.annotations) {
    requireRule(!!annotation.id && !ids.has(annotation.id) && annotation.applicationId === record.applicationId, '环节注记关联或 ID 无效'); ids.add(annotation.id);
    requireRule(!!annotation.commandId && !commands.has(annotation.commandId) && stageIds.has(annotation.stageId) && annotation.kind === 'skipped', '环节注记内容或命令 ID 无效'); commands.add(annotation.commandId);
    validateInstant(annotation.createdAt); if (annotation.invalidatedAt !== null) validateInstant(annotation.invalidatedAt);
  }
  const eventById = new Map(record.events.map(event => [event.id, event]));
  for (const event of record.events) {
    requireRule(!!event.id && !ids.has(event.id) && event.applicationId === record.applicationId, '进度事件 ID 或投递关联无效'); ids.add(event.id);
    requireRule(!!event.commandId.trim() && !commands.has(event.commandId), '一个 commandId 只能创建一个事件或注记'); commands.add(event.commandId);
    requireRule(!!event.statusNameSnapshot.trim(), '事件状态名称快照不能为空');
    if (event.migrationMeta) {
      requireRule(['stage', 'outcome'].includes(event.migrationMeta.legacyKind) && !!event.migrationMeta.legacyEventId && typeof event.migrationMeta.rawEvent === 'object' && event.migrationMeta.rawEvent !== null, '迁移事件来源快照无效');
      requireRule(event.migrationMeta.legacyReached === undefined || typeof event.migrationMeta.legacyReached === 'boolean', '迁移触达标记无效');
      requireRule(event.migrationMeta.legacyContinuationOfEventId === undefined || eventById.has(event.migrationMeta.legacyContinuationOfEventId), '迁移续接事件引用无效');
    }
    requireRule(['entered', 'continued', 'reopened', 'backfilled'].includes(event.source), '事件来源无效');
    requireRule(Number.isSafeInteger(event.sequence) && event.sequence > 0 && !!event.visitId, '事件顺序或 visitId 无效');
    validateDate(event.occurredOn); validateInstant(event.createdAt); if (event.invalidatedAt !== null) validateInstant(event.invalidatedAt);
    const stage = event.semantics.stageId === null ? null : definitions.stages.find(item => item.id === event.semantics.stageId);
    requireRule(event.semantics.stageId === null || (!!stage && !!event.semantics.stageNameSnapshot?.trim()), '事件引用的环节快照无效');
    requireRule(event.semantics.stageId !== null || event.semantics.stageNameSnapshot === null, '无环节事件不能包含环节名称快照');
    requireRule(event.contextStageId === null || stageIds.has(event.contextStageId), '上下文环节不存在');
    const definition = definitions.statuses.find(status => status.id === event.statusId);
    requireRule(!!definition, '事件引用的状态定义不存在');
    const revision = definition.semanticsHistory.find(item => item.version === event.definitionVersion);
    requireRule(!!revision, '事件状态版本不存在');
    requireRule(event.semantics.semantic === revision.semantic && event.semantics.stageId === revision.stageId && event.semantics.stageCategory === revision.stageCategory && event.semantics.countsAsInterview === revision.countsAsInterview && event.semantics.statisticsCategory === revision.statisticsCategory && event.semantics.terminalOutcome === terminalFor(revision.semantic), '事件语义快照与其状态版本不一致');
    requireRule(event.semantics.stageId === null || stageIds.has(event.semantics.stageId), '事件引用的环节定义不存在');
    requireRule(event.semantics.stageId === null ? event.phase === 'unknown' : event.phase === revision.defaultPhase, '阶段结果必须与所选状态定义一致');
    if (event.source === 'continued') requireRule(event.visitAction === 'continue', '继续事件必须标记为同一 visit');
    else if (event.source === 'backfilled') requireRule(event.visitAction === 'new' || event.visitAction === 'continue', '补录 visit 类型无效');
    else requireRule(event.visitAction === 'new', '普通进入或重新开启必须创建新 visit');
    if (event.source !== 'backfilled' && event.source !== 'reopened') requireRule(event.insertedBeforeEventId === null, '非补录事件不能指定后续锚点');
    requireRule(event.semantics.semantic === 'failed' ? event.failedAt !== null : event.failedAt === null, '失败事件必须明确记录 failedAt，其他事件不可带失败归因');
    if (typeof event.failedAt === 'object' && event.failedAt !== null) {
      const failedCause = event.failedAt;
      const failedStage = definitions.stages.find(item => item.id === failedCause.stageId);
      requireRule(!!failedStage && !!failedCause.stageNameSnapshot.trim(), '失败环节快照无效');
      requireRule(event.semantics.stageId === null || event.semantics.stageId === failedStage.id, '失败归因与状态环节不一致');
    }
    if (event.source === 'reopened') {
      const reopened = event.reopensEventId ? eventById.get(event.reopensEventId) : undefined;
      requireRule(!!event.reopenReason?.trim() && !!reopened && reopenableOutcomes.has(reopened.semantics.terminalOutcome), '重新开启必须记录原因并关联结束事件');
      if (event.invalidatedAt === null) requireRule(reopened.invalidatedAt === null && reopened.id === event.previousEventId, '有效重新开启必须紧接有效结束事件');
    } else requireRule(event.reopenReason === null && event.reopensEventId === null, '只有重新开启事件可以记录开启原因');
    requireRule(event.correctionOfEventId === null || (event.correctionOfEventId !== event.id && eventById.has(event.correctionOfEventId)), '纠正事件引用的原事件不存在');
    requireRule(event.insertedBeforeEventId === null || eventById.has(event.insertedBeforeEventId), '补录锚点事件不存在');
  }

  const active = record.events.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
  const uncertainEdges = record.migrationReview?.uncertainEdges ?? [];
  requireRule(!record.migrationReview || ['confirmed', 'needs_confirmation'].includes(record.migrationReview.status), '迁移审核状态无效');
  const edgeKeys = new Set<string>();
  for (const edge of uncertainEdges) {
    const key = `${edge.fromEventId}\0${edge.toEventId}`;
    requireRule(!!edge.fromEventId && !!edge.toEventId && edge.fromEventId !== edge.toEventId && !!edge.reason && !edgeKeys.has(key) && eventById.has(edge.fromEventId) && eventById.has(edge.toEventId), '不确定历史连接无效');
    edgeKeys.add(key);
  }
  requireRule(new Set(active.map(event => event.sequence)).size === active.length, '有效事件顺序不能重复');
  active.forEach((event, index) => {
    requireRule(event.sequence === index + 1, '有效事件顺序必须连续');
    requireRule(event.previousEventId === (index === 0 ? null : active[index - 1]!.id), '事件链连接与显式顺序不一致');
    if (index > 0) {
      const previous = active[index - 1]!;
      const uncertain = edgeKeys.has(`${previous.id}\0${event.id}`);
      requireRule(event.occurredOn >= previous.occurredOn || uncertain, '进度日期需按事件发生顺序排列；早期记录请使用补录命令');
    }
    if (event.visitAction === 'continue') requireRule(index > 0 && event.visitId === active[index - 1]!.visitId && event.semantics.stageId !== null && event.semantics.stageId === active[index - 1]!.semantics.stageId && active[index - 1]!.semantics.terminalOutcome === 'active', '继续 visit 必须复用同一进行中环节');
    else requireRule(!active.slice(0, index).some(previous => previous.visitId === event.visitId), '重新进入同一状态必须创建新的 visit');
  });
  const submitted = active.filter(event => event.semantics.semantic === 'submitted');
  requireRule(submitted.length <= 1, '一个投递只能有一个有效的首次投递事件');
  requireRule((submitted[0]?.occurredOn ?? null) === record.appliedOn, '投递日期必须与首次有效已投递事件一致');

  let pendingOffers = 0;
  for (const [index, event] of active.entries()) {
    const outcome = event.semantics.terminalOutcome;
    if (event.semantics.semantic === 'offer_received') pendingOffers += 1;
    if (outcome === 'offer_accepted' || outcome === 'offer_declined') {
      requireRule(pendingOffers > 0, '接受或拒绝 Offer 前必须有尚未决定的有效 Offer');
      pendingOffers -= 1;
    }
    if (outcome === 'withdrawn') pendingOffers = 0;
    if (reopenableOutcomes.has(outcome) && index < active.length - 1) {
      const next = active[index + 1]!;
      const legacyContinuation = next.migrationMeta?.legacyContinuationOfEventId === event.id
        && event.migrationMeta?.legacyKind === 'outcome'
        && next.migrationMeta !== undefined
        && next.semantics.terminalOutcome === 'active';
      requireRule((next.source === 'reopened' && next.reopensEventId === event.id) || legacyContinuation, '结束后继续流程必须显式重新开启');
    }
  }
  const activeAnnotations = record.annotations.filter(annotation => annotation.invalidatedAt === null);
  const skippedStages = new Set(activeAnnotations.map(annotation => annotation.stageId));
  requireRule(skippedStages.size === activeAnnotations.length, '同一环节只能有一条有效跳过注记');
  requireRule(!active.some(event => event.semantics.stageId !== null && skippedStages.has(event.semantics.stageId)), '已记录实际经历的环节不能同时标记跳过');
}

export function appendProgressEvent(recordInput: ProgressRecord, definitions: R1DefinitionsSnapshot, input: AppendProgressInput, context: ProgressCommandContext): AppendProgressResult {
  const record = structuredClone(recordInput);
  validateProgressRecord(record, definitions);
  requireRule(!!input.commandId.trim(), 'commandId 必填');
  const duplicate = record.events.find(event => event.commandId === input.commandId);
  if (duplicate) {
    const retry = { ...input, contextStageId: input.contextStageId === undefined ? duplicate.contextStageId : input.contextStageId };
    if (requestKey(retry, duplicate.phase) !== storedRequest(duplicate)) throw new DomainError('CONFLICT', '同一 commandId 不可用于不同请求');
    return { record, event: structuredClone(duplicate), duplicate: true };
  }
  validateDate(input.occurredOn); validateInstant(context.now);
  const status = definitions.statuses.find(item => item.id === input.statusId);
  if (!status) throw new DomainError('NOT_FOUND', '状态不存在');
  requireRule(status.archivedAt === null, '归档状态不能用于新记录');
  const semantics = semanticsFor(status, definitions);
  const stage = semantics.stageId === null ? null : definitions.stages.find(item => item.id === semantics.stageId)!;
  requireRule(!stage || stage.archivedAt === null, '归档环节不能用于新记录');
  requireRule(!record.annotations.some(annotation => annotation.invalidatedAt === null && annotation.stageId === status.stageId), '该环节已标记跳过，请先移除跳过注记');
  const phase = input.phase ?? status.defaultPhase;
  requireRule(['unknown', 'waiting', 'in_progress', 'awaiting_result', 'passed'].includes(phase), '阶段结果无效');
  requireRule(semantics.stageId === null ? phase === 'unknown' : phase === status.defaultPhase, '阶段结果必须与所选状态定义一致');
  const mode = input.mode ?? 'new_visit';
  if (input.continueVisit !== undefined) requireRule(mode === 'backfill', 'continueVisit 只可用于补录');
  const active = record.events.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
  let insertIndex = active.length;
  if (mode === 'backfill' || (mode === 'reopen' && input.beforeEventId !== undefined)) {
    requireRule(!!input.beforeEventId, '补录或回溯重新开启需要指定后续事件');
    insertIndex = active.findIndex(event => event.id === input.beforeEventId);
    requireRule(insertIndex >= 0, '补录锚点事件不存在');
    requireRule(insertIndex === 0 || active[insertIndex - 1]!.occurredOn <= input.occurredOn, '补录日期早于前一个事件');
    requireRule(input.occurredOn <= active[insertIndex]!.occurredOn, '补录日期晚于指定锚点');
  } else requireRule(input.beforeEventId === undefined, '只有补录或回溯重新开启可以指定后续事件');
  const previous = active[insertIndex - 1] ?? null;
  const failedAt = failureSnapshot(input, status, definitions);
  const reopens = mode === 'reopen';
  if (reopens) {
    requireRule(!!previous && reopenableOutcomes.has(previous.semantics.terminalOutcome), '重新开启必须紧接失败、接受/拒绝 Offer 或主动退出');
    requireRule(!!input.reopenReason?.trim(), '重新开启必须记录原因');
    requireRule(!reopenableOutcomes.has(semantics.terminalOutcome), '重新开启必须选择新的有效状态');
  } else requireRule(input.reopenReason === undefined, '只有重新开启时可以记录开启原因');
  if (mode === 'continue_visit' || (mode === 'backfill' && input.continueVisit)) {
    requireRule(!!previous && semantics.stageId !== null && previous.semantics.stageId === semantics.stageId, '继续 visit 必须属于同一实际环节');
    requireRule(previous.semantics.terminalOutcome === 'active', '终态 visit 不能继续');
  }
  if (status.semantic === 'submitted') requireRule(!active.some(event => event.semantics.semantic === 'submitted'), '已有首次投递事件，不能重复标记已投递');
  const priorOffers = active.slice(0, insertIndex);
  let pendingOffers = 0;
  for (const event of priorOffers) {
    if (event.semantics.semantic === 'offer_received') pendingOffers += 1;
    else if (event.semantics.semantic === 'offer_accepted' || event.semantics.semantic === 'offer_declined') pendingOffers -= 1;
    else if (event.semantics.semantic === 'withdrawn') pendingOffers = 0;
  }
  if (status.semantic === 'offer_accepted' || status.semantic === 'offer_declined') requireRule(pendingOffers > 0, '接受或拒绝 Offer 前必须有尚未决定的有效 Offer');

  const visitAction = mode === 'continue_visit' || (mode === 'backfill' && !!input.continueVisit) ? 'continue' : 'new';
  const contextStageId = input.contextStageId === undefined ? (status.stageId === null ? previous?.semantics.stageId ?? previous?.contextStageId ?? null : null) : input.contextStageId;
  requireRule(contextStageId === null || definitions.stages.some(item => item.id === contextStageId), '上下文环节不存在');
  const event: ProgressEvent = {
    id: context.id(), applicationId: record.applicationId, commandId: input.commandId, statusId: status.id, statusNameSnapshot: status.name,
    definitionVersion: status.version, semantics, phase, occurredOn: input.occurredOn, createdAt: context.now,
    sequence: insertIndex + 1, previousEventId: previous?.id ?? null,
    visitId: visitAction === 'continue' ? previous!.visitId : context.id(), source: sourceForMode(mode), visitAction,
    insertedBeforeEventId: input.beforeEventId ?? null, reopenReason: reopens ? input.reopenReason!.trim() : null, reopensEventId: reopens ? previous!.id : null,
    correctionOfEventId: null, failedAt, contextStageId, notes: input.notes ?? '', invalidatedAt: null,
  };
  record.events.push(event);
  const activeWithInserted = [...active.slice(0, insertIndex), event, ...active.slice(insertIndex)];
  activeWithInserted.forEach((candidate, index) => { candidate.sequence = index + 1; candidate.previousEventId = index === 0 ? null : activeWithInserted[index - 1]!.id; });
  if (semantics.semantic === 'submitted') record.appliedOn = event.occurredOn;
  validateProgressRecord(record, definitions);
  return { record, event: structuredClone(event), duplicate: false };
}

/** Replaces an event in its exact logical position and keeps the rejected fact as invalidated history. */
export function correctProgressEvent(recordInput: ProgressRecord, definitions: R1DefinitionsSnapshot, eventId: string, input: CorrectProgressInput, context: ProgressCommandContext): CorrectProgressResult {
  const record = structuredClone(recordInput);
  validateProgressRecord(record, definitions);
  requireRule(!!input.commandId.trim(), 'commandId 必填');
  const duplicate = record.events.find(event => event.commandId === input.commandId);
  if (duplicate) {
    if (duplicate.correctionOfEventId !== eventId) throw new DomainError('CONFLICT', '同一 commandId 不可用于不同纠正');
    const sourceMode = modeForSource(duplicate.source);
    const retry: AppendProgressInput = { ...input, contextStageId: input.contextStageId === undefined ? duplicate.contextStageId : input.contextStageId, mode: sourceMode, ...(duplicate.insertedBeforeEventId ? { beforeEventId: duplicate.insertedBeforeEventId } : {}), continueVisit: duplicate.source === 'backfilled' && duplicate.visitAction === 'continue' };
    if (requestKey(retry, duplicate.phase, eventId) !== storedRequest(duplicate)) throw new DomainError('CONFLICT', '同一 commandId 不可用于不同请求');
    return { record, event: structuredClone(duplicate), duplicate: true, correctedEventId: eventId };
  }
  validateInstant(context.now); validateDate(input.occurredOn);
  const target = record.events.find(event => event.id === eventId && event.invalidatedAt === null);
  if (!target) throw new DomainError('NOT_FOUND', '有效待纠正事件不存在');
  const status = definitions.statuses.find(item => item.id === input.statusId);
  if (!status) throw new DomainError('NOT_FOUND', '替代状态不存在');
  const semantics = semanticsFor(status, definitions);
  const phase = input.phase ?? status.defaultPhase;
  requireRule(semantics.stageId === null ? phase === 'unknown' : phase === status.defaultPhase, '阶段结果必须与所选状态定义一致');
  const failedAt = failureSnapshot(input, status, definitions);
  const dependentReopen = record.events.find(event => event.invalidatedAt === null && event.source === 'reopened' && event.reopensEventId === target.id);
  if (dependentReopen && !reopenableOutcomes.has(semantics.terminalOutcome)) throw new DomainError('VALIDATION', '该结束事件已有后续重新开启；需先纠正后续开启事件，再移除结束状态');
  if (target.source === 'reopened' && reopenableOutcomes.has(semantics.terminalOutcome)) throw new DomainError('VALIDATION', '重新开启事件必须保持为进行中的状态');
  const contextStageId = input.contextStageId === undefined ? target.contextStageId : input.contextStageId;
  requireRule(contextStageId === null || definitions.stages.some(stage => stage.id === contextStageId), '上下文环节不存在');
  const index = target.sequence - 1;
  const replacement: ProgressEvent = {
    ...structuredClone(target),
    id: context.id(), commandId: input.commandId, statusId: status.id, statusNameSnapshot: status.name,
    definitionVersion: status.version, semantics, phase, occurredOn: input.occurredOn, createdAt: context.now,
    failedAt, contextStageId, reopenReason: target.source === 'reopened' ? (input.reopenReason ?? target.reopenReason) : null,
    correctionOfEventId: target.id, notes: input.notes ?? '', invalidatedAt: null,
  };
  if (replacement.source === 'reopened') {
    requireRule(!!replacement.reopenReason?.trim(), '重新开启必须记录原因');
    requireRule(!reopenableOutcomes.has(replacement.semantics.terminalOutcome), '重新开启事件必须保持为进行中的状态');
  }
  else requireRule(input.reopenReason === undefined, '只有重新开启时可以记录开启原因');
  target.invalidatedAt = context.now;
  record.events.push(replacement);
  if (reopenableOutcomes.has(replacement.semantics.terminalOutcome)) {
    for (const event of record.events) if (event.invalidatedAt === null && event.source === 'reopened' && event.reopensEventId === target.id) event.reopensEventId = replacement.id;
  }
  const active = normalizeActive(record);
  const actualIndex = active.findIndex(event => event.id === replacement.id);
  requireRule(actualIndex === index, '纠正必须保留原事件顺序');
  syncAppliedOn(record);
  validateProgressRecord(record, definitions);
  return { record, event: structuredClone(replacement), duplicate: false, correctedEventId: eventId };
}

export function addStageAnnotation(recordInput: ProgressRecord, definitions: R1DefinitionsSnapshot, input: AddStageAnnotationInput, context: ProgressCommandContext): AddStageAnnotationResult {
  const record = structuredClone(recordInput); validateProgressRecord(record, definitions);
  const duplicate = record.annotations.find(annotation => annotation.commandId === input.commandId);
  if (duplicate) {
    if (duplicate.stageId !== input.stageId || duplicate.notes !== (input.notes ?? '')) throw new DomainError('CONFLICT', '同一 commandId 不可用于不同请求');
    return { record, annotation: structuredClone(duplicate), duplicate: true };
  }
  if (record.events.some(event => event.commandId === input.commandId)) throw new DomainError('CONFLICT', 'commandId 已被进度事件使用');
  validateInstant(context.now);
  requireRule(!!input.commandId.trim(), 'commandId 必填');
  requireRule(!record.events.some(event => event.invalidatedAt === null && event.semantics.stageId === input.stageId), '已有实际经历时不能标记跳过');
  requireRule(!record.annotations.some(annotation => annotation.invalidatedAt === null && annotation.stageId === input.stageId), '该环节已经标记跳过');
  requireRule(definitions.stages.some(stage => stage.id === input.stageId), '环节不存在');
  const annotation = { id: context.id(), applicationId: record.applicationId, commandId: input.commandId, stageId: input.stageId, kind: 'skipped' as const, notes: input.notes ?? '', createdAt: context.now, invalidatedAt: null };
  record.annotations.push(annotation); validateProgressRecord(record, definitions);
  return { record, annotation: structuredClone(annotation), duplicate: false };
}

export function removeStageAnnotation(recordInput: ProgressRecord, definitions: R1DefinitionsSnapshot, annotationId: string, at: string): ProgressRecord {
  const record = structuredClone(recordInput); validateInstant(at);
  const annotation = record.annotations.find(item => item.id === annotationId && item.invalidatedAt === null);
  if (!annotation) throw new DomainError('NOT_FOUND', '有效环节注记不存在');
  annotation.invalidatedAt = at; validateProgressRecord(record, definitions); return record;
}

/** Invalidate only the selected fact; if dependent facts break, use correctProgressEvent for an atomic replacement. */
export function invalidateProgressEvent(recordInput: ProgressRecord, definitions: R1DefinitionsSnapshot, eventId: string, at: string): ProgressRecord {
  const record = structuredClone(recordInput); validateInstant(at);
  const event = record.events.find(candidate => candidate.id === eventId && candidate.invalidatedAt === null);
  if (!event) throw new DomainError('NOT_FOUND', '有效事件不存在');
  event.invalidatedAt = at;
  const active = normalizeActive(record); syncAppliedOn(record);
  // A record that continued the removed one's visit joins the visit now before it when that is the
  // same, still-open stage (so a mistaken duplicate entry stops counting as a second visit);
  // otherwise it opens the visit itself.
  active.forEach((candidate, index) => {
    if (candidate.visitAction !== 'continue') return;
    const previous = active[index - 1];
    const sameOpenStage = !!previous && candidate.semantics.stageId !== null
      && previous.semantics.stageId === candidate.semantics.stageId && previous.semantics.terminalOutcome === 'active';
    if (sameOpenStage) { candidate.visitId = previous.visitId; return; }
    candidate.visitAction = 'new';
    if (candidate.source === 'continued') candidate.source = 'entered';
  });
  validateProgressRecord(record, definitions);
  return record;
}

export function projectProgress(record: ProgressRecord, definitions: R1DefinitionsSnapshot, now: string): ProgressProjection {
  validateProgressRecord(record, definitions); validateDate(now);
  const events = record.events.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
  const currentEvent = events.at(-1) ?? null;
  const byVisit = new Map<string, ProgressEvent[]>();
  for (const event of events) byVisit.set(event.visitId, [...(byVisit.get(event.visitId) ?? []), event]);
  const visits: ProgressVisit[] = [...byVisit.entries()].map(([id, visitEvents]) => {
    const firstEvent = visitEvents[0]!, lastEvent = visitEvents.at(-1)!;
    const actualInterviewTouch = visitEvents.some(item => item.semantics.countsAsInterview && (item.migrationMeta?.legacyReached === true || ['in_progress', 'awaiting_result', 'passed'].includes(item.phase)));
    const currentStatusName = definitions.statuses.find(status => status.id === lastEvent.statusId)!.name;
    return { id, statusId: lastEvent.statusId, statusName: currentStatusName, statusNameSnapshot: lastEvent.statusNameSnapshot, stageId: lastEvent.semantics.stageId, firstEvent, lastEvent, events: structuredClone(visitEvents), countAsInterview: actualInterviewTouch };
  });
  const annotations = record.annotations.filter(annotation => annotation.invalidatedAt === null);
  const stages: StageCellProjection[] = definitions.stages.filter(stage => stage.archivedAt === null || visits.some(visit => visit.stageId === stage.id) || annotations.some(annotation => annotation.stageId === stage.id)).map(stage => {
    const matching = visits.filter(visit => visit.stageId === stage.id).sort((a, b) => b.lastEvent.sequence - a.lastEvent.sequence);
    const latest = matching[0] ?? null;
    const activeCurrent = currentEvent?.semantics.terminalOutcome === 'active' || currentEvent?.semantics.terminalOutcome === 'offer_received';
    const current = !!currentEvent && !!activeCurrent && latest?.id === currentEvent.visitId;
    const daysInCurrentVisit = current && latest ? Math.max(0, Math.floor((Date.parse(`${now}T00:00:00.000Z`) - Date.parse(`${latest.firstEvent.occurredOn}T00:00:00.000Z`)) / 86_400_000)) : null;
    const stageAnnotations = annotations.filter(annotation => annotation.stageId === stage.id);
    return { stageId: stage.id, stageName: stage.name, visits: matching.length, latest: latest ? structuredClone(latest) : null, daysInCurrentVisit, skipped: stageAnnotations.length > 0, annotationNotes: stageAnnotations.map(annotation => annotation.notes) };
  });
  const view: ProgressView = {
    applicationId: record.applicationId,
    currentEvent: currentEvent ? structuredClone(currentEvent) : null,
    currentStatusName: currentEvent ? definitions.statuses.find(status => status.id === currentEvent.statusId)!.name : null,
    events: structuredClone(events), visits,
    activeVisitCount: currentEvent && (currentEvent.semantics.terminalOutcome === 'active' || currentEvent.semantics.terminalOutcome === 'offer_received') ? 1 : 0,
    offerCount: events.some(event => event.semantics.semantic === 'offer_received') ? 1 : 0,
    failedAt: currentEvent?.semantics.terminalOutcome === 'failed' ? structuredClone(currentEvent.failedAt) : null,
    uncertainEdges: structuredClone(record.migrationReview?.uncertainEdges ?? []),
  };
  return { ...view, stages };
}
