import { DomainError, requireRule } from '../errors.js';
import { validateInstant } from '../validation.js';
import type { ProgressPhase, R1DefinitionsSnapshot, StageCategory, StageDefinition, StatusDefinition, StatusSemanticsVersion, StatusSemantic } from './types.js';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function validateDefinitions(input: R1DefinitionsSnapshot): void {
  const stageIds = new Set<string>();
  for (const stage of input.stages) {
    requireRule(!!stage.id && !!stage.name.trim() && !stageIds.has(stage.id), '环节 ID 必须唯一且名称不能为空');
    requireRule(['screening', 'written_test', 'assessment', 'ai_interview', 'interview', 'pool', 'offer', 'custom'].includes(stage.category), '环节分类无效');
    requireRule(typeof stage.countsAsInterview === 'boolean', '面试统计定义无效');
    requireRule(Number.isSafeInteger(stage.sortOrder), '环节顺序无效');
    requireRule(Number.isSafeInteger(stage.interviewRound ?? 0) && (stage.interviewRound ?? 0) >= 0, '面试轮次无效');
    if (stage.archivedAt !== null) validateInstant(stage.archivedAt);
    stageIds.add(stage.id);
  }
  const statusIds = new Set<string>();
  for (const status of input.statuses) {
    requireRule(!!status.id && !!status.name.trim() && !statusIds.has(status.id), '状态 ID 必须唯一且名称不能为空');
    requireRule(HEX_COLOR.test(status.color), '状态颜色必须是六位十六进制色值');
    requireRule(Number.isSafeInteger(status.sortOrder) && Number.isSafeInteger(status.version) && status.version > 0, '状态版本或顺序无效');
    requireRule(Array.isArray(status.semanticsHistory) && status.semanticsHistory.length === status.version, '状态语义版本历史不完整');
    status.semanticsHistory.forEach((revision, index) => {
      requireRule(revision.version === index + 1, '状态语义版本必须连续');
      requireRule(typeof revision.countsAsInterview === 'boolean', '历史面试统计定义无效');
      requireRule(['draft', 'submitted', 'screening', 'pool', 'stage', 'offer_received', 'offer_accepted', 'offer_declined', 'failed', 'withdrawn', 'custom'].includes(revision.semantic), '历史状态语义无效');
      requireRule(['unknown', 'waiting', 'in_progress', 'awaiting_result', 'passed'].includes(revision.defaultPhase), '历史默认阶段无效');
      requireRule(revision.stageCategory === null || ['screening', 'written_test', 'assessment', 'ai_interview', 'interview', 'pool', 'offer', 'custom'].includes(revision.stageCategory), '历史环节分类无效');
      requireRule(revision.stageId === null || stageIds.has(revision.stageId), '历史状态引用的环节不存在');
      requireRule((revision.stageId === null) === (revision.stageCategory === null), '状态环节与历史分类快照必须同时存在');
      requireRule(revision.stageId !== null || revision.defaultPhase === 'unknown', '无关联环节的状态 phase 必须为 unknown');
      if (['draft', 'submitted', 'screening', 'pool', 'offer_received', 'offer_accepted', 'offer_declined', 'failed', 'withdrawn'].includes(revision.semantic)) requireRule(revision.defaultPhase === 'unknown', '该历史状态的 phase 必须为 unknown');
      if (['offer_received', 'offer_accepted', 'offer_declined'].includes(revision.semantic)) requireRule(input.stages.find(s => s.id === revision.stageId)?.category === 'offer', 'Offer 状态必须关联 Offer 环节');
    });
    const latest = status.semanticsHistory.at(-1)!;
    requireRule(latest.version === status.version && latest.semantic === status.semantic && latest.stageId === status.stageId && latest.defaultPhase === status.defaultPhase && latest.statisticsCategory === status.statisticsCategory, '当前状态定义与最新语义版本不一致');
    const currentStage = input.stages.find(stage => stage.id === status.stageId);
    requireRule(status.stageId !== null || status.defaultPhase === 'unknown', '无关联环节的状态 phase 必须为 unknown');
    requireRule(latest.countsAsInterview === (currentStage?.countsAsInterview ?? false), '当前状态的面试统计定义不一致');
    requireRule(latest.stageCategory === (currentStage?.category ?? null), '当前状态环节分类版本不一致');
    if (status.archivedAt !== null) validateInstant(status.archivedAt);
    requireRule(['draft', 'submitted', 'screening', 'pool', 'stage', 'offer_received', 'offer_accepted', 'offer_declined', 'failed', 'withdrawn', 'custom'].includes(status.semantic), '状态语义无效');
    requireRule(['unknown', 'waiting', 'in_progress', 'awaiting_result', 'passed'].includes(status.defaultPhase), '默认环节结果无效');
    if (['draft', 'submitted', 'screening', 'pool', 'offer_received', 'offer_accepted', 'offer_declined', 'failed', 'withdrawn'].includes(status.semantic)) requireRule(status.defaultPhase === 'unknown', '该状态的 phase 必须为 unknown');
    requireRule(status.stageId === null || stageIds.has(status.stageId), '状态引用的环节不存在');
    const referencedStage = input.stages.find(stage => stage.id === status.stageId);
    if (status.archivedAt === null) requireRule(!referencedStage || referencedStage.archivedAt === null, '可用状态不能关联已归档环节');
    if (['offer_received', 'offer_accepted', 'offer_declined'].includes(status.semantic)) {
      const stage = input.stages.find(s => s.id === status.stageId);
      requireRule(stage?.category === 'offer', 'Offer 状态必须关联 Offer 环节');
    }
    statusIds.add(status.id);
  }
}

