import './ProgressHistory.css';
import { useState } from 'react';
import { ConfirmDialog } from '../../shared/ui/Dialog.js';
import { projectProgressHistory, type ProgressHistoryNode, type ProgressHistoryUncertainEdge } from './history.js';
import type { ProgressEvent } from '../../domain/v2/types.js';

export interface ProgressHistoryProps {
  /** One application's effective R1 chain, used to render the ordered history. */
  events: readonly ProgressEvent[];
  /**
   * The complete R1 audit record set for this application, including invalidated
   * events. Pass this when `events` is already filtered to the effective chain so
   * uncertain edges can still follow correction ancestry.
   */
  auditEvents?: readonly ProgressEvent[];
  uncertainEdges?: readonly ProgressHistoryUncertainEdge[];
  onAppend?: () => void;
  /** The supplied id is the event that the new backfilled event must precede. */
  onBackfill?: (beforeEventId: string) => void;
  onCorrect?: (event: ProgressEvent) => void;
  /** Removes a mistaken record; the component asks for confirmation first. */
  onDelete?: (event: ProgressEvent) => void;
  onSelectEvent?: (event: ProgressEvent) => void;
  title?: string;
}

const sourceLabel: Record<ProgressEvent['source'], string> = {
  entered: '正常记录',
  continued: '同一轮的进展',
  reopened: '重新开启',
  backfilled: '历史补录',
};

function tone(node: ProgressHistoryNode): string {
  const outcome = node.event.semantics.terminalOutcome;
  if (outcome === 'failed') return 'failed';
  if (outcome === 'offer_received' || outcome === 'offer_accepted') return 'offer';
  if (outcome === 'offer_declined' || outcome === 'withdrawn') return 'ended';
  return 'active';
}

const shortDate = (date: string) => date.slice(5).replace('-', '/');

/** A thin connector with a small round-capped chevron; dashed when the order is uncertain or for the next step. */
function Connector({ dashed = false, chevron = true }: { dashed?: boolean; chevron?: boolean }) {
  return <svg className="progress-history__connector" width="34" height="12" viewBox="0 0 34 12" aria-hidden="true">
    <path d={chevron ? 'M3 6H29' : 'M3 6H31'} strokeDasharray={dashed ? '3 3' : undefined} />
    {chevron ? <path d="M26 2.5 29.5 6 26 9.5" /> : null}
  </svg>;
}

