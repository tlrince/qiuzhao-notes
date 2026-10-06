import { DomainError, requireRule } from '../../domain/errors.js';
import { validateInstant } from '../../domain/validation.js';
import { validateDefinitions } from '../../domain/v2/definitions.js';
import { validateV2Snapshot, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import type {
  ProgressPhase,
  R1DefinitionsSnapshot,
  StageCategory,
  StageDefinition,
  StatusDefinition,
  StatusSemantic,
  StatusSemanticsVersion,
} from '../../domain/v2/types.js';
import type { SnapshotStoreV2 } from '../storage-v2-contract.js';

export interface DefinitionCommandContext {
  now: () => string;
  id: () => string;
}

export interface WorkspaceRevisionInput {
  workspaceId: string;
  expectedRevision: number;
}

export interface CreateStageInput extends WorkspaceRevisionInput {
  id?: string;
  name: string;
  category: StageCategory;
  sortOrder: number;
  countsAsInterview?: boolean;
  interviewRound?: number;
}

export type StageDefinitionPatch = Partial<Pick<StageDefinition,
  'name' | 'category' | 'sortOrder' | 'countsAsInterview' | 'interviewRound'
>>;

export interface CreateStatusInput extends WorkspaceRevisionInput {
  id?: string;
  name: string;
  color: string;
  sortOrder: number;
  semantic: StatusSemantic;
  stageId: string | null;
  defaultPhase: ProgressPhase;
  statisticsCategory: string | null;
}

export type StatusDefinitionPatch = Partial<Pick<StatusDefinition,
  'name' | 'color' | 'sortOrder' | 'semantic' | 'stageId' | 'defaultPhase' | 'statisticsCategory'
>>;

export interface DefinitionCommandResult<T> {
  revision: number;
  value: T;
}

export interface DefinitionCommands {
  createStage(input: CreateStageInput): Promise<DefinitionCommandResult<StageDefinition>>;
  updateStage(input: WorkspaceRevisionInput & { stageId: string; patch: StageDefinitionPatch }): Promise<DefinitionCommandResult<StageDefinition>>;
  archiveStage(input: WorkspaceRevisionInput & { stageId: string; at?: string }): Promise<DefinitionCommandResult<StageDefinition>>;
  deleteStage(input: WorkspaceRevisionInput & { stageId: string }): Promise<DefinitionCommandResult<void>>;
  createStatus(input: CreateStatusInput): Promise<DefinitionCommandResult<StatusDefinition>>;
  updateStatus(input: WorkspaceRevisionInput & { statusId: string; patch: StatusDefinitionPatch }): Promise<DefinitionCommandResult<StatusDefinition>>;
  archiveStatus(input: WorkspaceRevisionInput & { statusId: string; at?: string }): Promise<DefinitionCommandResult<StatusDefinition>>;
  deleteStatus(input: WorkspaceRevisionInput & { statusId: string }): Promise<DefinitionCommandResult<void>>;
}

const stagePatchKeys = new Set<keyof StageDefinitionPatch>([
  'name', 'category', 'sortOrder', 'countsAsInterview', 'interviewRound',
]);
const statusPatchKeys = new Set<keyof StatusDefinitionPatch>([
  'name', 'color', 'sortOrder', 'semantic', 'stageId', 'defaultPhase', 'statisticsCategory',
]);
const semanticsKeys: Array<keyof Pick<StatusDefinition, 'semantic' | 'stageId' | 'defaultPhase' | 'statisticsCategory'>> = [
  'semantic', 'stageId', 'defaultPhase', 'statisticsCategory',
];

function assertRevision(expectedRevision: number, actualRevision: number): void {
  requireRule(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, '快照版本无效');
  if (expectedRevision !== actualRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
}

function assertWorkspace(snapshot: DataSnapshotV2, workspaceId: string): void {
  requireRule(typeof workspaceId === 'string' && !!workspaceId.trim(), '工作空间 ID 必填');
  if (workspaceId !== snapshot.workspace.id) throw new DomainError('VALIDATION', '定义不属于当前工作空间');
}

function findStage(definitions: R1DefinitionsSnapshot, stageId: string): StageDefinition {
  const stage = definitions.stages.find(item => item.id === stageId);
  if (!stage) throw new DomainError('NOT_FOUND', '环节不存在');
  return stage;
}

function findStatus(definitions: R1DefinitionsSnapshot, statusId: string): StatusDefinition {
  const status = definitions.statuses.find(item => item.id === statusId);
  if (!status) throw new DomainError('NOT_FOUND', '状态不存在');
  return status;
}

function semanticsVersion(status: StatusDefinition, definitions: R1DefinitionsSnapshot): StatusSemanticsVersion {
  const stage = status.stageId === null ? null : findStage(definitions, status.stageId);
  return {
    version: status.version,
    semantic: status.semantic,
    stageId: status.stageId,
    stageCategory: stage?.category ?? null,
    defaultPhase: status.defaultPhase,
    statisticsCategory: status.statisticsCategory,
    countsAsInterview: stage?.countsAsInterview ?? false,
  };
}

function assertDefinitionRelations(definitions: R1DefinitionsSnapshot): void {
  // The general domain validator checks shape and version continuity. These
  // extra relations prevent an outcome status from being configured as an
  // unrelated stage while still allowing arbitrary user-defined categories.
  validateDefinitions(definitions);
  for (const status of definitions.statuses) {
    for (const revision of status.semanticsHistory) {
      requireRule(revision.statisticsCategory === null
        || (typeof revision.statisticsCategory === 'string' && !!revision.statisticsCategory.trim()), '统计分类必须为非空文本或空值');
      if (revision.semantic === 'draft' || revision.semantic === 'submitted' || revision.semantic === 'withdrawn') {
        requireRule(revision.stageId === null && revision.defaultPhase === 'unknown', `${revision.semantic} 状态不能关联环节`);
      }
      if (revision.semantic === 'screening') {
        requireRule(revision.stageId !== null && revision.stageCategory === 'screening', '筛选状态必须关联筛选环节');
      }
      if (revision.semantic === 'pool') {
        requireRule(revision.stageId !== null && revision.stageCategory === 'pool', '泡池子状态必须关联池子环节');
      }
      if (revision.semantic === 'stage') {
        requireRule(revision.stageId !== null, '阶段状态必须关联一个环节');
      }
      if (revision.semantic === 'offer_received' || revision.semantic === 'offer_accepted' || revision.semantic === 'offer_declined') {
        requireRule(revision.stageId !== null && revision.stageCategory === 'offer', 'Offer 结果必须关联 Offer 分类环节');
      }
      if (revision.semantic === 'failed' && revision.stageId === null) {
        requireRule(revision.defaultPhase === 'unknown', '未指定失败环节时结果必须为未知');
      }
    }
  }
}

function statusIsReferenced(snapshot: DataSnapshotV2, statusId: string): boolean {
  return snapshot.applications.some(application => application.currentStatusId === statusId)
    || snapshot.progressRecords.some(record => record.events.some(event => event.statusId === statusId));
}

function stageIsReferenced(snapshot: DataSnapshotV2, stageId: string): boolean {
  return snapshot.definitions.statuses.some(status => status.stageId === stageId
      || status.semanticsHistory.some(revision => revision.stageId === stageId))
    || snapshot.applications.some(application => application.currentStage === stageId
      || (typeof application.failedAt === 'object' && application.failedAt !== null && application.failedAt.stageId === stageId))
    || snapshot.progressRecords.some(record => record.annotations.some(annotation => annotation.stageId === stageId)
      || record.events.some(event => event.semantics.stageId === stageId
        || event.contextStageId === stageId
        || (typeof event.failedAt === 'object' && event.failedAt !== null && event.failedAt.stageId === stageId)));
}

/**
 * Versioned v2 definition commands. Definitions are scoped to the single
 * workspace carried by this snapshot; every call must name that workspace.
 * Semantic changes append a StatusSemanticsVersion so existing event snapshots
 * keep their original meaning. Writes validate and commit one whole snapshot
 * with revision CAS.
 */
export function createDefinitionCommands(
  store: SnapshotStoreV2,
  context: Partial<DefinitionCommandContext> = {},
): DefinitionCommands {
  const now = context.now ?? (() => new Date().toISOString());
  const id = context.id ?? (() => globalThis.crypto.randomUUID());

  async function transact<T>(
    input: WorkspaceRevisionInput,
    mutate: (snapshot: DataSnapshotV2, timestamp: string) => T,
  ): Promise<DefinitionCommandResult<T>> {
    const stored = await store.read();
    assertRevision(input.expectedRevision, stored.revision);
    assertWorkspace(stored.data, input.workspaceId);
    const timestamp = now();
    validateInstant(timestamp);
    const next = structuredClone(stored.data);
    const value = mutate(next, timestamp);
    assertDefinitionRelations(next.definitions);
    validateV2Snapshot(next);
    const revision = await store.commit(input.expectedRevision, next);
    return { revision, value: structuredClone(value) };
  }

  function ensureNewId(candidate: string | undefined, kind: string, definitions: R1DefinitionsSnapshot): string {
    const value = candidate ?? id();
    requireRule(typeof value === 'string' && !!value.trim(), `${kind} ID 无效`);
    if (definitions.stages.some(stage => stage.id === value) || definitions.statuses.some(status => status.id === value)) {
      throw new DomainError('CONFLICT', `${kind} ID 已存在`);
    }
    return value;
  }

  return {
    createStage(input) {
      return transact(input, (snapshot) => {
        const stageId = ensureNewId(input.id, '环节', snapshot.definitions);
        requireRule(typeof input.name === 'string' && !!input.name.trim(), '环节名称不能为空');
        const stage: StageDefinition = {
          id: stageId,
          name: input.name.trim(),
          category: input.category,
          sortOrder: input.sortOrder,
          archivedAt: null,
          countsAsInterview: input.countsAsInterview ?? false,
          ...(input.interviewRound === undefined ? {} : { interviewRound: input.interviewRound }),
        };
        snapshot.definitions.stages.push(stage);
        return stage;
      });
    },

    updateStage(input) {
      return transact(input, (snapshot) => {
        requireRule(typeof input.patch === 'object' && input.patch !== null && !Array.isArray(input.patch), '环节更新内容无效');
        const keys = Object.keys(input.patch) as Array<keyof StageDefinitionPatch>;
        requireRule(keys.length > 0, '至少需要更新一个环节字段');
        for (const key of keys) {
          requireRule(stagePatchKeys.has(key), `不允许修改环节字段：${String(key)}`);
          requireRule(input.patch[key] !== undefined, `环节字段不能写入 undefined：${String(key)}`);
        }
        const stage = findStage(snapshot.definitions, input.stageId);
        if ('name' in input.patch) {
          requireRule(typeof input.patch.name === 'string' && !!input.patch.name.trim(), '环节名称不能为空');
          stage.name = input.patch.name.trim();
        }
        if ('category' in input.patch) stage.category = input.patch.category!;
        if ('sortOrder' in input.patch) stage.sortOrder = input.patch.sortOrder!;
        if ('countsAsInterview' in input.patch) stage.countsAsInterview = input.patch.countsAsInterview!;
        if ('interviewRound' in input.patch) stage.interviewRound = input.patch.interviewRound!;

        const meaningChanged = 'category' in input.patch || 'countsAsInterview' in input.patch;
        if (meaningChanged) {
          for (const status of snapshot.definitions.statuses.filter(item => item.stageId === stage.id)) {
            status.version += 1;
            status.semanticsHistory.push(semanticsVersion(status, snapshot.definitions));
          }
        }
        return stage;
      });
    },

    archiveStage(input) {
      return transact(input, (snapshot, timestamp) => {
        const at = input.at ?? timestamp;
        validateInstant(at);
        const stage = findStage(snapshot.definitions, input.stageId);
        stage.archivedAt ??= at;
        for (const status of snapshot.definitions.statuses) {
          if (status.stageId === stage.id) status.archivedAt ??= at;
        }
        return stage;
      });
    },

    deleteStage(input) {
      return transact(input, snapshot => {
        const stage = findStage(snapshot.definitions, input.stageId);
        requireRule(stage.archivedAt !== null, '删除前必须先归档环节');
        requireRule(!stageIsReferenced(snapshot, stage.id), '被状态、注记或历史记录引用的环节只能归档');
        snapshot.definitions.stages = snapshot.definitions.stages.filter(item => item.id !== stage.id);
        return undefined;
      });
    },

    createStatus(input) {
      return transact(input, snapshot => {
        const statusId = ensureNewId(input.id, '状态', snapshot.definitions);
        requireRule(typeof input.name === 'string' && !!input.name.trim(), '状态名称不能为空');
        const stage = input.stageId === null ? null : findStage(snapshot.definitions, input.stageId);
        requireRule(input.statisticsCategory === null
          || (typeof input.statisticsCategory === 'string' && !!input.statisticsCategory.trim()), '统计分类必须为非空文本或空值');
        const status: StatusDefinition = {
          id: statusId,
          name: input.name.trim(),
          color: input.color,
          sortOrder: input.sortOrder,
          version: 1,
          archivedAt: null,
          semantic: input.semantic,
          stageId: input.stageId,
          defaultPhase: input.defaultPhase,
          statisticsCategory: input.statisticsCategory,
          semanticsHistory: [{
            version: 1,
            semantic: input.semantic,
            stageId: input.stageId,
            stageCategory: stage?.category ?? null,
            defaultPhase: input.defaultPhase,
            statisticsCategory: input.statisticsCategory,
            countsAsInterview: stage?.countsAsInterview ?? false,
          }],
        };
        snapshot.definitions.statuses.push(status);
        return status;
      });
    },

    updateStatus(input) {
      return transact(input, snapshot => {
        requireRule(typeof input.patch === 'object' && input.patch !== null && !Array.isArray(input.patch), '状态更新内容无效');
        const keys = Object.keys(input.patch) as Array<keyof StatusDefinitionPatch>;
        requireRule(keys.length > 0, '至少需要更新一个状态字段');
        for (const key of keys) {
          requireRule(statusPatchKeys.has(key), `不允许修改状态字段：${String(key)}`);
          requireRule(input.patch[key] !== undefined, `状态字段不能写入 undefined：${String(key)}`);
        }
        const status = findStatus(snapshot.definitions, input.statusId);
        const previousMeaning = Object.fromEntries(semanticsKeys.map(key => [key, status[key]]));
        if ('name' in input.patch) {
          requireRule(typeof input.patch.name === 'string' && !!input.patch.name.trim(), '状态名称不能为空');
          status.name = input.patch.name.trim();
        }
        if ('color' in input.patch) status.color = input.patch.color!;
        if ('sortOrder' in input.patch) status.sortOrder = input.patch.sortOrder!;
        if ('semantic' in input.patch) status.semantic = input.patch.semantic!;
        if ('stageId' in input.patch) status.stageId = input.patch.stageId!;
        if ('defaultPhase' in input.patch) status.defaultPhase = input.patch.defaultPhase!;
        if ('statisticsCategory' in input.patch) status.statisticsCategory = input.patch.statisticsCategory!;

        const semanticChanged = semanticsKeys.some(key => previousMeaning[key] !== status[key]);
        if (semanticChanged) {
          const linkedStage = status.stageId === null ? null : findStage(snapshot.definitions, status.stageId);
          requireRule(status.archivedAt !== null || !linkedStage || linkedStage.archivedAt === null, '可用状态不能关联已归档环节');
          status.version += 1;
          status.semanticsHistory.push(semanticsVersion(status, snapshot.definitions));
        }
        return status;
      });
    },

    archiveStatus(input) {
      return transact(input, (snapshot, timestamp) => {
        const at = input.at ?? timestamp;
        validateInstant(at);
        const status = findStatus(snapshot.definitions, input.statusId);
        status.archivedAt ??= at;
        return status;
      });
    },

    deleteStatus(input) {
      return transact(input, snapshot => {
        const status = findStatus(snapshot.definitions, input.statusId);
        requireRule(status.archivedAt !== null, '删除前必须先归档状态');
        requireRule(!statusIsReferenced(snapshot, status.id), '已被投递或历史事件引用的状态只能归档');
        snapshot.definitions.statuses = snapshot.definitions.statuses.filter(item => item.id !== status.id);
        return undefined;
      });
    },
  };
}
