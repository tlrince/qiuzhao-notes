import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { calculateV2Analytics, type V2AnalyticsResult } from '../../domain/v2/analytics.js';
import { useV2Data } from '../../app/V2DataContext.js';
import { Button, ChartCard, EmptyState, PageHeader } from '../../shared/ui/components.js';
import { Icon } from '../../shared/ui/Icon.js';
import {
  buildActivityWeeks,
  businessDateAt,
  formatAnalysisRate,
  resolveAnalysisDateScope,
  twelveWeekWindow,
  weeklyActivityTotals,
  type AnalysisRangeMode,
  type BusinessDateRange,
} from './analysis-page-model.js';
import './AnalysisV2Page.css';

interface AnalysisV2PageProps {
  /** When supplied with onSeasonChange, the page follows the workspace season selector. */
  seasonId?: string | null;
  onSeasonChange?: (seasonId: string | null) => void;
  onAddApplication?: () => void;
  onExport?: () => void;
}

function Metric({ label, value, note, icon, accent = false }: { label: string; value: number; note: string; icon: 'file' | 'clock' | 'board' | 'leaf'; accent?: boolean }) {
  return <article className={`analysis-v2__metric${accent ? ' analysis-v2__metric--accent' : ''}`} aria-label={`${label}：${value}`}>
    <div className="analysis-v2__metric-heading"><span>{label}</span><Icon name={icon} size={18} /></div>
    <div className="analysis-v2__metric-value">{value}<span>个岗位</span></div>
    <p>{note}</p>
  </article>;
}

function activityDescription(date: string, count: number, disabled: boolean, today: string): string {
  if (date > today) return `${date}：未来日期，不计入热力图`;
  if (disabled) return `${date}：不在当前统计范围`;
  return `${date}：${count} 次投递`;
}

function activityLevel(count: number, maximum: number): number {
  if (count <= 0 || maximum <= 0) return 0;
  return Math.min(4, Math.ceil((count / maximum) * 4));
}

