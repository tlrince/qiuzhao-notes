import type { DataSnapshot } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import { emptySnapshot } from '../../fixtures/acceptance.js';
import type { SnapshotStore, VersionedSnapshot } from '../storage-contract.js';

export interface IndexedDbSnapshotStoreOptions {
  dbName?: string;
  indexedDB?: IDBFactory;
  channelName?: string;
}

const DB_VERSION = 1;
const SNAPSHOT_STORE = 'snapshot';
const META_STORE = 'meta';
const CURRENT_KEY = 'current';

export function createIndexedDbSnapshotStore(options: IndexedDbSnapshotStoreOptions = {}): SnapshotStore {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new DomainError('STORAGE', '当前环境不支持 IndexedDB');
  const dbName = options.dbName ?? 'autumn-notes-v1';
  let closed = false;
  let dbPromise: Promise<IDBDatabase> | undefined;
  let channel: BroadcastChannel | undefined;

  const open = () => dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = factory.open(dbName, DB_VERSION); } catch (error) { reject(new DomainError('STORAGE', String(error))); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) db.createObjectStore(SNAPSHOT_STORE);
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(new DomainError('STORAGE', request.error?.message ?? '无法打开本地存储'));
    request.onblocked = () => reject(new DomainError('STORAGE', '本地存储升级被阻塞'));
  });

  const requireOpen = () => { if (closed) throw new DomainError('STORAGE', '存储已关闭'); };
  const transact = async <T>(mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>): Promise<T> => {
    requireOpen();
    const db = await open();
    requireOpen();
    const tx = db.transaction([SNAPSHOT_STORE, META_STORE], mode);
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new DomainError('STORAGE', tx.error?.message ?? '本地存储事务失败'));
      tx.onabort = () => reject(new DomainError('STORAGE', tx.error?.message ?? '本地存储事务已回滚'));
    });
    // A validation error aborts the transaction before `completed` is awaited.
    // Attach a handler immediately so the abort rejection cannot become unhandled.
    void completed.catch(() => undefined);
    try { const value = await fn(tx); await completed; return value; } catch (error) { try { tx.abort(); } catch {} throw error; }
  };
  const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new DomainError('STORAGE', request.error?.message ?? '本地存储操作失败'));
  });

  const store: SnapshotStore = {
    async read(): Promise<VersionedSnapshot> {
      return transact('readonly', async tx => {
        const record = await requestValue<{ revision: number; data: DataSnapshot } | undefined>(tx.objectStore(SNAPSHOT_STORE).get(CURRENT_KEY));
        if (record && record.data.settings?.schemaVersion !== 1) throw new DomainError('BACKUP_INCOMPATIBLE', '当前客户端不能读取新版本地数据，请升级应用');
        return record ? structuredClone(record) : { revision: 0, data: emptySnapshot() };
      });
    },
    async commit(expectedRevision, nextData) {
      return transact('readwrite', async tx => {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
        if (nextData.settings.schemaVersion !== 1) throw new DomainError('BACKUP_INCOMPATIBLE', '当前客户端不能写入新版本地数据，请升级应用');
        const os = tx.objectStore(SNAPSHOT_STORE);
        const current = await requestValue<{ revision: number; data: DataSnapshot } | undefined>(os.get(CURRENT_KEY));
        const revision = current?.revision ?? 0;
        if (revision !== expectedRevision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
        if (revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
        const nextRevision = revision + 1;
        os.put({ revision: nextRevision, data: structuredClone(nextData) }, CURRENT_KEY);
        tx.objectStore(META_STORE).put({ schemaVersion: 1, revision: nextRevision }, 'state');
        if (options.channelName && typeof BroadcastChannel !== 'undefined') {
          channel ??= new BroadcastChannel(options.channelName);
          channel.postMessage({ revision: nextRevision });
        }
        return nextRevision;
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      channel?.close(); channel = undefined;
      if (dbPromise) (await dbPromise).close();
    },
  };
  return store;
}
