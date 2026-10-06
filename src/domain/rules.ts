import { requireRule } from './errors.js';
import { STAGES, type ApplicationDetail, type CreateApplicationInput, type TransitionInput, type CorrectHistoryInput } from './types.js';
import { validateDetail, validateDate } from './validation.js';
export interface CommandContext { now: string; id: () => string }
export function createDetail(input: CreateApplicationInput, ctx: CommandContext): ApplicationDetail {
  const stage = input.currentStage ?? 'draft';
  const id = ctx.id();
  const result: ApplicationDetail = { application: {
    id, seasonId: input.seasonId, company: input.company.trim(), role: input.role.trim(), city: input.city?.trim() ?? '',
    channelId: input.channelId ?? 'unspecified', jobUrl: input.jobUrl ?? '', appliedOn: input.appliedOn ?? null,
    currentStage: stage, outcome: 'active', isStarred: input.isStarred ?? false, notes: input.notes ?? '', createdAt: ctx.now, updatedAt: ctx.now,
  }, stageEvents: [], outcomeEvents: [], schedules: [] };
  if (stage !== 'draft') {
    requireRule(input.appliedOn, '非草稿必须有投递日期');
    result.stageEvents.push({ id: ctx.id(), applicationId: id, stage: 'submitted', occurredOn: input.appliedOn, createdAt: ctx.now, supersededAt: null, source: 'create' });
    if (stage !== 'submitted') result.stageEvents.push({ id: ctx.id(), applicationId: id, stage, occurredOn: input.stageOccurredOn ?? input.appliedOn, createdAt: ctx.now, supersededAt: null, source: 'create' });
  }
  validateDetail(result); return result;
}
export function transitionDetail(detail: ApplicationDetail, input: TransitionInput, ctx: CommandContext): ApplicationDetail {
  const result = structuredClone(detail); const a = result.application; validateDate(input.occurredOn);
  if (input.kind === 'stage') {
    requireRule(a.outcome === 'active', '请先重新开启流程');
    requireRule(STAGES.includes(input.stage), '未知阶段');
    requireRule(STAGES.indexOf(input.stage) >= STAGES.indexOf(a.currentStage), '阶段回退必须纠正历史');
    if (input.stage === a.currentStage) return result;
    const last = result.stageEvents.filter(e => !e.supersededAt).at(-1);
    requireRule(!last || input.occurredOn >= last.occurredOn, '推进日期不能早于上一阶段');
    if (a.currentStage === 'draft') {
      a.appliedOn = input.occurredOn;
      result.stageEvents.push({ id: ctx.id(), applicationId: a.id, stage: 'submitted', occurredOn: input.occurredOn, createdAt: ctx.now, supersededAt: null, source: 'transition' });
    }
    if (input.stage !== 'submitted' || a.currentStage !== 'draft') result.stageEvents.push({ id: ctx.id(), applicationId: a.id, stage: input.stage as Exclude<typeof input.stage, 'draft'>, occurredOn: input.occurredOn, createdAt: ctx.now, supersededAt: null, source: 'transition' });
    a.currentStage = input.stage;
  } else {
    requireRule(!(a.currentStage === 'draft' && input.outcome === 'offer'), '待投递不能获得 Offer');
    if (input.outcome === a.outcome) return result;
    const last = result.outcomeEvents.filter(e => !e.supersededAt).at(-1);
    requireRule(!last || input.occurredOn >= last.occurredOn, '结果日期不能早于上一结果');
    result.outcomeEvents.push({ id: ctx.id(), applicationId: a.id, outcome: input.outcome, occurredOn: input.occurredOn, createdAt: ctx.now, supersededAt: null }); a.outcome = input.outcome;
  }
  a.updatedAt = ctx.now; validateDetail(result); return result;
}
export function correctDetail(detail: ApplicationDetail, input: CorrectHistoryInput, ctx: CommandContext): ApplicationDetail {
  const result = structuredClone(detail);
  const events = input.kind === 'stage' ? result.stageEvents : result.outcomeEvents;
  const index = events.findIndex(e => e.id === input.eventId && !e.supersededAt);
  requireRule(index >= 0, '只能纠正有效历史'); const event = events[index]!; event.supersededAt = ctx.now;
  if (input.kind === 'stage') {
    if (input.replacement) result.stageEvents.splice(index + 1, 0, { id: ctx.id(), applicationId: result.application.id, ...input.replacement, createdAt: ctx.now, supersededAt: null, source: 'correction' });
    const valid = result.stageEvents.filter(e => !e.supersededAt);
    result.application.currentStage = valid.at(-1)?.stage ?? 'draft';
    result.application.appliedOn = valid.find(e => e.stage === 'submitted')?.occurredOn ?? null;
  } else {
    if (input.replacement) result.outcomeEvents.splice(index + 1, 0, { id: ctx.id(), applicationId: result.application.id, ...input.replacement, createdAt: ctx.now, supersededAt: null });
    result.application.outcome = result.outcomeEvents.filter(e => !e.supersededAt).at(-1)?.outcome ?? 'active';
  }
  result.application.updatedAt = ctx.now; validateDetail(result); return result;
}
