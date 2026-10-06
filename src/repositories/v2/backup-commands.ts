import { DomainError } from '../../domain/errors.js';
import { migrateV1Snapshot } from '../../domain/v2/migration.js';
import { assertV2Backup, validateV2Snapshot, type BackupEnvelopeV2, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import type { BackupEnvelope } from '../../domain/types.js';
import { validateInstant } from '../../domain/validation.js';
import type { RecoverySnapshotInfo, SnapshotStoreV2 } from '../storage-v2-contract.js';

export interface BackupRestorePreview {
  sourceSchemaVersion: 1 | 2;
  exportedAt: string;
  workspaceName: string;
  seasonNames: string[];
  seasonCount: number;
  applicationCount: number;
  progressEventCount: number;
  scheduleCount: number;
}

export interface ParsedBackup extends BackupRestorePreview {
  data: DataSnapshotV2;
}

export interface BackupCommands {
  /** Reads the complete stored snapshot; page filters are never accepted here. */
  exportAll(exportedAt: string): Promise<BackupEnvelopeV2>;
  inspect(input: unknown, migratedAt?: string): BackupRestorePreview;
  restore(input: unknown, expectedRevision: number, migratedAt?: string): Promise<{ revision: number; preview: BackupRestorePreview }>;
  listRecoverySnapshots(): Promise<RecoverySnapshotInfo[]>;
  restoreRecoverySnapshot(recoveryId: string, expectedRevision: number): Promise<{ revision: number; recovery: RecoverySnapshotInfo }>;
  deleteRecoverySnapshot(recoveryId: string, expectedRevision: number): Promise<{ revision: number; recovery: RecoverySnapshotInfo }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asIncompatible(error: unknown): DomainError {
  if (error instanceof DomainError && error.code === 'BACKUP_INCOMPATIBLE') return error;
  return new DomainError('BACKUP_INCOMPATIBLE', error instanceof Error ? error.message : '备份数据无效');
}

function decodeJson(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try { return JSON.parse(input) as unknown; }
  catch (error) { throw new DomainError('BACKUP_INCOMPATIBLE', `备份 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`); }
}

/** Creates a v2 full-data envelope without changing lastBackupAt or using platform time. */
export function createBackupEnvelope(data: DataSnapshotV2, exportedAt: string): BackupEnvelopeV2 {
  try {
    validateInstant(exportedAt);
    validateV2Snapshot(data);
    const envelope: BackupEnvelopeV2 = {
      format: 'autumn-applications',
      schemaVersion: 2,
      exportedAt,
      data: structuredClone(data),
    };
    assertV2Backup(envelope);
    return envelope;
  } catch (error) { throw asIncompatible(error); }
}

/** Validates the whole envelope and returns a normalized v2 snapshot for preview/restore. */
export function parseBackup(input: unknown, migratedAt?: string): ParsedBackup {
  const decoded = decodeJson(input);
  try {
    if (!isRecord(decoded)) throw new DomainError('BACKUP_INCOMPATIBLE', '备份结构无效');
    if (decoded.format !== 'autumn-applications') throw new DomainError('BACKUP_INCOMPATIBLE', '备份格式不受支持');
    if (decoded.schemaVersion !== 1 && decoded.schemaVersion !== 2) throw new DomainError('BACKUP_INCOMPATIBLE', '备份版本不受支持');
    if (typeof decoded.exportedAt !== 'string') throw new DomainError('BACKUP_INCOMPATIBLE', '备份导出时间无效');
    validateInstant(decoded.exportedAt);

    let data: DataSnapshotV2;
    if (decoded.schemaVersion === 2) {
      assertV2Backup(decoded);
      data = structuredClone(decoded.data);
    } else {
      const envelope = decoded as unknown as BackupEnvelope;
      if (!isRecord(envelope.data?.settings) || envelope.data.settings.schemaVersion !== 1) {
        throw new DomainError('BACKUP_INCOMPATIBLE', '备份版本与数据版本不一致');
      }
      if (typeof migratedAt !== 'string') throw new DomainError('BACKUP_INCOMPATIBLE', '迁移旧备份时需要提供迁移时间');
      data = migrateV1Snapshot(envelope.data, { migratedAt });
      validateV2Snapshot(data);
    }

    const preview: BackupRestorePreview = {
      sourceSchemaVersion: decoded.schemaVersion,
      exportedAt: decoded.exportedAt,
      workspaceName: data.workspace.name,
      seasonNames: data.seasons.map(season => season.name),
      seasonCount: data.seasons.length,
      applicationCount: data.applications.length,
      progressEventCount: data.progressRecords.reduce((count, record) => count + record.events.length, 0),
      scheduleCount: data.schedules.length,
    };
    return { ...preview, data };
  } catch (error) { throw asIncompatible(error); }
}

/** Platform-neutral backup commands. Callers own exportedAt and lastBackupAt semantics. */
export function createBackupCommands(store: SnapshotStoreV2): BackupCommands {
  return {
    async exportAll(exportedAt) {
      const snapshot = await store.read();
      return createBackupEnvelope(snapshot.data, exportedAt);
    },
    inspect(input, migratedAt) {
      const { data: _data, ...preview } = parseBackup(input, migratedAt);
      return preview;
    },
    async restore(input, expectedRevision, migratedAt) {
      const parsed = parseBackup(input, migratedAt);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      // Restore is a distinct atomic storage operation: it must CAS, retain the
      // displaced snapshot, and replace the live snapshot in one transaction.
      const revision = await store.restore(expectedRevision, parsed.data);
      const { data: _data, ...preview } = parsed;
      return { revision, preview };
    },
    async listRecoverySnapshots() {
      return store.listRecoverySnapshots();
    },
    async restoreRecoverySnapshot(recoveryId, expectedRevision) {
      if (typeof recoveryId !== 'string' || recoveryId.length === 0) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      const available = await store.listRecoverySnapshots();
      const recovery = available.find(item => item.id === recoveryId);
      if (!recovery) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      const revision = await store.restoreRecoverySnapshot(expectedRevision, recoveryId);
      return { revision, recovery };
    },
    async deleteRecoverySnapshot(recoveryId, expectedRevision) {
      if (typeof recoveryId !== 'string' || recoveryId.length === 0) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      const available = await store.listRecoverySnapshots();
      const recovery = available.find(item => item.id === recoveryId);
      if (!recovery) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      const revision = await store.deleteRecoverySnapshot(expectedRevision, recoveryId);
      return { revision, recovery };
    },
  };
}
