import { DomainError, requireRule } from '../../domain/errors.js';
import { validateDate } from '../../domain/validation.js';
import type { AppendProgressInput, CorrectProgressInput } from '../../domain/v2/progress.js';
import type { ProgressEvent, ProgressRecord, R1DefinitionsSnapshot, StatusDefinition } from '../../domain/v2/types.js';

export type ProgressStatusEditorMode = 'append' | 'correct';

export interface ProgressStatusEditorDraft {
  mode: ProgressStatusEditorMode;
  statusId: string;
  /** Empty means use the supplied business-local today. */
  occurredOn: string;
  /** Empty means use the phase encoded by the selected status definition. */
  phase: string;
  failedAt: string;
  eventId: string;
  notes: string;
  reopenReason: string;
}

export type ProgressStatusEditorCommand =
  | {
      kind: 'append';
      input: {
        applicationId: string;
        expectedRevision: number;
        command: AppendProgressInput;
      };
    }
  | {
      kind: 'correct';
      input: {
        applicationId: string;
        expectedRevision: number;
        eventId: string;
        command: CorrectProgressInput;
      };
    };

const terminalOutcomes = new Set(['failed', 'offer_accepted', 'offer_declined', 'withdrawn']);
const resolveLiveStage = (definitions: R1DefinitionsSnapshot, stageId: string) => definitions.stages.find(stage => stage.id === stageId && stage.archivedAt === null);

export function activeProgressStatuses(definitions: R1DefinitionsSnapshot): StatusDefinition[] {
  return definitions.statuses
    .filter(status => status.archivedAt === null && (status.stageId === null || resolveLiveStage(definitions, status.stageId) !== undefined))
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
}

function effectiveEvents(record: ProgressRecord): ProgressEvent[] {
  return record.events.filter(event => event.invalidatedAt === null).sort((left, right) => left.sequence - right.sequence);
}

function pendingOffers(events: readonly ProgressEvent[]): number {
  let pending = 0;
  for (const event of events) {
    const semantic = event.semantics.semantic;
    if (semantic === 'offer_received') pending += 1;
    else if (semantic === 'offer_accepted' || semantic === 'offer_declined') pending = Math.max(0, pending - 1);
    else if (semantic === 'withdrawn') pending = 0;
  }
  return pending;
}

function eventTarget(record: ProgressRecord, eventId: string): ProgressEvent {
  const target = record.events.find(event => event.id === eventId && event.invalidatedAt === null);
  if (!target) throw new DomainError('VALIDATION', '请选择一条有效进度事件进行纠错');
  return target;
}

export function pendingOfferCountForDraft(record: ProgressRecord, draft: Pick<ProgressStatusEditorDraft, 'mode' | 'eventId'>): number {
  const events = effectiveEvents(record);
  if (draft.mode === 'append') return pendingOffers(events);
  if (!draft.eventId) return 0;
  const target = eventTarget(record, draft.eventId);
  return pendingOffers(events.slice(0, target.sequence - 1));
}

export function allowedProgressStatuses(
  definitions: R1DefinitionsSnapshot,
  record: ProgressRecord,
  draft: Pick<ProgressStatusEditorDraft, 'mode' | 'eventId'>,
): StatusDefinition[] {
  const hasPendingOffer = pendingOfferCountForDraft(record, draft) > 0;
  return activeProgressStatuses(definitions).filter(status =>
    hasPendingOffer || (status.semantic !== 'offer_accepted' && status.semantic !== 'offer_declined'),
  );
}

function currentEvent(record: ProgressRecord): ProgressEvent | null {
  return effectiveEvents(record).at(-1) ?? null;
}

export function buildProgressStatusEditorCommand(args: {
  definitions: R1DefinitionsSnapshot;
  record: ProgressRecord;
  expectedRevision: number;
  draft: ProgressStatusEditorDraft;
  today: string;
  commandId: string;
}): ProgressStatusEditorCommand {
  const { definitions, record, expectedRevision, draft, today, commandId } = args;
  requireRule(!!record.applicationId.trim(), '投递 ID 必填');
  requireRule(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, '快照版本无效');
  requireRule(!!commandId.trim(), 'commandId 必填');
  const occurredOn = draft.occurredOn.trim() || today;
  validateDate(occurredOn);
  const target = draft.mode === 'correct' ? eventTarget(record, draft.eventId) : null;

  const statuses = allowedProgressStatuses(definitions, record, draft);
  const status = statuses.find(item => item.id === draft.statusId);
  if (!status) throw new DomainError('VALIDATION', '请选择可用状态；接受或拒绝 Offer 需要尚未决定的有效 Offer');

  const phase = draft.phase.trim();
  requireRule(!phase || phase === status.defaultPhase, '进度结果必须与所选状态定义一致');
  const notes = draft.notes.trim();
  let failedAt: AppendProgressInput['failedAt'];
  if (status.semantic === 'failed') {
    requireRule(!!draft.failedAt, '挂掉必须选择失败环节，未知时选择“环节未知”');
    if (draft.failedAt === 'unknown') {
      requireRule(status.stageId === null, '已指定失败环节的状态不能选择“环节未知”');
      failedAt = 'unknown';
    }
    else {
      const stageId = draft.failedAt.startsWith('stage:') ? draft.failedAt.slice('stage:'.length) : draft.failedAt;
      const stage = resolveLiveStage(definitions, stageId);
      requireRule(!!stage, '请选择有效且未归档的失败环节');
      requireRule(status.stageId === null || status.stageId === stage.id, '失败归因环节必须与所选状态一致');
      failedAt = { stageId: stage.id };
    }
  } else requireRule(!draft.failedAt, '只有挂掉状态可以记录失败归因');

  const common = {
    commandId: commandId.trim(),
    statusId: status.id,
    occurredOn,
    ...(phase ? { phase: status.defaultPhase } : {}),
    ...(notes ? { notes } : {}),
    ...(failedAt === undefined ? {} : { failedAt }),
  };

  if (draft.mode === 'append') {
    const last = currentEvent(record);
    if (last && terminalOutcomes.has(last.semantics.terminalOutcome)) {
      requireRule(!!draft.reopenReason.trim(), '重新开启流程必须记录原因');
      requireRule(!terminalOutcomes.has(status.semantic), '重新开启后必须选择一个进行中的状态');
      const command: AppendProgressInput = {
        ...common,
        mode: 'reopen',
        reopenReason: draft.reopenReason.trim(),
      };
      return { kind: 'append', input: { applicationId: record.applicationId, expectedRevision, command } };
    }
    requireRule(!draft.reopenReason.trim(), '只有从终止状态重新开始时才填写原因');
    const command: AppendProgressInput = common;
    return { kind: 'append', input: { applicationId: record.applicationId, expectedRevision, command } };
  }

  // `target` was validated before status selection so correction always has an explicit anchor.
  requireRule(!!target, '请选择一条有效进度事件进行纠错');
  const command: CorrectProgressInput = common;
  return { kind: 'correct', input: { applicationId: record.applicationId, expectedRevision, eventId: target.id, command } };
}

export function localBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function phaseLabel(phase: string): string {
  return ({ unknown: '结果未知', waiting: '待安排', in_progress: '进行中', awaiting_result: '待结果', passed: '已通过' } as Record<string, string>)[phase] ?? phase;
}
