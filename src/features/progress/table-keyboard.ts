export type ProgressTableArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export interface ProgressTableGridPosition {
  row: number;
  column: number;
}

export type EditableProgressField = 'appliedOn' | 'trackingUrl' | 'notes';

export interface EditableProgressCell {
  applicationId: string;
  field: EditableProgressField;
}

/** Return a neighboring body-cell coordinate; edges and invalid coordinates stay put. */
export function moveProgressTableFocus(
  position: ProgressTableGridPosition,
  key: ProgressTableArrowKey,
  rowCount: number,
  columnCount: number,
): ProgressTableGridPosition | null {
  if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(columnCount) || rowCount < 1 || columnCount < 1) return null;
  if (!Number.isSafeInteger(position.row) || !Number.isSafeInteger(position.column)
    || position.row < 0 || position.row >= rowCount || position.column < 0 || position.column >= columnCount) return null;
  const next = { ...position };
  if (key === 'ArrowUp') next.row -= 1;
  else if (key === 'ArrowDown') next.row += 1;
  else if (key === 'ArrowLeft') next.column -= 1;
  else next.column += 1;
  return next.row < 0 || next.row >= rowCount || next.column < 0 || next.column >= columnCount ? null : next;
}

/** Inputs, textareas, selects, editable content and active IME composition own their keys. */
export function progressTableKeyIsOwnedByEditor(input: {
  tagName?: string;
  isContentEditable?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  const tag = input.tagName?.toUpperCase();
  return input.isComposing === true || input.keyCode === 229 || input.isContentEditable === true
    || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Tab moves through editable application fields in visual order and wraps at table edges. */
export function moveProgressEditableCell(
  applicationIds: readonly string[],
  current: EditableProgressCell,
  direction: -1 | 1,
): EditableProgressCell | null {
  if (applicationIds.length === 0) return null;
  const fields: EditableProgressField[] = ['appliedOn', 'trackingUrl', 'notes'];
  const row = applicationIds.indexOf(current.applicationId);
  const field = fields.indexOf(current.field);
  if (row < 0 || field < 0) return null;
  const flatIndex = row * fields.length + field;
  const total = applicationIds.length * fields.length;
  const nextIndex = (flatIndex + direction + total) % total;
  return {
    applicationId: applicationIds[Math.floor(nextIndex / fields.length)]!,
    field: fields[nextIndex % fields.length]!,
  };
}

/** Encode one value as a one-cell TSV record. */
export function serializeTsvCell(value: string): string {
  return /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Parse only a single TSV cell; rows or columns of data are rejected to prevent batch paste. */
export function parseSingleTsvCell(input: string): string | null {
  if (!input.startsWith('"')) return /[\t\r\n]/.test(input) ? null : input;
  let result = '';
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (character !== '"') {
      result += character;
      continue;
    }
    if (input[index + 1] === '"') {
      result += '"';
      index += 1;
      continue;
    }
    return index === input.length - 1 ? result : null;
  }
  return null;
}

export function isValidProgressDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1000) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
