import type { DataSnapshot } from '../../domain/types.js';
import { DomainError } from '../../domain/errors.js';
import type { SnapshotStore, VersionedSnapshot } from '../storage-contract.js';

interface NativeSnapshot { revision: number; data: DataSnapshot }

function nativeError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const message = String(error);
  if (message.includes('CONFLICT:') || message.includes('冲突:')) return new DomainError('CONFLICT', message);
  if (message.includes('BACKUP_INCOMPATIBLE:') || message.includes('版本不兼容')) return new DomainError('BACKUP_INCOMPATIBLE', message);
  if (message.includes('VALIDATION:')) return new DomainError('VALIDATION', message);
  return new DomainError('STORAGE', message);
}

/** Tauri IPC adapter. The Rust command owns the SQLite transaction and app-data path. */
export function createDesktopSnapshotStore(): SnapshotStore {
  let closed = false;
  const invoke = async <T>(command: string, args?: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(command, args);
  const open = () => { if (closed) throw new DomainError('STORAGE', '存储已关闭'); };
  return {
    async read(): Promise<VersionedSnapshot> { open(); try { const value = await invoke<NativeSnapshot>('read_snapshot'); if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new DomainError('STORAGE', '存储版本号无效'); if (value.data.settings?.schemaVersion !== 1) throw new DomainError('BACKUP_INCOMPATIBLE', '当前客户端不能读取新版本地数据，请升级应用'); return structuredClone(value); } catch (error) { throw nativeError(error); } },
    async commit(expectedRevision, data) { open(); if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new DomainError('CONFLICT', '数据已更新，请重新加载'); if (data.settings.schemaVersion !== 1) throw new DomainError('BACKUP_INCOMPATIBLE', '当前客户端不能写入新版本地数据，请升级应用'); try { return await invoke<number>('commit_snapshot', { expectedRevision, data: structuredClone(data) }); } catch (error) { throw nativeError(error); } },
    async close() { closed = true; },
  };
}
