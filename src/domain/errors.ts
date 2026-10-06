export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'STORAGE' | 'BACKUP_INCOMPATIBLE' | 'CONFLICT';
export class DomainError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.name = 'DomainError'; this.code = code; }
}
export function requireRule(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError('VALIDATION', message);
}
