import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MenuAction } from '../platform/contracts.js';
import { usePlatform } from './PlatformContext.js';
import { useBackupExport } from './useBackupExport.js';
import { CreateApplicationDrawer } from '../features/applications/ApplicationDrawers.js';
import { ToastRegion, useToasts } from '../shared/ui/Toast.js';

/** Focuses the current page's search box; returns false when the page has none. */
function focusPageSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>('main input[type="search"]');
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

/** Handles the Mac menu (⌘N 新增投递, 导出/恢复备份, ⌘F 查找). On the web nothing subscribes. */
export function MenuActions({ seasonId }: { seasonId: string | null }) {
  const { platform, requestLeave } = usePlatform();
  const navigate = useNavigate();
  const { exportBackup } = useBackupExport();
  const { toasts, show, dismiss } = useToasts(3200);
  const notice = useCallback((message: string, tone: 'success' | 'error' = 'success') => show(message, tone), [show]);
  const [creating, setCreating] = useState(false);
  const handlerRef = useRef<(action: MenuAction) => void>(() => {});

  handlerRef.current = action => {
    if (action === 'new') {
      if (!seasonId) { notice('请先在设置里创建或恢复一个招聘季。', 'error'); return; }
      setCreating(true);
    } else if (action === 'backup') {
      void exportBackup().then(message => notice(message), cause => notice(cause instanceof Error ? cause.message : '备份导出失败。', 'error'));
    } else if (action === 'restore') {
      void requestLeave(async () => { navigate('/settings?action=restore'); });
    } else if (!focusPageSearch()) {
      void requestLeave(async () => { navigate('/board?find=1'); });
    }
  };

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void platform.subscribeMenuAction(action => handlerRef.current(action)).then(off => { if (disposed) off(); else cleanup = off; });
    return () => { disposed = true; cleanup?.(); };
  }, [platform]);

  return <>
    {creating ? <CreateApplicationDrawer open seasonId={seasonId} onClose={() => setCreating(false)} notice={notice} /> : null}
    <ToastRegion toasts={toasts} onDismiss={dismiss} />
  </>;
}
