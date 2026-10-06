import { DomainError } from '../../domain/errors.js';
import { migrateV1Snapshot } from '../../domain/v2/migration.js';
import { validateV2Snapshot, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import type { DataSnapshot } from '../../domain/types.js';
import { estimateJsonUtf8Bytes, type RecoverySnapshotInfo, type SnapshotStoreV2, type VersionedSnapshotV2 } from '../storage-v2-contract.js';

interface NativeSnapshot { revision: number; data: unknown }
interface NativeRecoveryCopy { id: string; sourceRevision: number; sourceSchemaVersion: 1 | 2; data: unknown }

function mapNativeError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const message = String(error);
  if (message.includes('CONFLICT:') || message.includes('冲突:')) return new DomainError('CONFLICT', message);
  if (message.includes('NOT_FOUND:')) return new DomainError('NOT_FOUND', message);
  if (message.includes('BACKUP_INCOMPATIBLE:') || message.includes('版本不兼容')) return new DomainError('BACKUP_INCOMPATIBLE', message);
  if (message.includes('VALIDATION:')) return new DomainError('VALIDATION', message);
  return new DomainError('STORAGE', message);
}

/** Tauri adapter for v2; the Rust command owns SQLite backup, CAS and the write transaction. */
export function createDesktopSnapshotStoreV2(options: { migrationNow?: () => string } = {}): SnapshotStoreV2 {
  let closed = false;
  const invoke = async <T>(command: string, args?: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(command, args);
  const requireOpen = () => { if (closed) throw new DomainError('STORAGE', '存储已关闭'); };
  const readAndUpgrade = async (): Promise<VersionedSnapshotV2> => {
    requireOpen();
    try {
      const native = await invoke<NativeSnapshot>('read_snapshot_v2');
      if (!Number.isSafeInteger(native.revision) || native.revision < 0) throw new DomainError('STORAGE', '存储版本号无效');
      if (typeof native.data !== 'object' || native.data === null || Array.isArray(native.data)) throw new DomainError('BACKUP_INCOMPATIBLE', '本地快照结构无效');
      const settings = (native.data as { settings?: { schemaVersion?: unknown } }).settings;
      if (settings?.schemaVersion === 1) {
        const data = migrateV1Snapshot(native.data as DataSnapshot, { migratedAt: (options.migrationNow ?? (() => new Date().toISOString()))() });
        validateV2Snapshot(data);
        const revision = await invoke<number>('commit_snapshot_v2', { expectedRevision: native.revision, data });
        return { revision, data };
      }
      validateV2Snapshot(native.data);
      return { revision: native.revision, data: structuredClone(native.data) };
    } catch (error) { throw mapNativeError(error); }
  };
  const readRecoveries = async (): Promise<Array<{ info: RecoverySnapshotInfo; data: DataSnapshotV2; sourceData: unknown }>> => {
    requireOpen();
    try {
      const rows = await invoke<NativeRecoveryCopy[]>('read_recovery_snapshots_v2');
      if (!Array.isArray(rows)) throw new DomainError('BACKUP_INCOMPATIBLE', '恢复副本列表无效');
      return rows.map(row => {
        if (!row || typeof row.id !== 'string' || !Number.isSafeInteger(row.sourceRevision) || row.sourceRevision < 0 || (row.sourceSchemaVersion !== 1 && row.sourceSchemaVersion !== 2)) throw new DomainError('BACKUP_INCOMPATIBLE', '恢复副本版本信息无效');
        if (row.id !== `v1-${row.sourceRevision}` && row.id !== `restore-v2-${row.sourceRevision}`) throw new DomainError('BACKUP_INCOMPATIBLE', '恢复副本编号无效');
        const data = row.sourceSchemaVersion === 1
          ? migrateV1Snapshot(row.data, { migratedAt: (options.migrationNow ?? (() => new Date().toISOString()))() })
          : structuredClone(row.data as DataSnapshotV2);
        validateV2Snapshot(data);
        return {
          info: {
            id: row.id,
            sourceRevision: row.sourceRevision,
            sourceSchemaVersion: row.sourceSchemaVersion,
            workspaceName: data.workspace.name,
            seasonNames: data.seasons.map(season => season.name),
            seasonCount: data.seasons.length,
            applicationCount: data.applications.length,
            estimatedJsonBytes: estimateJsonUtf8Bytes(row.data),
          },
          data,
          sourceData: structuredClone(row.data),
        };
      });
    } catch (error) { throw mapNativeError(error); }
  };
  return {
    async read() { requireOpen(); return readAndUpgrade(); },
    async commit(expectedRevision, nextData) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      validateV2Snapshot(nextData);
      try { return await invoke<number>('commit_snapshot_v2', { expectedRevision, data: structuredClone(nextData) }); }
      catch (error) { throw mapNativeError(error); }
    },
    async restore(expectedRevision, nextData) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      validateV2Snapshot(nextData);
      try { return await invoke<number>('restore_snapshot_v2', { expectedRevision, data: structuredClone(nextData) }); }
      catch (error) { throw mapNativeError(error); }
    },
    async listRecoverySnapshots() {
      return (await readRecoveries()).map(item => item.info);
    },
    async restoreRecoverySnapshot(expectedRevision, recoveryId) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      const selected = (await readRecoveries()).find(item => item.info.id === recoveryId);
      if (!selected) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      try {
        return await invoke<number>('restore_recovery_snapshot_v2', {
          expectedRevision,
          recoveryId,
          data: structuredClone(selected.data),
          sourceData: selected.sourceData,
        });
      } catch (error) { throw mapNativeError(error); }
    },
    async deleteRecoverySnapshot(expectedRevision, recoveryId) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      if (typeof recoveryId !== 'string' || recoveryId.length === 0) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      const selected = (await readRecoveries()).find(item => item.info.id === recoveryId);
      if (!selected) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      try {
        return await invoke<number>('delete_recovery_snapshot_v2', { expectedRevision, recoveryId });
      } catch (error) { throw mapNativeError(error); }
    },
    async close() { closed = true; },
  };
}
