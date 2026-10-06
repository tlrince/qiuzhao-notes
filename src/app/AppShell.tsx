import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import type { Season, Workspace } from '../domain/types.js';
import { Drawer } from '../shared/ui/Dialog.js';
import { Icon, type IconName } from '../shared/ui/Icon.js';
import { SaveIndicator, type SaveStatus } from '../shared/ui/components.js';
import { usePlatform } from './PlatformContext.js';
export const navigation: { path: string; label: string; icon: IconName }[] = [
  { path: '/overview', label: '数据总览', icon: 'grid' },
  { path: '/applications', label: '投递管理', icon: 'file' },
  { path: '/board', label: '进度看板', icon: 'board' },
  { path: '/analytics', label: '深度分析', icon: 'chart' },
  { path: '/settings', label: '数据与设置', icon: 'settings' },
];
export interface AppShellProps {
  workspace: Workspace; seasons: Season[]; submittedCount: number; saveStatus: SaveStatus;
  onSeasonChange: (id: string) => void; children: ReactNode;
}
export function AppShell({ workspace, seasons, submittedCount, saveStatus, onSeasonChange, children }: AppShellProps) {
  const { platform } = usePlatform();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const previousPath = useRef(location.pathname);
  const season = seasons.find(s => s.id === workspace.activeSeasonId);
  const pageName = navigation.find(n => location.pathname === n.path)?.label ?? (location.pathname === '/design-system' ? '组件预览' : location.pathname.startsWith('/settings/definitions') ? '状态与环节' : '页面未找到');
  useEffect(() => {
    document.title = `${pageName} · 秋招手记`;
    if (previousPath.current !== location.pathname) {
      previousPath.current = location.pathname;
      // Let the mobile dialog close and restore its trigger before announcing the new page.
      const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('h1')?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [location.pathname, pageName]);
  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const close = () => { if (media.matches) setMobileOpen(false); };
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);
  const nav = (mobile = false) => <>
    <div className="brand"><span className="brand-symbol"><Icon name="leaf" size={25} /></span><div className="brand-name">秋招手记<span>AUTUMN NOTES</span></div></div>
    <div className="season-picker"><label htmlFor={mobile ? 'season-mobile' : 'season-desktop'}>我的工作空间</label><div className="season-select"><Icon name="folder" size={16} /><select id={mobile ? 'season-mobile' : 'season-desktop'} aria-label="当前招聘季" value={workspace.activeSeasonId ?? ''} disabled={!seasons.length} onChange={event => onSeasonChange(event.target.value)}>{!seasons.length && <option value="">尚未创建招聘季</option>}{seasons.length > 0 && !workspace.activeSeasonId && <option value="" disabled>选择招聘季</option>}{seasons.map(s => <option key={s.id} value={s.id}>{s.name}{s.archivedAt ? ' · 已归档' : ''}</option>)}</select></div></div>
    <nav aria-label="主导航" className="navigation">{navigation.map((item, i) => <NavLink key={item.path} to={item.path} title={item.label} className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}${i === 4 ? ' nav-link--settings' : ''}`} onClick={() => setMobileOpen(false)}><Icon name={item.icon} /><span>{item.label}</span></NavLink>)}</nav>
    <div className="sidebar-bottom"><div className="goal-card"><div className="goal-heading"><span>本季投递目标</span><Icon name="target" size={15} /></div>{season ? <><div className="goal-number">{submittedCount}<span>/ {season.targetCount} 份</span></div><progress max={season.targetCount} value={Math.min(submittedCount, season.targetCount)} aria-label="本季投递目标进度" /><p>按自己的节奏，一步一步来。</p></> : <><div className="goal-unset">一个新的开始</div><p>创建招聘季后，设定你的目标。</p><Link to="/settings" onClick={() => setMobileOpen(false)}>了解工作空间 <Icon name="arrow" size={14} /></Link></>}</div><div className="workspace-caption"><span className="workspace-dot" />{workspace.name}<span className="workspace-local">LOCAL WORKSPACE</span></div></div>
  </>;
  return <div className="app-shell"><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳转到主要内容</a><aside className="sidebar">{nav()}</aside><div className="app-body"><header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="打开导航" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><Icon name="menu" /></button><span className="breadcrumb-home">工作空间</span><span className="breadcrumb-slash">/</span><span>{pageName}</span></div><SaveIndicator status={saveStatus} storageLabel={platform.storageLabel} /></header><main id="main-content" className="page-content" tabIndex={-1}>{children}</main><footer className="app-footer"><span>记录每一次尝试，也看见每一点成长。</span><Link to="/design-system">组件预览 <Icon name="arrow" size={13} /></Link></footer></div><Drawer open={mobileOpen} onClose={() => setMobileOpen(false)} title="工作空间导航"><div className="mobile-navigation">{nav(true)}</div></Drawer></div>;
}
