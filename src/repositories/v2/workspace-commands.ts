import { DomainError, requireRule } from '../../domain/errors.js';
import { validateDate, validateInstant } from '../../domain/validation.js';
import { validateV2Snapshot, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import type { Season, Workspace } from '../../domain/types.js';
import type { SnapshotStoreV2 } from '../storage-v2-contract.js';

export interface WorkspaceCommands {
  setActiveSeason(input: { expectedRevision: number; seasonId: string | null }): Promise<{ revision: number; value: Workspace }>;
  createSeason(input: { expectedRevision: number; name: string; startDate: string; endDate: string; targetCount: number; activate?: boolean }): Promise<{ revision: number; value: Season }>;
  updateSeason(input: { expectedRevision: number; seasonId: string; patch: Partial<Pick<Season, 'name' | 'startDate' | 'endDate' | 'targetCount'>> }): Promise<{ revision: number; value: Season }>;
  archiveSeason(input: { expectedRevision: number; seasonId: string }): Promise<{ revision: number; value: Season }>;
  setPreference(input: { expectedRevision: number; key: string; value: string | number | boolean }): Promise<{ revision: number; value: string | number | boolean }>;
}

/** Snapshot-CAS commands for workspace and recruiting-season metadata. */
export function createWorkspaceCommands(
  store: SnapshotStoreV2,
  context: { now?: () => string; id?: () => string } = {},
): WorkspaceCommands {
  const now = context.now ?? (() => new Date().toISOString());
  const id = context.id ?? (() => globalThis.crypto.randomUUID());

  async function transact<T>(expectedRevision: number, mutate: (snapshot: DataSnapshotV2, timestamp: string) => T): Promise<{ revision: number; value: T }> {
    const stored = await store.read();
    requireRule(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0, '快照版本无效');
    if (stored.revision !== expectedRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
    const timestamp = now();
    validateInstant(timestamp);
    const next = structuredClone(stored.data);
    const value = mutate(next, timestamp);
    validateV2Snapshot(next);
    const revision = await store.commit(expectedRevision, next);
    return { revision, value: structuredClone(value) };
  }

  const findSeason = (snapshot: DataSnapshotV2, seasonId: string): Season => {
    const season = snapshot.seasons.find(item => item.id === seasonId);
    if (!season) throw new DomainError('NOT_FOUND', '招聘季不存在');
    return season;
  };

  return {
    setActiveSeason(input) {
      return transact(input.expectedRevision, snapshot => {
        if (input.seasonId !== null) {
          const season = findSeason(snapshot, input.seasonId);
          requireRule(season.archivedAt === null, '已归档的招聘季不能设为当前招聘季');
        }
        snapshot.workspace.activeSeasonId = input.seasonId;
        return snapshot.workspace;
      });
    },
    createSeason(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        const name = input.name.trim();
        requireRule(name.length > 0 && name.length <= 100, '招聘季名称不能为空且最多 100 个字符');
        validateDate(input.startDate); validateDate(input.endDate);
        requireRule(input.startDate <= input.endDate, '招聘季开始日期不能晚于结束日期');
        requireRule(Number.isSafeInteger(input.targetCount) && input.targetCount > 0, '目标投递数必须为正整数');
        const seasonId = id();
        requireRule(typeof seasonId === 'string' && seasonId.trim().length > 0, '招聘季 ID 无效');
        requireRule(!snapshot.seasons.some(item => item.id === seasonId), '招聘季 ID 已存在');
        const season: Season = { id: seasonId, name, startDate: input.startDate, endDate: input.endDate, targetCount: input.targetCount, archivedAt: null };
        snapshot.seasons.push(season);
        if (input.activate ?? snapshot.workspace.activeSeasonId === null) snapshot.workspace.activeSeasonId = season.id;
        void timestamp;
        return season;
      });
    },
    updateSeason(input) {
      return transact(input.expectedRevision, snapshot => {
        const season = findSeason(snapshot, input.seasonId);
        requireRule(season.archivedAt === null, '已归档的招聘季不能修改');
        const keys = Object.keys(input.patch);
        requireRule(keys.length > 0, '至少需要修改一个招聘季字段');
        if (input.patch.name !== undefined) {
          const name = input.patch.name.trim();
          requireRule(name.length > 0 && name.length <= 100, '招聘季名称不能为空且最多 100 个字符');
          season.name = name;
        }
        if (input.patch.startDate !== undefined) { validateDate(input.patch.startDate); season.startDate = input.patch.startDate; }
        if (input.patch.endDate !== undefined) { validateDate(input.patch.endDate); season.endDate = input.patch.endDate; }
        if (input.patch.targetCount !== undefined) {
          requireRule(Number.isSafeInteger(input.patch.targetCount) && input.patch.targetCount > 0, '目标投递数必须为正整数');
          season.targetCount = input.patch.targetCount;
        }
        requireRule(season.startDate <= season.endDate, '招聘季开始日期不能晚于结束日期');
        return season;
      });
    },
    archiveSeason(input) {
      return transact(input.expectedRevision, (snapshot, timestamp) => {
        const season = findSeason(snapshot, input.seasonId);
        requireRule(season.archivedAt === null, '招聘季已经归档');
        season.archivedAt = timestamp;
        if (snapshot.workspace.activeSeasonId === season.id) snapshot.workspace.activeSeasonId = null;
        return season;
      });
    },
    setPreference(input) {
      return transact(input.expectedRevision, snapshot => {
        requireRule(typeof input.key === 'string' && input.key.trim().length > 0 && input.key.length <= 160, '偏好设置名称无效');
        requireRule(typeof input.value === 'string' || typeof input.value === 'boolean' || (typeof input.value === 'number' && Number.isFinite(input.value)), '偏好设置值无效');
        snapshot.settings.preferences[input.key] = input.value;
        return input.value;
      });
    },
  };
}
