import { useMemo, useState, type FormEvent } from 'react';
import type { R1DefinitionsSnapshot, StageCategory, StageDefinition, StatusDefinition, StatusSemantic, ProgressPhase } from '../../domain/v2/types.js';
import type { StageDefinitionPatch, StatusDefinitionPatch } from '../../repositories/v2/definition-commands.js';
import {
  orderedStages,
  orderedStatuses,
  PROGRESS_PHASE_LABELS,
  PROGRESS_PHASES,
  STAGE_CATEGORIES,
  STAGE_CATEGORY_LABELS,
  STATUS_SEMANTICS,
  STATUS_SEMANTIC_LABELS,
  stageDraftFrom,
  stageDraftToPatch,
  stageDraftToValues,
  statusDraftFrom,
  statusDraftToPatch,
  statusDraftToValues,
  type StageDefinitionDraft,
  type StatusDefinitionDraft,
} from './definition-manager-model.js';
import './DefinitionManager.css';

export interface DefinitionManagerCommands {
  onCreateStage(input: { name: string; category: StageCategory; sortOrder: number; countsAsInterview: boolean; interviewRound?: number }): Promise<unknown>;
  onUpdateStage(input: { stageId: string; patch: StageDefinitionPatch }): Promise<unknown>;
  onArchiveStage(stageId: string): Promise<unknown>;
  onCreateStatus(input: { name: string; color: string; sortOrder: number; semantic: StatusSemantic; stageId: string | null; defaultPhase: ProgressPhase; statisticsCategory: string | null }): Promise<unknown>;
  onUpdateStatus(input: { statusId: string; patch: StatusDefinitionPatch }): Promise<unknown>;
  onArchiveStatus(statusId: string): Promise<unknown>;
}

export interface DefinitionManagerProps {
  definitions: R1DefinitionsSnapshot;
  onCommand: DefinitionManagerCommands;
}

function phaseChoices(draft: StatusDefinitionDraft): ProgressPhase[] {
  const fixedUnknown = ['draft', 'submitted', 'screening', 'pool', 'offer_received', 'offer_accepted', 'offer_declined', 'failed', 'withdrawn'].includes(draft.semantic);
  return !draft.stageId || fixedUnknown ? ['unknown'] : PROGRESS_PHASES;
}

function stageLabel(stage: StageDefinition): string {
  return `${stage.name} · ${STAGE_CATEGORY_LABELS[stage.category]}`;
}

function statusLabel(status: StatusDefinition, definitions: R1DefinitionsSnapshot): string {
  const stage = definitions.stages.find(item => item.id === status.stageId);
  return stage ? `${stage.name} · ${STATUS_SEMANTIC_LABELS[status.semantic]}` : `${STATUS_SEMANTIC_LABELS[status.semantic]} · 未关联环节`;
}

