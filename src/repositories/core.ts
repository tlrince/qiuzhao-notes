import type * as T from '../domain/types.js';
import type { ApplicationRepository, ScheduleRepository, WorkspaceRepository, RepositoryEvents, RepositoryChange } from './contracts.js';
import type { SnapshotStore } from './storage-contract.js';
import { createMemoryRepositories } from './memory.js';

export interface SnapshotRepositories {
  applications: ApplicationRepository;
  schedules: ScheduleRepository;
  workspace: WorkspaceRepository;
  events: RepositoryEvents;
  snapshot(): Promise<{ revision: number; data: T.DataSnapshot }>;
  close(): Promise<void>;
}

/** 共用事务编排：领域命令在单一快照上执行，随后以 CAS 原子替换整个快照。 */
export function createSnapshotRepositories(store: SnapshotStore, options: { now?: () => string; id?: () => string } = {}): SnapshotRepositories {
  const listeners = new Set<(change: RepositoryChange) => void>();
  const transact = async <R>(scope: RepositoryChange['scope'], id: string | null, fn: (r: ReturnType<typeof createMemoryRepositories>) => Promise<R>): Promise<R> => {
    const before = await store.read();
    const memory = createMemoryRepositories(before.data, options);
    const result = await fn(memory);
    await store.commit(before.revision, memory.snapshot());
    for (const listener of listeners) { try { listener({ scope, id }); } catch (error) { console.error('Repository subscriber failed', error); } }
    return result;
  };
  const readRepo = async () => createMemoryRepositories((await store.read()).data, options);
  const applications: ApplicationRepository = {
    list: async q => (await readRepo()).applications.list(q),
    getDetail: async id => (await readRepo()).applications.getDetail(id),
    create: async input => transact('applications', null, r => r.applications.create(input)),
    update: async (id, input) => transact('applications', id, r => r.applications.update(id, input)),
    transition: async input => transact('applications', input.id, r => r.applications.transition(input)),
    correctHistory: async input => transact('applications', input.id, r => r.applications.correctHistory(input)),
    remove: async id => transact('applications', id, r => r.applications.remove(id)),
  };
  const schedules: ScheduleRepository = {
    list: async q => (await readRepo()).schedules.list(q),
    save: async input => transact('schedules', input.id ?? null, r => r.schedules.save(input)),
    remove: async id => transact('schedules', id, r => r.schedules.remove(id)),
  };
  const workspace: WorkspaceRepository = {
    get: async () => (await readRepo()).workspace.get(),
    saveSeason: async input => transact('workspace', input.id ?? null, r => r.workspace.saveSeason(input)),
    setActiveSeason: async id => transact('workspace', id, r => r.workspace.setActiveSeason(id)),
    saveSettings: async input => transact('workspace', null, r => r.workspace.saveSettings(input)),
  };
  const events: RepositoryEvents = { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  return { applications, schedules, workspace, events, async snapshot() { return structuredClone(await store.read()); }, close: () => store.close() };
}

export function createDefaultSnapshotRepositories(store: SnapshotStore, options?: { now?: () => string; id?: () => string }) {
  return createSnapshotRepositories(store, options);
}
