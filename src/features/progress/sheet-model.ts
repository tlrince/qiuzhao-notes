import type { Channel } from '../../domain/types.js';
import type { ProgressTableRow } from '../../domain/v2/table.js';
import type { ProgressRecord, R1DefinitionsSnapshot } from '../../domain/v2/types.js';
import { splitCities } from '../../domain/v2/cities.js';
import { currentQuickStatusKey, quickStatusKeyLabel, quickStatusKeyRank } from './quick-status.js';

/** Days without a status change before a row suggests following up (offer.html used 14). */
export const STALE_DAYS = 14;

export type SheetSort = 'apply-desc' | 'apply-asc' | 'update-desc' | 'create-desc' | 'company';

export interface SheetItem {
  row: ProgressTableRow;
  record: ProgressRecord;
  statusKey: string;
  /** Filter group: the stage the application is in or failed at (一面挂 belongs to 一面). */
  stageKey: string;
  outcome: SheetOutcome;
  cities: string[];
  channelName: string;
  /** Days since the current status, only for rows still waiting on someone (not drafts, pools or outcomes). */
  staleDays: number | null;
}

export type SheetOutcome = 'active' | 'failed' | 'offer' | 'withdrawn';

export interface SheetFilters {
  search: string;
  channelId: string;
  /** A stage group key from stageFilterKey, or ALL. */
  stageKey: string;
  outcome: SheetOutcome | typeof ALL;
  city: string;
}

/** Groups by stage regardless of phase or result, so 待一面、一面中、一面挂 are all 一面. */
export function stageFilterKey(record: ProgressRecord): string {
  const current = record.events.filter(event => event.invalidatedAt === null).sort((left, right) => left.sequence - right.sequence).at(-1);
  if (!current || current.semantics.semantic === 'draft') return 'draft';
  const { semantic } = current.semantics;
  if (semantic === 'submitted') return 'submitted';
  if (semantic === 'offer_received' || semantic === 'offer_accepted' || semantic === 'offer_declined') return 'offer';
  if (semantic === 'failed') {
    const stageId = typeof current.failedAt === 'object' && current.failedAt !== null ? current.failedAt.stageId : current.semantics.stageId ?? current.contextStageId;
    return stageId ? `stage:${stageId}` : 'failed';
  }
  if (semantic === 'withdrawn') return 'withdrawn';
  return current.semantics.stageId ? `stage:${current.semantics.stageId}` : `status:${current.statusId}`;
}

function outcomeGroup(outcome: ProgressTableRow['current']['outcome']): SheetOutcome {
  if (outcome === 'failed') return 'failed';
  if (outcome === 'withdrawn') return 'withdrawn';
  if (outcome === 'active') return 'active';
  return 'offer';
}

export const ALL = 'all';

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/** Import metadata lines (导入字段：…) stay in the record but are noise in the sheet. */
export function displayNotes(notes: string): string {
  return notes.split('\n').filter(line => !line.startsWith('导入字段：')).join('\n').trim();
}

/** offer.html grouped 网易游戏互娱/雷火 under 网易 and dropped a trailing （…） suffix. */
export function companyGroupName(company: string): string {
  const clean = company.trim();
  if (/^网易游戏(?:互娱|雷火)/.test(clean)) return '网易';
  return clean.replace(/[（(][^）)]*[）)]\s*$/, '').trim() || clean;
}

export function buildSheetItems(rows: readonly ProgressTableRow[], records: readonly ProgressRecord[], channels: readonly Channel[], today: string): SheetItem[] {
  const recordById = new Map(records.map(record => [record.applicationId, record]));
  const channelById = new Map(channels.map(channel => [channel.id, channel.name]));
  return rows.flatMap(row => {
    const record = recordById.get(row.application.id);
    if (!record) return [];
    const statusKey = currentQuickStatusKey(record);
    const waiting = row.current.outcome === 'active' && statusKey !== 'draft' && statusKey !== 'stage:pool' && row.current.occurredOn !== null;
    return [{
      row,
      record,
      statusKey,
      stageKey: stageFilterKey(record),
      outcome: outcomeGroup(row.current.outcome),
      cities: splitCities(row.application.city),
      channelName: channelById.get(row.application.channelId) ?? '未知渠道',
      staleDays: waiting ? Math.max(0, daysBetween(row.current.occurredOn!, today)) : null,
    }];
  });
}

