export const STAGES = ['draft', 'submitted', 'assessment', 'interview_1', 'interview_2', 'interview_3_plus'] as const;
export type Stage = typeof STAGES[number];
export const OUTCOMES = ['active', 'offer', 'rejected', 'withdrawn'] as const;
export type Outcome = typeof OUTCOMES[number];
export type BusinessDate = string;
export type Instant = string;
export interface Workspace { id: string; name: string; timeZone: string; activeSeasonId: string | null }
export interface Season { id: string; name: string; startDate: BusinessDate; endDate: BusinessDate; targetCount: number; archivedAt: Instant | null }
export interface Channel { id: string; name: string; archivedAt: Instant | null }
export interface Settings { schemaVersion: 1; lastBackupAt: Instant | null; preferences: Record<string, string | number | boolean> }
export interface Application {
  id: string; seasonId: string; company: string; role: string; city: string; channelId: string;
  jobUrl: string; appliedOn: BusinessDate | null; currentStage: Stage; outcome: Outcome;
  isStarred: boolean; notes: string; createdAt: Instant; updatedAt: Instant;
}
export interface StageEvent { id: string; applicationId: string; stage: Exclude<Stage, 'draft'>; occurredOn: BusinessDate; createdAt: Instant; supersededAt: Instant | null; source: 'create' | 'transition' | 'correction' }
export interface OutcomeEvent { id: string; applicationId: string; outcome: Outcome; occurredOn: BusinessDate; createdAt: Instant; supersededAt: Instant | null }
export interface Schedule { id: string; applicationId: string; type: 'assessment' | 'interview' | 'follow_up' | 'other'; title: string; startsAt: Instant; status: 'pending' | 'completed' | 'cancelled'; notes: string }
export interface ApplicationDetail { application: Application; stageEvents: StageEvent[]; outcomeEvents: OutcomeEvent[]; schedules: Schedule[] }
export interface WorkspaceSnapshot { workspace: Workspace; seasons: Season[]; channels: Channel[]; settings: Settings }
export interface DataSnapshot extends WorkspaceSnapshot { applications: Application[]; stageEvents: StageEvent[]; outcomeEvents: OutcomeEvent[]; schedules: Schedule[] }
export interface DateRange { from: BusinessDate; to: BusinessDate }
export interface ApplicationQuery { seasonId: string; keyword?: string; stages?: Stage[]; outcomes?: Outcome[]; city?: string; channelId?: string; appliedDateRange?: DateRange; sort?: { field: 'appliedOn' | 'updatedAt'; direction: 'asc' | 'desc' } }
export interface CreateApplicationInput { seasonId: string; company: string; role: string; city?: string; channelId?: string; jobUrl?: string; appliedOn?: BusinessDate | null; currentStage?: Stage; stageOccurredOn?: BusinessDate; isStarred?: boolean; notes?: string }
export interface UpdateApplicationInput { expectedUpdatedAt: Instant; company?: string; role?: string; city?: string; channelId?: string; jobUrl?: string; appliedOn?: BusinessDate; isStarred?: boolean; notes?: string }
export type TransitionInput = { id: string; expectedUpdatedAt: Instant; occurredOn: BusinessDate } & ({ kind: 'stage'; stage: Stage } | { kind: 'outcome'; outcome: Outcome });
export type CorrectHistoryInput = { id: string; expectedUpdatedAt: Instant; eventId: string } & ({ kind: 'stage'; replacement: { stage: Exclude<Stage, 'draft'>; occurredOn: BusinessDate } | null } | { kind: 'outcome'; replacement: { outcome: Outcome; occurredOn: BusinessDate } | null });
export interface ScheduleQuery { seasonId: string; applicationId?: string; status?: Schedule['status']; startsAtRange?: { from: Instant; to: Instant } }
export type SaveScheduleInput = Omit<Schedule, 'id'> & { id?: string };
export type SaveSeasonInput = Omit<Season, 'id'> & { id?: string };
export interface SettingsInput { name?: string; timeZone?: string; preferences?: Settings['preferences'] }
export type AnalyticsSnapshot = Pick<DataSnapshot, 'applications' | 'stageEvents' | 'outcomeEvents' | 'channels'>;
export interface AnalyticsQuery { seasonId: string; appliedDateRange?: DateRange }
export interface AnalyticsResult {
  recordCount: number; submittedCount: number; activeCount: number; interviewCount: number; offerCount: number;
  interviewRate: number | null; offerRate: number | null; thisWeekCount: number;
  stages: { stage: Exclude<Stage, 'draft'>; count: number; rate: number | null }[];
  activity: { date: BusinessDate; count: number; disabled: boolean }[];
  activityWindow: DateRange; activeDayCount: number;
  channels: { channelId: string; name: string; submittedCount: number; interviewCount: number; offerCount: number }[];
  cities: { city: string; count: number }[];
}
export type CalculateAnalytics = (snapshot: AnalyticsSnapshot, query: AnalyticsQuery, clock: { now: Instant; timeZone: string }) => AnalyticsResult;
export interface BackupEnvelope { format: 'autumn-applications'; schemaVersion: 1; exportedAt: Instant; data: DataSnapshot }
export type BackupValidation = { valid: true; data: BackupEnvelope; seasonCount: number; applicationCount: number } | { valid: false; issues: string[] };