export interface DefinitionRepository {
  snapshot(): R1DefinitionsSnapshot;
  createStage(input: Omit<StageDefinition, 'archivedAt'> & { archivedAt?: null }): StageDefinition;
  renameStage(id: string, name: string): StageDefinition;
  reorderStage(id: string, sortOrder: number): StageDefinition;
  updateStage(id: string, change: Pick<StageDefinition, 'category' | 'countsAsInterview' | 'interviewRound'>): StageDefinition;
  archiveStage(id: string, at: string): StageDefinition;
  createStatus(input: Omit<StatusDefinition, 'archivedAt' | 'version' | 'semanticsHistory'> & { archivedAt?: null }): StatusDefinition;
  renameStatus(id: string, name: string): StatusDefinition;
  updateStatusColor(id: string, color: string): StatusDefinition;
  updateStatusSemantics(id: string, change: Pick<StatusDefinition, 'semantic' | 'stageId' | 'defaultPhase' | 'statisticsCategory'>): StatusDefinition;
  reorderStatus(id: string, sortOrder: number): StatusDefinition;
  archiveStatus(id: string, at: string): StatusDefinition;
  deleteStatus(id: string): void;
}

export function createDefinitionRepository(seed: R1DefinitionsSnapshot, options: { id?: () => string; isStatusUsed: (id: string) => boolean }): DefinitionRepository {
  let value = structuredClone(seed);
  const id = options.id ?? (() => crypto.randomUUID());
  const findStage = (snapshot: R1DefinitionsSnapshot, key: string) => { const result = snapshot.stages.find(x => x.id === key); if (!result) throw new DomainError('NOT_FOUND', '环节不存在'); return result; };
  const findStatus = (snapshot: R1DefinitionsSnapshot, key: string) => { const result = snapshot.statuses.find(x => x.id === key); if (!result) throw new DomainError('NOT_FOUND', '状态不存在'); return result; };
  const save = <T>(next: R1DefinitionsSnapshot, result: T): T => { validateDefinitions(next); value = next; return structuredClone(result); };
  validateDefinitions(value);
  return {
    snapshot() { return structuredClone(value); },
    createStage(input) {
      const next = structuredClone(value); requireRule(!next.stages.some(x => x.id === input.id), '环节 ID 已存在');
      const created: StageDefinition = { ...input, archivedAt: null }; next.stages.push(created); return save(next, created);
    },
    renameStage(key, name) { requireRule(!!name.trim(), '环节名称不能为空'); const next = structuredClone(value); const result = findStage(next, key); result.name = name.trim(); return save(next, result); },
    reorderStage(key, sortOrder) { requireRule(Number.isSafeInteger(sortOrder), '环节顺序无效'); const next = structuredClone(value); const result = findStage(next, key); result.sortOrder = sortOrder; return save(next, result); },
    updateStage(key, change) {
      const next = structuredClone(value); const result = findStage(next, key); const countsChanged = result.countsAsInterview !== change.countsAsInterview; const categoryChanged = result.category !== change.category;
      Object.assign(result, change);
      if (countsChanged || categoryChanged) for (const item of next.statuses.filter(status => status.stageId === key)) {
        item.version += 1;
        item.semanticsHistory.push(semanticsVersion(item, result.countsAsInterview, result.category));
      }
      return save(next, result);
    },
    archiveStage(key, at) { validateInstant(at); const next = structuredClone(value); const result = findStage(next, key); result.archivedAt = at; for (const item of next.statuses) if (item.stageId === key) item.archivedAt = at; return save(next, result); },
    createStatus(input) {
      const next = structuredClone(value); const stage = next.stages.find(item => item.id === input.stageId); const created: StatusDefinition = { ...input, archivedAt: null, version: 1, semanticsHistory: [] };
      created.semanticsHistory.push(semanticsVersion(created, stage?.countsAsInterview ?? false, stage?.category ?? null));
      requireRule(!next.statuses.some(x => x.id === created.id), '状态 ID 已存在'); next.statuses.push(created); return save(next, created);
    },
    renameStatus(key, name) { requireRule(!!name.trim(), '状态名称不能为空'); const next = structuredClone(value); const result = findStatus(next, key); result.name = name.trim(); return save(next, result); },
    updateStatusColor(key, color) { const next = structuredClone(value); const result = findStatus(next, key); result.color = color; return save(next, result); },
    updateStatusSemantics(key, change) { const next = structuredClone(value); const result = findStatus(next, key); Object.assign(result, change); result.version += 1; const stage = next.stages.find(item => item.id === result.stageId); result.semanticsHistory.push(semanticsVersion(result, stage?.countsAsInterview ?? false, stage?.category ?? null)); return save(next, result); },
    reorderStatus(key, sortOrder) { requireRule(Number.isSafeInteger(sortOrder), '状态顺序无效'); const next = structuredClone(value); const result = findStatus(next, key); result.sortOrder = sortOrder; return save(next, result); },
    archiveStatus(key, at) { validateInstant(at); const next = structuredClone(value); const result = findStatus(next, key); result.archivedAt = at; return save(next, result); },
    deleteStatus(key) {
      const next = structuredClone(value); const result = findStatus(next, key); requireRule(result.archivedAt !== null, '删除前必须先归档状态');
      requireRule(!options.isStatusUsed(key), '已被事件引用的状态只能归档'); next.statuses = next.statuses.filter(x => x.id !== key); save(next, undefined);
    },
  };
}

