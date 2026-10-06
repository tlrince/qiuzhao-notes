import type { AppendProgressInput } from '../../domain/v2/progress.js';
import type { ProgressEvent, ProgressRecord, R1DefinitionsSnapshot, StatusDefinition } from '../../domain/v2/types.js';
import { activeProgressStatuses, pendingOfferCountForDraft, visitContinuation } from '../applications/progress-status-editor.js';

/**
 * One status in the sheet's status dropdown. Every live status is offered, grouped
 * under its stage (待一面 / 一面中 / 一面待结果 / 一面通过 / 一面挂 under 一面), so the
 * sheet records exactly what happened without opening the full editor.
 */
export interface QuickStatusOption {
  /** The status id; also the <option> value. */
  key: string;
  label: string;
  statusId: string;
  disabled: boolean;
  /** The <optgroup> this option belongs to. */
  group: string;
}

export interface QuickStatusTone {
  color: string;
  background: string;
}

export type QuickStatusResult =
  | { kind: 'noop' }
  /** Leaving a finished outcome needs an explicit reopen reason, so use the full editor. */
  | { kind: 'needs-reopen' }
  /** A later status on an unsubmitted row; ask before also recording the submission. */
  | { kind: 'needs-submission' }
  | { kind: 'append'; steps: AppendProgressInput[]; label: string };

const reopenable = new Set(['failed', 'offer_accepted', 'offer_declined', 'withdrawn']);

function effectiveEvents(record: ProgressRecord): ProgressEvent[] {
  return record.events.filter(event => event.invalidatedAt === null).sort((left, right) => left.sequence - right.sequence);
}

function keyFor(semantic: StatusDefinition['semantic'], stageId: string | null, statusId: string): string {
  if (semantic === 'draft' || semantic === 'submitted' || semantic === 'failed' || semantic === 'withdrawn'
    || semantic === 'offer_accepted' || semantic === 'offer_declined') return semantic;
  if (semantic === 'offer_received') return 'offer';
  return stageId ? `stage:${stageId}` : `status:${statusId}`;
}

/** The dropdown key of the application's current position. */
export function currentQuickStatusKey(record: ProgressRecord): string {
  const current = effectiveEvents(record).at(-1);
  return current ? keyFor(current.semantics.semantic, current.semantics.stageId, current.statusId) : 'draft';
}

const OUTCOME_SEMANTICS = new Set(['offer_received', 'offer_accepted', 'offer_declined', 'withdrawn']);

/** Every live status in process order and grouped by stage; the current status is selected and labelled exactly. */
export function quickStatusOptions(definitions: R1DefinitionsSnapshot, record: ProgressRecord): QuickStatusOption[] {
  const statuses = activeProgressStatuses(definitions);
  const events = effectiveEvents(record);
  const current = events.at(-1) ?? null;
  const submitted = events.some(event => event.semantics.semantic === 'submitted');
  const pendingOffers = pendingOfferCountForDraft(record, { mode: 'append', eventId: '' });
  const options: QuickStatusOption[] = [];
  const add = (status: StatusDefinition, group: string, disabled = false) => options.push({ key: status.id, label: status.name, statusId: status.id, disabled, group });

  for (const status of statuses) {
    if (status.semantic === 'draft' && current === null) add(status, '投递');
    if (status.semantic === 'submitted') add(status, '投递', submitted && current?.statusId !== status.id);
  }
  const stages = definitions.stages
    .filter(stage => stage.archivedAt === null && stage.category !== 'offer')
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  for (const stage of stages) {
    for (const status of statuses) if (status.stageId === stage.id && !OUTCOME_SEMANTICS.has(status.semantic)) add(status, stage.name);
  }
  for (const status of statuses) {
    if (status.semantic === 'offer_received') add(status, 'Offer');
    if ((status.semantic === 'offer_accepted' || status.semantic === 'offer_declined') && (pendingOffers > 0 || current?.statusId === status.id)) add(status, 'Offer');
  }
  const listed = new Set(options.map(option => option.statusId));
  for (const status of statuses) {
    const general = status.stageId === null || !stages.some(stage => stage.id === status.stageId);
    if (!listed.has(status.id) && general && status.semantic !== 'draft' && status.semantic !== 'submitted' && !OUTCOME_SEMANTICS.has(status.semantic)) add(status, '其他');
  }
  for (const status of statuses) if (status.semantic === 'withdrawn') add(status, '其他');

  if (current && !options.some(option => option.statusId === current.statusId)) {
    options.unshift({ key: current.statusId, label: current.statusNameSnapshot, statusId: current.statusId, disabled: true, group: '当前' });
  }
  return options;
}

/** Consecutive options sharing a group, for rendering <optgroup>s. */
export function groupQuickStatusOptions(options: readonly QuickStatusOption[]): { label: string; options: QuickStatusOption[] }[] {
  const groups: { label: string; options: QuickStatusOption[] }[] = [];
  for (const option of options) {
    const last = groups.at(-1);
    if (last && last.label === option.group) last.options.push(option);
    else groups.push({ label: option.group, options: [option] });
  }
  return groups;
}