export function DefinitionManager({ definitions, onCommand }: DefinitionManagerProps) {
  const stages = useMemo(() => orderedStages(definitions), [definitions]);
  const statuses = useMemo(() => orderedStatuses(definitions), [definitions]);
  const liveStages = stages.filter(stage => stage.archivedAt === null);

  const [stageDraft, setStageDraft] = useState<StageDefinitionDraft>(() => stageDraftFrom());
  const [editingStageId, setEditingStageId] = useState<string | null>(null);
  const [stageMessage, setStageMessage] = useState('');
  const [stageError, setStageError] = useState('');
  const [stageSaving, setStageSaving] = useState(false);

  const [statusDraft, setStatusDraft] = useState<StatusDefinitionDraft>(() => statusDraftFrom());
  const [editingStatusId, setEditingStatusId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusError, setStatusError] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);

  const editStage = (stage: StageDefinition) => {
    setEditingStageId(stage.id);
    setStageDraft(stageDraftFrom(stage));
    setStageError('');
    setStageMessage('');
  };

  const editStatus = (status: StatusDefinition) => {
    setEditingStatusId(status.id);
    setStatusDraft(statusDraftFrom(status));
    setStatusError('');
    setStatusMessage('');
  };

  const cancelStageEdit = () => {
    setEditingStageId(null);
    setStageDraft(stageDraftFrom());
    setStageError('');
    setStageMessage('');
  };

  const cancelStatusEdit = () => {
    setEditingStatusId(null);
    setStatusDraft(statusDraftFrom());
    setStatusError('');
    setStatusMessage('');
  };

  const submitStage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStageError('');
    setStageMessage('');
    const current = stages.find(stage => stage.id === editingStageId);
    if (editingStageId && !current) {
      setStageError('环节已更新，请重新选择后再保存');
      return;
    }
    const result = current ? stageDraftToPatch(stageDraft, current) : stageDraftToValues(stageDraft);
    if (!result.ok) { setStageError(result.error); return; }
    setStageSaving(true);
    try {
      if (current) {
        const patchResult = stageDraftToPatch(stageDraft, current);
        if (!patchResult.ok) { setStageError(patchResult.error); return; }
        await onCommand.onUpdateStage({ stageId: current.id, patch: patchResult.value });
      } else {
        const createResult = stageDraftToValues(stageDraft);
        if (!createResult.ok) { setStageError(createResult.error); return; }
        await onCommand.onCreateStage(createResult.value);
      }
      setStageMessage(current ? '环节已保存' : '环节已创建');
      cancelStageEdit();
      setStageMessage(current ? '环节已保存' : '环节已创建');
    } catch (cause) {
      setStageError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setStageSaving(false);
    }
  };

  const submitStatus = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatusError('');
    setStatusMessage('');
    const result = statusDraftToPatch(statusDraft, definitions);
    if (!result.ok) { setStatusError(result.error); return; }
    const current = statuses.find(status => status.id === editingStatusId);
    if (editingStatusId && !current) {
      setStatusError('状态已更新，请重新选择后再保存');
      return;
    }
    setStatusSaving(true);
    try {
      if (current) {
        const patchResult = statusDraftToPatch(statusDraft, definitions);
        if (!patchResult.ok) { setStatusError(patchResult.error); return; }
        await onCommand.onUpdateStatus({ statusId: current.id, patch: patchResult.value });
      } else {
        const createResult = statusDraftToValues(statusDraft, definitions);
        if (!createResult.ok) { setStatusError(createResult.error); return; }
        await onCommand.onCreateStatus(createResult.value);
      }
      setStatusMessage(current ? '状态已保存' : '状态已创建');
      cancelStatusEdit();
      setStatusMessage(current ? '状态已保存' : '状态已创建');
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setStatusSaving(false);
    }
  };

  const archiveStage = async (stage: StageDefinition) => {
    const linkedCount = statuses.filter(status => status.stageId === stage.id && status.archivedAt === null).length;
    const detail = linkedCount ? `同时会归档关联的 ${linkedCount} 个可用状态。` : '';
    if (!window.confirm(`归档「${stage.name}」？${detail}历史记录仍会保留。`)) return;
    setStageError('');
    setStageMessage('');
    try {
      await onCommand.onArchiveStage(stage.id);
      setStageMessage('环节已归档');
      if (editingStageId === stage.id) cancelStageEdit();
      if (editingStatusId && statuses.find(status => status.id === editingStatusId)?.stageId === stage.id) cancelStatusEdit();
    } catch (cause) {
      setStageError(cause instanceof Error ? cause.message : '归档失败，请重试');
    }
  };

  const archiveStatus = async (status: StatusDefinition) => {
    if (!window.confirm(`归档「${status.name}」？现有投递和历史记录将保留。`)) return;
    setStatusError('');
    setStatusMessage('');
    try {
      await onCommand.onArchiveStatus(status.id);
      setStatusMessage('状态已归档');
      if (editingStatusId === status.id) cancelStatusEdit();
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : '归档失败，请重试');
    }
  };

  const stageForm = (
    <form className="definition-manager__form" onSubmit={submitStage} aria-label={editingStageId ? '编辑环节' : '新建环节'}>
      <h3>{editingStageId ? '编辑环节' : '新增环节'}</h3>
      <label><span>环节名称</span><input required maxLength={80} value={stageDraft.name} onChange={event => setStageDraft(current => ({ ...current, name: event.target.value }))} /></label>
      <label><span>统计分类</span><select value={stageDraft.category} onChange={event => setStageDraft(current => ({ ...current, category: event.target.value as StageCategory }))}>
        {STAGE_CATEGORIES.map(category => <option key={category} value={category}>{STAGE_CATEGORY_LABELS[category]}</option>)}
      </select></label>
      <label><span>排序值</span><input required type="number" step="1" value={stageDraft.sortOrder} onChange={event => setStageDraft(current => ({ ...current, sortOrder: event.target.value }))} /></label>
      <label className="definition-manager__check"><input type="checkbox" checked={stageDraft.countsAsInterview} onChange={event => setStageDraft(current => ({ ...current, countsAsInterview: event.target.checked }))} /><span>计入面试统计</span></label>
      {stageDraft.countsAsInterview ? <label><span>面试轮次（可选）</span><input type="number" min="0" step="1" value={stageDraft.interviewRound} onChange={event => setStageDraft(current => ({ ...current, interviewRound: event.target.value }))} /><small>留空表示不指定轮次。</small></label> : null}
      {stageError ? <p className="definition-manager__error" role="alert">{stageError}</p> : null}
      {stageMessage ? <p className="definition-manager__success" role="status">{stageMessage}</p> : null}
      <div className="definition-manager__actions">
        {editingStageId ? <button type="button" className="definition-manager__button--quiet" onClick={cancelStageEdit} disabled={stageSaving}>取消</button> : null}
        <button type="submit" disabled={stageSaving}>{stageSaving ? '保存中…' : editingStageId ? '保存环节' : '创建环节'}</button>
      </div>
      {editingStageId && stages.find(stage => stage.id === editingStageId)?.interviewRound !== undefined && !stageDraft.interviewRound.trim()
        ? <small>当前环节已有轮次。命令接口不支持清除轮次，留空将保留原值。</small> : null}
    </form>
  );

  const editableStages = liveStages;
  const allowedPhases = phaseChoices(statusDraft);
  const statusForm = (
    <form className="definition-manager__form" onSubmit={submitStatus} aria-label={editingStatusId ? '编辑状态' : '新建状态'}>
      <h3>{editingStatusId ? '编辑状态' : '新增状态'}</h3>
      <label><span>状态名称</span><input required maxLength={80} value={statusDraft.name} onChange={event => setStatusDraft(current => ({ ...current, name: event.target.value }))} /></label>
      <label><span>状态颜色</span><span className="definition-manager__color-field"><input type="color" aria-label="状态颜色" value={statusDraft.color} onChange={event => setStatusDraft(current => ({ ...current, color: event.target.value }))} /><input aria-label="十六进制颜色" value={statusDraft.color} onChange={event => setStatusDraft(current => ({ ...current, color: event.target.value }))} /></span></label>
      <label><span>排序值</span><input required type="number" step="1" value={statusDraft.sortOrder} onChange={event => setStatusDraft(current => ({ ...current, sortOrder: event.target.value }))} /></label>
      <label><span>状态语义</span><select value={statusDraft.semantic} onChange={event => setStatusDraft(current => ({ ...current, semantic: event.target.value as StatusSemantic, defaultPhase: 'unknown' }))}>
        {STATUS_SEMANTICS.map(semantic => <option key={semantic} value={semantic}>{STATUS_SEMANTIC_LABELS[semantic]}</option>)}
      </select></label>
      <label><span>所属环节</span><select value={statusDraft.stageId} onChange={event => setStatusDraft(current => ({ ...current, stageId: event.target.value, defaultPhase: event.target.value ? current.defaultPhase : 'unknown' }))}>
        <option value="">未分类 / 不关联环节</option>
        {editableStages.map(stage => <option key={stage.id} value={stage.id}>{stageLabel(stage)}</option>)}
      </select><small>自定义状态可以保持未分类，也可以关联任一环节。</small></label>
      <label><span>默认流程结果</span><select value={statusDraft.defaultPhase} onChange={event => setStatusDraft(current => ({ ...current, defaultPhase: event.target.value as ProgressPhase }))}>
        {allowedPhases.map(phase => <option key={phase} value={phase}>{PROGRESS_PHASE_LABELS[phase]}</option>)}
      </select><small>已有经历保留当时保存的语义快照。</small></label>
      <label><span>统计分类</span><input maxLength={80} value={statusDraft.statisticsCategory} onChange={event => setStatusDraft(current => ({ ...current, statisticsCategory: event.target.value }))} placeholder="留空表示未分类" /><small>可填写自定义分类；留空不会从状态名称推断。</small></label>
      {statusError ? <p className="definition-manager__error" role="alert">{statusError}</p> : null}
      {statusMessage ? <p className="definition-manager__success" role="status">{statusMessage}</p> : null}
      <div className="definition-manager__actions">
        {editingStatusId ? <button type="button" className="definition-manager__button--quiet" onClick={cancelStatusEdit} disabled={statusSaving}>取消</button> : null}
        <button type="submit" disabled={statusSaving}>{statusSaving ? '保存中…' : editingStatusId ? '保存状态' : '创建状态'}</button>
      </div>
    </form>
  );

  return (
    <section className="definition-manager">
      <header className="definition-manager__header">
        <p className="definition-manager__eyebrow">配置</p>
        <h1>状态与环节</h1>
        <p>状态定义只提供记录选项，不会自动生成投递经历。语义调整会影响新记录，已有经历继续使用当时的快照。</p>
      </header>
      <div className="definition-manager__grid">
        <section className="definition-manager__section" aria-labelledby="definition-manager-stages">
          <div className="definition-manager__section-heading"><div><p className="definition-manager__eyebrow">流程列</p><h2 id="definition-manager-stages">环节</h2></div><span>{liveStages.length} 个可用</span></div>
          <div className="definition-manager__list" aria-label="环节定义">
            {stages.map(stage => (
              <article key={stage.id} className={`definition-manager__item${stage.archivedAt ? ' is-archived' : ''}`}>
                <div className="definition-manager__item-copy"><strong>{stage.name}</strong><span>{STAGE_CATEGORY_LABELS[stage.category]} · 顺序 {stage.sortOrder}{stage.countsAsInterview ? ' · 计入面试' : ''}{stage.interviewRound !== undefined ? ` · 第 ${stage.interviewRound} 轮` : ''}</span></div>
                {stage.archivedAt ? <span className="definition-manager__archived">已归档</span> : <div className="definition-manager__item-actions"><button type="button" className="definition-manager__button--quiet" onClick={() => editStage(stage)}>编辑</button><button type="button" className="definition-manager__button--danger" onClick={() => void archiveStage(stage)}>归档</button></div>}
              </article>
            ))}
            {!stages.length ? <p className="definition-manager__empty">还没有环节，可以先新增一个自定义环节。</p> : null}
          </div>
          {stageForm}
        </section>

        <section className="definition-manager__section" aria-labelledby="definition-manager-statuses">
          <div className="definition-manager__section-heading"><div><p className="definition-manager__eyebrow">可记录选项</p><h2 id="definition-manager-statuses">状态</h2></div><span>{statuses.filter(status => status.archivedAt === null).length} 个可用</span></div>
          <div className="definition-manager__list" aria-label="状态定义">
            {statuses.map(status => (
              <article key={status.id} className={`definition-manager__item${status.archivedAt ? ' is-archived' : ''}`}>
                <span className="definition-manager__swatch" aria-hidden="true" style={{ backgroundColor: status.color }} />
                <div className="definition-manager__item-copy"><strong>{status.name}</strong><span>{statusLabel(status, definitions)} · 顺序 {status.sortOrder}{status.statisticsCategory ? ` · ${status.statisticsCategory}` : ''}</span></div>
                {status.archivedAt ? <span className="definition-manager__archived">已归档</span> : <div className="definition-manager__item-actions"><button type="button" className="definition-manager__button--quiet" onClick={() => editStatus(status)}>编辑</button><button type="button" className="definition-manager__button--danger" onClick={() => void archiveStatus(status)}>归档</button></div>}
              </article>
            ))}
            {!statuses.length ? <p className="definition-manager__empty">还没有状态，可以新建自定义且未分类的状态。</p> : null}
          </div>
          {statusForm}
          <p className="definition-manager__footnote">已被投递或历史记录引用的状态只可归档。此面板不提供硬删除。</p>
        </section>
      </div>
    </section>
  );
}
