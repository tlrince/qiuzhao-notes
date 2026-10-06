import { DomainError, requireRule } from '../../domain/errors.js';
import { validateV2Snapshot, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import type { ImportedApplicationV2 } from '../../domain/v2/raw-import.js';
import type { SnapshotStoreV2 } from '../storage-v2-contract.js';

export interface ReplaceSeasonApplicationsInput {
  expectedRevision: number;
  seasonId: string;
  applications: ImportedApplicationV2[];
}

export interface ReplaceSeasonApplicationsResult {
  revision: number;
  seasonId: string;
  removedApplicationCount: number;
  importedApplicationCount: number;
}

export interface ImportCommands {
  /** Replaces one season's applications atomically, retaining the displaced full snapshot for recovery. */
  replaceSeasonApplications(input: ReplaceSeasonApplicationsInput): Promise<ReplaceSeasonApplicationsResult>;
}

function assertExpectedRevision(expectedRevision: number, actualRevision: number): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== actualRevision) {
    throw new DomainError('CONFLICT', '数据已更新，请重新加载');
  }
}

function assertImportedRows(snapshot: DataSnapshotV2, seasonId: string, rows: ImportedApplicationV2[]): void {
  requireRule(Array.isArray(rows) && rows.length > 0, '导入记录不能为空，未写入数据');
  const sourceIds = new Set<string>();
  const applicationIds = new Set<string>();
  const importedEventIds = new Set<string>();
  const importedAnnotationIds = new Set<string>();
  const retainedApplications = snapshot.applications.filter(application => application.seasonId !== seasonId);
  const retainedApplicationIds = new Set(retainedApplications.map(application => application.id));
  const retainedProgress = snapshot.progressRecords.filter(record => retainedApplicationIds.has(record.applicationId));
  const retainedEventIds = new Set(retainedProgress.flatMap(record => record.events.map(event => event.id)));
  const retainedAnnotationIds = new Set(retainedProgress.flatMap(record => record.annotations.map(annotation => annotation.id)));

  for (const row of rows) {
    requireRule(typeof row === 'object' && row !== null, '导入记录不完整');
    requireRule(typeof row.sourceId === 'string' && !!row.sourceId.trim(), '源记录 ID 不完整');
    requireRule(typeof row.sourceStatus === 'string' && !!row.sourceStatus.trim(), '源状态不完整');
    requireRule(typeof row.sourceRecord === 'object' && row.sourceRecord !== null && !Array.isArray(row.sourceRecord), '源记录内容不完整');
    requireRule(row.sourceRecord.id === row.sourceId && row.sourceRecord.status === row.sourceStatus, '源记录 ID 或状态与预览不一致');
    requireRule(!sourceIds.has(row.sourceId), `源记录 ID 重复：${row.sourceId}`);
    sourceIds.add(row.sourceId);

    const application = row.application;
    requireRule(typeof application === 'object' && application !== null, `投递 ${row.sourceId} 缺少投递数据`);
    requireRule(application.seasonId === seasonId, `投递 ${application.id} 不属于所选招聘季`);
    requireRule(typeof application.id === 'string' && !!application.id.trim(), '导入投递 ID 不能为空');
    requireRule(!applicationIds.has(application.id), `导入投递 ID 重复：${application.id}`);
    requireRule(!retainedApplicationIds.has(application.id), `投递 ID 与其他招聘季冲突：${application.id}`);
    applicationIds.add(application.id);

    const matchingChannels = snapshot.channels.filter(channel => channel.id === application.channelId);
    requireRule(matchingChannels.length === 1, matchingChannels.length
      ? `投递渠道 ID 存在冲突：${application.channelId}`
      : `投递渠道不存在：${application.channelId}`);

    const progress = row.progress;
    requireRule(typeof progress === 'object' && progress !== null, `投递 ${application.id} 缺少进度历史`);
    requireRule(progress.applicationId === application.id, `投递 ${application.id} 的进度历史关联错误`);
    requireRule(Array.isArray(progress.events) && Array.isArray(progress.annotations), `投递 ${application.id} 的进度历史不完整`);
    for (const event of progress.events) {
      requireRule(!importedEventIds.has(event.id) && !retainedEventIds.has(event.id), `进度事件 ID 冲突：${event.id}`);
      importedEventIds.add(event.id);
    }
    for (const annotation of progress.annotations) {
      requireRule(!importedAnnotationIds.has(annotation.id) && !retainedAnnotationIds.has(annotation.id), `环节注记 ID 冲突：${annotation.id}`);
      importedAnnotationIds.add(annotation.id);
    }
  }

  requireRule(applicationIds.size === rows.length, '导入投递 ID 重复');
}

export function createImportCommands(store: SnapshotStoreV2): ImportCommands {
  return {
    async replaceSeasonApplications(input) {
      const stored = await store.read();
      assertExpectedRevision(input.expectedRevision, stored.revision);
      requireRule(typeof input.seasonId === 'string' && !!input.seasonId.trim(), '必须选择招聘季');
      const season = stored.data.seasons.find(item => item.id === input.seasonId);
      requireRule(!!season, '招聘季不存在');
      requireRule(season.archivedAt === null, '不能向已归档招聘季导入');

      assertImportedRows(stored.data, input.seasonId, input.applications);

      const next = structuredClone(stored.data);
      const replacedIds = new Set(next.applications.filter(application => application.seasonId === input.seasonId).map(application => application.id));
      const removedApplicationCount = replacedIds.size;
      next.applications = next.applications.filter(application => application.seasonId !== input.seasonId);
      next.progressRecords = next.progressRecords.filter(record => !replacedIds.has(record.applicationId));
      next.schedules = next.schedules.filter(schedule => !replacedIds.has(schedule.applicationId));
      next.legacyHistory = next.legacyHistory.filter(record => !replacedIds.has(record.applicationId));
      next.applications.push(...input.applications.map(row => structuredClone(row.application)));
      next.progressRecords.push(...input.applications.map(row => structuredClone(row.progress)));

      validateV2Snapshot(next);
      const revision = await store.restore(input.expectedRevision, next);
      return {
        revision,
        seasonId: input.seasonId,
        removedApplicationCount,
        importedApplicationCount: input.applications.length,
      };
    },
  };
}
