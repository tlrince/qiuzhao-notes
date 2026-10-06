import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PlatformServices } from '../platform/index.js';
import { ConfirmDialog } from '../shared/ui/Dialog.js';

interface PlatformContextValue {
  platform: PlatformServices;
  registerDirty: (key: symbol, discard: () => void) => () => void;
  requestLeave: (action: () => Promise<void>) => Promise<void>;
  trackWrite: <T>(write: Promise<T>) => Promise<T>;
}
const Context = createContext<PlatformContextValue | null>(null);

export function PlatformProvider({ platform, children }: { platform: PlatformServices; children: ReactNode }) {
  const dirty = useRef(new Map<symbol, () => void>());
  const writes = useRef(new Set<Promise<unknown>>());
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null);
  const [error, setError] = useState('');
  const registerDirty = useCallback((key: symbol, discard: () => void) => {
    dirty.current.set(key, discard);
    return () => { dirty.current.delete(key); };
  }, []);
  const finish = useCallback(async (action: () => Promise<void>) => {
    try {
      // Later repositories register their in-flight writes here before window exit.
      while (writes.current.size) await Promise.all([...writes.current]);
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  const requestLeave = useCallback(async (action: () => Promise<void>) => {
    setError('');
    if (dirty.current.size) setPending(() => action);
    else await finish(action);
  }, [finish]);
  const trackWrite = useCallback(<T,>(write: Promise<T>) => {
    writes.current.add(write);
    void write.then(() => writes.current.delete(write), () => writes.current.delete(write));
    return write;
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current.size || writes.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  return <Context.Provider value={{ platform, registerDirty, requestLeave, trackWrite }}>
    {error && <div className="platform-error" role="alert">操作未完成：{error}<button type="button" onClick={() => setError('')}>关闭提示</button></div>}
    {children}
    <ConfirmDialog open={pending !== null} title="放弃未保存的内容？" description="当前预览内容尚未保存。继续操作会清除本次输入。" cancelLabel="继续编辑" confirmLabel="放弃并继续" onCancel={() => setPending(null)} onConfirm={() => {
      const action = pending;
      setPending(null);
      for (const discard of dirty.current.values()) discard();
      dirty.current.clear();
      if (action) void finish(action);
    }} />
  </Context.Provider>;
}

export function usePlatform() {
  const value = useContext(Context);
  if (!value) throw new Error('PlatformProvider is required');
  return value;
}

export function useUnsavedChanges(isDirty: boolean, discard: () => void) {
  const { registerDirty } = usePlatform();
  const key = useRef(Symbol('unsaved-form'));
  const latestDiscard = useRef(discard);
  latestDiscard.current = discard;
  useEffect(() => isDirty ? registerDirty(key.current, () => latestDiscard.current()) : undefined, [isDirty, registerDirty]);
}
