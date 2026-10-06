import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'error';
  action?: ToastAction;
}

/** Short-lived confirmations such as “状态已更新为「一面」”. */
export function useToasts(duration = 2400) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const serial = useRef(0);
  const timers = useRef(new Set<number>());
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);
  const dismiss = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);
  const show = useCallback((text: string, tone: ToastMessage['tone'] = 'success', action?: ToastAction) => {
    const id = ++serial.current;
    setToasts(current => [...current.slice(-2), { id, text, tone, ...(action ? { action } : {}) }]);
    // Leave enough time to reach an undo button.
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      dismiss(id);
    }, action ? Math.max(duration, 8000) : tone === 'error' ? duration * 2 : duration);
    timers.current.add(timer);
  }, [dismiss, duration]);
  return { toasts, show, dismiss };
}

export function ToastRegion({ toasts, onDismiss }: { toasts: readonly ToastMessage[]; onDismiss?: (id: number) => void }) {
  return <div className="toast-region" role="status" aria-live="polite">
    {toasts.map(toast => <div key={toast.id} className={`toast toast--${toast.tone}${toast.action ? ' toast--with-action' : ''}`}>
      {toast.text}
      {toast.action && <button type="button" className="toast__action" onClick={() => { onDismiss?.(toast.id); void toast.action!.run(); }}>{toast.action.label}</button>}
    </div>)}
  </div>;
}
