import type { DataSnapshot } from '../domain/types.js';
import { DomainError } from '../domain/errors.js';
import { emptySnapshot } from '../fixtures/acceptance.js';
export interface VersionedSnapshot { revision: number; data: DataSnapshot }
/** Adapters must compare revision and replace the entire snapshot in one transaction. */
export interface SnapshotStore {
  read(): Promise<VersionedSnapshot>;
  commit(expectedRevision: number, nextData: DataSnapshot): Promise<number>;
  close(): Promise<void>;
}
/** Contract reference only; not persistent and does not execute business commands. */
export function createMemorySnapshotStore(seed: DataSnapshot = emptySnapshot()): SnapshotStore {
  let current: VersionedSnapshot = { revision: 0, data: structuredClone(seed) }, closed = false;
  const requireOpen = () => { if (closed) throw new DomainError('STORAGE', '存储已关闭'); };
  return {
    async read() { requireOpen(); return structuredClone(current); },
    async commit(expectedRevision, nextData) {
      requireOpen();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
      if (current.revision === Number.MAX_SAFE_INTEGER) throw new DomainError('STORAGE', '存储版本号已达到上限');
      const data = structuredClone(nextData);
      current = { revision: current.revision + 1, data }; return current.revision;
    },
    async close() { closed = true; },
  };
}
