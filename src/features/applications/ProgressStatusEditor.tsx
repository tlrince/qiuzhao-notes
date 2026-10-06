import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ProgressEvent, ProgressRecord, R1DefinitionsSnapshot, StatusDefinition } from '../../domain/v2/types.js';
import {
  allowedProgressStatuses,
  buildProgressStatusEditorCommand,
  continuesVisit,
  localBusinessDate,
  pendingOfferCountForDraft,
  visitContinuation,
  type ProgressStatusEditorCommand,
  type ProgressStatusEditorDraft,
} from './progress-status-editor.js';
import './ProgressStatusEditor.css';

export interface ProgressStatusEditorProps {
  definitions: R1DefinitionsSnapshot;
  record: ProgressRecord;
  expectedRevision: number;
  onSubmit: (command: ProgressStatusEditorCommand) => void | Promise<void>;
  onCancel?: () => void;
  today?: string;
}

const orderedEvents = (record: ProgressRecord): ProgressEvent[] => record.events
  .filter(event => event.invalidatedAt === null)
  .sort((left, right) => left.sequence - right.sequence);

const liveStages = (definitions: R1DefinitionsSnapshot) => definitions.stages
  .filter(stage => stage.archivedAt === null)
  .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));

function statusLabel(status: StatusDefinition, definitions: R1DefinitionsSnapshot): string {
  const stage = definitions.stages.find(item => item.id === status.stageId);
  return stage ? `${status.name} · ${stage.name}` : status.name;
}

function createInitialDraft(today: string): ProgressStatusEditorDraft {
  return { mode: 'append', statusId: '', occurredOn: today, phase: '', failedAt: '', eventId: '', notes: '', reopenReason: '' };
}

