import { useState, type ReactNode } from 'react';
import type { Schedule } from '../../domain/types.js';
import { useV2Data } from '../../app/V2DataContext.js';
import { ApplicationDetailDrawer, scheduleTypeName } from '../applications/ApplicationDrawers.js';
import { ToastRegion, useToasts } from '../../shared/ui/Toast.js';
import './UpcomingSchedules.css';

export interface UpcomingScheduleItem {
  schedule: Schedule;
  company: string;
  role: string;
  overdue: boolean;
}

const formatTime = (instant: string) => new Date(instant).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The overview's schedule list: click an item to see its details, finish it with one click
 * (with undo), or jump to the application it belongs to.
 */
export function UpcomingSchedules({ items, emptyState }: { items: readonly UpcomingScheduleItem[]; emptyState: ReactNode }) {
  const { runScheduleCommand } = useV2Data();
  const { toasts, show, dismiss } = useToasts(3200);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const setStatus = (schedule: Schedule, status: Schedule['status']) =>
    runScheduleCommand((commands, expectedRevision) => commands.setScheduleStatus({ scheduleId: schedule.id, expectedRevision, status }));

  const complete = async (schedule: Schedule) => {
    setBusyId(schedule.id);
    try {
      await setStatus(schedule, 'completed');
      show(`已完成「${schedule.title}」`, 'success', {
        label: '撤销',
        run: () => setStatus(schedule, 'pending').then(() => show(`已恢复「${schedule.title}」为待办`), cause => show(cause instanceof Error ? cause.message : '撤销失败', 'error')),
      });
    } catch (cause) {
      show(cause instanceof Error ? cause.message : '操作失败，请重试', 'error');
    } finally {
      setBusyId(null);
    }
  };

  return <>
    {items.length === 0 ? emptyState : <ul className="upcoming">
      {items.map(({ schedule, company, role, overdue }) => {
        const open = openId === schedule.id;
        return <li key={schedule.id} className={`upcoming__item${overdue ? ' upcoming__item--overdue' : ''}`}>
          <div className="upcoming__row">
            <button type="button" className="upcoming__main" aria-expanded={open} onClick={() => setOpenId(open ? null : schedule.id)}>
              <strong>{schedule.title}</strong>
              <span>{company}</span>
            </button>
            <time dateTime={schedule.startsAt}>{overdue && <span className="overview-overdue">已逾期 · </span>}{formatTime(schedule.startsAt)}</time>
            <button type="button" className="upcoming__done" disabled={busyId === schedule.id} aria-label={`完成日程：${schedule.title}`} onClick={() => void complete(schedule)}>完成</button>
          </div>
          {open && <div className="upcoming__detail">
            <dl>
              <div><dt>类型</dt><dd>{scheduleTypeName(schedule.type)}</dd></div>
              <div><dt>投递</dt><dd>{company} · {role}</dd></div>
              <div><dt>时间</dt><dd>{formatTime(schedule.startsAt)}</dd></div>
              {schedule.notes.trim() ? <div className="upcoming__wide"><dt>备注</dt><dd>{schedule.notes}</dd></div> : null}
            </dl>
            <button type="button" className="upcoming__link" onClick={() => setDetailId(schedule.applicationId)}>打开这条投递（改时间、取消、删除）</button>
          </div>}
        </li>;
      })}
    </ul>}
    <ApplicationDetailDrawer applicationId={detailId} onClose={() => setDetailId(null)} notice={(message, tone = 'success', action) => show(message, tone, action)} />
    <ToastRegion toasts={toasts} onDismiss={dismiss} />
  </>;
}
