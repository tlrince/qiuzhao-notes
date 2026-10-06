import type { AppendProgressInput } from '../../domain/v2/progress.js';
import type { ProgressEvent, ProgressRecord, R1DefinitionsSnapshot, StatusDefinition } from '../../domain/v2/types.js';
import { activeProgressStatuses, pendingOfferCountForDraft, visitContinuation } from '../applications/progress-status-editor.js';

/**
 * One coarse choice in the sheet's status dropdown, like the original offer.html list
 * (已投递、筛选中、笔试、一面…挂掉). Each choice records one representative status;
 * finer phases stay available in the full status editor.
 */
export interface QuickStatusOption {
  key: string;
  label: string;
  statusId: string;
  disabled: boolean;
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

function representative(statuses: StatusDefinition[], stageId: string): StatusDefinition | undefined {
  const linked = statuses.filter(status => status.stageId === stageId && status.semantic !== 'failed'
    && status.semantic !== 'offer_accepted' && status.semantic !== 'offer_declined');
  return linked.find(status => status.semantic === 'screening' || status.semantic === 'pool')
    ?? linked.find(status => status.semantic === 'stage' && status.defaultPhase === 'in_progress')
    ?? linked.find(status => status.semantic === 'stage')
    ?? linked[0];
}

/** Options in process order; the current choice is labelled with the exact current status. */
export function quickStatusOptions(definitions: R1DefinitionsSnapshot, record: ProgressRecord): QuickStatusOption[] {
  const statuses = activeProgressStatuses(definitions);
  const events = effectiveEvents(record);
  const current = events.at(-1) ?? null;
  const currentKey = currentQuickStatusKey(record);
  const submitted = events.some(event => event.semantics.semantic === 'submitted');
  const pendingOffers = pendingOfferCountForDraft(record, { mode: 'append', eventId: '' });
  const bySemantic = (semantic: StatusDefinition['semantic']) => statuses.find(status => status.semantic === semantic);
  const options: QuickStatusOption[] = [];
  const add = (key: string, label: string, status: StatusDefinition | undefined, disabled = false) => {
    if (status) options.push({ key, label, statusId: status.id, disabled });
  };

  if (currentKey === 'draft') add('draft', bySemantic('draft')?.name ?? '待投递', bySemantic('draft'));
  add('submitted', bySemantic('submitted')?.name ?? '已投递', bySemantic('submitted'), submitted && currentKey !== 'submitted');
  const stages = definitions.stages
    .filter(stage => stage.archivedAt === null && stage.category !== 'offer')
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  for (const stage of stages) {
    const status = representative(statuses, stage.id);
    if (!status) continue;
    add(`stage:${stage.id}`, status.semantic === 'screening' || status.semantic === 'pool' ? status.name : stage.name, status);
  }
  add('offer', 'Offer', bySemantic('offer_received'));
  if (pendingOffers > 0 || currentKey === 'offer_accepted') add('offer_accepted', bySemantic('offer_accepted')?.name ?? '已接受 Offer', bySemantic('offer_accepted'));
  if (pendingOffers > 0 || currentKey === 'offer_declined') add('offer_declined', bySemantic('offer_declined')?.name ?? '已拒绝 Offer', bySemantic('offer_declined'));
  add('failed', '挂掉', statuses.find(status => status.semantic === 'failed' && status.stageId === null) ?? bySemantic('failed'));
  add('withdrawn', bySemantic('withdrawn')?.name ?? '主动退出', bySemantic('withdrawn'));

  const selected = options.find(option => option.key === currentKey);
  if (selected && current) selected.label = current.statusNameSnapshot;
  else if (current) options.unshift({ key: currentKey, label: current.statusNameSnapshot, statusId: current.statusId, disabled: true });
  return options;
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
  if (option.key === currentQuickStatusKey(record) || option.disabled) return { kind: 'noop' };
  if (current && reopenable.has(current.semantics.terminalOutcome)) return { kind: 'needs-reopen' };

  const statuses = activeProgressStatuses(definitions);
  let status = statuses.find(item => item.id === option.statusId);
  if (!status) return { kind: 'noop' };
  let failedAt: AppendProgressInput['failedAt'];
  if (option.key === 'failed') {
    // Attribute the failure to the stage the application is in, when that stage has its own failed status.
    const stageId = current?.semantics.stageId ?? null;
    status = (stageId ? statuses.find(item => item.semantic === 'failed' && item.stageId === stageId) : undefined) ?? status;
    failedAt = status.stageId ? { stageId: status.stageId } : 'unknown';
  }

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
