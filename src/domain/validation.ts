import { DomainError, requireRule } from './errors.js';
import { STAGES, OUTCOMES, type ApplicationDetail, type Season } from './types.js';
export function validateDate(value: string): void {
  requireRule(/^\d{4}-\d{2}-\d{2}$/.test(value), '日期必须为 YYYY-MM-DD');
  const date = new Date(`${value}T00:00:00.000Z`);
  requireRule(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, '日期不存在');
}
export function validateInstant(value: string): void {
  requireRule(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)), '时间必须为 UTC ISO 字符串');
  validateDate(value.slice(0, 10));
  requireRule(new Date(value).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')), '时间不存在');
}
export function validateTimeZone(value: string): void {
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: value }); } catch { requireRule(false, '无效时区'); }
}
export function validateSeason(season: Season): void {
  requireRule(season.id && season.name.trim(), '招聘季名称不能为空');
  validateDate(season.startDate); validateDate(season.endDate);
  requireRule(season.startDate <= season.endDate, '招聘季日期范围无效');
  requireRule(Number.isSafeInteger(season.targetCount) && season.targetCount > 0, '目标必须为正整数');
  if (season.archivedAt !== null) validateInstant(season.archivedAt);
}
export function validateDetail(detail: ApplicationDetail): void {
  const { application: a, stageEvents, outcomeEvents, schedules } = detail;
  requireRule(a.id && a.seasonId && a.channelId && a.company.trim() && a.role.trim(), '公司、岗位与关联 ID 必填');
  requireRule(STAGES.includes(a.currentStage) && OUTCOMES.includes(a.outcome), '未知阶段或结果');
  requireRule(typeof a.isStarred === 'boolean', '关注标记必须为布尔值');
  if (a.jobUrl) { let url: URL; try { url = new URL(a.jobUrl); } catch { throw new DomainError('VALIDATION', '招聘链接无效'); } requireRule(['http:', 'https:'].includes(url.protocol), '招聘链接仅允许 http/https'); }
  validateInstant(a.createdAt); validateInstant(a.updatedAt);
  const stages = stageEvents.filter(e => !e.supersededAt);
  const outcomes = outcomeEvents.filter(e => !e.supersededAt);
  for (const e of [...stageEvents, ...outcomeEvents]) {
    requireRule(e.id && e.applicationId === a.id, '历史关联无效'); validateDate(e.occurredOn); validateInstant(e.createdAt);
    if (e.supersededAt !== null) validateInstant(e.supersededAt);
    if ('stage' in e) requireRule(STAGES.includes(e.stage) && e.stage !== ('draft' as string) && ['create', 'transition', 'correction'].includes(e.source), '阶段事件无效');
    else requireRule(OUTCOMES.includes(e.outcome), '结果事件无效');
  }
  const submitted = stages.filter(e => e.stage === 'submitted');
  if (a.currentStage === 'draft') {
    requireRule(a.appliedOn === null && stages.length === 0, '草稿不能有投递日期或有效阶段历史');
    requireRule(!outcomes.some(e => e.outcome === 'offer'), '草稿不能获得 Offer');
  } else {
    requireRule(a.appliedOn !== null, '非草稿必须有投递日期'); validateDate(a.appliedOn);
    requireRule(submitted.length === 1 && submitted[0]?.occurredOn === a.appliedOn, '投递日期与 submitted 历史必须一致');
    requireRule(stages.at(-1)?.stage === a.currentStage, '当前阶段与有效历史不一致');
    requireRule(stages.every(e => e.occurredOn >= a.appliedOn!), '阶段日期不能早于投递日期');
  }
  requireRule(a.outcome === (outcomes.at(-1)?.outcome ?? 'active'), '当前结果与有效历史不一致');
  requireRule(outcomes.every(e => a.appliedOn === null || e.occurredOn >= a.appliedOn), '结果日期不能早于投递日期');
  for (const s of schedules) {
    requireRule(s.id && s.applicationId === a.id && s.title.trim(), '日程关联或标题无效'); validateInstant(s.startsAt);
    requireRule(['pending', 'completed', 'cancelled'].includes(s.status) && ['assessment', 'interview', 'follow_up', 'other'].includes(s.type), '日程类型或状态无效');
  }
}