const semanticsVersion = (status: Pick<StatusDefinition, 'version' | 'semantic' | 'stageId' | 'defaultPhase' | 'statisticsCategory'>, countsAsInterview: boolean, stageCategory: StageCategory | null): StatusSemanticsVersion => ({
  version: status.version,
  semantic: status.semantic,
  stageId: status.stageId,
  stageCategory,
  defaultPhase: status.defaultPhase,
  statisticsCategory: status.statisticsCategory,
  countsAsInterview,
});

const stage = (id: string, name: string, category: StageCategory, sortOrder: number, countsAsInterview = false, interviewRound?: number): StageDefinition => ({ id, name, category, sortOrder, archivedAt: null, countsAsInterview, ...(interviewRound === undefined ? {} : { interviewRound }) });
const status = (id: string, name: string, semantic: StatusSemantic, stageId: string | null, sortOrder: number, color: string, defaultPhase: ProgressPhase = 'unknown', statisticsCategory: string | null = null, countsAsInterview = false, stageCategory: StageCategory | null = stageId === null ? null : 'custom'): StatusDefinition => ({ id, name, semantic, stageId, sortOrder, color, defaultPhase, statisticsCategory, archivedAt: null, version: 1, semanticsHistory: [{ version: 1, semantic, stageId, stageCategory, defaultPhase, statisticsCategory, countsAsInterview }] });

