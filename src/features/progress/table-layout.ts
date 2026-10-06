import type { ProgressTableProjection } from '../../domain/v2/table.js';

export interface ProgressTableColumnPreferences {
  /** Reading order for stage columns. Newly introduced columns are appended. */
  stageOrder: readonly string[];
  hiddenStageIds: readonly string[];
  /** Pixel widths keyed by base column id or `stage:<stage id>`. */
  columnWidths?: Readonly<Partial<Record<ProgressTableColumnKey, number>>>;
}

export const DEFAULT_PROGRESS_TABLE_COLUMN_WIDTHS = {
  identity: 220,
  current: 150,
  applied: 120,
  url: 160,
  notes: 220,
  stage: 168,
} as const;

export const PROGRESS_TABLE_COLUMN_WIDTH_LIMITS = {
  identity: { min: 160, max: 440 },
  current: { min: 120, max: 320 },
  applied: { min: 96, max: 240 },
  url: { min: 120, max: 360 },
  notes: { min: 144, max: 480 },
  stage: { min: 120, max: 420 },
} as const;

export type ProgressTableBaseColumnId = 'identity' | 'current' | 'applied' | 'url' | 'notes';
export type ProgressTableColumnKey = ProgressTableBaseColumnId | `stage:${string}`;

export interface ResolvedProgressTableColumns {
  stageOrder: string[];
  hiddenStageIds: string[];
  visibleColumns: ProgressTableProjection['columns'];
}

const emptyPreferences = (): ProgressTableColumnPreferences => ({ stageOrder: [], hiddenStageIds: [], columnWidths: {} });

function isProgressTableColumnKey(value: string): value is ProgressTableColumnKey {
  return value === 'identity' || value === 'current' || value === 'applied' || value === 'url' || value === 'notes'
    || (value.startsWith('stage:') && value.length > 'stage:'.length);
}

export function progressTableStageColumnKey(stageId: string): `stage:${string}` {
  return `stage:${stageId}`;
}

/** Keep user-provided, restored, and keyboard-adjusted widths inside usable bounds. */
export function clampProgressTableColumnWidth(columnKey: ProgressTableColumnKey, width: number): number {
  const baseId: keyof typeof PROGRESS_TABLE_COLUMN_WIDTH_LIMITS = columnKey.startsWith('stage:') ? 'stage' : columnKey as ProgressTableBaseColumnId;
  const limits = PROGRESS_TABLE_COLUMN_WIDTH_LIMITS[baseId];
  const defaultWidth = DEFAULT_PROGRESS_TABLE_COLUMN_WIDTHS[baseId];
  const safeWidth = Number.isFinite(width) ? Math.round(width) : defaultWidth;
  return Math.min(limits.max, Math.max(limits.min, safeWidth));
}

export function getProgressTableColumnWidth(
  preferences: ProgressTableColumnPreferences | undefined,
  columnKey: ProgressTableColumnKey,
): number {
  const saved = preferences?.columnWidths?.[columnKey];
  const defaultWidth = columnKey.startsWith('stage:')
    ? DEFAULT_PROGRESS_TABLE_COLUMN_WIDTHS.stage
    : DEFAULT_PROGRESS_TABLE_COLUMN_WIDTHS[columnKey as ProgressTableBaseColumnId];
  return clampProgressTableColumnWidth(columnKey, typeof saved === 'number' ? saved : defaultWidth);
}

/** Create the next preference value without mutating the controlled preference object. */
export function resizeProgressTableColumnWidth(
  preferences: ProgressTableColumnPreferences,
  columnKey: ProgressTableColumnKey,
  width: number,
): ProgressTableColumnPreferences {
  return {
    ...preferences,
    columnWidths: {
      ...preferences.columnWidths,
      [columnKey]: clampProgressTableColumnWidth(columnKey, width),
    },
  };
}

function parseColumnWidths(value: unknown): Partial<Record<ProgressTableColumnKey, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const widths: Partial<Record<ProgressTableColumnKey, number>> = {};
  for (const [key, width] of Object.entries(value)) {
    if (!isProgressTableColumnKey(key) || typeof width !== 'number' || !Number.isFinite(width)) continue;
    widths[key] = clampProgressTableColumnWidth(key, width);
  }
  return widths;
}

/** Parse the primitive-string workspace preference without trusting persisted JSON. */
export function parseProgressTableColumnPreferences(value: unknown): ProgressTableColumnPreferences {
  if (typeof value !== 'string') return emptyPreferences();
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyPreferences();
    const candidate = parsed as Record<string, unknown>;
    if (!Array.isArray(candidate.stageOrder) || !Array.isArray(candidate.hiddenStageIds)) return emptyPreferences();
    return {
      stageOrder: [...new Set(candidate.stageOrder.filter((item): item is string => typeof item === 'string' && item.length > 0))],
      hiddenStageIds: [...new Set(candidate.hiddenStageIds.filter((item): item is string => typeof item === 'string' && item.length > 0))],
      // Older `progress-table.columns.v1` values have no width map and retain default widths.
      columnWidths: parseColumnWidths(candidate.columnWidths),
    };
  } catch {
    return emptyPreferences();
  }
}

export function serializeProgressTableColumnPreferences(value: ProgressTableColumnPreferences): string {
  return JSON.stringify({
    stageOrder: [...new Set(value.stageOrder.filter(item => typeof item === 'string' && item.length > 0))],
    hiddenStageIds: [...new Set(value.hiddenStageIds.filter(item => typeof item === 'string' && item.length > 0))],
    columnWidths: parseColumnWidths(value.columnWidths),
  });
}

/** Resolve controlled preferences against the current dynamic projection. */
export function resolveProgressTableColumns(
  projection: ProgressTableProjection,
  preferences?: ProgressTableColumnPreferences,
): ResolvedProgressTableColumns {
  const columns = projection.columns;
  const available = new Set(columns.map(column => column.id));
  const seen = new Set<string>();
  const stageOrder: string[] = [];
  for (const id of preferences?.stageOrder ?? []) {
    if (available.has(id) && !seen.has(id)) {
      seen.add(id);
      stageOrder.push(id);
    }
  }
  for (const column of columns) {
    if (!seen.has(column.id)) {
      seen.add(column.id);
      stageOrder.push(column.id);
    }
  }

  const hiddenStageIds = [...new Set(preferences?.hiddenStageIds ?? [])].filter(id => available.has(id));
  const hidden = new Set(hiddenStageIds);
  const byId = new Map(columns.map(column => [column.id, column]));
  return {
    stageOrder,
    hiddenStageIds,
    visibleColumns: stageOrder.flatMap(id => {
      const column = byId.get(id);
      return column && !hidden.has(id) ? [column] : [];
    }),
  };
}

/** Move one stage column by one position in the complete (visible and hidden) order. */
export function moveProgressStageColumn(order: readonly string[], stageId: string, direction: -1 | 1): string[] {
  const next = [...order];
  const index = next.indexOf(stageId);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= next.length) return next;
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}
