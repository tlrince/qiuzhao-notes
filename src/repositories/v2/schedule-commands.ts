import { DomainError, requireRule } from '../../domain/errors.js';
import { validateInstant } from '../../domain/validation.js';
import type { Schedule } from '../../domain/types.js';
import { validateV2Snapshot, type DataSnapshotV2 } from '../../domain/v2/snapshot.js';
import type { SnapshotStoreV2 } from '../storage-v2-contract.js';

type ScheduleFields = Pick<Schedule, 'type' | 'title' | 'startsAt' | 'notes'>;

export interface ScheduleCommands {
  createSchedule(input: { expectedRevision: number; applicationId: string } & ScheduleFields): Promise<{ revision: number; value: Schedule }>;
  updateSchedule(input: { expectedRevision: number; scheduleId: string; patch: Partial<ScheduleFields> }): Promise<{ revision: number; value: Schedule }>;
  setScheduleStatus(input: { expectedRevision: number; scheduleId: string; status: Schedule['status'] }): Promise<{ revision: number; value: Schedule }>;
  deleteSchedule(input: { expectedRevision: number; scheduleId: string }): Promise<{ revision: number; value: { scheduleId: string; applicationId: string } }>;
}

const scheduleTypes = new Set<Schedule['type']>(['assessment', 'interview', 'follow_up', 'other']);
const scheduleStatuses = new Set<Schedule['status']>(['pending', 'completed', 'cancelled']);

function checkRevision(expected: number, actual: number): void {
  requireRule(Number.isSafeInteger(expected) && expected >= 0, '快照版本无效');
  if (expected !== actual) throw new DomainError('CONFLICT', '数据已更新，请重新加载');
}

function findSchedule(snapshot: DataSnapshotV2, id: string): Schedule {
  const schedule = snapshot.schedules.find(item => item.id === id);
  if (!schedule) throw new DomainError('NOT_FOUND', '日程不存在');
  return schedule;
}

function validateFields(value: ScheduleFields): void {
  requireRule(scheduleTypes.has(value.type), '日程类型无效');
  requireRule(typeof value.title === 'string' && value.title.trim().length > 0 && value.title.trim().length <= 160, '日程标题不能为空且最多 160 个字符');
  requireRule(typeof value.notes === 'string' && value.notes.length <= 4000, '日程备注无效');
  validateInstant(value.startsAt);
}

/** Schedule CRUD uses a full-snapshot CAS transaction so schedules remain aligned with application deletion/import. */
export function createScheduleCommands(
  store: SnapshotStoreV2,
  context: { id?: () => string } = {},
): ScheduleCommands {
  const id = context.id ?? (() => globalThis.crypto.randomUUID());

  async function transact<T>(
    expectedRevision: number,
    mutate: (snapshot: DataSnapshotV2) => T,
    preserveRecoveryCopy = false,
  ): Promise<{ revision: number; value: T }> {
    const stored = await store.read();
    checkRevision(expectedRevision, stored.revision);
    const next = structuredClone(stored.data);
    const value = mutate(next);
    validateV2Snapshot(next);
    const revision = preserveRecoveryCopy
      ? await store.restore(expectedRevision, next)
      : await store.commit(expectedRevision, next);
    return { revision, value: structuredClone(value) };
  }

  return {
    createSchedule(input) {
      return transact(input.expectedRevision, snapshot => {
        requireRule(snapshot.applications.some(application => application.id === input.applicationId), '投递不存在');
        const scheduleId = id();
        requireRule(typeof scheduleId === 'string' && scheduleId.trim().length > 0, '日程 ID 无效');
        requireRule(!snapshot.schedules.some(schedule => schedule.id === scheduleId), '日程 ID 已存在');
        const fields = { type: input.type, title: input.title, startsAt: input.startsAt, notes: input.notes };
        validateFields(fields);
        const schedule: Schedule = {
          id: scheduleId,
          applicationId: input.applicationId,
          ...fields,
          title: fields.title.trim(),
          status: 'pending',
        };
        snapshot.schedules.push(schedule);
        return schedule;
      });
    },
    updateSchedule(input) {
      return transact(input.expectedRevision, snapshot => {
        const schedule = findSchedule(snapshot, input.scheduleId);
        requireRule(typeof input.patch === 'object' && input.patch !== null && !Array.isArray(input.patch), '日程更新内容无效');
        const allowed = new Set(['type', 'title', 'startsAt', 'notes']);
        const keys = Object.keys(input.patch);
        requireRule(keys.length > 0, '至少需要修改一个日程字段');
        for (const key of keys) {
          requireRule(allowed.has(key), `不允许直接修改日程字段：${key}`);
          requireRule(input.patch[key as keyof ScheduleFields] !== undefined, `日程字段不能写入 undefined：${key}`);
        }
        const fields: ScheduleFields = {
          type: input.patch.type ?? schedule.type,
          title: input.patch.title ?? schedule.title,
          startsAt: input.patch.startsAt ?? schedule.startsAt,
          notes: input.patch.notes ?? schedule.notes,
        };
        validateFields(fields);
        Object.assign(schedule, fields, { title: fields.title.trim() });
        return schedule;
      });
    },
    setScheduleStatus(input) {
      return transact(input.expectedRevision, snapshot => {
        const schedule = findSchedule(snapshot, input.scheduleId);
        requireRule(scheduleStatuses.has(input.status), '日程状态无效');
        schedule.status = input.status;
        return schedule;
      });
    },
    deleteSchedule(input) {
      return transact(input.expectedRevision, snapshot => {
        const schedule = findSchedule(snapshot, input.scheduleId);
        const removed = { scheduleId: schedule.id, applicationId: schedule.applicationId };
        snapshot.schedules = snapshot.schedules.filter(item => item.id !== schedule.id);
        return removed;
      }, true);
    },
  };
}
