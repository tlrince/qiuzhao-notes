import type { ApplicationV2 } from '../../domain/v2/snapshot.js';

type SearchableApplication = Pick<ApplicationV2, 'seasonId' | 'company' | 'role' | 'city' | 'updatedAt'>;

/** A season-scoped search that deliberately covers only the fields named in the UI contract. */
export function filterApplicationsForSeason<T extends SearchableApplication>(
  applications: readonly T[],
  seasonId: string,
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return applications
    .filter(application => application.seasonId === seasonId
      && (!needle || `${application.company} ${application.role} ${application.city}`.toLocaleLowerCase().includes(needle)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || left.company.localeCompare(right.company, 'zh-CN'));
}

/** Only HTTP(S) links are exposed as openable external destinations. */
export function safeExternalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Accepts a pasted address without a scheme (jobs.example.com/…) as an https link. */
export function normalizeUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed) || /\s/.test(trimmed)) return trimmed;
  return /^[^/]+\.[^/]+/.test(trimmed) ? `https://${trimmed}` : trimmed;
}

/** Earlier applications for the same company and position; different periods are allowed. */
export function sameRoleApplications<T extends Pick<ApplicationV2, 'seasonId' | 'company' | 'role'>>(
  applications: readonly T[],
  seasonId: string,
  company: string,
  role: string,
): T[] {
  const key = (value: string) => value.trim().toLocaleLowerCase();
  if (!key(company) || !key(role)) return [];
  return applications.filter(application => application.seasonId === seasonId && key(application.company) === key(company) && key(application.role) === key(role));
}
