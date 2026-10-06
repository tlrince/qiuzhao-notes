import { useCallback, useEffect, useState } from 'react';
import type { AvailableUpdate } from '../platform/contracts.js';
import { usePlatform } from './PlatformContext.js';

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'available'; update: AvailableUpdate }
  | { kind: 'installing'; update: AvailableUpdate }
  | { kind: 'error'; message: string; update: AvailableUpdate | null };

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Shared check/install flow for the startup notice and the Settings button. Mac only. */
export function useAppUpdate() {
  const { platform, requestLeave } = usePlatform();
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const supported = platform.kind === 'macos';

  const check = useCallback(async (quiet = false) => {
    if (!supported) return;
    if (!quiet) setState({ kind: 'checking' });
    try {
      const update = await platform.checkForUpdate();
      setState(update ? { kind: 'available', update } : quiet ? { kind: 'idle' } : { kind: 'latest' });
    } catch (cause) {
      // A failed background check (offline, no release yet) should not nag.
      setState(quiet ? { kind: 'idle' } : { kind: 'error', message: errorText(cause), update: null });
    }
  }, [platform, supported]);

  const install = useCallback((update: AvailableUpdate) => {
    void requestLeave(async () => {
      setState({ kind: 'installing', update });
      try { await platform.installUpdate(); }
      catch (cause) { setState({ kind: 'error', message: errorText(cause), update }); }
    });
  }, [platform, requestLeave]);

  return { supported, state, check, install, dismiss: () => setState({ kind: 'idle' }) };
}

/** Checks quietly a few seconds after launch and offers 「更新并重启」 when a newer release exists. */
export function UpdateNotice() {
  const { supported, state, check, install, dismiss } = useAppUpdate();
  useEffect(() => {
    if (!supported) return;
    const timer = window.setTimeout(() => void check(true), 4000);
    return () => window.clearTimeout(timer);
  }, [supported, check]);

  if (state.kind !== 'available' && state.kind !== 'installing' && !(state.kind === 'error' && state.update)) return null;
  const update = state.kind === 'error' ? state.update! : state.update;
  return <aside className="update-notice" role="status" aria-label="新版本">
    <strong>发现新版本 {update.version}</strong>
    {update.notes ? <p className="update-notice__notes">{update.notes}</p> : null}
    {state.kind === 'error' ? <p className="update-notice__error" role="alert">{state.message}</p> : null}
    <p className="update-notice__hint">更新只替换应用本身，你的数据不受影响。</p>
    <div className="update-notice__actions">
      <button type="button" className="update-notice__later" onClick={dismiss} disabled={state.kind === 'installing'}>稍后</button>
      <button type="button" className="update-notice__go" onClick={() => install(update)} disabled={state.kind === 'installing'}>{state.kind === 'installing' ? '正在下载并安装…' : state.kind === 'error' ? '重试' : '更新并重启'}</button>
    </div>
  </aside>;
}
