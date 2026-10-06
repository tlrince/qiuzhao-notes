import type { V2AnalyticsResult } from '../../domain/v2/analytics.js';
import type { Season } from '../../domain/types.js';

export type AnalysisRangeMode = 'season' | 'last30' | 'custom';
export interface BusinessDateRange { from: string; to: string }
export interface AnalysisDateScope {
  valid: true;
  range?: BusinessDateRange;
}
export interface InvalidAnalysisDateScope {
  valid: false;
  reason: string;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function addDays(date: string, offset: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Resolve page controls into the exact appliedOn filter consumed by M5. */
export function resolveAnalysisDateScope(
  mode: AnalysisRangeMode,
  season: Pick<Season, 'startDate' | 'endDate'>,
  today: string,
  custom: BusinessDateRange,
): AnalysisDateScope | InvalidAnalysisDateScope {
  if (!validDate(season.startDate) || !validDate(season.endDate) || season.startDate > season.endDate) {
    return { valid: false, reason: '招聘季日期无效，暂时无法统计。' };
  }
  if (!validDate(today)) return { valid: false, reason: '当前业务日期无效，暂时无法统计。' };
  if (mode === 'season') return { valid: true };

  const latestAvailableDate = season.endDate < today ? season.endDate : today;
  if (latestAvailableDate < season.startDate) {
    return { valid: false, reason: '所选招聘季尚未开始，当前没有可统计的日期。' };
  }
  if (mode === 'last30') {
    const requestedStart = addDays(latestAvailableDate, -29);
    return { valid: true, range: { from: requestedStart < season.startDate ? season.startDate : requestedStart, to: latestAvailableDate } };
  }

  if (!validDate(custom.from) || !validDate(custom.to)) {
    return { valid: false, reason: '请选择自定义统计的开始和结束日期。' };
  }
  if (custom.from > custom.to) return { valid: false, reason: '开始日期不能晚于结束日期。' };
  if (custom.from < season.startDate || custom.to > season.endDate) {
    return { valid: false, reason: '自定义日期需要位于所选招聘季内。' };
  }
  if (custom.to > today) return { valid: false, reason: '统计结束日期不能晚于今天。' };
  return { valid: true, range: { from: custom.from, to: custom.to } };
}

/** Current date in the workspace business timezone, matching the M5 calculator. */
export function businessDateAt(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) throw new RangeError('当前时间无效');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('无法按工作空间时区解析日期');
  return `${year}-${month}-${day}`;
}

function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** A Monday-aligned display window; M5 still clips it to season and appliedOn scope. */
export function twelveWeekWindow(today: string): BusinessDateRange {
  if (!validDate(today)) throw new RangeError('today 必须是有效的 YYYY-MM-DD 日期');
  return { from: addDays(mondayOf(today), -77), to: today };
}

export interface ActivityCell {
  date: string;
  count: number;
  disabled: boolean;
}

/** Twelve aligned weeks for display; days outside M5's returned window and future days are disabled. */
export function buildActivityWeeks(
  result: Pick<V2AnalyticsResult, 'activity' | 'activityWindow'>,
  today: string,
  weekCount = 12,
): ActivityCell[][] {
  if (!validDate(today)) throw new RangeError('today 必须是有效的 YYYY-MM-DD 日期');
  if (!Number.isSafeInteger(weekCount) || weekCount <= 0) throw new RangeError('weekCount 必须是正整数');
  const firstMonday = addDays(mondayOf(today), -(weekCount - 1) * 7);
  const counts = new Map(result.activity.map(day => [day.date, day.count]));
  return Array.from({ length: weekCount }, (_, weekIndex) => Array.from({ length: 7 }, (_, weekday) => {
    const date = addDays(firstMonday, weekIndex * 7 + weekday);
    const inResultWindow = result.activityWindow !== null
      && date >= result.activityWindow.from
      && date <= result.activityWindow.to;
    const future = date > today;
    return { date, count: counts.get(date) ?? 0, disabled: future || !inResultWindow };
  }));
}

export function weeklyActivityTotals(weeks: readonly (readonly ActivityCell[])[]): number[] {
  return weeks.map(week => week.reduce((sum, cell) => sum + (cell.disabled ? 0 : cell.count), 0));
}

export function formatAnalysisRate(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)}%`;
}
