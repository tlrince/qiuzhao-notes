import type { DataSnapshot, Stage, Outcome } from '../domain/types.js';
import { createDetail, transitionDetail } from '../domain/rules.js';
export function emptySnapshot(): DataSnapshot {
  return { workspace: { id: 'local', name: '秋招工作空间', timeZone: 'Asia/Shanghai', activeSeasonId: null }, seasons: [],
    channels: ['官网', '内推', '招聘平台', '校园宣讲', '其他', '未填写'].map((name, i) => ({ id: ['official', 'referral', 'platform', 'campus', 'other', 'unspecified'][i]!, name, archivedAt: null })),
    settings: { schemaVersion: 1, lastBackupAt: null, preferences: {} }, applications: [], stageEvents: [], outcomeEvents: [], schedules: [] };
}
/** 显式调用才加载。预期值是验收常量，非统计实现。 */
export const ACCEPTANCE_EXPECTED = { recordCount: 6, submittedCount: 5, activeCount: 2, interviewCount: 3, offerCount: 1, interviewRate: 0.6, offerRate: 0.2, stages: { submitted: 5, assessment: 2, interview_1: 3, interview_2: 1, interview_3_plus: 0 } } as const;
export function acceptanceSnapshot(): DataSnapshot {
  const data = emptySnapshot(); data.seasons.push({ id: '2026-autumn', name: '2026 秋招', startDate: '2026-07-01', endDate: '2026-12-31', targetCount: 100, archivedAt: null }); data.workspace.activeSeasonId = '2026-autumn';
  const cases: [string, Stage[], Outcome][] = [['A', [], 'active'], ['B', ['submitted'], 'active'], ['C', ['submitted', 'assessment'], 'rejected'], ['D', ['submitted', 'interview_1'], 'active'], ['E', ['submitted', 'assessment', 'interview_1', 'interview_2'], 'offer'], ['F', ['submitted', 'interview_1'], 'withdrawn']];
  for (const [label, stages, outcome] of cases) {
    let sequence = 0; const ctx = { now: '2026-09-10T00:00:00.000Z', id: () => sequence++ === 0 ? label : `${label}-${sequence}` };
    let detail = createDetail({ seasonId: '2026-autumn', company: `样例公司 ${label}`, role: '前端工程师', city: label === 'B' ? '' : '上海', channelId: label === 'D' ? 'referral' : 'official' }, ctx);
    for (const stage of stages) detail = transitionDetail(detail, { id: label, expectedUpdatedAt: detail.application.updatedAt, kind: 'stage', stage, occurredOn: '2026-09-10' }, ctx);
    if (outcome !== 'active') detail = transitionDetail(detail, { id: label, expectedUpdatedAt: detail.application.updatedAt, kind: 'outcome', outcome, occurredOn: '2026-09-10' }, ctx);
    data.applications.push(detail.application); data.stageEvents.push(...detail.stageEvents); data.outcomeEvents.push(...detail.outcomeEvents);
  }
  return data;
}
