import type { CSSProperties } from 'react';
export type IconName = 'grid' | 'file' | 'board' | 'chart' | 'settings' | 'arrow' | 'plus' | 'chevron' | 'calendar' | 'check' | 'clock' | 'alert' | 'menu' | 'leaf' | 'target' | 'folder' | 'shield' | 'search' | 'download';
const paths: Record<IconName, string[]> = {
  grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  file: ['M14 3H5v18h14V8z', 'M14 3v5h5M8 12h8M8 16h5'],
  board: ['M3 4h18v16H3zM9 4v16M15 4v16', 'M5 8h2M11 8h2M17 8h2M5 12h2M11 12h2'],
  chart: ['M4 3v17h17M8 15v-4M13 15V7M18 15V4'],
  settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8', 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z'],
  arrow: ['M5 12h14M13 6l6 6-6 6'], plus: ['M12 5v14M5 12h14'], chevron: ['m8 10 4 4 4-4'],
  calendar: ['M4 5h16v16H4zM8 3v4M16 3v4M4 10h16M8 14h2M14 14h2M8 17h2'],
  check: ['m5 12 4 4L19 6'], clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2'],
  alert: ['m12 3 10 18H2zM12 9v5M12 17h.01'], menu: ['M4 6h16M4 12h16M4 18h16'],
  leaf: ['M5 19C0 7 10 4 20 3c-1 10-4 20-15 16ZM5 19 16 8'],
  target: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 11v2'],
  folder: ['M3 6h7l2 2h9v12H3zM3 6V4h7l2 2h9v2'],
  shield: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z', 'm8 12 3 3 5-6'],
  search: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6'],
  download: ['M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'],
};
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}>{paths[name].map((d, i) => <path d={d} key={i} />)}</svg>;
}