/** A horizontal timeline of the effective events; selecting a node shows its details and actions. */
function ProgressHistory({
  events,
  auditEvents = events,
  uncertainEdges = [],
  onAppend,
  onBackfill,
  onCorrect,
  onDelete,
  onSelectEvent,
  title = '进度历史',
}: ProgressHistoryProps) {
  const history = projectProgressHistory(events, uncertainEdges, auditEvents);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const selectedNode = history.nodes.find(node => node.event.id === selectedEventId) ?? null;
  const selected = selectedNode?.event ?? null;
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <section className="progress-history" aria-label={title}>
      <h2 className="progress-history__title">{title}</h2>

      {history.nodes.length === 0 ? (
        <div className="progress-history__empty">
          <p>还没有进度记录</p>
          {onAppend ? <button type="button" className="progress-history__add" onClick={onAppend}>记录状态</button> : null}
        </div>
      ) : (
        <div className="progress-history__scroller" tabIndex={0} aria-label="可横向滚动的进度流程">
          <ol className="progress-history__track" aria-label="有效进度事件历史">
            {history.nodes.map((node, index) => {
              const event = node.event;
              const link = history.links[index];
              const meta = [
                node.visitCount ? `第 ${node.visitOrdinal}/${node.visitCount} 次` : null,
                node.failureLabel?.replace('失败环节：', '挂在 '),
              ].filter(Boolean).join(' · ');
              return (
                <li className="progress-history__node" key={event.id}>
                  <button
                    type="button"
                    className={`progress-history__card progress-history__card--${tone(node)}${node.isCurrent ? ' progress-history__card--current' : ''}${selectedEventId === event.id ? ' progress-history__card--selected' : ''}`}
                    aria-pressed={selectedEventId === event.id}
                    aria-current={node.isCurrent ? 'step' : undefined}
                    aria-label={`查看事件：${event.statusNameSnapshot}，${event.occurredOn}${node.isCurrent ? '，当前节点' : ''}`}
                    onClick={() => {
                      const next = selectedEventId === event.id ? null : event.id;
                      setSelectedEventId(next);
                      if (next) onSelectEvent?.(event);
                    }}
                  >
                    <span className="progress-history__dot" aria-hidden="true" />
                    <span className="progress-history__name">{event.statusNameSnapshot}</span>
                    <span className="progress-history__date">{shortDate(event.occurredOn)}</span>
                    {meta ? <span className="progress-history__meta">{meta}</span> : null}
                    {event.notes.trim() ? <span className="progress-history__note" title={event.notes}>{event.notes}</span> : null}
                  </button>
                  {link ? (
                    <span className={`progress-history__edge${link.uncertain ? ' progress-history__edge--uncertain' : ''}`} title={link.uncertaintyReason ?? undefined}>
                      <Connector dashed={link.uncertain} />
                      {link.uncertain ? <span className="progress-history__sr-only">连接顺序待确认：{link.uncertaintyReason}</span> : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {onAppend ? (
              <li className="progress-history__node progress-history__node--add">
                <span className="progress-history__edge progress-history__edge--next" aria-hidden="true"><Connector dashed chevron={false} /></span>
                <button type="button" className="progress-history__add" onClick={onAppend}>＋ 记录新进展</button>
              </li>
            ) : null}
          </ol>
        </div>
      )}

      {selected && selectedNode ? (
        <aside className="progress-history__details" aria-label="选中事件详情">
          <div className="progress-history__details-head">
            <h3>{selected.statusNameSnapshot}<span>{selected.occurredOn}</span></h3>
            <div className="progress-history__details-actions">
              {onBackfill ? <button type="button" onClick={() => onBackfill(selected.id)}>在此之前补录</button> : null}
              {onCorrect ? <button type="button" onClick={() => onCorrect(selected)}>纠错</button> : null}
              {onDelete ? <button type="button" className="progress-history__delete" onClick={() => setConfirmDelete(true)}>删除这条</button> : null}
            </div>
          </div>
          <dl>
            <div><dt>环节</dt><dd>{selected.semantics.stageNameSnapshot ?? '不属于具体环节'}</dd></div>
            <div><dt>进度</dt><dd>{selectedNode.phaseLabel ?? '—'}</dd></div>
            <div><dt>记录方式</dt><dd>{sourceLabel[selected.source]}</dd></div>
            {selectedNode.outcomeLabel ? <div><dt>结果</dt><dd>{selectedNode.outcomeLabel}</dd></div> : null}
            {selected.failedAt ? <div><dt>失败环节</dt><dd>{selected.failedAt === 'unknown' ? '未知' : selected.failedAt.stageNameSnapshot}</dd></div> : null}
            {selected.reopenReason ? <div><dt>重新开启原因</dt><dd>{selected.reopenReason}</dd></div> : null}
            {selected.notes.trim() ? <div className="progress-history__details-wide"><dt>备注</dt><dd>{selected.notes}</dd></div> : null}
          </dl>
          <details className="progress-history__tech">
            <summary>技术信息</summary>
            <p>第 {selected.sequence} 条有效记录 · 事件 ID <code>{selected.id}</code></p>
            {selected.previousEventId ? <p>前一事件 ID <code>{selected.previousEventId}</code></p> : null}
            {selected.insertedBeforeEventId ? <p>补录锚点 ID <code>{selected.insertedBeforeEventId}</code></p> : null}
            {selected.correctionOfEventId ? <p>纠正来源 ID <code>{selected.correctionOfEventId}</code></p> : null}
          </details>
        </aside>
      ) : history.nodes.length > 0 ? <p className="progress-history__hint">点一个节点可以查看详情、在它之前补录、纠错或删除。</p> : null}
      {onDelete ? <ConfirmDialog
        open={confirmDelete && !!selected}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); if (selected) { setSelectedEventId(null); onDelete(selected); } }}
        title={`删除「${selected?.statusNameSnapshot ?? ''}」这条进展？`}
        description={`适用于记错或重复记录的进展。删除后流程里不再显示这一条，统计也不再计入；后面的记录会自动接上（${selected?.occurredOn ?? ''}）。`}
        confirmLabel="删除"
        cancelLabel="取消"
      /> : null}
    </section>
  );
}

export { ProgressHistory };
