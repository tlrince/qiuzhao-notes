import { useMemo, useState, type FormEvent } from 'react';
import type { ProgressPhase, R1DefinitionsSnapshot, StageCategory, StageDefinition, StatusDefinition, StatusSemantic } from '../../domain/v2/types.js';
import type { StageDefinitionPatch, StatusDefinitionPatch } from '../../repositories/v2/definition-commands.js';
import { orderedStages, orderedStatuses, STAGE_CATEGORIES, STAGE_CATEGORY_LABELS } from './definition-manager-model.js';
import { ConfirmDialog } from '../../shared/ui/Dialog.js';
import './DefinitionManager.css';

export interface DefinitionManagerCommands {
  onCreateStage(input: { name: string; category: StageCategory; sortOrder: number; countsAsInterview: boolean; withStatuses: boolean }): Promise<unknown>;
  onUpdateStage(input: { stageId: string; patch: StageDefinitionPatch }): Promise<unknown>;
  onArchiveStage(stageId: string): Promise<unknown>;
  onUnarchiveStage(stageId: string): Promise<unknown>;
  onCreateStatus(input: { name: string; color: string; sortOrder: number; semantic: StatusSemantic; stageId: string | null; defaultPhase: ProgressPhase; statisticsCategory: string | null }): Promise<unknown>;
  onUpdateStatus(input: { statusId: string; patch: StatusDefinitionPatch }): Promise<unknown>;
  onArchiveStatus(statusId: string): Promise<unknown>;
  onUnarchiveStatus(statusId: string): Promise<unknown>;
}

export interface DefinitionManagerProps {
  definitions: R1DefinitionsSnapshot;
  onCommand: DefinitionManagerCommands;
}

/** What a new status means inside its stage. */
type StatusKind = 'waiting' | 'in_progress' | 'awaiting_result' | 'passed' | 'failed' | 'plain';
const KIND_LABELS: Record<StatusKind, string> = { waiting: '待进行', in_progress: '进行中', awaiting_result: '待结果', passed: '已通过', failed: '挂掉', plain: '普通' };
const KIND_COLORS: Record<StatusKind, string> = { waiting: '#c39b63', in_progress: '#0d9488', awaiting_result: '#c39b63', passed: '#8c9a70', failed: '#b87962', plain: '#94a3b8' };
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '保存失败，请重试';

function kindsFor(stage: StageDefinition | null): StatusKind[] {
  if (!stage) return ['plain'];
  if (stage.category === 'screening' || stage.category === 'pool') return ['plain', 'failed'];
  return ['waiting', 'in_progress', 'awaiting_result', 'passed', 'failed'];
}

function previewStatuses(name: string, category: StageCategory): string[] {
  const label = name.trim() || 'X';
  if (category === 'offer') return [];
  if (category === 'pool') return [label];
  if (category === 'screening') return [`${label}中`, `${label}挂`];
  return [`待${label}`, `${label}中`, `${label}待结果`, `${label}通过`, `${label}挂`];
}

function StatusEditor({ status, onCommand, onDone }: { status: StatusDefinition; onCommand: DefinitionManagerCommands; onDone: (message: string) => void }) {
  const [name, setName] = useState(status.name);
  const [color, setColor] = useState(status.color);
  const [error, setError] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch: StatusDefinitionPatch = {};
    if (name.trim() !== status.name) patch.name = name.trim();
    if (color.toLowerCase() !== status.color.toLowerCase()) patch.color = color.toLowerCase();
    if (!Object.keys(patch).length) { onDone(''); return; }
    try { await onCommand.onUpdateStatus({ statusId: status.id, patch }); onDone(`已保存「${name.trim()}」`); }
    catch (cause) { setError(errorText(cause)); }
  };
  const archive = () => {
    setConfirmArchive(false);
    void onCommand.onArchiveStatus(status.id).then(() => onDone(`已归档「${status.name}」，可在下方「已归档」里恢复`), cause => setError(errorText(cause)));
  };
  return <form className="definition-manager__inline" onSubmit={save} aria-label={`编辑状态 ${status.name}`}>
    <input type="color" aria-label="状态颜色" value={color} onChange={event => setColor(event.target.value)} />
    <input aria-label="状态名称" required autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} />
    <button type="submit">保存</button>
    <button type="button" className="definition-manager__quiet" onClick={() => onDone('')}>取消</button>
    <button type="button" className="definition-manager__danger" onClick={() => setConfirmArchive(true)}>归档</button>
    {error ? <p className="definition-manager__error" role="alert">{error}</p> : null}
    <ConfirmDialog open={confirmArchive} onCancel={() => setConfirmArchive(false)} onConfirm={archive} title={`归档「${status.name}」？`} description="归档后新记录不能再选这个状态；已有的投递和历史照常显示，之后可以恢复。" confirmLabel="归档" cancelLabel="取消" />
  </form>;
}

