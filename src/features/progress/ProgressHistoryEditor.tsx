import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { ProgressEvent, ProgressRecord, R1DefinitionsSnapshot, StatusDefinition } from '../../domain/v2/types.js';
import {
  allowedProgressStatuses,
  buildProgressStatusEditorCommand,
  localBusinessDate,
  pendingOfferCountForDraft,
  phaseLabel,
  type ProgressStatusEditorCommand,
  type ProgressStatusEditorDraft,
} from '../applications/progress-status-editor.js';
import '../applications/ProgressStatusEditor.css';

export type ProgressHistoryAction =
  | { kind: 'append' }
  | { kind: 'backfill'; beforeEventId: string }
  | { kind: 'correct'; eventId: string };

export interface ProgressHistoryEditorProps {
  action: ProgressHistoryAction;
  definitions: R1DefinitionsSnapshot;
  record: ProgressRecord;
  expectedRevision: number;
  onSubmit: (command: ProgressStatusEditorCommand) => void | Promise<void>;
  onCancel?: () => void;
  today?: string;
}

const terminalOutcomes = new Set(['failed', 'offer_accepted', 'offer_declined', 'withdrawn']);

const effectiveEvents = (record: ProgressRecord): ProgressEvent[] => record.events
  .filter(event => event.invalidatedAt === null)
  .sort((left, right) => left.sequence - right.sequence);

function initialDraft(action: ProgressHistoryAction, record: ProgressRecord, today: string): ProgressStatusEditorDraft {
  const events = effectiveEvents(record);
  if (action.kind === 'append') {
    return { mode: 'append', statusId: '', occurredOn: today, phase: '', failedAt: '', eventId: '', notes: '', reopenReason: '' };
  }
  const targetId = action.kind === 'backfill' ? action.beforeEventId : action.eventId;
  const target = events.find(event => event.id === targetId) ?? null;
  return {
    // The domain form helper validates correction fields against this fixed anchor.
    // Backfill converts the validated command to an insertion before that anchor.
    mode: 'correct',
    statusId: '',
    occurredOn: action.kind === 'backfill' ? target?.occurredOn ?? today : target?.occurredOn ?? today,
    phase: '',
    failedAt: '',
    eventId: targetId,
    notes: action.kind === 'correct' ? target?.notes ?? '' : '',
    reopenReason: '',
  };
}

function statusLabel(status: StatusDefinition, definitions: R1DefinitionsSnapshot): string {
  const stage = definitions.stages.find(item => item.id === status.stageId);
  return stage ? `${status.name} · ${stage.name}` : status.name;
}

