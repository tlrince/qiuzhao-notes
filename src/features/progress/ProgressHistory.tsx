import './ProgressHistory.css';
import { useState } from 'react';
import { projectProgressHistory, type ProgressHistoryUncertainEdge } from './history.js';
import type { ProgressEvent } from '../../domain/v2/types.js';

export interface ProgressHistoryProps {
  /** One application's effective R1 chain, used to render the ordered history. */
  events: readonly ProgressEvent[];
  /**
   * The complete R1 audit record set for this application, including invalidated
   * events. Pass this when `events` is already filtered to the effective chain so
   * uncertain edges can still follow correction ancestry. Defaults to `events` for
   * backwards compatibility when it already contains the full record set.
   */
  auditEvents?: readonly ProgressEvent[];
  uncertainEdges?: readonly ProgressHistoryUncertainEdge[];
  onAppend?: () => void;
  /** The supplied id is the event that the new backfilled event must precede. */
  onBackfill?: (beforeEventId: string) => void;
  onCorrect?: (event: ProgressEvent) => void;
  onSelectEvent?: (event: ProgressEvent) => void;
  title?: string;
}

function ProgressHistory({
  events,
  auditEvents = events,
  uncertainEdges = [],
  onAppend,
  onBackfill,
  onCorrect,
  onSelectEvent,
  title = '进度历史',
}: ProgressHistoryProps) {
  const history = projectProgressHistory(events, uncertainEdges, auditEvents);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const selectedNode = history.nodes.find(node => node.event.id === selectedEventId) ?? null;
  const selectedEvent = selectedNode?.event ?? null;

  const sourceLabel: Record<ProgressEvent['source'], string> = {
    entered: '正常记录',
    continued: '继续同一轮',
    reopened: '重新开启',
    backfilled: '历史补录',
  };
  const visitLabel: Record<ProgressEvent['visitAction'], string> = {
    new: '新一轮',
    continue: '延续上一轮',
  };

  return (
    <section className="progress-history" aria-label={title}>
      <div className="progress-history__heading">
        <h2>{title}</h2>
      </div>

      {history.nodes.length === 0 ? (
        <div className="progress-history__empty">
          <p>暂无进度记录</p>
          {onAppend ? <button type="button" onClick={onAppend}>记录状态</button> : null}
        </div>
      ) : (
        <div className="progress-history__scroller" tabIndex={0} aria-label="可横向滚动的进度流程">
          <ol className="progress-history__events" aria-label="有效进度事件历史">
            {history.nodes.map((node, index) => {
              const link = history.links[index];
              const event = node.event;
              const visitLabel = node.visitCount
                ? `第 ${node.visitOrdinal} 次，共 ${node.visitCount} 次`
                : null;

              return (
                <li className="progress-history__item" key={event.id}>
                  <article
                    className={`progress-history__card${node.isCurrent ? ' progress-history__card--current' : ''}`}
                    aria-current={node.isCurrent ? 'step' : undefined}
                  >
                    <div className="progress-history__badges">
                      {node.isCurrent ? <span className="progress-history__badge progress-history__badge--current">当前节点</span> : null}
                      {visitLabel ? <span className="progress-history__badge progress-history__badge--visit">{visitLabel}</span> : null}
                      {node.outcomeLabel ? (
                        <span className={`progress-history__badge ${event.semantics.terminalOutcome === 'failed' ? 'progress-history__badge--failure' : event.semantics.terminalOutcome === 'offer_declined' ? 'progress-history__badge--declined' : event.semantics.terminalOutcome === 'withdrawn' ? 'progress-history__badge--withdrawn' : 'progress-history__badge--offer'}`}>
                          {node.outcomeLabel}
                        </span>
                      ) : null}
                    </div>
                    <h3>{event.statusNameSnapshot}</h3>
                    <p className="progress-history__date">发生日期：{event.occurredOn}</p>
                    {node.failureLabel ? <p className="progress-history__failure">{node.failureLabel}</p> : null}
                    {node.phaseLabel ? <p className="progress-history__phase">进度：{node.phaseLabel}</p> : null}
                    {event.notes.trim() ? <p className="progress-history__notes">{event.notes}</p> : null}
                    {event.reopenReason ? <p className="progress-history__notes">重新开启原因：{event.reopenReason}</p> : null}
                    <div className="progress-history__actions">
                      <button type="button" aria-pressed={selectedEventId === event.id} onClick={() => { setSelectedEventId(event.id); onSelectEvent?.(event); }}>查看事件</button>
                      {onBackfill ? <button type="button" onClick={() => onBackfill(event.id)}>在此节点前补录</button> : null}
                      {onCorrect ? <button type="button" onClick={() => onCorrect(event)}>纠错</button> : null}
                      {node.isCurrent && onAppend ? <button type="button" onClick={onAppend}>＋ 追加记录</button> : null}
                    </div>
                  </article>
                  {link ? (
                    <>
                      <span className="progress-history__edge">
                        <span
                          className={`progress-history__link${link.uncertain ? ' progress-history__link--uncertain' : ''}`}
                          aria-hidden="true"
                        >
                          <svg viewBox="0 0 12 28" focusable="false">
                            <path className="progress-history__arrow-shaft" d="M6 1V21" />
                            <path className="progress-history__arrow-head" d="M2 18L6 23L10 18" />
                          </svg>
                        </span>
                        {link.uncertain ? <span className="progress-history__uncertain-label">顺序待确认</span> : null}
                      </span>
                      {link.uncertain ? (
                        <span className="progress-history__sr-only">
                          连接顺序待确认；停留时长无法精确计算。{link.uncertaintyReason}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {selectedEvent ? <aside className="progress-history__details" aria-label="选中事件详情">
        <h3>事件详情 · {selectedEvent.statusNameSnapshot}</h3>
        <dl>
          <div><dt>发生日期</dt><dd>{selectedEvent.occurredOn}</dd></div>
          <div><dt>进度结果</dt><dd>{selectedNode?.phaseLabel ?? '结果未知'}</dd></div>
          <div><dt>阶段</dt><dd>{selectedEvent.semantics.stageNameSnapshot ?? '不属于具体阶段'}</dd></div>
          <div><dt>事件类型</dt><dd>{sourceLabel[selectedEvent.source]}</dd></div>
          <div><dt>本轮关系</dt><dd>{visitLabel[selectedEvent.visitAction]}</dd></div>
          <div><dt>事件序号</dt><dd>第 {selectedEvent.sequence} 条有效记录</dd></div>
          <div><dt>事件 ID</dt><dd><code>{selectedEvent.id}</code></dd></div>
          {selectedEvent.previousEventId ? <div><dt>前一事件 ID</dt><dd><code>{selectedEvent.previousEventId}</code></dd></div> : null}
          {selectedEvent.insertedBeforeEventId ? <div><dt>补录锚点 ID</dt><dd><code>{selectedEvent.insertedBeforeEventId}</code></dd></div> : null}
          {selectedEvent.correctionOfEventId ? <div><dt>纠正来源 ID</dt><dd><code>{selectedEvent.correctionOfEventId}</code></dd></div> : null}
          {selectedEvent.reopenReason ? <div><dt>重新开启原因</dt><dd>{selectedEvent.reopenReason}</dd></div> : null}
          {selectedEvent.failedAt ? <div><dt>失败环节</dt><dd>{selectedEvent.failedAt === 'unknown' ? '未知' : selectedEvent.failedAt.stageNameSnapshot}</dd></div> : null}
          {selectedEvent.notes.trim() ? <div><dt>备注</dt><dd>{selectedEvent.notes}</dd></div> : null}
        </dl>
      </aside> : null}
    </section>
  );
}

export { ProgressHistory };
