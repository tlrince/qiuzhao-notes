import { DomainError, requireRule } from '../errors.js';
import type { Schedule } from '../types.js';
import { validateDate } from '../validation.js';
import { validateDefinitions } from './definitions.js';
import { projectProgress } from './progress.js';
import type { ApplicationV2 } from './snapshot.js';
import type { FailedAt, ProgressEvent, ProgressPhase, ProgressRecord, R1DefinitionsSnapshot, StageCategory, TerminalOutcome } from './types.js';

export interface ProgressTableFilters {
  currentStatusIds?: readonly string[];
  currentOutcomes?: readonly TerminalOutcome[];
  currentFailureAt?: string | 'unknown' | readonly (string | 'unknown')[];
  /** Match a row if any non-invalidated event in its active history has one of these values. */
  historyStatusIds?: readonly string[];
  historyOutcomes?: readonly TerminalOutcome[];
  minCurrentStayDays?: number;
  maxCurrentStayDays?: number;
}

export interface ProjectProgressTableInput {
  applications: readonly ApplicationV2[];
  progressRecords: readonly ProgressRecord[];
  definitions: R1DefinitionsSnapshot;
  schedules?: readonly Schedule[];
  /** Business date in the workspace time zone; elapsed stays are counted as calendar days. */
  now: string;
  /** User-fixed columns. Active stages with actual history are included automatically. */
  pinnedStageIds?: readonly string[];
  filters?: ProgressTableFilters;
}

export interface ProgressTableColumn {
  id: string;
  name: string;
  category: StageCategory;
  sortOrder: number;
  archived: boolean;
}

export interface ProgressTableVisit {
  id: string;
  enteredOn: string;
  latestOn: string;
  /** Last date with an actual stage touch; waiting-only interview visits remain null. */
  actualOn: string | null;
  durationDays: number | null;
  stayBasis: 'current' | 'last_completed' | 'needs_confirmation' | null;
  events: ProgressEvent[];
}

export interface OfferReceiptProjection {
  receivedEventId: string;
  receivedOn: string;
  statusName: string;
  decision: 'pending' | 'accepted' | 'declined' | 'needs_confirmation';
  decisionEventId: string | null;
  decidedOn: string | null;
}

export interface ProgressTableStageCell {
  stageId: string;
  stageName: string;
  visitCount: number;
  visits: ProgressTableVisit[];
  latestStatusId: string | null;
  latestStatusName: string | null;
  latestPhase: ProgressPhase | null;
  latestOutcome: TerminalOutcome | null;
  latestOccurredOn: string | null;
  latestActualOn: string | null;
  current: boolean;
  stayDays: number | null;
  stayBasis: ProgressTableVisit['stayBasis'];
  skipped: boolean;
  annotationNotes: string[];
  /** Failure conclusions are visible without counting them as actual stage visits. */
  failureEvents: ProgressEvent[];
  /** Offer decisions attach to receipts; they never increase the receipt/visit count. */
  offerReceipts: OfferReceiptProjection[];
}

export interface ProgressTableRow {
  application: ApplicationV2;
  current: {
    statusId: string;
    statusName: string;
    stageId: string | null;
    phase: ProgressPhase;
    outcome: TerminalOutcome;
    failedAt: FailedAt | null;
    occurredOn: string | null;
  };
  currentStayDays: number | null;
  stageCells: Record<string, ProgressTableStageCell>;
  /** Active, effective chain only; invalidated audit events do not affect table filters. */
  events: ProgressEvent[];
  hasHistoricalFailure: boolean;
  nextSchedule: Schedule | null;
  pendingSchedules: Schedule[];
}

export interface ProgressTableProjection {
  columns: ProgressTableColumn[];
  rows: ProgressTableRow[];
}

const terminalOutcomes = new Set<TerminalOutcome>(['active', 'offer_received', 'offer_accepted', 'offer_declined', 'failed', 'withdrawn']);
const activeStayOutcomes = new Set<TerminalOutcome>(['active', 'offer_received']);
const actualPhases = new Set<ProgressPhase>(['in_progress', 'awaiting_result', 'passed']);
const dayMs = 86_400_000;

