import type { ProgressEvent, ProgressPhase } from '../../domain/v2/types.js';

export interface ProgressHistoryUncertainEdge {
  fromEventId: string;
  toEventId: string;
  reason: string;
}

export interface ProgressHistoryNode {
  event: ProgressEvent;
  isCurrent: boolean;
  visitOrdinal: number | null;
  visitCount: number | null;
  outcomeLabel: string | null;
  failureLabel: string | null;
  phaseLabel: string | null;
}

export interface ProgressHistoryLink {
  fromEventId: string;
  toEventId: string;
  uncertain: boolean;
  uncertaintyReason: string | null;
  timingIsPrecise: boolean;
}

export interface ProgressHistoryProjection {
  applicationId: string | null;
  nodes: ProgressHistoryNode[];
  links: ProgressHistoryLink[];
  currentEventId: string | null;
}

function resolveCorrectedEventId(id: string, byId: Map<string, ProgressEvent>): string | null {
  const visited = new Set<string>();
  let currentId: string | null = id;
  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const event = byId.get(currentId);
    if (!event) return null;
    if (event.invalidatedAt === null) return event.id;
    const replacements = [...byId.values()].filter(candidate => candidate.correctionOfEventId === currentId);
    if (replacements.length > 1) return null;
    const replacement = replacements[0];
    currentId = replacement?.id ?? null;
  }
  return null;
}

function resultLabel(event: ProgressEvent): string | null {
  switch (event.semantics.terminalOutcome) {
    case 'failed': return '流程挂掉';
    case 'offer_declined': return '已拒绝 Offer';
    case 'withdrawn': return '主动退出';
    case 'offer_received': return '获得 Offer';
    case 'offer_accepted': return '已接受 Offer';
    default: return null;
  }
}

function failureLabel(event: ProgressEvent): string | null {
  if (event.semantics.terminalOutcome !== 'failed') return null;
  if (event.failedAt === 'unknown') return '失败环节：未知';
  if (event.failedAt) return `失败环节：${event.failedAt.stageNameSnapshot}`;
  return '失败环节：未提供';
}

function phaseLabel(phase: ProgressPhase): string | null {
  switch (phase) {
    case 'waiting': return '等待中';
    case 'in_progress': return '进行中';
    case 'awaiting_result': return '等待结果';
    case 'passed': return '已通过';
    default: return null;
  }
}

/**
 * Builds a linear display model from one application's effective event chain.
 * Array order and createdAt are deliberately ignored: previousEventId establishes
 * each connection, and sequence verifies that the chain has no gaps or forks.
 * `auditEvents` is the complete R1 record set, including invalidated events. It is
 * used only to resolve uncertain edges through correction ancestry. When omitted,
 * `providedEvents` is treated as the complete record set for backwards compatibility.
 */
export function projectProgressHistory(
  providedEvents: readonly ProgressEvent[],
  uncertainEdges: readonly ProgressHistoryUncertainEdge[] = [],
  auditEvents: readonly ProgressEvent[] = providedEvents,
): ProgressHistoryProjection {
  const allById = new Map<string, ProgressEvent>();
  for (const event of auditEvents) {
    if (!event.id || allById.has(event.id)) throw new Error('进度审计历史包含重复或空事件 ID');
    allById.set(event.id, event);
  }
  for (const event of providedEvents) {
    if (!event.id) throw new Error('进度历史包含重复或空事件 ID');
    // An effective event may be a separately materialized view of the same record.
    // Prefer the complete audit record when present, and add omitted active records
    // so callers can supply a partial audit set without breaking ordinary edges.
    if (!allById.has(event.id)) allById.set(event.id, event);
  }

  const active = providedEvents.filter(event => event.invalidatedAt === null);
  if (active.length === 0) return { applicationId: providedEvents[0]?.applicationId ?? null, nodes: [], links: [], currentEventId: null };

  const applicationId = active[0]!.applicationId;
  if (active.some(event => event.applicationId !== applicationId)) throw new Error('进度历史不能混合不同投递的事件');

  const ordered: ProgressEvent[] = [];
  let current = active.find(event => event.previousEventId === null);
  if (!current || current.sequence !== 1) throw new Error('有效进度历史必须从 sequence=1 的首个事件开始');

  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) throw new Error('进度历史连接包含循环');
    visited.add(current.id);
    ordered.push(current);
    const children = active.filter(event => event.previousEventId === current!.id);
    if (children.length > 1) throw new Error('一个历史事件不能连接到多个后续事件');
    const next = children[0];
    if (next && next.sequence !== current.sequence + 1) throw new Error('进度历史的 sequence 与 previousEventId 不一致');
    current = next;
  }

  if (ordered.length !== active.length) throw new Error('进度历史包含未连接的有效事件');
  if (ordered.some((event, index) => event.sequence !== index + 1)) throw new Error('进度历史的 sequence 必须连续');

  const stageVisits = new Map<string, string[]>();
  for (const event of ordered) {
    const stageId = event.semantics.stageId;
    const resultOnly = event.semantics.terminalOutcome === 'failed'
      || event.semantics.terminalOutcome === 'offer_accepted'
      || event.semantics.terminalOutcome === 'offer_declined'
      || event.semantics.terminalOutcome === 'withdrawn';
    if (!stageId || resultOnly) continue;
    const visits = stageVisits.get(stageId) ?? [];
    if (!visits.includes(event.visitId)) visits.push(event.visitId);
    stageVisits.set(stageId, visits);
  }

  const visitOrdinalByKey = new Map<string, number>();
  for (const [stageId, visits] of stageVisits) visits.forEach((visitId, index) => visitOrdinalByKey.set(`${stageId}\0${visitId}`, index + 1));

  const uncertainByPair = new Map<string, string>();
  for (const edge of uncertainEdges) {
    const fromEventId = resolveCorrectedEventId(edge.fromEventId, allById);
    const toEventId = resolveCorrectedEventId(edge.toEventId, allById);
    if (fromEventId && toEventId && fromEventId !== toEventId) {
      uncertainByPair.set(`${fromEventId}\0${toEventId}`, edge.reason);
    }
  }

  const currentEventId = ordered.at(-1)?.id ?? null;
  const nodes = ordered.map(event => {
    const stageId = event.semantics.stageId;
    const visits = stageId ? stageVisits.get(stageId) ?? [] : [];
    return {
      event,
      isCurrent: event.id === currentEventId,
      visitOrdinal: stageId ? visitOrdinalByKey.get(`${stageId}\0${event.visitId}`) ?? null : null,
      visitCount: stageId && visits.length > 1 ? visits.length : null,
      outcomeLabel: resultLabel(event),
      failureLabel: failureLabel(event),
      phaseLabel: phaseLabel(event.phase),
    };
  });

  const links = ordered.slice(0, -1).map((event, index) => {
    const next = ordered[index + 1]!;
    const reason = uncertainByPair.get(`${event.id}\0${next.id}`) ?? null;
    return {
      fromEventId: event.id,
      toEventId: next.id,
      uncertain: reason !== null,
      uncertaintyReason: reason,
      timingIsPrecise: reason === null,
    };
  });

  return { applicationId, nodes, links, currentEventId };
}
