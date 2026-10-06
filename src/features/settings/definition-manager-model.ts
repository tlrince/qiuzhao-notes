import type {
  ProgressPhase,
  R1DefinitionsSnapshot,
  StageCategory,
  StageDefinition,
  StatusDefinition,
  StatusSemantic,
} from '../../domain/v2/types.js';
import type { StageDefinitionPatch, StatusDefinitionPatch } from '../../repositories/v2/definition-commands.js';

export interface StageDefinitionDraft {
  name: string;
  category: StageCategory;
  sortOrder: string;
  countsAsInterview: boolean;
  interviewRound: string;
}

export interface StatusDefinitionDraft {
  name: string;
  color: string;
  sortOrder: string;
  semantic: StatusSemantic;
  stageId: string;
  defaultPhase: ProgressPhase;
  statisticsCategory: string;
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const STAGE_CATEGORY_LABELS: Record<StageCategory, string> = {
  screening: '筛选',
  written_test: '笔试',
  assessment: '测评',
  ai_interview: 'AI 面',
  interview: '人工面试',
  pool: '泡池子',
  offer: 'Offer',
  custom: '自定义',
};

export const STATUS_SEMANTIC_LABELS: Record<StatusSemantic, string> = {
  draft: '待投递',
  submitted: '已投递',
  screening: '筛选中',
  pool: '泡池子',
  stage: '普通阶段',
  offer_received: '获得 Offer',
  offer_accepted: '接受 Offer',
  offer_declined: '拒绝 Offer',
  failed: '失败',
  withdrawn: '主动退出',
  custom: '自定义（未分类）',
};

export const PROGRESS_PHASE_LABELS: Record<ProgressPhase, string> = {
  unknown: '未分类',
  waiting: '待进行',
  in_progress: '进行中',
  awaiting_result: '待结果',
  passed: '已通过',
};

export const STAGE_CATEGORIES = Object.keys(STAGE_CATEGORY_LABELS) as StageCategory[];
export const STATUS_SEMANTICS = Object.keys(STATUS_SEMANTIC_LABELS) as StatusSemantic[];
export const PROGRESS_PHASES = Object.keys(PROGRESS_PHASE_LABELS) as ProgressPhase[];

export function orderedStages(definitions: R1DefinitionsSnapshot): StageDefinition[] {
  return [...definitions.stages].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function orderedStatuses(definitions: R1DefinitionsSnapshot): StatusDefinition[] {
  return [...definitions.statuses].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function stageDraftFrom(stage?: StageDefinition): StageDefinitionDraft {
  return {
    name: stage?.name ?? '',
    category: stage?.category ?? 'custom',
    sortOrder: String(stage?.sortOrder ?? 0),
    countsAsInterview: stage?.countsAsInterview ?? false,
    interviewRound: stage?.interviewRound === undefined ? '' : String(stage.interviewRound),
  };
}

export function statusDraftFrom(status?: StatusDefinition): StatusDefinitionDraft {
  return {
    name: status?.name ?? '',
    color: status?.color ?? '#76835f',
    sortOrder: String(status?.sortOrder ?? 0),
    semantic: status?.semantic ?? 'custom',
    stageId: status?.stageId ?? '',
    defaultPhase: status?.defaultPhase ?? 'unknown',
    statisticsCategory: status?.statisticsCategory ?? '',
  };
}

function orderValue(raw: string): DraftResult<number> {
  const value = Number(raw);
  return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, error: '排序值必须是整数' };
}

function validateStatusSemantics(draft: StatusDefinitionDraft, definitions: R1DefinitionsSnapshot): string | null {
  const stage = draft.stageId ? definitions.stages.find(item => item.id === draft.stageId) : null;
  if (draft.stageId && !stage) return '所属环节不存在';
  if (stage?.archivedAt !== null && stage !== null) return '可用状态不能关联已归档环节';
  if (!stage && draft.defaultPhase !== 'unknown') return '未关联环节时，流程结果必须为未分类';
  if (['draft', 'submitted', 'screening', 'pool', 'offer_received', 'offer_accepted', 'offer_declined', 'failed', 'withdrawn'].includes(draft.semantic)
    && draft.defaultPhase !== 'unknown') return `${STATUS_SEMANTIC_LABELS[draft.semantic]}状态的流程结果必须为未分类`;
  if (['draft', 'submitted', 'withdrawn'].includes(draft.semantic) && stage) return `${STATUS_SEMANTIC_LABELS[draft.semantic]}状态不能关联环节`;
  if (draft.semantic === 'screening' && stage?.category !== 'screening') return '筛选中状态必须关联筛选类环节';
  if (draft.semantic === 'pool' && stage?.category !== 'pool') return '泡池子状态必须关联泡池子类环节';
  if (draft.semantic === 'stage' && !stage) return '普通阶段状态必须关联环节';
  if (['offer_received', 'offer_accepted', 'offer_declined'].includes(draft.semantic) && stage?.category !== 'offer') return 'Offer 结果状态必须关联 Offer 类环节';
  return null;
}

export function stageDraftToValues(draft: StageDefinitionDraft): DraftResult<Omit<StageDefinition, 'id' | 'archivedAt'>> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: '环节名称不能为空' };
  const sortOrder = orderValue(draft.sortOrder);
  if (!sortOrder.ok) return sortOrder;
  let interviewRound: number | undefined;
  if (draft.interviewRound.trim()) {
    interviewRound = Number(draft.interviewRound);
    if (!Number.isSafeInteger(interviewRound) || interviewRound < 0) return { ok: false, error: '面试轮次必须是零或正整数' };
  }
  return {
    ok: true,
    value: {
      name,
      category: draft.category,
      sortOrder: sortOrder.value,
      countsAsInterview: draft.countsAsInterview,
      ...(interviewRound === undefined ? {} : { interviewRound }),
    },
  };
}