function dateDistance(from: string, to: string): number | null {
  const distance = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / dayMs;
  return Number.isInteger(distance) && distance >= 0 ? distance : null;
}

function stageForEvent(event: ProgressEvent): string | null {
  if (event.semantics.stageId) return event.semantics.stageId;
  if (event.failedAt !== null && event.failedAt !== 'unknown') return event.failedAt.stageId;
  return event.contextStageId;
}

function isActualStageEvent(event: ProgressEvent): boolean {
  if (event.semantics.terminalOutcome === 'failed' || event.semantics.semantic === 'offer_accepted' || event.semantics.semantic === 'offer_declined') return false;
  if (event.migrationMeta?.legacyReached === true) return true;
  if (event.semantics.semantic === 'screening' || event.semantics.semantic === 'pool' || event.semantics.semantic === 'submitted') return true;
  return actualPhases.has(event.phase);
}

function containsUncertainBoundary(record: ProgressRecord, visitEventIds: Set<string>): boolean {
  return (record.migrationReview?.uncertainEdges ?? []).some(edge => visitEventIds.has(edge.fromEventId) || visitEventIds.has(edge.toEventId));
}

function failedAtKey(value: FailedAt | null): string | null {
  return value === null ? null : value === 'unknown' ? 'unknown' : value.stageId;
}

function failureFilterValues(value: ProgressTableFilters['currentFailureAt']): readonly (string | 'unknown')[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as string | 'unknown'];
}

function sameFailure(a: FailedAt | null, b: FailedAt | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === 'unknown' || b === 'unknown') return a === b;
  return a.stageId === b.stageId && a.stageNameSnapshot === b.stageNameSnapshot;
}

function validateFilters(filters: ProgressTableFilters, definitions: R1DefinitionsSnapshot): void {
  const stageIds = new Set(definitions.stages.map(stage => stage.id));
  const statusIds = new Set(definitions.statuses.map(status => status.id));
  for (const id of filters.currentStatusIds ?? []) requireRule(statusIds.has(id), `当前状态筛选不存在: ${id}`);
  for (const id of filters.historyStatusIds ?? []) requireRule(statusIds.has(id), `历史状态筛选不存在: ${id}`);
  for (const id of failureFilterValues(filters.currentFailureAt)) requireRule(id === 'unknown' || stageIds.has(id), `失败环节筛选不存在: ${id}`);
  for (const outcome of [...(filters.currentOutcomes ?? []), ...(filters.historyOutcomes ?? [])]) requireRule(terminalOutcomes.has(outcome), '结果筛选值无效');
  for (const value of [filters.minCurrentStayDays, filters.maxCurrentStayDays]) {
    if (value !== undefined) requireRule(Number.isSafeInteger(value) && value >= 0, '停留天数筛选必须为非负整数');
  }
  if (filters.minCurrentStayDays !== undefined && filters.maxCurrentStayDays !== undefined) requireRule(filters.minCurrentStayDays <= filters.maxCurrentStayDays, '最小停留天数不能大于最大停留天数');
}

function stageVisitHasRealEntry(stageId: string, events: readonly ProgressEvent[]): boolean {
  return events.some(event => event.semantics.stageId === stageId && event.semantics.terminalOutcome !== 'failed' && event.semantics.semantic !== 'offer_accepted' && event.semantics.semantic !== 'offer_declined');
}

