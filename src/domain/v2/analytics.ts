import type { DataSnapshotV2 } from './snapshot.js';
import type { FailedAt, ProgressEvent, ProgressRecord, StageDefinition } from './types.js';

export interface V2AnalyticsQuery {
  seasonId: string;
  /** Business-date filter. When omitted, the full season is included, including drafts. */
  appliedDateRange?: { from: string; to: string };
  /** Optional display-only heatmap range; KPI scope remains appliedDateRange. */
  heatmapWindow?: { from: string; to: string };
}

export interface V2AnalyticsClock {
  now: string;
  timeZone: string;
}

export interface AnalyticsStageTouch {
  stageId: string;
  name: string;
  category: StageDefinition['category'] | 'submission';
  /** Unique applications with at least one effective actual touch. */
  touchCount: number;
  /** Unique applicationId + visitId pairs with at least one effective actual touch. */
  visitCount: number;
  /** Percentage points, rounded to one decimal place; null when there are no submissions. */
  rate: number | null;
}

export interface PoolVisitDuration {
  applicationId: string;
  visitId: string;
  enteredOn: string;
  exitedOn: string | null;
  /** Calendar days; null when the relevant historical connection is uncertain. */
  durationDays: number | null;
  current: boolean;
}

export interface V2AnalyticsResult {
  recordCount: number;
  submittedCount: number;
  activeCount: number;
  humanInterviewCount: number;
  aiInterviewCount: number;
  offerCount: number;
  failedCount: number;
  offerDeclinedCount: number;
  failedByStage: Array<{ stageId: string | 'unknown'; name: string; count: number }>;
  currentPoolCount: number;
  /** Percentage points, rounded to one decimal place; null when submittedCount is zero. */
  interviewRate: number | null;
  offerRate: number | null;
  thisWeekCount: number;
  target: { submittedCount: number; count: number; rate: number | null };
  stages: AnalyticsStageTouch[];
  activity: Array<{ date: string; count: number; disabled: boolean }>;
  activityWindow: { from: string; to: string } | null;
  activeDayCount: number;
  channels: Array<{ channelId: string; name: string; submittedCount: number; interviewCount: number; aiInterviewCount: number; offerCount: number }>;
  cities: Array<{ city: string; count: number }>;
  poolVisits: PoolVisitDuration[];
  poolDuration: { knownVisitCount: number; unknownVisitCount: number; averageDays: number | null };
}

const actualPhases = new Set(['in_progress', 'awaiting_result', 'passed']);
const dayMilliseconds = 86_400_000;

function assertBusinessDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError(`${label} 必须是 YYYY-MM-DD`);
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new RangeError(`${label} 不是有效日期`);
}

function assertRange(range: { from: string; to: string }, label: string): void {
  assertBusinessDate(range.from, `${label}.from`);
  assertBusinessDate(range.to, `${label}.to`);
  if (range.from > range.to) throw new RangeError(`${label}.from 不能晚于 to`);
}

function businessDateAt(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf())) throw new RangeError('clock.now 必须是有效时间');
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
  if (!year || !month || !day) throw new RangeError('无法按指定时区解析当前日期');
  return `${year}-${month}-${day}`;
}

function dateDistance(from: string, to: string): number | null {
  const days = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / dayMilliseconds;
  return Number.isSafeInteger(days) && days >= 0 ? days : null;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * dayMilliseconds).toISOString().slice(0, 10);
}

function percent(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10;
}

function effectiveEvents(record: ProgressRecord): ProgressEvent[] {
  return record.events.filter(event => event.invalidatedAt === null).sort((a, b) => a.sequence - b.sequence);
}

function isActualTouch(event: ProgressEvent): boolean {
  if (event.semantics.terminalOutcome === 'failed' || event.semantics.semantic === 'offer_accepted' || event.semantics.semantic === 'offer_declined' || event.semantics.semantic === 'withdrawn') return false;
  if (event.migrationMeta?.legacyKind === 'stage' && event.migrationMeta.legacyReached === true) return true;
  if (event.semantics.semantic === 'submitted' || event.semantics.semantic === 'screening' || event.semantics.semantic === 'pool' || event.semantics.semantic === 'offer_received') return true;
  return actualPhases.has(event.phase);
}

function currentWeekMonday(today: string): string {
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return addDays(today, -daysSinceMonday);
}

