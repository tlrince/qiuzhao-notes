import type { Channel } from '../../domain/types.js';
import type { ProgressTableRow } from '../../domain/v2/table.js';
import type { ProgressRecord, R1DefinitionsSnapshot } from '../../domain/v2/types.js';
import { currentQuickStatusKey, quickStatusKeyLabel, quickStatusKeyRank } from './quick-status.js';

/** Days without a status change before a row suggests following up (offer.html used 14). */
export const STALE_DAYS = 14;

export type SheetSort = 'apply-desc' | 'apply-asc' | 'update-desc' | 'create-desc' | 'company';

export interface SheetItem {
  row: ProgressTableRow;
  record: ProgressRecord;
  statusKey: string;
  channelName: string;
  /** Days since the current status, only for rows still waiting on someone (not drafts, pools or outcomes). */
  staleDays: number | null;
}

export interface SheetFilters {
  search: string;
  channelId: string;
  statusKey: string;
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
      channelName: channelById.get(row.application.channelId) ?? '未知渠道',
      staleDays: waiting ? Math.max(0, daysBetween(row.current.occurredOn!, today)) : null,
    }];
  });
}

export function matchesSearchAndChannel(item: SheetItem, filters: Pick<SheetFilters, 'search' | 'channelId'>): boolean {
  if (filters.channelId !== ALL && item.row.application.channelId !== filters.channelId) return false;
  const needle = filters.search.trim().toLocaleLowerCase();
  if (!needle) return true;
  const { company, role, city, notes } = item.row.application;
  return [company, role, city, notes, item.channelName].join('\n').toLocaleLowerCase().includes(needle);
}

export function filterSheetItems(items: readonly SheetItem[], filters: SheetFilters): SheetItem[] {
  return items.filter(item => matchesSearchAndChannel(item, filters) && (filters.statusKey === ALL || item.statusKey === filters.statusKey));
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

/** Status chips with counts over the rows that pass search and channel filters. */
export function sheetStatusChips(items: readonly SheetItem[], definitions: R1DefinitionsSnapshot, selected: string): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.statusKey, (counts.get(item.statusKey) ?? 0) + 1);
  if (selected !== ALL && !counts.has(selected)) counts.set(selected, 0);
  return [...counts.entries()]
    .sort(([left], [right]) => quickStatusKeyRank(left, definitions) - quickStatusKeyRank(right, definitions))
    .map(([key, count]) => ({ key, label: quickStatusKeyLabel(key, definitions), count }));
}

export interface SheetStats {
  total: number;
  companies: number;
  active: number;
  offers: number;
  pool: number;
  failed: number;
  /** Whole percent of submitted rows that currently hold an Offer; null without submissions. */
  offerRate: number | null;
}

export function sheetStats(items: readonly SheetItem[]): SheetStats {
  const submitted = items.filter(item => item.statusKey !== 'draft');
  const offers = items.filter(item => item.row.current.outcome === 'offer_received' || item.row.current.outcome === 'offer_accepted').length;
  return {
    total: items.length,
    companies: new Set(submitted.map(item => companyGroupName(item.row.application.company).toLocaleLowerCase())).size,
    active: submitted.filter(item => item.row.current.outcome === 'active' && item.statusKey !== 'stage:pool').length,
    offers,
    pool: items.filter(item => item.statusKey === 'stage:pool' && item.row.current.outcome === 'active').length,
    failed: items.filter(item => item.row.current.outcome === 'failed').length,
    offerRate: submitted.length ? Math.round((offers / submitted.length) * 100) : null,
  };
}
