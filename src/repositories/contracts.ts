import type * as T from '../domain/types.js';
export interface ApplicationRepository {
  list(query: T.ApplicationQuery): Promise<T.Application[]>;
  getDetail(id: string): Promise<T.ApplicationDetail | null>;
  create(input: T.CreateApplicationInput): Promise<T.ApplicationDetail>;
  update(id: string, input: T.UpdateApplicationInput): Promise<T.ApplicationDetail>;
  transition(input: T.TransitionInput): Promise<T.ApplicationDetail>;
  correctHistory(input: T.CorrectHistoryInput): Promise<T.ApplicationDetail>;
  remove(id: string): Promise<void>;
}
export interface ScheduleRepository { list(query: T.ScheduleQuery): Promise<T.Schedule[]>; save(input: T.SaveScheduleInput): Promise<T.Schedule>; remove(id: string): Promise<void> }
export interface WorkspaceRepository { get(): Promise<T.WorkspaceSnapshot>; saveSeason(input: T.SaveSeasonInput): Promise<T.Season>; setActiveSeason(id: string): Promise<void>; saveSettings(input: T.SettingsInput): Promise<void> }
export interface BackupService { exportAll(): Promise<T.BackupEnvelope>; validate(input: unknown): T.BackupValidation; restore(input: T.BackupEnvelope, mode: 'replace'): Promise<void> }
export interface RepositoryChange { scope: 'applications' | 'schedules' | 'workspace'; id: string | null }
export interface RepositoryEvents { subscribe(listener: (change: RepositoryChange) => void): () => void }
