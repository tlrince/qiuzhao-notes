export type StageCategory = 'screening' | 'written_test' | 'assessment' | 'ai_interview' | 'interview' | 'pool' | 'offer' | 'custom';
export type ProgressPhase = 'unknown' | 'waiting' | 'in_progress' | 'awaiting_result' | 'passed';
export type StatusSemantic = 'draft' | 'submitted' | 'screening' | 'pool' | 'stage' | 'offer_received' | 'offer_accepted' | 'offer_declined' | 'failed' | 'withdrawn' | 'custom';
export type TerminalOutcome = 'active' | 'offer_received' | 'offer_accepted' | 'offer_declined' | 'failed' | 'withdrawn';

export interface StageDefinition {
  id: string;
  name: string;
  category: StageCategory;
  sortOrder: number;
  archivedAt: string | null;
  interviewRound?: number;
  countsAsInterview: boolean;
}

/** The fields that determine event meaning at a particular configuration revision. */
export interface StatusSemanticsVersion {
  version: number;
  semantic: StatusSemantic;
  stageId: string | null;
  stageCategory: StageCategory | null;
  defaultPhase: ProgressPhase;
  statisticsCategory: string | null;
  countsAsInterview: boolean;
}

/** Mutable display definition. Events copy the semantic fields and label at entry time. */
export interface StatusDefinition {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  version: number;
  archivedAt: string | null;
  semantic: StatusSemantic;
  stageId: string | null;
  defaultPhase: ProgressPhase;
  statisticsCategory: string | null;
  semanticsHistory: StatusSemanticsVersion[];
}

export type FailedAt = { stageId: string; stageNameSnapshot: string } | 'unknown';

export interface ProgressSemanticsSnapshot {
  semantic: StatusSemantic;
  stageId: string | null;
  stageCategory: StageCategory | null;
  stageNameSnapshot: string | null;
  countsAsInterview: boolean;
  statisticsCategory: string | null;
  terminalOutcome: TerminalOutcome;
}

export interface ProgressEvent {
  id: string;
  applicationId: string;
  commandId: string;
  statusId: string;
  statusNameSnapshot: string;
  definitionVersion: number;
  semantics: ProgressSemanticsSnapshot;
  phase: ProgressPhase;
  occurredOn: string;
  createdAt: string;
  sequence: number;
  previousEventId: string | null;
  visitId: string;
  source: 'entered' | 'continued' | 'reopened' | 'backfilled';
  visitAction: 'new' | 'continue';
  insertedBeforeEventId: string | null;
  reopenReason: string | null;
  reopensEventId: string | null;
  correctionOfEventId: string | null;
  failedAt: FailedAt | null;
  contextStageId: string | null;
  notes: string;
  invalidatedAt: string | null;
  /** Present only for records migrated from an older event model. */
  migrationMeta?: {
    legacyKind: 'stage' | 'outcome';
    legacyEventId: string;
    legacySource?: string;
    legacyReached?: boolean;
    /** An old active record may continue after a terminal outcome without an explicit reopen command. */
    legacyContinuationOfEventId?: string;
    rawEvent: Record<string, unknown>;
  };
}

export interface ProgressRecord {
  applicationId: string;
  appliedOn: string | null;
  events: ProgressEvent[];
  annotations: StageAnnotation[];
  /** The stored sequence is deterministic; marked edges are not asserted as historical fact. */
  migrationReview?: {
    status: 'confirmed' | 'needs_confirmation';
    uncertainEdges: Array<{ fromEventId: string; toEventId: string; reason: string }>;
  };
}

/** A table-only mark. It is not a real visit and never contributes a progress event. */
export interface StageAnnotation {
  id: string;
  applicationId: string;
  commandId: string;
  stageId: string;
  kind: 'skipped';
  notes: string;
  createdAt: string;
  invalidatedAt: string | null;
}

export interface ProgressView {
  applicationId: string;
  currentEvent: ProgressEvent | null;
  currentStatusName: string | null;
  events: ProgressEvent[];
  visits: ProgressVisit[];
  activeVisitCount: number;
  offerCount: number;
  failedAt: FailedAt | null;
  uncertainEdges: Array<{ fromEventId: string; toEventId: string; reason: string }>;
}

export interface ProgressVisit {
  id: string;
  statusId: string;
  statusName: string;
  statusNameSnapshot: string;
  stageId: string | null;
  firstEvent: ProgressEvent;
  lastEvent: ProgressEvent;
  events: ProgressEvent[];
  countAsInterview: boolean;
}

export interface StageCellProjection {
  stageId: string;
  stageName: string;
  visits: number;
  latest: ProgressVisit | null;
  daysInCurrentVisit: number | null;
  skipped: boolean;
  annotationNotes: string[];
}

export interface ProgressProjection extends ProgressView {
  stages: StageCellProjection[];
}

export interface R1DefinitionsSnapshot {
  stages: StageDefinition[];
  statuses: StatusDefinition[];
}
