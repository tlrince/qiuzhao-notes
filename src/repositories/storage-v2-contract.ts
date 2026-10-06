import { DomainError } from '../domain/errors.js';
import { validateV2Snapshot, type DataSnapshotV2 } from '../domain/v2/snapshot.js';

export interface VersionedSnapshotV2 { revision: number; data: DataSnapshotV2 }

/** Safe-to-render metadata for an immutable snapshot kept before replacement. */
export interface RecoverySnapshotInfo {
  id: string;
  sourceRevision: number;
  sourceSchemaVersion: 1 | 2;
  workspaceName: string;
  seasonNames: string[];
  seasonCount: number;
  applicationCount: number;
  /** UTF-8 bytes of JSON.stringify() over the originally stored recovery data. */
  estimatedJsonBytes: number;
}

/**
 * Automatic copies taken before a whole-workspace replacement (restore, import, sync).
 * Only the newest ones are kept; older copies are pruned in the same transaction.
 */
export const RECOVERY_COPY_LIMIT = 5;

/** Estimates serialized JSON payload size; this is not the database's physical disk usage. */
export function estimateJsonUtf8Bytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new DomainError('BACKUP_INCOMPATIBLE', '恢复副本无法序列化为 JSON');
  return new TextEncoder().encode(json).byteLength;
}

/** Complete-snapshot CAS contract shared by the v2 Web and native adapters. */
export interface SnapshotStoreV2 {
  read(): Promise<VersionedSnapshotV2>;
  /** Atomically commits a whole snapshot with revision CAS after validation. */
  commit(expectedRevision: number, nextData: DataSnapshotV2): Promise<number>;
  /** Atomic restore primitive: retain the current snapshot before replacing it. */
  restore(expectedRevision: number, nextData: DataSnapshotV2): Promise<number>;
  /** Lists immutable replacement/migration copies without exposing their full data. */
  listRecoverySnapshots(): Promise<RecoverySnapshotInfo[]>;
  /** Restores the selected immutable copy with revision CAS and retains current data. */
  restoreRecoverySnapshot(expectedRevision: number, recoveryId: string): Promise<number>;
  /** Deletes exactly one selected copy with revision CAS; ordinary commits never prune copies. */
  deleteRecoverySnapshot(expectedRevision: number, recoveryId: string): Promise<number>;
  close(): Promise<void>;
}

export function createMemorySnapshotStoreV2(seed: DataSnapshotV2): SnapshotStoreV2 {
  validateV2Snapshot(seed);
  let current: VersionedSnapshotV2 = { revision: 0, data: structuredClone(seed) };
  const recovery = new Map<string, { sourceRevision: number; sourceSchemaVersion: 1 | 2; data: DataSnapshotV2 }>();
  let closed = false;
  const pruneRecovery = () => {
    const automatic = [...recovery.entries()].filter(([id]) => id.startsWith('restore-v2-')).sort(([, left], [, right]) => right.sourceRevision - left.sourceRevision);
    for (const [id] of automatic.slice(RECOVERY_COPY_LIMIT)) recovery.delete(id);
  };
  const requireOpen = () => { if (closed) throw new DomainError('STORAGE', '存储已关闭'); };
  return {
    async read() { requireOpen(); return structuredClone(current); },
    async commit(expectedRevision, nextData) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== current.revision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
      validateV2Snapshot(nextData);
      current = { revision: current.revision + 1, data: structuredClone(nextData) };
      return current.revision;
    },
    async restore(expectedRevision, nextData) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== current.revision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
      validateV2Snapshot(nextData);
      const id = `restore-v2-${current.revision}`;
      if (recovery.has(id)) throw new DomainError('STORAGE', '恢复副本编号重复，当前快照未替换');
      recovery.set(id, { sourceRevision: current.revision, sourceSchemaVersion: 2, data: structuredClone(current.data) });
      pruneRecovery();
      current = { revision: current.revision + 1, data: structuredClone(nextData) };
      return current.revision;
    },
    async listRecoverySnapshots() {
      requireOpen();
      return [...recovery.entries()].map(([id, item]) => ({
        id,
        sourceRevision: item.sourceRevision,
        sourceSchemaVersion: item.sourceSchemaVersion,
        workspaceName: item.data.workspace.name,
        seasonNames: item.data.seasons.map(season => season.name),
        seasonCount: item.data.seasons.length,
        applicationCount: item.data.applications.length,
        estimatedJsonBytes: estimateJsonUtf8Bytes(item.data),
      })).sort((a, b) => b.sourceRevision - a.sourceRevision || a.id.localeCompare(b.id));
    },
    async restoreRecoverySnapshot(expectedRevision, recoveryId) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== current.revision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
      const recoveryItem = recovery.get(recoveryId);
      if (!recoveryItem) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      validateV2Snapshot(recoveryItem.data);
      const displacedId = `restore-v2-${current.revision}`;
      if (recovery.has(displacedId)) throw new DomainError('STORAGE', '恢复副本编号重复，当前快照未替换');
      recovery.set(displacedId, { sourceRevision: current.revision, sourceSchemaVersion: 2, data: structuredClone(current.data) });
      pruneRecovery();
      current = { revision: current.revision + 1, data: structuredClone(recoveryItem.data) };
      return current.revision;
    },
    async deleteRecoverySnapshot(expectedRevision, recoveryId) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== current.revision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
      if (!recovery.delete(recoveryId)) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      current = { ...current, revision: current.revision + 1 };
      return current.revision;
    },
    async close() { closed = true; },
  };
}