function ActivityCharts({ result, today }: { result: V2AnalyticsResult; today: string }) {
  const weeks = useMemo(() => buildActivityWeeks(result, today), [result, today]);
  // Follow the pointer and describe the day under it immediately (native titles lag).
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);
  const [trendHover, setTrendHover] = useState<{ text: string; x: number; y: number } | null>(null);
  const pointerTracker = (set: typeof setHover) => (event: React.PointerEvent<HTMLDivElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-label]');
    if (!cell) { set(null); return; }
    const box = event.currentTarget.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    // Keep the tip inside the chart near the left and right edges.
    const center = cellBox.left - box.left + cellBox.width / 2;
    set({ text: cell.dataset.label ?? '', x: Math.min(Math.max(center, 72), Math.max(72, box.width - 72)), y: cellBox.top - box.top });
  };
  const trackPointer = pointerTracker(setHover);
  // Week labels are shown every 1, 2 or 3 columns, depending on how much room each column gets.
  const trendRef = useRef<HTMLDivElement>(null);
  const [labelStep, setLabelStep] = useState(2);
  useEffect(() => {
    const element = trendRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const column = (entry?.contentRect.width ?? 0) / 12;
      setLabelStep(column >= 40 ? 1 : column >= 20 ? 2 : 3);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const totals = useMemo(() => weeklyActivityTotals(weeks), [weeks]);
  const maxDaily = Math.max(0, ...weeks.flat().filter(cell => !cell.disabled).map(cell => cell.count));
  const maxWeekly = Math.max(1, ...totals);

  return <ChartCard title="投递活跃度" subtitle="近 12 周的实际投递节奏；未来日期和筛选范围外日期不计入。" aside={<span className="analysis-v2__tag">按投递日期</span>} className="analysis-v2__activity-card">
    <div className="analysis-v2__activity-content">
      <div className="analysis-v2__activity-summary"><strong>{result.activeDayCount}</strong><span>个有投递的日期</span><span className="analysis-v2__summary-divider" aria-hidden="true" /><strong>{result.thisWeekCount}</strong><span>本周投递</span></div>
      <div className="analysis-v2__heatmap-wrap">
        <div className="analysis-v2__weekday-labels" aria-hidden="true"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
        <div className="analysis-v2__heatmap" role="grid" aria-label="近 12 周投递活跃度，按周一至周日排列" onPointerMove={trackPointer} onPointerLeave={() => setHover(null)}>
          {hover && <div className="analysis-v2__heat-tip" style={{ left: hover.x, top: hover.y }} role="tooltip">{hover.text}</div>}
          {weeks.map((week, index) => <div className="analysis-v2__heatmap-week" role="row" key={week[0]?.date ?? index} aria-label={`${week[0]?.date ?? ''} 所在周`}>
            {week.map(cell => <span
              className={`analysis-v2__day analysis-v2__day--level-${activityLevel(cell.count, maxDaily)}${cell.disabled ? ' analysis-v2__day--disabled' : ''}`}
              role="gridcell"
              aria-label={activityDescription(cell.date, cell.count, cell.disabled, today)}
              data-date={cell.date}
              data-label={activityDescription(cell.date, cell.count, cell.disabled, today)}
              key={cell.date}
            />)}
          </div>)}
        </div>
      </div>
      <div className="analysis-v2__heatmap-footer">
        <div className="analysis-v2__heatmap-range"><span>{weeks[0]?.[0]?.date ?? ''}</span><span aria-hidden="true">—</span><span>{today}</span></div>
        <div className="analysis-v2__legend" aria-label="每格代表一天，投递量由少到多"><span>每格一天</span><span>少</span>{[0, 1, 2, 3, 4].map(level => <i key={level} className={`analysis-v2__day analysis-v2__day--level-${level}`} />)}<span>多</span></div>
      </div>
      <div className="analysis-v2__weekly-trend" aria-label="近 12 周每周投递数">
        <div className="analysis-v2__trend-heading"><strong>每周投递</strong><span>按周汇总，同一日多条分别计数</span></div>
        <div className="analysis-v2__trend-bars" ref={trendRef} onPointerMove={pointerTracker(setTrendHover)} onPointerLeave={() => setTrendHover(null)}>
          {trendHover && <div className="analysis-v2__heat-tip" style={{ left: trendHover.x, top: trendHover.y }} role="tooltip">{trendHover.text}</div>}
          {weeks.map((week, index) => {
            const total = totals[index] ?? 0;
            const height = total === 0 ? 2 : Math.max(7, (total / maxWeekly) * 100);
            const label = week[0]?.date ?? '';
            const rangeEnd = week.at(-1)?.date ?? label;
            const short = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
            return <div className="analysis-v2__trend-column" key={label} data-label={`${short(label)} – ${short(rangeEnd)}：${total} 次投递`} aria-label={`${label} 至 ${rangeEnd}：${total} 次投递`}>
              <span className="analysis-v2__trend-value">{total || ''}</span>
              <div className="analysis-v2__trend-track"><i style={{ height: `${height}%` }} /></div>
              <span className="analysis-v2__trend-label" aria-hidden="true">{index % labelStep === 0 ? short(label) : ''}</span>
            </div>;
          })}
        </div>
      </div>
      {result.submittedCount === 0 && <p className="analysis-v2__chart-empty-note">所选范围内还没有已投递记录。记录投递日期后，这里会显示活跃节奏。</p>}
    </div>
  </ChartCard>;
}

function StageReach({ result }: { result: V2AnalyticsResult }) {
  const reached = result.stages.filter(stage => stage.touchCount > 0);
  const maxCount = Math.max(1, result.submittedCount, ...reached.map(stage => stage.touchCount));
  return <ChartCard title="累计阶段触达" subtitle="只展示至少有一条实际触达记录的环节。" aside={<span className="analysis-v2__tag">按岗位去重</span>} className="analysis-v2__stage-card">
    {reached.length ? <div className="analysis-v2__stage-list">
      {reached.map(stage => <div className="analysis-v2__stage-row" key={stage.stageId} title={`${stage.name}：${stage.touchCount} 个岗位${stage.visitCount !== stage.touchCount ? `，共 ${stage.visitCount} 次经历` : ''}`}>
        <div className="analysis-v2__stage-label" title={stage.name}>{stage.name}</div>
        <div className="analysis-v2__stage-track" role="meter" aria-label={`${stage.name}触达岗位`} aria-valuemin={0} aria-valuemax={maxCount} aria-valuenow={stage.touchCount}>
          <span style={{ width: `${Math.max(2, (stage.touchCount / maxCount) * 100)}%` }} />
        </div>
        <div className="analysis-v2__stage-value"><strong>{stage.touchCount}</strong><span>{formatAnalysisRate(stage.rate)}</span></div>
      </div>)}
      <p className="analysis-v2__chart-footnote">比例 = 触达岗位 ÷ 已投递岗位；若记录了尚无投递日期的后续经历，比例可能超过 100%。</p>
    </div> : <EmptyState compact icon="board" title="还没有实际阶段触达" description="记录一次真实状态后，对应环节会显示在这里；未经历的模板环节不会预先出现。" />}
  </ChartCard>;
}

const channelRateColumns = [
  { key: 'aiInterviewCount', label: 'AI 面' },
  { key: 'interviewCount', label: '人工面试' },
  { key: 'offerCount', label: 'Offer' },
] as const;

/** One row per channel; every cell is a count with the same caption line (share or conversion rate) underneath. */
function ChannelPerformance({ result }: { result: V2AnalyticsResult }) {
  const channels = result.channels.filter(channel => channel.submittedCount + channel.interviewCount + channel.aiInterviewCount + channel.offerCount > 0);
  const totalSubmitted = channels.reduce((sum, channel) => sum + channel.submittedCount, 0);
  const rate = (count: number, base: number) => base === 0 ? null : (count / base) * 100;
  return <ChartCard title="渠道表现" subtitle="按岗位去重；转化率 = 该渠道进入此环节的岗位 ÷ 该渠道已投递岗位。" className="analysis-v2__channel-card">
    {channels.length ? <div className="analysis-v2__channels">
      <table className="analysis-v2__channel-table">
        <thead><tr><th scope="col">渠道</th><th scope="col">投递</th>{channelRateColumns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
        <tbody>{channels.map(channel => {
          const share = rate(channel.submittedCount, totalSubmitted);
          return <tr key={channel.channelId}>
            <th scope="row" title={channel.name}>{channel.name}</th>
            <td title={`${channel.name}：${channel.submittedCount} 个已投递岗位，占全部投递 ${formatAnalysisRate(share)}`}>
              <strong>{channel.submittedCount}</strong>
              <span className="analysis-v2__channel-share"><i style={{ width: `${share ?? 0}%` }} /></span>
              <small>占 {formatAnalysisRate(share)}</small>
            </td>
            {channelRateColumns.map(column => {
              const count = channel[column.key];
              const conversion = rate(count, channel.submittedCount);
              return <td key={column.key} className={count === 0 ? 'is-zero' : undefined} title={`${channel.name}：${count} 个岗位进入${column.label}；转化率 ${formatAnalysisRate(conversion)}`}>
                <strong>{count}</strong>
                <small>{formatAnalysisRate(conversion)}</small>
              </td>;
            })}
          </tr>;
        })}</tbody>
      </table>
      <p className="analysis-v2__chart-footnote">草稿不计入渠道统计。</p>
    </div> : <EmptyState compact icon="chart" title="还没有渠道样本" description="已投递记录会按真实渠道归组；没有填写渠道的记录会单独列出。" />}
  </ChartCard>;
}

const cityPalette = ['#0f766e', '#2fa594', '#d4a24c', '#5b8db8', '#8fd3c5', '#c47a5a', '#7b8c86', '#b8a77a'];

function CityDistribution({ result }: { result: V2AnalyticsResult }) {
  const total = result.cities.reduce((sum, item) => sum + item.count, 0);
  const segments = result.cities.map((item, index) => ({ ...item, color: cityPalette[index % cityPalette.length] }));
  let angle = 0;
  const gradient = segments.map(segment => {
    const start = angle;
    angle += total === 0 ? 0 : (segment.count / total) * 360;
    return `${segment.color} ${start}deg ${angle}deg`;
  }).join(', ');
  const donutStyle: CSSProperties = { background: total > 0 ? `conic-gradient(${gradient})` : 'var(--color-border)' };
  return <ChartCard title="城市分布" subtitle="按已投递岗位统计；一个岗位有多个城市时分别计入每个城市，空城市归入“未填写”。" className="analysis-v2__city-card">
    {segments.length ? <div className="analysis-v2__city-content">
      <div className="analysis-v2__donut" role="img" aria-label={`城市分布，共 ${result.submittedCount} 个岗位：${segments.map(item => `${item.city} ${item.count}`).join('，')}`} style={donutStyle}>
        <div><strong>{result.submittedCount}</strong><span>个岗位</span></div>
      </div>
      <ul className="analysis-v2__city-list">
        {segments.map(city => <li key={city.city}><span className="analysis-v2__city-name"><i style={{ backgroundColor: city.color }} />{city.city}</span><strong>{city.count}</strong><small>{formatAnalysisRate((city.count / Math.max(1, result.submittedCount)) * 100)}</small></li>)}
      </ul>
    </div> : <EmptyState compact icon="target" title="还没有城市样本" description="已投递记录的城市会显示在这里；城市未填写时会归入“未填写”。" />}
  </ChartCard>;
}

function StatArea({ result, today, seasonName }: { result: V2AnalyticsResult; today: string; seasonName: string }) {
  return <>
    <div className="analysis-v2__scope-caption"><strong>数据洞察 · 共 {result.recordCount} 条记录，其中 {result.submittedCount} 条已投递</strong><span>{seasonName}</span></div>
    <div className="analysis-v2__metrics">
      <Metric label="累计投递" value={result.submittedCount} note="以有效投递事件和投递日期统计" icon="file" />
      <Metric label="流程进行中" value={result.activeCount} note="已投递且当前仍在招聘流程中" icon="clock" />
      <Metric label="推进至人工面试" value={result.humanInterviewCount} note={`实际人工面试触达率 ${formatAnalysisRate(result.interviewRate)}；AI 面单独统计`} icon="board" />
      <Metric label="累计获得 Offer" value={result.offerCount} note="包括之后已接受或已拒绝的 Offer" icon="leaf" accent />
    </div>
    <div className="analysis-v2__chart-grid">
      <StageReach result={result} />
      <ActivityCharts result={result} today={today} />
      <ChannelPerformance result={result} />
      <CityDistribution result={result} />
    </div>
  </>;
}

export function AnalysisV2Page({ seasonId, onSeasonChange, onAddApplication, onExport }: AnalysisV2PageProps) {
  const { snapshot } = useV2Data();
  const firstSeason = snapshot.seasons.find(season => season.id === snapshot.workspace.activeSeasonId)
    ?? snapshot.seasons.find(season => season.archivedAt === null)
    ?? snapshot.seasons[0]
    ?? null;
  const [localSeasonId, setLocalSeasonId] = useState<string | null>(seasonId ?? firstSeason?.id ?? null);
  const controlled = seasonId !== undefined && onSeasonChange !== undefined;
  const selectedSeasonId = controlled ? seasonId : (seasonId ?? localSeasonId ?? firstSeason?.id ?? null);
  const season = selectedSeasonId ? snapshot.seasons.find(item => item.id === selectedSeasonId) ?? null : null;
  const [rangeMode, setRangeMode] = useState<AnalysisRangeMode>('season');
  const [customRange, setCustomRange] = useState<BusinessDateRange>({ from: '', to: '' });
  const [nowInstant, setNowInstant] = useState(() => new Date().toISOString());

  useEffect(() => {
    const timer = window.setInterval(() => setNowInstant(new Date().toISOString()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const dateInfo = useMemo(() => {
    try { return { today: businessDateAt(nowInstant, snapshot.workspace.timeZone), error: null as string | null }; }
    catch (cause) { return { today: null, error: cause instanceof Error ? cause.message : '无法读取当前业务日期' }; }
  }, [nowInstant, snapshot.workspace.timeZone]);
  const today = dateInfo.today;

  useEffect(() => {
    if (!season || !today) return;
    const recent = resolveAnalysisDateScope('last30', season, today, { from: '', to: '' });
    setRangeMode('season');
    if (recent.valid && recent.range) setCustomRange(recent.range);
  }, [season?.id]);

  const scope = useMemo(() => {
    if (!season || !today) return null;
    return resolveAnalysisDateScope(rangeMode, season, today, customRange);
  }, [season, today, rangeMode, customRange]);

  const calculation = useMemo(() => {
    if (!season || !today || !scope?.valid) return { result: null, error: null as string | null };
    try {
      const result = calculateV2Analytics(snapshot, {
        seasonId: season.id,
        ...(scope.range ? { appliedDateRange: scope.range } : {}),
        heatmapWindow: twelveWeekWindow(today),
      }, { now: nowInstant, timeZone: snapshot.workspace.timeZone });
      return { result, error: null as string | null };
    } catch (cause) {
      return { result: null, error: cause instanceof Error ? cause.message : '统计数据暂时无法读取。' };
    }
  }, [snapshot, season, today, scope, nowInstant]);

  const latestDate = season && today ? (season.endDate < today ? season.endDate : today) : '';
  const customUnavailable = !season || !today || latestDate < season.startDate;
  const changeSeason = (nextId: string) => {
    const value = nextId || null;
    setLocalSeasonId(value);
    onSeasonChange?.(value);
  };
  const changeCustomDate = (field: keyof BusinessDateRange, value: string) => setCustomRange(current => ({ ...current, [field]: value }));

  return <>
    <PageHeader
      eyebrow="REFLECT & GROW"
      title="从数据里，找到方向。"
      description="回望投递节奏与真实流程进展，让下一步更有把握。"
      actions={<>
        <Button variant="secondary" onClick={onExport} disabled={!onExport} title={!onExport ? '备份导出将在页面接入后开放' : undefined}><Icon name="download" size={16} />导出备份</Button>
        <Button onClick={onAddApplication} disabled={!onAddApplication} title={!onAddApplication ? '新增投递将在页面接入后开放' : undefined}><Icon name="plus" size={16} />新增投递</Button>
      </>}
    />

    <section className="analysis-v2__filters" aria-label="分析范围">
      <label className="analysis-v2__control"><span>招聘季</span><select aria-label="选择招聘季" value={selectedSeasonId ?? ''} onChange={event => changeSeason(event.target.value)} disabled={snapshot.seasons.length === 0}>
        {!snapshot.seasons.length && <option value="">暂无招聘季</option>}
        {selectedSeasonId === null && snapshot.seasons.length > 0 && <option value="">选择招聘季</option>}
        {snapshot.seasons.filter(item => !controlled || item.archivedAt === null).map(item => <option key={item.id} value={item.id}>{item.name}{item.archivedAt ? '（已归档）' : ''}</option>)}
      </select></label>
      <label className="analysis-v2__control"><span>投递日期范围</span><select aria-label="选择投递日期范围" value={rangeMode} onChange={event => setRangeMode(event.target.value as AnalysisRangeMode)} disabled={!season}>
        <option value="season">整个招聘季</option><option value="last30">近 30 天</option><option value="custom">自定义</option>
      </select></label>
      {rangeMode === 'custom' && <div className="analysis-v2__custom-range" aria-label="自定义投递日期范围">
        <label><span>从</span><input aria-label="统计开始日期" type="date" min={season?.startDate} max={latestDate || undefined} value={customRange.from} disabled={customUnavailable} onChange={event => changeCustomDate('from', event.target.value)} /></label>
        <span aria-hidden="true">至</span>
        <label><span>到</span><input aria-label="统计结束日期" type="date" min={season?.startDate} max={latestDate || undefined} value={customRange.to} disabled={customUnavailable} onChange={event => changeCustomDate('to', event.target.value)} /></label>
      </div>}
      <p className="analysis-v2__filter-note">{rangeMode === 'season' && season ? `统计整个「${season.name}」，包含草稿记录。` : rangeMode === 'last30' ? '按最近 30 个自然日内的投递日期筛选；未投递草稿不计入。' : '自定义日期依据投递日期筛选；未投递草稿不计入。'}</p>
    </section>

    {snapshot.seasons.length === 0 ? <EmptyState icon="calendar" title="还没有招聘季" description="创建招聘季后，分析页会从同一份 v2 数据记录中计算指标。" />
      : !season ? <EmptyState icon="calendar" title="请选择招聘季" description="选择一个招聘季后查看对应的投递统计。" />
        : dateInfo.error ? <p className="analysis-v2__error" role="alert">{dateInfo.error}</p>
          : scope && !scope.valid ? <p className="analysis-v2__error" role="alert">{scope.reason}</p>
            : calculation.error ? <p className="analysis-v2__error" role="alert">统计失败：{calculation.error}</p>
              : calculation.result && today ? <StatArea result={calculation.result} today={today} seasonName={season.name} />
                : null}
  </>;
}
