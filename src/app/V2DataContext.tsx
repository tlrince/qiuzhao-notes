import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DataSnapshotV2 } from '../domain/v2/snapshot.js';
import type { ApplicationCommands } from '../repositories/v2/application-commands.js';
import { createApplicationCommands } from '../repositories/v2/application-commands.js';
import type { SnapshotStoreV2, VersionedSnapshotV2 } from '../repositories/storage-v2-contract.js';
import type { WorkspaceCommands } from '../repositories/v2/workspace-commands.js';
import { createWorkspaceCommands } from '../repositories/v2/workspace-commands.js';
import type { DefinitionCommands } from '../repositories/v2/definition-commands.js';
import { createDefinitionCommands } from '../repositories/v2/definition-commands.js';
import type { BackupCommands } from '../repositories/v2/backup-commands.js';
import { createBackupCommands } from '../repositories/v2/backup-commands.js';
import type { ImportCommands } from '../repositories/v2/import-commands.js';
import { createImportCommands } from '../repositories/v2/import-commands.js';
import type { ScheduleCommands } from '../repositories/v2/schedule-commands.js';
import { createScheduleCommands } from '../repositories/v2/schedule-commands.js';

export type V2SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface V2DataContextValue {
  snapshot: DataSnapshotV2;
  revision: number;
  saveStatus: V2SaveStatus;
  lastError: string | null;
  commands: ApplicationCommands;
  workspaceCommands: WorkspaceCommands;
  definitionCommands: DefinitionCommands;
  backupCommands: BackupCommands;
  importCommands: ImportCommands;
  scheduleCommands: ScheduleCommands;
  refresh(): Promise<VersionedSnapshotV2>;
  runCommand<T>(action: (commands: ApplicationCommands, revision: number) => Promise<T>): Promise<T>;
  runWorkspaceCommand<T>(action: (commands: WorkspaceCommands, revision: number) => Promise<T>): Promise<T>;
  runDefinitionCommand<T>(action: (commands: DefinitionCommands, revision: number) => Promise<T>): Promise<T>;
  runBackupCommand<T>(action: (commands: BackupCommands, revision: number) => Promise<T>): Promise<T>;
  runImportCommand<T>(action: (commands: ImportCommands, revision: number) => Promise<T>): Promise<T>;
  runScheduleCommand<T>(action: (commands: ScheduleCommands, revision: number) => Promise<T>): Promise<T>;
  recordBackupAt(at: string): Promise<void>;
  /** Clears a failed-save notice; the failed command committed nothing, so stored data is unchanged. */
  dismissError(): void;
}

const V2DataContext = createContext<V2DataContextValue | null>(null);

/**
 * Shared v2 state for every business route. The render entry must call read()
 * before mounting so migrations complete before any route can write.
 */