/** Turns a dropdown choice into append steps; it never fabricates a submission on its own. */
export function buildQuickStatusChange(args: {
  definitions: R1DefinitionsSnapshot;
  record: ProgressRecord;
  option: QuickStatusOption;
  today: string;
  commandId: string;
  /** The user agreed to record 已投递 (today) before the chosen later status. */
  withSubmission?: boolean;
}): QuickStatusResult {
  const { definitions, record, option, today, commandId } = args;
  const events = effectiveEvents(record);
  const current = events.at(-1) ?? null;
  if (option.statusId === current?.statusId || option.disabled) return { kind: 'noop' };
  if (current && reopenable.has(current.semantics.terminalOutcome)) return { kind: 'needs-reopen' };

  const statuses = activeProgressStatuses(definitions);
  const status = statuses.find(item => item.id === option.statusId);
  if (!status) return { kind: 'noop' };
  const failedAt: AppendProgressInput['failedAt'] = status.semantic === 'failed' ? status.stageId ? { stageId: status.stageId } : 'unknown' : undefined;

  const occurredOn = current && current.occurredOn > today ? current.occurredOn : today;
  const steps: AppendProgressInput[] = [];
  const submitted = events.some(event => event.semantics.semantic === 'submitted');
  if (!submitted && status.semantic !== 'submitted' && status.semantic !== 'draft') {
    if (!args.withSubmission) return { kind: 'needs-submission' };
    const submission = statuses.find(item => item.semantic === 'submitted');
    if (!submission) return { kind: 'noop' };
    steps.push({ commandId: `${commandId}:submitted`, statusId: submission.id, occurredOn });
  }
  const continueVisit = steps.length === 0 && visitContinuation(definitions, record, status.id).suggested;
  steps.push({
    commandId,
    statusId: status.id,
    occurredOn,
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(continueVisit ? { mode: 'continue_visit' as const } : {}),
  });
  return { kind: 'append', steps, label: status.name };
}

const TONES: Readonly<Record<string, readonly [string, string]>> = {
  draft: ['#64748b', '#f1f5f9'],
  submitted: ['#2563eb', '#eff6ff'],
  'stage:screening': ['#0284c7', '#f0f9ff'],
  'stage:assessment': ['#0891b2', '#ecfeff'],
  'stage:written_test': ['#4f46e5', '#eef2ff'],
  'stage:ai_interview': ['#0d9488', '#f0fdfa'],
  'stage:interview_1': ['#7c3aed', '#f5f3ff'],
  'stage:interview_2': ['#9333ea', '#faf5ff'],
  'stage:interview_3': ['#c026d3', '#fdf4ff'],
  'stage:legacy_interview_3_plus': ['#c026d3', '#fdf4ff'],
  'stage:interview_4': ['#db2777', '#fdf2f8'],
  'stage:interview_extra': ['#e11d48', '#fff1f2'],
  'stage:pool': ['#d97706', '#fffbeb'],
  offer: ['#16a34a', '#f0fdf4'],
  offer_accepted: ['#15803d', '#dcfce7'],
  offer_declined: ['#78716c', '#f5f5f4'],
  failed: ['#dc2626', '#fef2f2'],
  withdrawn: ['#78716c', '#f5f5f4'],
};

const CATEGORY_TONES: Readonly<Record<string, readonly [string, string]>> = {
  screening: TONES['stage:screening']!,
  written_test: TONES['stage:written_test']!,
  assessment: TONES['stage:assessment']!,
  ai_interview: TONES['stage:ai_interview']!,
  interview: ['#7c3aed', '#f5f3ff'],
  pool: TONES['stage:pool']!,
  offer: TONES.offer!,
};

/** Status colours follow offer.html; custom stages borrow their category's colour. */
export function quickStatusTone(key: string, definitions: R1DefinitionsSnapshot): QuickStatusTone {
  const known = TONES[key];
  if (known) return { color: known[0], background: known[1] };
  const stage = key.startsWith('stage:') ? definitions.stages.find(item => item.id === key.slice('stage:'.length)) : undefined;
  const byCategory = stage ? CATEGORY_TONES[stage.category] : undefined;
  if (byCategory) return { color: byCategory[0], background: byCategory[1] };
  const status = key.startsWith('status:') ? definitions.statuses.find(item => item.id === key.slice('status:'.length)) : undefined;
  const color = status?.color ?? '#78716c';
  return { color, background: `${color}1a` };
}

/** Display label of a dropdown key, used for filter chips. */
export function quickStatusKeyLabel(key: string, definitions: R1DefinitionsSnapshot): string {
  const fixed: Record<string, string> = { draft: '待投递', submitted: '已投递', offer: 'Offer', offer_accepted: '已接受 Offer', offer_declined: '已拒绝 Offer', failed: '挂掉', withdrawn: '主动退出' };
  if (fixed[key]) return fixed[key];
  if (key.startsWith('stage:')) {
    const stageId = key.slice('stage:'.length);
    const named = definitions.statuses.find(status => status.stageId === stageId && (status.semantic === 'screening' || status.semantic === 'pool'));
    return named?.name ?? definitions.stages.find(stage => stage.id === stageId)?.name ?? stageId;
  }
  return definitions.statuses.find(status => status.id === key.slice('status:'.length))?.name ?? key;
}

/** Process order for chips: draft, submission, stages by sort order, then outcomes. */
export function quickStatusKeyRank(key: string, definitions: R1DefinitionsSnapshot): number {
  const fixed: Record<string, number> = { draft: 0, submitted: 1, offer: 100_000, offer_accepted: 100_001, offer_declined: 100_002, failed: 100_003, withdrawn: 100_004 };
  if (fixed[key] !== undefined) return fixed[key]!;
  if (key.startsWith('stage:')) return 10 + (definitions.stages.find(stage => stage.id === key.slice('stage:'.length))?.sortOrder ?? 90_000);
  return 100_005;
}