/** Initial template only; it does not create any application progress events. */
export function defaultR1Definitions(): R1DefinitionsSnapshot {
  const stages = [
    stage('screening', '简历筛选', 'screening', 10), stage('written_test', '笔试', 'written_test', 20), stage('assessment', '测评', 'assessment', 30),
    stage('ai_interview', 'AI 面', 'ai_interview', 40), stage('interview_1', '一面', 'interview', 50, true, 1), stage('interview_2', '二面', 'interview', 60, true, 2),
    stage('interview_3', '三面', 'interview', 70, true, 3), stage('interview_4', '四面', 'interview', 80, true, 4), stage('interview_extra', '加面', 'interview', 90, true),
    stage('pool', '泡池子', 'pool', 100), stage('offer', 'Offer', 'offer', 110),
  ];
  const statuses: StatusDefinition[] = [
    status('draft', '待投递', 'draft', null, 0, '#9b8f83'), status('submitted', '已投递', 'submitted', null, 1, '#b87962', 'unknown', 'submitted'),
    status('screening', '筛选中', 'screening', 'screening', 10, '#c39b63', 'unknown', 'screening'), status('pool', '泡池子', 'pool', 'pool', 100, '#c39b63', 'unknown', 'pool'),
    status('written_test_waiting', '待笔试', 'stage', 'written_test', 20, '#c39b63', 'waiting', 'written_test'), status('written_test_active', '笔试中', 'stage', 'written_test', 21, '#b87962', 'in_progress', 'written_test'), status('written_test_result', '笔试待结果', 'stage', 'written_test', 22, '#c39b63', 'awaiting_result', 'written_test'), status('written_test_passed', '笔试通过', 'stage', 'written_test', 23, '#8c9a70', 'passed', 'written_test'),
    status('assessment_waiting', '待测评', 'stage', 'assessment', 30, '#c39b63', 'waiting', 'assessment'), status('assessment_active', '测评中', 'stage', 'assessment', 31, '#b87962', 'in_progress', 'assessment'), status('assessment_result', '测评待结果', 'stage', 'assessment', 32, '#c39b63', 'awaiting_result', 'assessment'), status('assessment_passed', '测评通过', 'stage', 'assessment', 33, '#8c9a70', 'passed', 'assessment'),
    status('ai_waiting', '待 AI 面', 'stage', 'ai_interview', 40, '#c39b63', 'waiting', 'ai_interview'), status('ai_active', 'AI 面中', 'stage', 'ai_interview', 41, '#b87962', 'in_progress', 'ai_interview'), status('ai_result', 'AI 面待结果', 'stage', 'ai_interview', 42, '#c39b63', 'awaiting_result', 'ai_interview'), status('ai_passed', 'AI 面通过', 'stage', 'ai_interview', 43, '#8c9a70', 'passed', 'ai_interview'),
    ...stages.filter(s => s.category === 'interview').flatMap(s => [status(`${s.id}_waiting`, `待${s.name}`, 'stage', s.id, s.sortOrder, '#c39b63', 'waiting', s.id, true), status(`${s.id}_active`, `${s.name}中`, 'stage', s.id, s.sortOrder + 1, '#b87962', 'in_progress', s.id, true), status(`${s.id}_result`, `${s.name}待结果`, 'stage', s.id, s.sortOrder + 2, '#c39b63', 'awaiting_result', s.id, true), status(`${s.id}_passed`, `${s.name}通过`, 'stage', s.id, s.sortOrder + 3, '#8c9a70', 'passed', s.id, true)]),
    status('offer_received', '拿 Offer', 'offer_received', 'offer', 110, '#c39b63', 'unknown', 'offer_received'), status('offer_accepted', '已接受（Offer）', 'offer_accepted', 'offer', 111, '#8c9a70', 'unknown', 'offer_accepted'), status('offer_declined', '已拒绝（Offer）', 'offer_declined', 'offer', 112, '#9b8f83', 'unknown', 'offer_declined'),
    ...stages.filter(s => s.category !== 'offer' && s.category !== 'pool').map(s => status(`${s.id}_failed`, s.category === 'screening' ? '简历挂' : `${s.name}挂`, 'failed', s.id, s.sortOrder + 4, '#b87962', 'unknown', 'failed')),
    status('failed_unknown', '挂掉（环节未知）', 'failed', null, 114, '#b87962', 'unknown', 'failed'), status('withdrawn', '主动退出', 'withdrawn', null, 120, '#9b8f83', 'unknown', 'withdrawn'),
  ];
  for (const item of statuses) {
    const linkedStage = stages.find(candidate => candidate.id === item.stageId);
    item.semanticsHistory[0]!.countsAsInterview = linkedStage?.countsAsInterview ?? false;
    item.semanticsHistory[0]!.stageCategory = linkedStage?.category ?? null;
  }
  return { stages, statuses };
}