function AddStatusForm({ stage, nextOrder, onCommand, onDone }: { stage: StageDefinition | null; nextOrder: number; onCommand: DefinitionManagerCommands; onDone: (message: string) => void }) {
  const kinds = kindsFor(stage);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<StatusKind>(kinds[0]!);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const semantic: StatusSemantic = kind === 'failed' ? 'failed' : !stage ? 'custom' : stage.category === 'screening' ? 'screening' : stage.category === 'pool' ? 'pool' : 'stage';
    const defaultPhase: ProgressPhase = kind === 'failed' || kind === 'plain' ? 'unknown' : kind;
    try {
      await onCommand.onCreateStatus({ name: name.trim(), color: KIND_COLORS[kind], sortOrder: nextOrder, semantic, stageId: stage?.id ?? null, defaultPhase, statisticsCategory: kind === 'failed' ? 'failed' : stage?.id ?? null });
      onDone(`已添加「${name.trim()}」`);
    } catch (cause) { setError(errorText(cause)); }
  };
  return <form className="definition-manager__inline" onSubmit={submit} aria-label={stage ? `给${stage.name}添加状态` : '添加不属于环节的状态'}>
    <input aria-label="新状态名称" required autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder={stage ? `如：${stage.name}加面` : '如：暂缓'} />
    {kinds.length > 1 ? <select aria-label="状态含义" value={kind} onChange={event => setKind(event.target.value as StatusKind)}>{kinds.map(item => <option key={item} value={item}>{KIND_LABELS[item]}</option>)}</select> : null}
    <button type="submit">添加</button>
    <button type="button" className="definition-manager__quiet" onClick={() => onDone('')}>取消</button>
    {error ? <p className="definition-manager__error" role="alert">{error}</p> : null}
  </form>;
}

function StageEditor({ stage, onCommand, onDone }: { stage: StageDefinition; onCommand: DefinitionManagerCommands; onDone: (message: string) => void }) {
  const [name, setName] = useState(stage.name);
  const [category, setCategory] = useState<StageCategory>(stage.category);
  const [countsAsInterview, setCountsAsInterview] = useState(stage.countsAsInterview);
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch: StageDefinitionPatch = {};
    if (name.trim() !== stage.name) patch.name = name.trim();
    if (category !== stage.category) patch.category = category;
    if (countsAsInterview !== stage.countsAsInterview) patch.countsAsInterview = countsAsInterview;
    if (!Object.keys(patch).length) { onDone(''); return; }
    try { await onCommand.onUpdateStage({ stageId: stage.id, patch }); onDone(patch.name ? `已改名为「${patch.name}」，它的状态名也一起更新了` : '环节已保存'); }
    catch (cause) { setError(errorText(cause)); }
  };
  return <form className="definition-manager__inline definition-manager__inline--stage" onSubmit={save} aria-label={`编辑环节 ${stage.name}`}>
    <input aria-label="环节名称" required autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} />
    <select aria-label="统计分类" value={category} onChange={event => setCategory(event.target.value as StageCategory)}>
      {STAGE_CATEGORIES.map(value => <option key={value} value={value}>{STAGE_CATEGORY_LABELS[value]}</option>)}
    </select>
    <label className="definition-manager__check"><input type="checkbox" checked={countsAsInterview} onChange={event => setCountsAsInterview(event.target.checked)} />计入面试统计</label>
    <button type="submit">保存</button>
    <button type="button" className="definition-manager__quiet" onClick={() => onDone('')}>取消</button>
    {error ? <p className="definition-manager__error" role="alert">{error}</p> : null}
  </form>;
}

