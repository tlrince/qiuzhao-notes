import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Stage } from '../../domain/types.js';
import { Icon, type IconName } from './Icon.js';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }>(function Button({ variant = 'primary', className = '', type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={`button button--${variant} ${className}`} {...props} />;
});
export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div><div className="eyebrow"><span />{eyebrow}</div><h1 tabIndex={-1}>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}
export function MetricCard({ label, value, note, icon, accent = false }: { label: string; value: string | number; note: string; icon: IconName; accent?: boolean }) {
  return <article className={`metric-card${accent ? ' metric-card--accent' : ''}`} aria-label={label}><div className="metric-top"><span>{label}</span><Icon name={icon} size={18} /></div><div className="metric-value">{value}<span>份</span></div><div className="metric-note">{note}</div></article>;
}
export function ChartCard({ title, subtitle, aside, children, className = '' }: { title: string; subtitle: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`chart-card ${className}`}><header className="chart-header"><div><h2>{title}</h2><p>{subtitle}</p></div>{aside}</header>{children}</section>;
}
export function FilterBar({ children, label = '筛选条件' }: { children: ReactNode; label?: string }) {
  return <div className="filter-bar" role="group" aria-label={label}>{children}</div>;
}
const stageLabels: Record<Stage, string> = { draft: '待投递', submitted: '已投递', assessment: '笔试', interview_1: '一面', interview_2: '二面', interview_3_plus: '三面及以上' };
export function StageBadge({ stage }: { stage: Stage }) { return <span className={`stage-badge stage-badge--${stage}`}><span aria-hidden="true" />{stageLabels[stage]}</span>; }
export function EmptyState({ title, description, icon = 'folder', action, compact = false }: { title: string; description: string; icon?: IconName; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state${compact ? ' empty-state--compact' : ''}`}><div className="empty-icon"><Icon name={icon} size={compact ? 22 : 28} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
const statuses: Record<SaveStatus, { label: string; icon: IconName }> = { idle: { label: '尚未保存', icon: 'shield' }, saving: { label: '保存中', icon: 'clock' }, saved: { label: '已保存到本机', icon: 'check' }, error: { label: '保存失败', icon: 'alert' } };
export function SaveIndicator({ status, onRetry, onDismiss, detail, storageLabel = '此浏览器' }: { status: SaveStatus; onRetry?: () => void; onDismiss?: () => void; detail?: string | null; storageLabel?: string }) {
  return <div className={`save-indicator save-indicator--${status}`} role="status" aria-live="polite" title={status === 'error' && detail ? detail : undefined}><Icon name={statuses[status].icon} size={15} /><span>{status === 'saved' ? `已保存到${storageLabel}` : statuses[status].label}</span>{status === 'error' && onRetry && <button onClick={onRetry} type="button">重试</button>}{status === 'error' && onDismiss && <button onClick={onDismiss} type="button">知道了</button>}</div>;
}