function getRecordMap(snapshot: DataSnapshotV2): Map<string, ProgressRecord> {
  return new Map(snapshot.progressRecords.map(record => [record.applicationId, record]));
}

function wasSubmitted(events: readonly ProgressEvent[]): boolean {
  return events.some(event => event.semantics.semantic === 'submitted');
}

function hasHistoricalOffer(events: readonly ProgressEvent[]): boolean {
  return events.some(event => event.semantics.semantic === 'offer_received');
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  let values = map.get(key);
  if (!values) map.set(key, values = new Set());
  values.add(value);
}

function projectPoolVisits(
  applicationId: string,
  record: ProgressRecord,
  events: readonly ProgressEvent[],
  currentStage: string | null,
  outcome: string,
  poolStageIds: ReadonlySet<string>,
  today: string,
): PoolVisitDuration[] {
  const visits = new Map<string, ProgressEvent[]>();
  for (const event of events) {
    if (!event.semantics.stageId || !poolStageIds.has(event.semantics.stageId)) continue;
    visits.set(event.visitId, [...(visits.get(event.visitId) ?? []), event]);
  }

  const result: PoolVisitDuration[] = [];
  for (const [visitId, visitEvents] of visits) {
    const first = visitEvents[0]!;
    const last = visitEvents.at(-1)!;
    const lastIndex = events.findIndex(event => event.id === last.id);
    const following = lastIndex < 0 ? null : events[lastIndex + 1] ?? null;
    const isCurrent = following === null && currentStage !== null && poolStageIds.has(currentStage) && outcome === 'active';
    const visitEventIds = new Set(visitEvents.map(event => event.id));
    const crossesUncertain = (record.migrationReview?.uncertainEdges ?? []).some(edge => visitEventIds.has(edge.fromEventId) || visitEventIds.has(edge.toEventId));
    const exitedOn = following?.occurredOn ?? null;
    const durationDays = crossesUncertain ? null : isCurrent
      ? dateDistance(first.occurredOn, today)
      : exitedOn === null ? null : dateDistance(first.occurredOn, exitedOn);
    result.push({ applicationId, visitId, enteredOn: first.occurredOn, exitedOn, durationDays, current: isCurrent });
  }
  return result;
}

/**
 * Pure M5 aggregation over a validated v2 snapshot. All dates in the result are business
 * calendar dates; rates are percentage points (for example, 60 means 60.0%).
 */
