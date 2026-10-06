import { DomainError } from '../../domain/errors.js';
import { emptySnapshot } from '../../fixtures/acceptance.js';
import { migrateV1Snapshot } from '../../domain/v2/migration.js';
import { validateV2Snapshot, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import { estimateJsonUtf8Bytes, RECOVERY_COPY_LIMIT, type RecoverySnapshotInfo, type SnapshotStoreV2, type VersionedSnapshotV2 } from '../storage-v2-contract.js';
import type { DataSnapshot } from '../../domain/types.js';

export interface IndexedDbSnapshotStoreV2Options {
  dbName?: string;
  indexedDB?: IDBFactory;
  channelName?: string;
  migrationNow?: () => string;
}

const DB_VERSION = 2;
const SNAPSHOT_STORE = 'snapshot';
const META_STORE = 'meta';
const RECOVERY_STORE = 'recovery';
const CURRENT_KEY = 'current';
const META_KEY = 'state';

/** Opens the stable v1 database at physical version 2 and atomically preserves a recoverable v1 copy. */
export function createIndexedDbSnapshotStoreV2(options: IndexedDbSnapshotStoreV2Options = {}): SnapshotStoreV2 {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new DomainError('STORAGE', '当前环境不支持 IndexedDB');
  const dbName = options.dbName ?? 'autumn-notes-v1';
  let closed = false;
  let dbPromise: Promise<IDBDatabase> | undefined;
  let channel: BroadcastChannel | undefined;

  const open = () => dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    let upgradeFailure: unknown;
    let request: IDBOpenDBRequest;
    try { request = factory.open(dbName, DB_VERSION); } catch (error) { reject(new DomainError('STORAGE', String(error))); return; }
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(RECOVERY_STORE)) db.createObjectStore(RECOVERY_STORE);
      const tx = request.transaction!;
      const current = tx.objectStore(SNAPSHOT_STORE).get(CURRENT_KEY);
      current.onerror = () => { upgradeFailure = new DomainError('STORAGE', current.error?.message ?? '读取升级快照失败'); try { tx.abort(); } catch {} };
      current.onsuccess = () => {
        try {
          const record = current.result as { revision: number; data: DataSnapshot | DataSnapshotV2 } | undefined;
          const revision = record?.revision ?? 0;
          if (!Number.isSafeInteger(revision) || revision < 0) throw new DomainError('BACKUP_INCOMPATIBLE', '旧快照版本号无效');
          let data: DataSnapshotV2;
          if (!record) data = migrateV1Snapshot(emptySnapshot(), { migratedAt: (options.migrationNow ?? (() => new Date().toISOString()))() });
          else if ((record.data as DataSnapshot).settings?.schemaVersion === 1) {
            const v1 = record.data as DataSnapshot;
            data = migrateV1Snapshot(v1, { migratedAt: (options.migrationNow ?? (() => new Date().toISOString()))() });
            tx.objectStore(RECOVERY_STORE).put({ revision, schemaVersion: 1, data: structuredClone(v1) }, `v1-${revision}`);
          } else {
            data = record.data as DataSnapshotV2;
          }
          validateV2Snapshot(data);
          tx.objectStore(SNAPSHOT_STORE).put({ revision, data: structuredClone(data) }, CURRENT_KEY);
          tx.objectStore(META_STORE).put({ schemaVersion: 2, physicalVersion: DB_VERSION, revision }, META_KEY);
        } catch (error) {
          upgradeFailure = error;
          try { tx.abort(); } catch {}
        }
      };
      // IndexedDB rolls the entire versionchange transaction back if migration fails.
      tx.onerror = () => { upgradeFailure ??= tx.error; };
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(upgradeFailure instanceof Error ? upgradeFailure : new DomainError('STORAGE', request.error?.message ?? '无法打开本地存储'));
    request.onblocked = () => reject(new DomainError('STORAGE', '本地存储升级被阻塞，请关闭仍在使用的旧版本窗口后重试'));
  });

  const requireOpen = () => { if (closed) throw new DomainError('STORAGE', '存储已关闭'); };
  const recoveredData = (id: string, record: unknown): { sourceRevision: number; sourceSchemaVersion: 1 | 2; data: DataSnapshotV2 } => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new DomainError('BACKUP_INCOMPATIBLE', '恢复副本结构无效');
    const stored = record as { revision?: unknown; schemaVersion?: unknown; data?: unknown };
    const revision = stored.revision;
    const schemaVersion = stored.schemaVersion;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0 || (schemaVersion !== 1 && schemaVersion !== 2)) throw new DomainError('BACKUP_INCOMPATIBLE', '恢复副本版本信息无效');
    let data: DataSnapshotV2;
    if (schemaVersion === 1) data = migrateV1Snapshot(stored.data, { migratedAt: (options.migrationNow ?? (() => new Date().toISOString()))() });
    else data = structuredClone(stored.data as DataSnapshotV2);
    validateV2Snapshot(data);
    if (id !== `v1-${revision}` && id !== `restore-v2-${revision}`) throw new DomainError('BACKUP_INCOMPATIBLE', '恢复副本编号与版本信息不一致');
    return { sourceRevision: revision as number, sourceSchemaVersion: schemaVersion, data };
  };
  const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new DomainError('STORAGE', request.error?.message ?? '本地存储操作失败'));
  });
  /** Keeps the newest automatic copies; runs inside the transaction that added one. */
  const pruneRecoveryCopies = async (recovery: IDBObjectStore) => {
    const keys = await requestValue(recovery.getAllKeys());
    const automatic = keys
      .filter((key): key is string => typeof key === 'string' && /^restore-v2-\d+$/.test(key))
      .sort((left, right) => Number(right.slice('restore-v2-'.length)) - Number(left.slice('restore-v2-'.length)));
    for (const key of automatic.slice(RECOVERY_COPY_LIMIT)) recovery.delete(key);
  };
  const transact = async <T>(mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>, stores = [SNAPSHOT_STORE, META_STORE]): Promise<T> => {
    requireOpen(); const db = await open(); requireOpen();
    const tx = db.transaction(stores, mode);
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new DomainError('STORAGE', tx.error?.message ?? '本地存储事务失败'));
      tx.onabort = () => reject(new DomainError('STORAGE', tx.error?.message ?? '本地存储事务已回滚'));
    });
    void completed.catch(() => undefined);
    try { const value = await fn(tx); await completed; return value; }
    catch (error) { try { tx.abort(); } catch {} throw error; }
  };

  return {
    async read(): Promise<VersionedSnapshotV2> {
      return transact('readonly', async tx => {
        const record = await requestValue<{ revision: number; data: DataSnapshotV2 } | undefined>(tx.objectStore(SNAPSHOT_STORE).get(CURRENT_KEY));
        if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new DomainError('BACKUP_INCOMPATIBLE', '本地快照缺失或损坏');
        validateV2Snapshot(record.data);
        return structuredClone(record);
      });
    },
    async commit(expectedRevision, nextData) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      validateV2Snapshot(nextData);
      const nextRevision = await transact('readwrite', async tx => {
        const snapshots = tx.objectStore(SNAPSHOT_STORE);
        const current = await requestValue<{ revision: number; data: DataSnapshotV2 } | undefined>(snapshots.get(CURRENT_KEY));
        if (!current || current.revision !== expectedRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
        const revision = current.revision + 1;
        snapshots.put({ revision, data: structuredClone(nextData) }, CURRENT_KEY);
        tx.objectStore(META_STORE).put({ schemaVersion: 2, physicalVersion: DB_VERSION, revision }, META_KEY);
        return revision;
      });
      if (options.channelName && typeof BroadcastChannel !== 'undefined') {
        channel ??= new BroadcastChannel(options.channelName);
        channel.postMessage({ revision: nextRevision });
      }
      return nextRevision;
    },
    async restore(expectedRevision, nextData) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      validateV2Snapshot(nextData);
      const nextRevision = await transact('readwrite', async tx => {
        const snapshots = tx.objectStore(SNAPSHOT_STORE);
        const current = await requestValue<{ revision: number; data: DataSnapshotV2 } | undefined>(snapshots.get(CURRENT_KEY));
        if (!current || current.revision !== expectedRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
        // The recovery copy and replacement share this transaction: neither can
        // commit without the other, and a stale restore cannot create a copy.
        tx.objectStore(RECOVERY_STORE).add({ revision: current.revision, schemaVersion: 2, data: structuredClone(current.data) }, `restore-v2-${current.revision}`);
        await pruneRecoveryCopies(tx.objectStore(RECOVERY_STORE));
        const revision = current.revision + 1;
        snapshots.put({ revision, data: structuredClone(nextData) }, CURRENT_KEY);
        tx.objectStore(META_STORE).put({ schemaVersion: 2, physicalVersion: DB_VERSION, revision }, META_KEY);
        return revision;
      }, [SNAPSHOT_STORE, META_STORE, RECOVERY_STORE]);
      if (options.channelName && typeof BroadcastChannel !== 'undefined') {
        channel ??= new BroadcastChannel(options.channelName);
        channel.postMessage({ revision: nextRevision });
      }
      return nextRevision;
    },
    async listRecoverySnapshots(): Promise<RecoverySnapshotInfo[]> {
      return transact('readonly', async tx => {
        const recovery = tx.objectStore(RECOVERY_STORE);
        const [keys, values] = await Promise.all([
          requestValue(recovery.getAllKeys()),
          requestValue(recovery.getAll()),
        ]);
        return keys.flatMap((key, index) => {
          if (typeof key !== 'string') return [];
          const copy = recoveredData(key, values[index]);
          const storedData = (values[index] as { data: unknown }).data;
          return [{
            id: key,
            sourceRevision: copy.sourceRevision,
            sourceSchemaVersion: copy.sourceSchemaVersion,
            workspaceName: copy.data.workspace.name,
            seasonNames: copy.data.seasons.map(season => season.name),
            seasonCount: copy.data.seasons.length,
            applicationCount: copy.data.applications.length,
            estimatedJsonBytes: estimateJsonUtf8Bytes(storedData),
          }];
        }).sort((a, b) => b.sourceRevision - a.sourceRevision || a.id.localeCompare(b.id));
      }, [RECOVERY_STORE]);
    },
    async restoreRecoverySnapshot(expectedRevision, recoveryId) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      const nextRevision = await transact('readwrite', async tx => {
        const snapshots = tx.objectStore(SNAPSHOT_STORE);
        const recovery = tx.objectStore(RECOVERY_STORE);
        const [current, storedRecovery] = await Promise.all([
          requestValue<{ revision: number; data: DataSnapshotV2 } | undefined>(snapshots.get(CURRENT_KEY)),
          requestValue(recovery.get(recoveryId)),
        ]);
        if (!current || current.revision !== expectedRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
        validateV2Snapshot(current.data);
        const selected = recoveredData(recoveryId, storedRecovery);
        const displacedId = `restore-v2-${current.revision}`;
        if (displacedId === recoveryId) throw new DomainError('VALIDATION', '不能将当前恢复副本再次覆盖为自身');
        const revision = current.revision + 1;
        recovery.add({ revision: current.revision, schemaVersion: 2, data: structuredClone(current.data) }, displacedId);
        await pruneRecoveryCopies(recovery);
        snapshots.put({ revision, data: structuredClone(selected.data) }, CURRENT_KEY);
        tx.objectStore(META_STORE).put({ schemaVersion: 2, physicalVersion: DB_VERSION, revision }, META_KEY);
        return revision;
      }, [SNAPSHOT_STORE, META_STORE, RECOVERY_STORE]);
      if (options.channelName && typeof BroadcastChannel !== 'undefined') {
        channel ??= new BroadcastChannel(options.channelName);
        channel.postMessage({ revision: nextRevision });
      }
      return nextRevision;
    },
    async deleteRecoverySnapshot(expectedRevision, recoveryId) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      if (typeof recoveryId !== 'string' || recoveryId.length === 0) throw new DomainError('NOT_FOUND', '恢复副本不存在');
      const nextRevision = await transact('readwrite', async tx => {
        const snapshots = tx.objectStore(SNAPSHOT_STORE);
        const recovery = tx.objectStore(RECOVERY_STORE);
        const [current, selected] = await Promise.all([
          requestValue<{ revision: number; data: DataSnapshotV2 } | undefined>(snapshots.get(CURRENT_KEY)),
          requestValue(recovery.get(recoveryId)),
        ]);
        if (!current || current.revision !== expectedRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
        if (selected === undefined) throw new DomainError('NOT_FOUND', '恢复副本不存在');
        recoveredData(recoveryId, selected);
        const revision = current.revision + 1;
        recovery.delete(recoveryId);
        snapshots.put({ revision, data: current.data }, CURRENT_KEY);
        tx.objectStore(META_STORE).put({ schemaVersion: 2, physicalVersion: DB_VERSION, revision }, META_KEY);
        return revision;
      }, [SNAPSHOT_STORE, META_STORE, RECOVERY_STORE]);
      if (options.channelName && typeof BroadcastChannel !== 'undefined') {
        channel ??= new BroadcastChannel(options.channelName);
        channel.postMessage({ revision: nextRevision });
      }
      return nextRevision;
    },
    async close() {
      if (closed) return;
      closed = true; channel?.close(); channel = undefined;
      if (dbPromise) (await dbPromise).close();
    },
  };
}