function projectStageVisit(
  visit: { id: string; firstEvent: ProgressEvent; lastEvent: ProgressEvent; events: ProgressEvent[] },
  activeEvents: readonly ProgressEvent[],
  currentEvent: ProgressEvent | null,
  record: ProgressRecord,
  now: string,
): ProgressTableVisit {
  const visitEvents = structuredClone(visit.events);
  const ids = new Set(visitEvents.map(event => event.id));
  const endIndex = activeEvents.findIndex(event => event.id === visit.lastEvent.id);
  const followingEvent = endIndex >= 0 ? activeEvents[endIndex + 1] ?? null : null;
  const current = !!currentEvent && activeStayOutcomes.has(currentEvent.semantics.terminalOutcome) && currentEvent.visitId === visit.id;
  const uncertain = containsUncertainBoundary(record, ids);
  const endedOn = followingEvent?.occurredOn ?? null;
  const durationDays = uncertain ? null : current
    ? dateDistance(visit.firstEvent.occurredOn, now)
    : endedOn === null ? null : dateDistance(visit.firstEvent.occurredOn, endedOn);
  const stayBasis = uncertain ? 'needs_confirmation' : current ? 'current' : endedOn !== null && durationDays !== null ? 'last_completed' : null;
  const actual = visitEvents.filter(isActualStageEvent);
  const actualOn = actual.at(-1)?.occurredOn ?? null;
  return {
    id: visit.id,
    enteredOn: visit.firstEvent.occurredOn,
    latestOn: visit.lastEvent.occurredOn,
    actualOn,
    durationDays,
    stayBasis,
    events: visitEvents,
  };
}

function projectOfferReceipts(events: readonly ProgressEvent[]): OfferReceiptProjection[] {
  const receipts: OfferReceiptProjection[] = [];
  let unresolved: number[] = [];
  for (const event of events) {
    if (event.semantics.semantic === 'offer_received') {
      unresolved.push(receipts.length);
      receipts.push({ receivedEventId: event.id, receivedOn: event.occurredOn, statusName: event.statusNameSnapshot, decision: 'pending', decisionEventId: null, decidedOn: null });
      continue;
    }
    if (event.semantics.semantic !== 'offer_accepted' && event.semantics.semantic !== 'offer_declined') continue;
    if (unresolved.length === 1) {
      const receipt = receipts[unresolved[0]!]!;
      receipt.decision = event.semantics.semantic === 'offer_accepted' ? 'accepted' : 'declined';
      receipt.decisionEventId = event.id;
      receipt.decidedOn = event.occurredOn;
    } else if (unresolved.length > 1) {
      // The event model has no offerId. Never guess which of several outstanding offers was decided.
      for (const index of unresolved) receipts[index]!.decision = 'needs_confirmation';
    }
    unresolved = [];
  }
  return receipts;
}

function emptyCell(stageId: string, stageName: string, skipped = false, annotationNotes: string[] = []): ProgressTableStageCell {
  return {
    stageId, stageName, visitCount: 0, visits: [], latestStatusId: null, latestStatusName: null,
    latestPhase: null, latestOutcome: null, latestOccurredOn: null, latestActualOn: null,
    current: false, stayDays: null, stayBasis: null, skipped, annotationNotes,
    failureEvents: [], offerReceipts: [],
  };
}