export function V2DataProvider({
  store,
  initial,
  children,
  channelName = 'autumn-applications-v2',
}: {
  store: SnapshotStoreV2;
  initial: VersionedSnapshotV2;
  children: ReactNode;
  channelName?: string;
}) {
  const [stored, setStored] = useState(initial);
  // Commands read the newest loaded revision at call time, so actions run later
  // (such as an undo button in a notice) do not carry a stale revision.
  const revisionRef = useRef(initial.revision);
  useLayoutEffect(() => { revisionRef.current = stored.revision; }, [stored.revision]);
  // The initial snapshot was just read from durable storage, so it is already saved.
  const [saveStatus, setSaveStatus] = useState<V2SaveStatus>('saved');
  const [lastError, setLastError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const commands = useMemo(() => createApplicationCommands(store), [store]);
  const workspaceCommands = useMemo(() => createWorkspaceCommands(store), [store]);
  const definitionCommands = useMemo(() => createDefinitionCommands(store), [store]);
  const backupCommands = useMemo(() => createBackupCommands(store), [store]);
  const importCommands = useMemo(() => createImportCommands(store), [store]);
  const scheduleCommands = useMemo(() => createScheduleCommands(store), [store]);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const latest = await store.read();
    if (generation === refreshGeneration.current) {
      setStored(current => latest.revision >= current.revision ? latest : current);
      if (latest.revision > revisionRef.current) revisionRef.current = latest.revision;
    }
    return latest;
  }, [store]);

  const runCommand = useCallback(async <T,>(action: (commandSet: ApplicationCommands, revision: number) => Promise<T>) => {
    setSaveStatus('saving');
    setLastError(null);
    try {
      const value = await action(commands, revisionRef.current);
      await refresh();
      setSaveStatus('saved');
      return value;
    } catch (cause) {
      // A conflict means another tab/window may already have committed a newer snapshot.
      try { await refresh(); } catch { /* Preserve the original command failure. */ }
      const message = cause instanceof Error ? cause.message : String(cause);
      setLastError(message);
      setSaveStatus('error');
      throw cause;
    }
  }, [commands, refresh]);

  const runWorkspaceCommand = useCallback(async <T,>(action: (commandSet: WorkspaceCommands, revision: number) => Promise<T>) => {
    setSaveStatus('saving');
    setLastError(null);
    try {
      const value = await action(workspaceCommands, revisionRef.current);
      await refresh();
      setSaveStatus('saved');
      return value;
    } catch (cause) {
      try { await refresh(); } catch { /* Preserve the original command failure. */ }
      const message = cause instanceof Error ? cause.message : String(cause);
      setLastError(message);
      setSaveStatus('error');
      throw cause;
    }
  }, [refresh, workspaceCommands]);

  const runDefinitionCommand = useCallback(async <T,>(action: (commandSet: DefinitionCommands, revision: number) => Promise<T>) => {
    setSaveStatus('saving');
    setLastError(null);
    try {
      const value = await action(definitionCommands, revisionRef.current);
      await refresh();
      setSaveStatus('saved');
      return value;
    } catch (cause) {
      try { await refresh(); } catch { /* Preserve the original command failure. */ }
      const message = cause instanceof Error ? cause.message : String(cause);
      setLastError(message);
      setSaveStatus('error');
      throw cause;
    }
  }, [definitionCommands, refresh]);

  const runBackupCommand = useCallback(async <T,>(action: (commandSet: BackupCommands, revision: number) => Promise<T>) => {
    setSaveStatus('saving');
    setLastError(null);
    try {
      const value = await action(backupCommands, revisionRef.current);
      await refresh();
      setSaveStatus('saved');
      return value;
    } catch (cause) {
      try { await refresh(); } catch { /* Preserve the original command failure. */ }
      const message = cause instanceof Error ? cause.message : String(cause);
      setLastError(message);
      setSaveStatus('error');
      throw cause;
    }
  }, [backupCommands, refresh]);

  const runImportCommand = useCallback(async <T,>(action: (commandSet: ImportCommands, revision: number) => Promise<T>) => {
    setSaveStatus('saving');
    setLastError(null);
    try {
      const value = await action(importCommands, revisionRef.current);
      await refresh();
      setSaveStatus('saved');
      return value;
    } catch (cause) {
      try { await refresh(); } catch { /* Preserve the original command failure. */ }
      const message = cause instanceof Error ? cause.message : String(cause);
      setLastError(message);
      setSaveStatus('error');
      throw cause;
    }
  }, [importCommands, refresh]);

  const runScheduleCommand = useCallback(async <T,>(action: (commandSet: ScheduleCommands, revision: number) => Promise<T>) => {
    setSaveStatus('saving');
    setLastError(null);
    try {
      const value = await action(scheduleCommands, revisionRef.current);
      await refresh();
      setSaveStatus('saved');
      return value;
    } catch (cause) {
      try { await refresh(); } catch { /* Preserve the original command failure. */ }
      const message = cause instanceof Error ? cause.message : String(cause);
      setLastError(message);
      setSaveStatus('error');
      throw cause;
    }
  }, [refresh, scheduleCommands]);

  const recordBackupAt = useCallback(async (at: string) => {
    // File output succeeds independently of this bookkeeping write. Re-read and
    // CAS against the latest snapshot so a concurrent tab edit is not lost.
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await store.read();
      if (latest.data.settings.lastBackupAt && latest.data.settings.lastBackupAt >= at) {
        await refresh();
        return;
      }
      const next = structuredClone(latest.data);
      next.settings.lastBackupAt = at;
      try {
        await store.commit(latest.revision, next);
        await refresh();
        setSaveStatus('saved');
        return;
      } catch (cause) {
        if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'CONFLICT') || attempt === 2) throw cause;
      }
    }
  }, [refresh, store]);

  const dismissError = useCallback(() => {
    setLastError(null);
    setSaveStatus(current => current === 'error' ? 'saved' : current);
  }, []);

  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(channelName);
      channel.onmessage = () => { void refresh().catch(error => {
        setLastError(error instanceof Error ? error.message : String(error));
        setSaveStatus('error');
      }); };
    }
    const onFocus = () => { void refresh().catch(error => {
      setLastError(error instanceof Error ? error.message : String(error));
      setSaveStatus('error');
    }); };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      channel?.close();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [channelName, refresh]);

  const value = useMemo<V2DataContextValue>(() => ({
    snapshot: stored.data,
    revision: stored.revision,
    saveStatus,
    lastError,
    commands,
    workspaceCommands,
    definitionCommands,
    backupCommands,
    importCommands,
    scheduleCommands,
    refresh,
    runCommand,
    runWorkspaceCommand,
    runDefinitionCommand,
    runBackupCommand,
    runImportCommand,
    runScheduleCommand,
    recordBackupAt,
    dismissError,
  }), [stored, saveStatus, lastError, commands, workspaceCommands, definitionCommands, backupCommands, importCommands, scheduleCommands, refresh, runCommand, runWorkspaceCommand, runDefinitionCommand, runBackupCommand, runImportCommand, runScheduleCommand, recordBackupAt, dismissError]);

  return <V2DataContext.Provider value={value}>{children}</V2DataContext.Provider>;
}

export function useV2Data(): V2DataContextValue {
  const value = useContext(V2DataContext);
  if (!value) throw new Error('V2DataProvider is required');
  return value;
}