/** Everything except the stage chips, which count over this result. */
export function matchesSearchAndChannel(item: SheetItem, filters: Pick<SheetFilters, 'search' | 'channelId' | 'outcome' | 'city'>): boolean {
  if (filters.channelId !== ALL && item.row.application.channelId !== filters.channelId) return false;
  if (filters.outcome !== ALL && item.outcome !== filters.outcome) return false;
  if (filters.city !== ALL && !item.cities.includes(filters.city)) return false;
  const needle = filters.search.trim().toLocaleLowerCase();
  if (!needle) return true;
  const { company, role, city, notes } = item.row.application;
  return [company, role, city, notes, item.channelName].join('\n').toLocaleLowerCase().includes(needle);
}

export function filterSheetItems(items: readonly SheetItem[], filters: SheetFilters): SheetItem[] {
  return items.filter(item => matchesSearchAndChannel(item, filters) && (filters.stageKey === ALL || item.stageKey === filters.stageKey));
}

export function sortSheetItems(items: readonly SheetItem[], sort: SheetSort): SheetItem[] {
  const applied = (item: SheetItem) => item.row.application.appliedOn;
  const compare: Record<SheetSort, (left: SheetItem, right: SheetItem) => number> = {
    'apply-desc': (left, right) => (applied(right) ?? '').localeCompare(applied(left) ?? '') || right.row.application.createdAt.localeCompare(left.row.application.createdAt),
    'apply-asc': (left, right) => (applied(left) ?? '9999-99-99').localeCompare(applied(right) ?? '9999-99-99') || left.row.application.createdAt.localeCompare(right.row.application.createdAt),
    'update-desc': (left, right) => right.row.application.updatedAt.localeCompare(left.row.application.updatedAt),
    'create-desc': (left, right) => right.row.application.createdAt.localeCompare(left.row.application.createdAt),
    company: (left, right) => left.row.application.company.localeCompare(right.row.application.company, 'zh-Hans-CN'),
  };
  return [...items].sort(compare[sort]);
}

/** Stage chips with counts over the rows that pass the other filters. */
export function sheetStatusChips(items: readonly SheetItem[], definitions: R1DefinitionsSnapshot, selected: string): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.stageKey, (counts.get(item.stageKey) ?? 0) + 1);
  if (selected !== ALL && !counts.has(selected)) counts.set(selected, 0);
  return [...counts.entries()]
    .sort(([left], [right]) => quickStatusKeyRank(left, definitions) - quickStatusKeyRank(right, definitions))
    .map(([key, count]) => ({ key, label: stageChipLabel(key, definitions), count }));
}

/** Stage chips name the stage (简历筛选), since they also hold that stage's failures. */
function stageChipLabel(key: string, definitions: R1DefinitionsSnapshot): string {
  if (!key.startsWith('stage:')) return quickStatusKeyLabel(key, definitions);
  return definitions.stages.find(stage => stage.id === key.slice('stage:'.length))?.name ?? quickStatusKeyLabel(key, definitions);
}

/** Single cities for the city filter, most used first. */
export function sheetCities(items: readonly SheetItem[]): Array<{ city: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) for (const city of item.cities) counts.set(city, (counts.get(city) ?? 0) + 1);
  return [...counts.entries()].map(([city, count]) => ({ city, count })).sort((left, right) => right.count - left.count || left.city.localeCompare(right.city, 'zh-Hans-CN'));
}

export interface SheetStats {
  /** Applications with a recorded submission — the same number as 累计投递 in analytics. */
  total: number;
  drafts: number;
  companies: number;
  active: number;
  offers: number;
  pool: number;
  failed: number;
  /** Whole percent of submitted rows that currently hold an Offer; null without submissions. */
  offerRate: number | null;
}

export function sheetStats(items: readonly SheetItem[]): SheetStats {
  const submitted = items.filter(item => item.row.application.appliedOn !== null);
  const offers = items.filter(item => item.row.current.outcome === 'offer_received' || item.row.current.outcome === 'offer_accepted').length;
  return {
    total: submitted.length,
    drafts: items.length - submitted.length,
    companies: new Set(submitted.map(item => companyGroupName(item.row.application.company).toLocaleLowerCase())).size,
    active: submitted.filter(item => item.row.current.outcome === 'active' && item.statusKey !== 'stage:pool').length,
    offers,
    pool: items.filter(item => item.statusKey === 'stage:pool' && item.row.current.outcome === 'active').length,
    failed: items.filter(item => item.row.current.outcome === 'failed').length,
    offerRate: submitted.length ? Math.round((offers / submitted.length) * 100) : null,
  };
}