function makeStageCell(
  stageId: string,
  stageName: string,
  record: ProgressRecord,
  events: ProgressEvent[],
  visits: ReturnType<typeof projectProgress>['visits'],
  currentEvent: ProgressEvent | null,
  now: string,
): ProgressTableStageCell {
  const stageVisits = visits.filter(visit => visit.stageId === stageId && stageVisitHasRealEntry(stageId, visit.events));
  const projectedVisits = stageVisits.map(visit => projectStageVisit(visit, events, currentEvent, record, now));
  const latestVisit = projectedVisits.at(-1) ?? null;
  const related = events.filter(event => stageForEvent(event) === stageId);
  const latest = related.at(-1) ?? null;
  const latestActualOn = projectedVisits.map(visit => visit.actualOn).filter((date): date is string => date !== null).at(-1) ?? null;
  const current = !!currentEvent && activeStayOutcomes.has(currentEvent.semantics.terminalOutcome) && stageForEvent(currentEvent) === stageId;
  const stageAnnotations = record.annotations.filter(annotation => annotation.invalidatedAt === null && annotation.stageId === stageId);
  const stageDefinition = stageName;
  const cell = emptyCell(stageId, stageDefinition, stageAnnotations.length > 0, stageAnnotations.map(annotation => annotation.notes));
  cell.visitCount = projectedVisits.length;
  cell.visits = projectedVisits;
  cell.latestStatusId = latest?.statusId ?? null;
  cell.latestStatusName = latest?.statusNameSnapshot ?? null;
  cell.latestPhase = latest?.phase ?? null;
  cell.latestOutcome = latest?.semantics.terminalOutcome ?? null;
  cell.latestOccurredOn = latest?.occurredOn ?? null;
  cell.latestActualOn = latestActualOn;
  cell.current = current;
  cell.stayDays = latestVisit?.durationDays ?? null;
  cell.stayBasis = latestVisit?.stayBasis ?? null;
  cell.failureEvents = structuredClone(related.filter(event => event.semantics.terminalOutcome === 'failed'));
  if (stageId === 'offer' || related.some(event => event.semantics.semantic === 'offer_received' || event.semantics.semantic === 'offer_accepted' || event.semantics.semantic === 'offer_declined')) {
    cell.offerReceipts = projectOfferReceipts(events);
    cell.visitCount = cell.offerReceipts.length;
    cell.visits = cell.visits.filter(visit => visit.events.some(event => event.semantics.semantic === 'offer_received'));
  }
  return cell;
}

function matchesFilters(row: ProgressTableRow, filters: ProgressTableFilters): boolean {
  if ((filters.currentStatusIds?.length ?? 0) > 0 && !filters.currentStatusIds!.includes(row.current.statusId)) return false;
  if ((filters.currentOutcomes?.length ?? 0) > 0 && !filters.currentOutcomes!.includes(row.current.outcome)) return false;
  const failureValues = failureFilterValues(filters.currentFailureAt);
  if (failureValues.length > 0 && (row.current.outcome !== 'failed' || !failureValues.includes(failedAtKey(row.current.failedAt) ?? ''))) return false;
  if ((filters.historyStatusIds?.length ?? 0) > 0 && !row.events.some(event => filters.historyStatusIds!.includes(event.statusId))) return false;
  if ((filters.historyOutcomes?.length ?? 0) > 0 && !row.events.some(event => filters.historyOutcomes!.includes(event.semantics.terminalOutcome))) return false;
  if (filters.minCurrentStayDays !== undefined && (row.currentStayDays === null || row.currentStayDays < filters.minCurrentStayDays)) return false;
  if (filters.maxCurrentStayDays !== undefined && (row.currentStayDays === null || row.currentStayDays > filters.maxCurrentStayDays)) return false;
  return true;
}

