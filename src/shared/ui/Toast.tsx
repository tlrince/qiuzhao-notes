import { useCallback, useEffect, useRef, useState } from 'react';

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'error';
}

/** Short-lived confirmations such as “状态已更新为「一面」”. */
export function useToasts(duration = 2400) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const serial = useRef(0);
  const timers = useRef(new Set<number>());
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer); }, []);
  const show = useCallback((text: string, tone: ToastMessage['tone'] = 'success') => {
    const id = ++serial.current;
    setToasts(current => [...current.slice(-2), { id, text, tone }]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setToasts(current => current.filter(toast => toast.id !== id));
    }, tone === 'error' ? duration * 2 : duration);
    timers.current.add(timer);
  }, [duration]);
  return { toasts, show };
}

export function ToastRegion({ toasts }: { toasts: readonly ToastMessage[] }) {
  return <div className="toast-region" role="status" aria-live="polite">
    {toasts.map(toast => <div key={toast.id} className={`toast toast--${toast.tone}`}>{toast.text}</div>)}
  </div>;
}
