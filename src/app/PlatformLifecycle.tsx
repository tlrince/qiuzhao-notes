import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { usePlatform } from './PlatformContext.js';

export function PlatformLifecycle() {
  const { platform, requestLeave } = usePlatform();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState('');
  useEffect(() => {
    if (platform.kind !== 'macos') return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const keep = (cleanup: () => void) => disposed ? cleanup() : cleanups.push(cleanup);
    const fail = (cause: unknown) => { if (!disposed) setError(String(cause)); };
    void platform.subscribeSettingsNavigation(() => {
      void requestLeave(async () => { navigate('/settings'); });
    }).then(keep, fail);
    void platform.subscribeWindowAction(action => {
      void requestLeave(() => platform.finishWindowAction(action));
    }).then(keep, fail);
    return () => { disposed = true; cleanups.forEach(cleanup => cleanup()); };
  }, [platform, navigate, requestLeave]);
  useEffect(() => {
    if (platform.kind !== 'macos' || location.pathname === '/') return;
    void platform.saveLastRoute(`${location.pathname}${location.search}`).catch(cause => setError(String(cause)));
  }, [platform, location.pathname, location.search]);
  if (!error) return null;
  return <div className="platform-error" role="alert">应用偏好未保存或菜单连接失败：{error}<button type="button" onClick={() => setError('')}>关闭提示</button></div>;
}