export function ProgressStatusEditor({ definitions, record, expectedRevision, onSubmit, onCancel, today = localBusinessDate() }: ProgressStatusEditorProps) {
  const [draft, setDraft] = useState(() => createInitialDraft(today));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const visitFieldName = useId();
  const pendingCommand = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const events = useMemo(() => orderedEvents(record), [record]);
  const stages = useMemo(() => liveStages(definitions), [definitions]);
  const currentEvent = events.at(-1) ?? null;
  const reopening = draft.mode === 'append' && !!currentEvent && ['failed', 'offer_accepted', 'offer_declined', 'withdrawn'].includes(currentEvent.semantics.terminalOutcome);
  const target = draft.mode === 'correct' ? events.find(event => event.id === draft.eventId) ?? null : null;
  const offerCount = pendingOfferCountForDraft(record, draft);
  const statuses = allowedProgressStatuses(definitions, record, draft);
  const selectedStatus = statuses.find(status => status.id === draft.statusId) ?? null;
  const failureStages = selectedStatus?.semantic === 'failed'
    ? stages.filter(stage => selectedStatus.stageId === null || selectedStatus.stageId === stage.id)
    : [];
  const canContinueVisit = draft.mode === 'append' && !reopening && !!selectedStatus && visitContinuation(definitions, record, selectedStatus.id).possible;
  const continuing = canContinueVisit && continuesVisit(definitions, record, draft);

  const setMode = (mode: ProgressStatusEditorDraft['mode']) => {
    if (mode === 'append') {
      setDraft(previous => ({ ...previous, mode, eventId: '', statusId: '', occurredOn: today, phase: '', failedAt: '', notes: '', reopenReason: '' }));
      setError('');
      return;
    }
    const nextTarget = events.at(-1) ?? null;
    setDraft(previous => ({
      ...previous,
      mode,
      eventId: nextTarget?.id ?? '',
      statusId: '',
      occurredOn: nextTarget?.occurredOn ?? today,
      phase: '',
      failedAt: '',
      notes: nextTarget?.notes ?? '',
      reopenReason: '',
    }));
    setError('');
  };

  const selectTarget = (eventId: string) => {
    const nextTarget = events.find(event => event.id === eventId) ?? null;
    setDraft(previous => ({
      ...previous,
      eventId,
      statusId: '',
      occurredOn: nextTarget?.occurredOn ?? today,
      phase: '',
      failedAt: '',
      notes: nextTarget?.notes ?? '',
    }));
    setError('');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    let command: ProgressStatusEditorCommand;
    const fingerprint = JSON.stringify({ applicationId: record.applicationId, expectedRevision, draft, today });
    const commandId = pendingCommand.current?.fingerprint === fingerprint
      ? pendingCommand.current.commandId
      : globalThis.crypto.randomUUID();
    try {
      command = buildProgressStatusEditorCommand({
        definitions,
        record,
        expectedRevision,
        draft,
        today,
        commandId,
      });
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

  return (
    <form className="progress-status-editor" onSubmit={handleSubmit} aria-label="编辑投递状态">
      <fieldset className="progress-status-editor__mode">
        <legend>记录方式</legend>
        <label>
          <input type="radio" name="progress-editor-mode" value="append" checked={draft.mode === 'append'} onChange={() => setMode('append')} />
          追加新经历
        </label>
        <label>
          <input type="radio" name="progress-editor-mode" value="correct" checked={draft.mode === 'correct'} onChange={() => setMode('correct')} />
          纠正已有经历
        </label>
      </fieldset>

      {draft.mode === 'correct' ? (
        <label className="progress-status-editor__field">
          <span>要纠正的事件</span>
          <select required value={draft.eventId} onChange={event => selectTarget(event.target.value)}>
            <option value="">选择一条有效事件</option>
            {events.map(item => (
              <option key={item.id} value={item.id}>第 {item.sequence} 条 · {item.statusNameSnapshot} · {item.occurredOn}</option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="progress-status-editor__field">
        <span>状态</span>
        <select required value={draft.statusId} onChange={event => setDraft(previous => ({ ...previous, statusId: event.target.value, phase: '', failedAt: '', visitChoice: 'auto' }))}>
          <option value="">选择状态</option>
          {statuses.map(status => <option key={status.id} value={status.id}>{statusLabel(status, definitions)}</option>)}
        </select>
      </label>

      <p className="progress-status-editor__hint" aria-live="polite">
        {offerCount > 0
          ? `有 ${offerCount} 个尚未决定的有效 Offer，可选择接受或拒绝。`
          : '当前没有尚未决定的有效 Offer；接受或拒绝状态不可用。'}
      </p>

      {canContinueVisit ? (
        <fieldset className="progress-status-editor__mode">
          <legend>这次记录属于</legend>
          <label>
            <input type="radio" name={visitFieldName} checked={continuing} onChange={() => setDraft(previous => ({ ...previous, visitChoice: 'continue' }))} />
            同一轮的进展（如 一面中 → 一面通过）
          </label>
          <label>
            <input type="radio" name={visitFieldName} checked={!continuing} onChange={() => setDraft(previous => ({ ...previous, visitChoice: 'new' }))} />
            新的一轮（重面、再次进入该环节）
          </label>
        </fieldset>
      ) : null}

      {selectedStatus?.semantic === 'failed' ? (
        <label className="progress-status-editor__field">
          <span>失败环节</span>
          <select required value={draft.failedAt} onChange={event => setDraft(previous => ({ ...previous, failedAt: event.target.value }))}>
            <option value="">选择失败环节</option>
            {selectedStatus.stageId === null ? <option value="unknown">环节未知</option> : null}
            {failureStages.map(stage => <option key={stage.id} value={`stage:${stage.id}`}>{stage.name}</option>)}
          </select>
        </label>
      ) : null}

      <label className="progress-status-editor__field">
        <span>发生日期</span>
        <input type="date" value={draft.occurredOn} onChange={event => setDraft(previous => ({ ...previous, occurredOn: event.target.value }))} />
        <small>留空时使用今天（{today}）。</small>
      </label>

      {reopening ? (
        <label className="progress-status-editor__field">
          <span>重新开启原因</span>
          <input required value={draft.reopenReason} onChange={event => setDraft(previous => ({ ...previous, reopenReason: event.target.value }))} placeholder="例如：招聘方恢复流程" />
        </label>
      ) : null}

      <label className="progress-status-editor__field">
        <span>备注（可选）</span>
        <textarea rows={3} value={draft.notes} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} />
      </label>

      {error ? <p className="progress-status-editor__error" role="alert">{error}</p> : null}

      <div className="progress-status-editor__actions">
        {onCancel ? <button type="button" onClick={onCancel} disabled={saving}>取消</button> : null}
        <button type="submit" disabled={saving || !statuses.length || (draft.mode === 'correct' && !events.length)}>{saving ? '保存中…' : draft.mode === 'correct' ? '保存纠错' : '记录状态'}</button>
      </div>
      {draft.mode === 'correct' && !target ? <p className="progress-status-editor__hint">请选择一条有效事件后再纠错。</p> : null}
    </form>
  );
}