export function calculateV2Analytics(snapshot: DataSnapshotV2, query: V2AnalyticsQuery, clock: V2AnalyticsClock): V2AnalyticsResult {
  if (!snapshot || snapshot.schemaVersion !== 2) throw new RangeError('统计需要 v2 数据快照');
  const season = snapshot.seasons.find(item => item.id === query.seasonId);
  if (!season) throw new RangeError(`招聘季不存在: ${query.seasonId}`);
  assertBusinessDate(season.startDate, 'season.startDate');
  assertBusinessDate(season.endDate, 'season.endDate');
  if (season.startDate > season.endDate) throw new RangeError('招聘季开始日期不能晚于结束日期');
  if (query.appliedDateRange) assertRange(query.appliedDateRange, 'appliedDateRange');
  if (query.heatmapWindow) assertRange(query.heatmapWindow, 'heatmapWindow');
  const today = businessDateAt(clock.now, clock.timeZone);

  const recordsByApplication = getRecordMap(snapshot);
  const seasonApplications = snapshot.applications.filter(application => application.seasonId === season.id);
  const scopedApplications = seasonApplications.filter(application => {
    if (!query.appliedDateRange) return true;
    return application.appliedOn !== null && application.appliedOn >= query.appliedDateRange.from && application.appliedOn <= query.appliedDateRange.to;
  });
  const scopedRows = scopedApplications.map(application => {
    const record = recordsByApplication.get(application.id);
    if (!record) throw new RangeError(`投递缺少进度记录: ${application.id}`);
    const events = effectiveEvents(record);
    return { application, record, events, submitted: wasSubmitted(events), offer: hasHistoricalOffer(events) };
  });
  const submittedRows = scopedRows.filter(row => row.submitted && row.application.appliedOn !== null);
  const submittedCount = submittedRows.length;
  const activeCount = scopedRows.filter(row => row.submitted && row.application.outcome === 'active').length;
  const failedRows = scopedRows.filter(row => row.application.outcome === 'failed');
  const offerDeclinedCount = scopedRows.filter(row => row.application.outcome === 'offer_declined').length;
  const offerCount = scopedRows.filter(row => row.offer).length;

  const definitionsById = new Map(snapshot.definitions.stages.map(stage => [stage.id, stage]));
  const poolStageIds = new Set(snapshot.definitions.stages.filter(stage => stage.category === 'pool').map(stage => stage.id));
  const failureCounts = new Map<string, { name: string; count: number }>();
  for (const { application } of failedRows) {
    const failure: FailedAt | null = application.failedAt;
    const key = failure === null || failure === 'unknown' ? 'unknown' : failure.stageId;
    const name = failure === null || failure === 'unknown'
      ? '未知'
      : (failure.stageNameSnapshot || definitionsById.get(failure.stageId)?.name || failure.stageId);
    const item = failureCounts.get(key) ?? { name, count: 0 };
    item.count += 1;
    failureCounts.set(key, item);
  }
  const failedByStage = [...failureCounts.entries()]
    .map(([stageId, value]) => ({ stageId: stageId as string | 'unknown', ...value }))
    .sort((a, b) => a.stageId === 'unknown' ? 1 : b.stageId === 'unknown' ? -1 : a.name.localeCompare(b.name));

  const humanInterviewApps = new Set<string>();
  const aiInterviewApps = new Set<string>();
  const stageApplications = new Map<string, Set<string>>();
  const stageVisits = new Map<string, Set<string>>();
  const channelRows = new Map<string, { name: string; submitted: Set<string>; human: Set<string>; ai: Set<string>; offer: Set<string> }>();
  const cityRows = new Map<string, Set<string>>();

  const channelsById = new Map(snapshot.channels.map(channel => [channel.id, channel]));
  for (const row of scopedRows) {
    const { application, events } = row;
    const channel = channelsById.get(application.channelId);
    if (!channel) throw new RangeError(`投递引用的渠道不存在: ${application.channelId}`);
    const channelRow = channelRows.get(application.channelId) ?? { name: channel.name, submitted: new Set<string>(), human: new Set<string>(), ai: new Set<string>(), offer: new Set<string>() };
    if (row.submitted && application.appliedOn !== null) channelRow.submitted.add(application.id);
    if (row.offer) channelRow.offer.add(application.id);
    channelRows.set(application.channelId, channelRow);
    if (row.submitted && application.appliedOn !== null) {
      const city = application.city.trim() || '未填写';
      addToSetMap(cityRows, city, application.id);
    }

    const seenStageVisits = new Set<string>();
    for (const event of events) {
      if (!isActualTouch(event)) continue;
      if (event.semantics.semantic === 'submitted') {
        const key = 'submitted';
        addToSetMap(stageApplications, key, application.id);
        addToSetMap(stageVisits, key, `${application.id}\0${event.visitId}`);
      } else if (event.semantics.stageId) {
        const stageId = event.semantics.stageId;
        addToSetMap(stageApplications, stageId, application.id);
        const visitKey = `${stageId}\0${event.visitId}`;
        if (!seenStageVisits.has(visitKey)) {
          addToSetMap(stageVisits, stageId, `${application.id}\0${event.visitId}`);
          seenStageVisits.add(visitKey);
        }
      }

      if (event.semantics.stageCategory === 'ai_interview') {
        aiInterviewApps.add(application.id);
        channelRow.ai.add(application.id);
      } else if (event.semantics.countsAsInterview) {
        humanInterviewApps.add(application.id);
        channelRow.human.add(application.id);
      }
    }
  }

  const stages: AnalyticsStageTouch[] = [{
    stageId: 'submitted', name: '投递', category: 'submission',
    touchCount: stageApplications.get('submitted')?.size ?? 0,
    visitCount: stageVisits.get('submitted')?.size ?? 0,
    rate: percent(stageApplications.get('submitted')?.size ?? 0, submittedCount),
  }];
  const configuredStageIds = new Set(snapshot.definitions.stages.map(stage => stage.id));
  for (const stage of [...snapshot.definitions.stages].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))) {
    configuredStageIds.add(stage.id);
    stages.push({
      stageId: stage.id,
      name: stage.name,
      category: stage.category,
      touchCount: stageApplications.get(stage.id)?.size ?? 0,
      visitCount: stageVisits.get(stage.id)?.size ?? 0,
      rate: percent(stageApplications.get(stage.id)?.size ?? 0, submittedCount),
    });
  }
  // An archived or otherwise historical stage remains reportable under its event-time name.
  for (const [stageId, applications] of stageApplications) {
    if (stageId === 'submitted' || configuredStageIds.has(stageId)) continue;
    const event = scopedRows.flatMap(row => row.events).find(item => item.semantics.stageId === stageId);
    stages.push({ stageId, name: event?.semantics.stageNameSnapshot ?? stageId, category: event?.semantics.stageCategory ?? 'custom', touchCount: applications.size, visitCount: stageVisits.get(stageId)?.size ?? 0, rate: percent(applications.size, submittedCount) });
  }

  const currentPoolCount = scopedRows.filter(({ application }) => application.outcome === 'active' && application.currentStage !== null && poolStageIds.has(application.currentStage)).length;
  const poolVisits = scopedRows.flatMap(({ application, record, events }) => projectPoolVisits(application.id, record, events, application.currentStage, application.outcome, poolStageIds, today));
  const knownPoolDurations = poolVisits.filter(visit => visit.durationDays !== null).map(visit => visit.durationDays!);
  const poolDuration = {
    knownVisitCount: knownPoolDurations.length,
    unknownVisitCount: poolVisits.filter(visit => visit.durationDays === null).length,
    averageDays: knownPoolDurations.length === 0 ? null : Math.round((knownPoolDurations.reduce((sum, days) => sum + days, 0) / knownPoolDurations.length) * 10) / 10,
  };

  const monday = currentWeekMonday(today);
  const thisWeekCount = submittedRows.filter(({ application }) => application.appliedOn! >= monday && application.appliedOn! <= today).length;
  const seasonSubmittedCount = seasonApplications.filter(application => {
    const record = recordsByApplication.get(application.id);
    return application.appliedOn !== null && !!record && wasSubmitted(effectiveEvents(record));
  }).length;
  const displayWindow = query.heatmapWindow ?? { from: addDays(today, -83), to: today };
  const windowFrom = [displayWindow.from, season.startDate, query.appliedDateRange?.from ?? displayWindow.from].sort().at(-1)!;
  const windowTo = [displayWindow.to, season.endDate, query.appliedDateRange?.to ?? displayWindow.to, today].sort()[0]!;
  const activityWindow = windowFrom <= windowTo ? { from: windowFrom, to: windowTo } : null;
  const daily = new Map<string, number>();
  for (const { application } of submittedRows) {
    const date = application.appliedOn!;
    if (activityWindow && date >= activityWindow.from && date <= activityWindow.to) daily.set(date, (daily.get(date) ?? 0) + 1);
  }
  const activity: V2AnalyticsResult['activity'] = [];
  if (activityWindow) {
    const daysInWindow = Math.floor((Date.parse(`${activityWindow.to}T00:00:00.000Z`) - Date.parse(`${activityWindow.from}T00:00:00.000Z`)) / dayMilliseconds);
    for (let index = 0; index <= daysInWindow; index += 1) {
      const date = addDays(activityWindow.from, index);
      activity.push({ date, count: daily.get(date) ?? 0, disabled: false });
    }
  }

  return {
    recordCount: scopedApplications.length,
    submittedCount,
    activeCount,
    humanInterviewCount: humanInterviewApps.size,
    aiInterviewCount: aiInterviewApps.size,
    offerCount,
    failedCount: failedRows.length,
    offerDeclinedCount,
    failedByStage,
    currentPoolCount,
    interviewRate: percent(humanInterviewApps.size, submittedCount),
    offerRate: percent(offerCount, submittedCount),
    thisWeekCount,
    target: { submittedCount: seasonSubmittedCount, count: season.targetCount, rate: percent(seasonSubmittedCount, season.targetCount) },
    stages,
    activity,
    activityWindow,
    activeDayCount: activity.filter(item => item.count > 0).length,
    channels: [...channelRows.entries()].map(([channelId, row]) => ({ channelId, name: row.name, submittedCount: row.submitted.size, interviewCount: row.human.size, aiInterviewCount: row.ai.size, offerCount: row.offer.size })).sort((a, b) => a.name.localeCompare(b.name)),
    cities: [...cityRows.entries()].map(([city, applications]) => ({ city, count: applications.size })).sort((a, b) => a.city.localeCompare(b.city)),
    poolVisits,
    poolDuration,
  };
}