export function stageDraftToPatch(draft: StageDefinitionDraft, current: StageDefinition): DraftResult<StageDefinitionPatch> {
  const values = stageDraftToValues(draft);
  if (!values.ok) return values;
  const patch: StageDefinitionPatch = {
    name: values.value.name,
    category: values.value.category,
    sortOrder: values.value.sortOrder,
    countsAsInterview: values.value.countsAsInterview,
  };
  if (draft.interviewRound.trim()) patch.interviewRound = values.value.interviewRound ?? 0;
  else if (current.interviewRound !== undefined) patch.interviewRound = current.interviewRound;
  return { ok: true, value: patch };
}

export function statusDraftToValues(
  draft: StatusDefinitionDraft,
  definitions: R1DefinitionsSnapshot,
): DraftResult<Omit<StatusDefinition, 'id' | 'archivedAt' | 'version' | 'semanticsHistory'>> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: '状态名称不能为空' };
  if (!/^#[0-9a-f]{6}$/i.test(draft.color)) return { ok: false, error: '颜色必须是六位十六进制色值' };
  const sortOrder = orderValue(draft.sortOrder);
  if (!sortOrder.ok) return sortOrder;
  const statisticsCategory = draft.statisticsCategory.trim() || null;
  const normalized: StatusDefinitionDraft = { ...draft, name, sortOrder: String(sortOrder.value), statisticsCategory: statisticsCategory ?? '' };
  const semanticsError = validateStatusSemantics(normalized, definitions);
  if (semanticsError) return { ok: false, error: semanticsError };
  return {
    ok: true,
    value: {
      name,
      color: draft.color.toLowerCase(),
      sortOrder: sortOrder.value,
      semantic: draft.semantic,
      stageId: draft.stageId || null,
      defaultPhase: draft.defaultPhase,
      statisticsCategory,
    },
  };
}

export function statusDraftToPatch(
  draft: StatusDefinitionDraft,
  definitions: R1DefinitionsSnapshot,
): DraftResult<StatusDefinitionPatch> {
  const values = statusDraftToValues(draft, definitions);
  return values.ok ? { ok: true, value: values.value } : values;
}

