import { DomainError } from '../domain/errors.js';
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
export function validateBackupSize(bytes: number): void {
  if (bytes > MAX_BACKUP_BYTES) throw new DomainError('VALIDATION', '备份文件不能超过 25 MB');
}
export function validateExternalUrl(value: string): string {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value) || !/^https?:\/\//i.test(value)) {
    throw new DomainError('VALIDATION', '外链必须是完整的 HTTP 或 HTTPS 地址');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new DomainError('VALIDATION', '外链地址无效'); }
  if (!url.hostname || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new DomainError('VALIDATION', '外链地址无效');
  return url.href;
}
export function validateBackupName(name: string): void {
  if (!name.trim() || name.length > 180 || /[\u0000-\u001f\u007f/\\:]/u.test(name) || name === '.' || name === '..') throw new DomainError('VALIDATION', '备份文件名无效');
}
export function validateRoute(route: string): void {
  if (route.length > 2048 || /[\\\u0000-\u0020\u007f]/u.test(route) || !/^\/(analytics|overview|applications(?:\/[A-Za-z0-9_-]+)?|board|settings|design-system)(?:\?[^#]*)?$/u.test(route)) throw new DomainError('VALIDATION', '应用路由无效');
}