export function ProgressHistoryEditor({
  action,
  definitions,
  record,
  expectedRevision,
  onSubmit,
  onCancel,
  today = localBusinessDate(),
}: ProgressHistoryEditorProps) {
  const [draft, setDraft] = useState(() => initialDraft(action, record, today));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pendingCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const events = useMemo(() => effectiveEvents(record), [record]);
  const target = action.kind === 'append' ? null : events.find(event => event.id === (action.kind === 'backfill' ? action.beforeEventId : action.eventId)) ?? null;
  const anchorIndex = target ? events.findIndex(event => event.id === target.id) : -1;
  const preceding = anchorIndex > 0 ? events[anchorIndex - 1] ?? null : null;
  const current = events.at(-1) ?? null;
  const reopening = action.kind === 'append' && !!current && terminalOutcomes.has(current.semantics.terminalOutcome);
  const helperDraft = action.kind === 'append' ? draft : { ...draft, mode: 'correct' as const, eventId: target?.id ?? '' };
  const statuses = allowedProgressStatuses(definitions, record, helperDraft);
  const selectedStatus = statuses.find(status => status.id === draft.statusId) ?? null;
  const offerCount = pendingOfferCountForDraft(record, helperDraft);
  const stages = definitions.stages.filter(stage => stage.archivedAt === null).sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  const failureStages = selectedStatus?.semantic === 'failed'
    ? stages.filter(stage => selectedStatus.stageId === null || selectedStatus.stageId === stage.id)
    : [];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const fingerprint = JSON.stringify({ applicationId: record.applicationId, expectedRevision, action, draft, today });
    const commandId = pendingCommand.current?.fingerprint === fingerprint
      ? pendingCommand.current.commandId
      : globalThis.crypto.randomUUID();
    let command: ProgressStatusEditorCommand;
    try {
      command = buildProgressStatusEditorCommand({
        definitions,
        record,
        expectedRevision,
        draft: helperDraft,
        today,
        commandId,
      });
      if (action.kind === 'backfill') {
        if (command.kind !== 'correct') throw new Error('历史补录命令定位无效');
        command = {
          kind: 'append',
          input: {
            applicationId: record.applicationId,
            expectedRevision,
            command: { ...command.input.command, mode: 'backfill', beforeEventId: action.beforeEventId },
          },
        };
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '进度记录无效');
      return;
    }
    pendingCommand.current = { fingerprint, commandId };
    setSaving(true);
    try {
      await onSubmit(command);
      pendingCommand.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const title = action.kind === 'backfill' ? '在历史节点前补录' : action.kind === 'correct' ? '纠正历史事件' : '追加进度状态';
  const submitLabel = action.kind === 'backfill' ? '保存补录' : action.kind === 'correct' ? '保存纠错' : '记录状态';

  return <form className="progress-status-editor progress-history-editor" onSubmit={handleSubmit} aria-label={title}>
    <h2>{title}</h2>
    {action.kind === 'backfill' && target ? <p className="progress-status-editor__hint">
      新事件会插入在「{target.statusNameSnapshot} · {target.occurredOn}」之前；{preceding ? `前一节点是「${preceding.statusNameSnapshot} · ${preceding.occurredOn}」，` : '这是第一条历史记录，'}日期需落在这个顺序范围内。
    </p> : null}
    {action.kind === 'correct' && target ? <p className="progress-status-editor__hint">
      正在纠正「{target.statusNameSnapshot} · {target.occurredOn}」。原始事件会保留在审计历史中。
    </p> : null}

    {action.kind === 'correct' ? <label className="progress-status-editor__field">
      <span>要纠正的事件</span>
      <input readOnly value={`第 ${target?.sequence ?? ''} 条 · ${target?.statusNameSnapshot ?? '事件已失效'} · ${target?.occurredOn ?? ''}`} />
    </label> : null}

    <label className="progress-status-editor__field">
      <span>状态</span>
      <select required value={draft.statusId} onChange={event => setDraft(previous => ({ ...previous, statusId: event.target.value, phase: '', failedAt: '' }))}>
        <option value="">选择状态</option>
        {statuses.map(status => <option key={status.id} value={status.id}>{statusLabel(status, definitions)}</option>)}
      </select>
    </label>

    <p className="progress-status-editor__hint" aria-live="polite">
      {offerCount > 0 ? `在这个历史位置有 ${offerCount} 个尚未决定的有效 Offer，可选择接受或拒绝。` : '这个历史位置没有尚未决定的有效 Offer；接受或拒绝状态不可用。'}
    </p>

    {selectedStatus ? <label className="progress-status-editor__field">
      <span>阶段结果（可选）</span>
      <select value={draft.phase} onChange={event => setDraft(previous => ({ ...previous, phase: event.target.value }))}>
        <option value="">使用状态定义：{phaseLabel(selectedStatus.defaultPhase)}</option>
        <option value={selectedStatus.defaultPhase}>明确记录：{phaseLabel(selectedStatus.defaultPhase)}</option>
      </select>
      <small>结果由状态定义约束；例如「笔试通过」和「笔试待结果」是不同状态。</small>
    </label> : null}

    {selectedStatus?.semantic === 'failed' ? <label className="progress-status-editor__field">
      <span>失败环节</span>
      <select required value={draft.failedAt} onChange={event => setDraft(previous => ({ ...previous, failedAt: event.target.value }))}>
        <option value="">选择失败环节</option>
        {selectedStatus.stageId === null ? <option value="unknown">环节未知</option> : null}
        {failureStages.map(stage => <option key={stage.id} value={`stage:${stage.id}`}>{stage.name}</option>)}
      </select>
    </label> : null}

    <label className="progress-status-editor__field">
      <span>发生日期</span>
      <input type="date" value={draft.occurredOn} onChange={event => setDraft(previous => ({ ...previous, occurredOn: event.target.value }))} />
      <small>{action.kind === 'backfill' ? '日期必须处于前一节点和锚点日期之间，R1 命令会再次校验。' : `留空时使用今天（${today}）。`}</small>
    </label>

    {reopening ? <label className="progress-status-editor__field">
      <span>重新开启原因</span>
      <input required value={draft.reopenReason} onChange={event => setDraft(previous => ({ ...previous, reopenReason: event.target.value }))} placeholder="例如：招聘方恢复流程" />
    </label> : null}

    <label className="progress-status-editor__field">
      <span>备注（可选）</span>
      <textarea rows={3} value={draft.notes} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} />
    </label>

    {error ? <p className="progress-status-editor__error" role="alert">{error}</p> : null}
    <div className="progress-status-editor__actions">
      {onCancel ? <button type="button" onClick={onCancel} disabled={saving}>返回历史</button> : null}
      <button type="submit" disabled={saving || !statuses.length || (action.kind !== 'append' && !target)}>{saving ? '保存中…' : submitLabel}</button>
    </div>
  </form>;
}