/** Pure M4a table projection. It never changes the snapshot or generates progress events. */
export function projectProgressTable(input: ProjectProgressTableInput): ProgressTableProjection {
  validateDate(input.now);
  validateDefinitions(input.definitions);
  const filters = input.filters ?? {};
  validateFilters(filters, input.definitions);
  const applications = new Map<string, ApplicationV2>();
  for (const application of input.applications) {
    requireRule(!!application.id && !applications.has(application.id), '投递 ID 必须唯一');
    applications.set(application.id, application);
  }
  const records = new Map<string, ProgressRecord>();
  for (const record of input.progressRecords) {
    requireRule(applications.has(record.applicationId) && !records.has(record.applicationId), '进度记录投递关联无效或重复');
    records.set(record.applicationId, record);
  }
  requireRule(records.size === applications.size, '每个投递都必须有一条进度记录');
  const stages = new Map(input.definitions.stages.map(stage => [stage.id, stage]));
  const pinned = new Set(input.pinnedStageIds ?? []);
  for (const id of pinned) requireRule(stages.has(id), `固定显示的环节不存在: ${id}`);
  const sourceProjections = new Map<string, ReturnType<typeof projectProgress>>();
  const usedStageIds = new Set(pinned);
  for (const [id, application] of applications) {
    const record = records.get(id)!;
    const projection = projectProgress(record, input.definitions, input.now);
    const currentEvent = projection.currentEvent;
    requireRule(application.appliedOn === record.appliedOn, '投递日期与进度历史不一致');
    requireRule((application.currentEventId ?? null) === (currentEvent?.id ?? null), '投递当前事件与有效事件链尾不一致');
    if (!currentEvent) requireRule(application.currentStatusId === 'draft' && application.currentStage === null && application.phase === 'unknown' && application.outcome === 'active' && application.failedAt === null, '空历史投递必须保持草稿状态');
    else {
      const projectedStage = currentEvent.semantics.stageId ?? currentEvent.contextStageId;
      const stageMatches = application.currentStage === projectedStage;
      requireRule(application.currentStatusId === currentEvent.statusId && stageMatches && application.phase === currentEvent.phase && application.outcome === currentEvent.semantics.terminalOutcome, '投递当前状态与有效事件链尾不一致');
      requireRule(sameFailure(application.failedAt, currentEvent.semantics.terminalOutcome === 'failed' ? currentEvent.failedAt : null), '当前失败归因与有效事件链尾不一致');
    }
    sourceProjections.set(id, projection);
    for (const event of projection.events) {
      const stageId = stageForEvent(event);
      if (stageId) usedStageIds.add(stageId);
    }
    for (const annotation of record.annotations) if (annotation.invalidatedAt === null) usedStageIds.add(annotation.stageId);
    if (application.currentStage) usedStageIds.add(application.currentStage);
  }
  for (const stageId of usedStageIds) requireRule(stages.has(stageId), `进度记录引用不存在的环节: ${stageId}`);
  const columns = [...usedStageIds].map(id => stages.get(id)!).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).map(stage => ({
    id: stage.id, name: stage.name, category: stage.category, sortOrder: stage.sortOrder, archived: stage.archivedAt !== null,
  }));

  const rows: ProgressTableRow[] = [];
  for (const [id, application] of applications) {
    const record = records.get(id)!;
    const projection = sourceProjections.get(id)!;
    const currentEvent = projection.currentEvent;
    const currentStatus = input.definitions.statuses.find(status => status.id === application.currentStatusId);
    if (!currentStatus) throw new DomainError('VALIDATION', '投递当前状态不存在');
    const currentVisit = currentEvent ? projection.visits.find(visit => visit.id === currentEvent.visitId) ?? null : null;
    const currentUncertain = currentVisit ? containsUncertainBoundary(record, new Set(currentVisit.events.map(event => event.id))) : false;
    const currentStayDays = currentEvent && activeStayOutcomes.has(currentEvent.semantics.terminalOutcome) && currentVisit && !currentUncertain
      ? dateDistance(currentVisit.firstEvent.occurredOn, input.now)
      : null;
    const stageCells: Record<string, ProgressTableStageCell> = {};
    for (const column of columns) {
      stageCells[column.id] = makeStageCell(column.id, column.name, record, projection.events, projection.visits, currentEvent, input.now);
    }
    const pendingSchedules = structuredClone((input.schedules ?? []).filter(schedule => schedule.applicationId === id && schedule.status === 'pending').sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
    const row: ProgressTableRow = {
      application: structuredClone(application),
      current: {
        statusId: application.currentStatusId,
        statusName: currentStatus.name,
        stageId: application.currentStage,
        phase: application.phase,
        outcome: application.outcome,
        failedAt: structuredClone(application.failedAt),
        occurredOn: currentEvent?.occurredOn ?? null,
      },
      currentStayDays,
      stageCells,
      events: structuredClone(projection.events),
      hasHistoricalFailure: projection.events.some(event => event.semantics.terminalOutcome === 'failed'),
      nextSchedule: pendingSchedules[0] ?? null,
      pendingSchedules,
    };
    if (matchesFilters(row, filters)) rows.push(row);
  }
  return { columns, rows };
}