/** Stage-first configuration: every stage card owns its statuses, so renames and archives happen in one place. */
export function DefinitionManager({ definitions, onCommand }: DefinitionManagerProps) {
  const stages = useMemo(() => orderedStages(definitions), [definitions]);
  const statuses = useMemo(() => orderedStatuses(definitions), [definitions]);
  const liveStages = stages.filter(stage => stage.archivedAt === null);
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [archiving, setArchiving] = useState<StageDefinition | null>(null);
  const [newStage, setNewStage] = useState({ name: '', category: 'interview' as StageCategory, countsAsInterview: true, withStatuses: true });

  const done = (text: string) => { setEditing(null); setError(''); if (text) setMessage(text); };
  const run = (action: () => Promise<unknown>, text: string) => {
    setError('');
    setMessage('');
    void action().then(() => setMessage(text), cause => setError(errorText(cause)));
  };
  const liveStatusesOf = (stageId: string | null) => statuses.filter(status => status.stageId === stageId && status.archivedAt === null);
  const archivedStages = stages.filter(stage => stage.archivedAt !== null);
  // Statuses archived together with their stage come back with it, so only list the ones that can be restored alone.
  const archivedStatuses = statuses.filter(status => status.archivedAt !== null
    && (status.stageId === null || stages.find(stage => stage.id === status.stageId)?.archivedAt === null));
  const nextStageOrder = Math.max(0, ...liveStages.filter(stage => stage.category !== 'pool' && stage.category !== 'offer').map(stage => stage.sortOrder)) + 10;

  const move = (stage: StageDefinition, direction: -1 | 1) => {
    const neighbour = liveStages[liveStages.indexOf(stage) + direction];
    if (!neighbour) return;
    run(async () => {
      await onCommand.onUpdateStage({ stageId: stage.id, patch: { sortOrder: neighbour.sortOrder } });
      await onCommand.onUpdateStage({ stageId: neighbour.id, patch: { sortOrder: stage.sortOrder } });
    }, `已调整「${stage.name}」的顺序`);
  };

  const createStage = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    const name = newStage.name.trim();
    try {
      await onCommand.onCreateStage({ name, category: newStage.category, sortOrder: nextStageOrder, countsAsInterview: newStage.countsAsInterview, withStatuses: newStage.withStatuses });
      setMessage(`已新增环节「${name}」${newStage.withStatuses && newStage.category !== 'offer' ? '和它的常用状态' : ''}`);
      setNewStage(current => ({ ...current, name: '' }));
    } catch (cause) { setError(errorText(cause)); }
  };

  const renderStatuses = (stage: StageDefinition | null) => {
    const key = stage?.id ?? 'none';
    const list = liveStatusesOf(stage?.id ?? null);
    return <div className="definition-manager__chips" aria-label={stage ? `${stage.name}的状态` : '不属于具体环节的状态'}>
      {list.map(status => editing === `status:${status.id}`
        ? <StatusEditor key={status.id} status={status} onCommand={onCommand} onDone={done} />
        : <button key={status.id} type="button" className="definition-manager__chip" onClick={() => setEditing(`status:${status.id}`)} title="点击改名、换颜色或归档">
          <span className="definition-manager__swatch" style={{ backgroundColor: status.color }} aria-hidden="true" />{status.name}
        </button>)}
      {editing === `add:${key}`
        ? <AddStatusForm stage={stage} nextOrder={Math.max(stage?.sortOrder ?? 900, ...list.map(status => status.sortOrder)) + 1} onCommand={onCommand} onDone={done} />
        : <button type="button" className="definition-manager__chip definition-manager__chip--add" onClick={() => setEditing(`add:${key}`)}>＋ 状态</button>}
    </div>;
  };

  return <section className="definition-manager">
    <header className="definition-manager__header">
      <h1>状态与环节</h1>
      <p>每个环节自带一组状态，例如一面下有 待一面、一面中、一面待结果、一面通过、一面挂。给环节改名时，它的状态名会一起改；已经记下的历史保留当时的名字。点状态可以改名、换颜色或归档。</p>
    </header>
    {message ? <p className="definition-manager__success" role="status">{message}</p> : null}
    {error ? <p className="definition-manager__error" role="alert">{error}</p> : null}

    <div className="definition-manager__stages" aria-label="环节与状态">
      {liveStages.map((stage, index) => <article key={stage.id} className="definition-manager__stage" aria-label={`环节 ${stage.name}`}>
        <div className="definition-manager__stage-head">
          {editing === `stage:${stage.id}`
            ? <StageEditor stage={stage} onCommand={onCommand} onDone={done} />
            : <>
              <div className="definition-manager__stage-title"><strong>{stage.name}</strong><span>{STAGE_CATEGORY_LABELS[stage.category]}{stage.countsAsInterview ? ' · 计入面试' : ''}</span></div>
              <div className="definition-manager__stage-actions">
                <button type="button" className="definition-manager__icon" aria-label={`把${stage.name}上移`} disabled={index === 0} onClick={() => move(stage, -1)}>↑</button>
                <button type="button" className="definition-manager__icon" aria-label={`把${stage.name}下移`} disabled={index === liveStages.length - 1} onClick={() => move(stage, 1)}>↓</button>
                <button type="button" className="definition-manager__quiet" onClick={() => setEditing(`stage:${stage.id}`)}>编辑</button>
                <button type="button" className="definition-manager__danger" onClick={() => setArchiving(stage)}>归档</button>
              </div>
            </>}
        </div>
        {renderStatuses(stage)}
      </article>)}
      <article className="definition-manager__stage definition-manager__stage--plain" aria-label="不属于具体环节">
        <div className="definition-manager__stage-head"><div className="definition-manager__stage-title"><strong>不属于具体环节</strong><span>待投递、已投递、环节未知的挂掉、主动退出等</span></div></div>
        {renderStatuses(null)}
      </article>
    </div>

    <form className="definition-manager__new" onSubmit={createStage} aria-label="新增环节">
      <h2>新增环节</h2>
      <div className="definition-manager__new-fields">
        <label><span>环节名称</span><input required maxLength={80} value={newStage.name} onChange={event => setNewStage(current => ({ ...current, name: event.target.value }))} placeholder="如：HR 面" /></label>
        <label><span>统计分类</span><select value={newStage.category} onChange={event => { const category = event.target.value as StageCategory; setNewStage(current => ({ ...current, category, countsAsInterview: category === 'interview' })); }}>
          {STAGE_CATEGORIES.map(value => <option key={value} value={value}>{STAGE_CATEGORY_LABELS[value]}</option>)}
        </select></label>
        <label className="definition-manager__check"><input type="checkbox" checked={newStage.countsAsInterview} onChange={event => setNewStage(current => ({ ...current, countsAsInterview: event.target.checked }))} />计入面试统计</label>
        <label className="definition-manager__check"><input type="checkbox" checked={newStage.withStatuses} onChange={event => setNewStage(current => ({ ...current, withStatuses: event.target.checked }))} />同时创建常用状态</label>
        <button type="submit">新增环节</button>
      </div>
      {newStage.withStatuses && previewStatuses(newStage.name, newStage.category).length
        ? <p className="definition-manager__hint">将一起创建：{previewStatuses(newStage.name, newStage.category).join('、')}</p> : null}
    </form>

    {archivedStages.length + archivedStatuses.length > 0 ? <details className="definition-manager__archived">
      <summary>已归档（{archivedStages.length + archivedStatuses.length}）</summary>
      <p className="definition-manager__hint">归档的环节和状态不会出现在新记录的选项里，已有的投递和历史照常显示。恢复环节会连同它当时一起归档的状态。</p>
      <ul>
        {archivedStages.map(stage => <li key={stage.id}><span>环节 · {stage.name}</span><button type="button" className="definition-manager__quiet" onClick={() => run(() => onCommand.onUnarchiveStage(stage.id), `已恢复环节「${stage.name}」`)}>恢复</button></li>)}
        {archivedStatuses.map(status => <li key={status.id}><span>状态 · {status.name}</span><button type="button" className="definition-manager__quiet" onClick={() => run(() => onCommand.onUnarchiveStatus(status.id), `已恢复状态「${status.name}」`)}>恢复</button></li>)}
      </ul>
    </details> : null}

    <ConfirmDialog
      open={archiving !== null}
      onCancel={() => setArchiving(null)}
      onConfirm={() => { const stage = archiving; setArchiving(null); if (stage) run(() => onCommand.onArchiveStage(stage.id), `已归档「${stage.name}」，可在下方「已归档」里恢复`); }}
      title={`归档「${archiving?.name ?? ''}」？`}
      description={`${archiving ? `它的 ${liveStatusesOf(archiving.id).length} 个状态会一起归档。` : ''}新记录不能再选，已有的投递和历史照常显示，之后可以在「已归档」里恢复。`}
      confirmLabel="归档"
      cancelLabel="取消"
    />
  </section>;
}
