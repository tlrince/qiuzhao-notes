import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import './dialog.css';

let scrollLocks = 0;
let previousOverflow = '';
const modalStack: HTMLDialogElement[] = [];

function lockBodyScroll() {
  if (scrollLocks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLocks += 1;
  return () => {
    scrollLocks -= 1;
    if (scrollLocks === 0) document.body.style.overflow = previousOverflow;
  };
}

function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialog.showModal();
    modalStack.push(dialog);
    const unlock = lockBodyScroll();
    return () => {
      modalStack.splice(modalStack.lastIndexOf(dialog), 1);
      dialog.close();
      unlock();
      // Nested dialogs can close in the same render. Restore only after all cleanups.
      queueMicrotask(() => {
        if (!previousFocus?.isConnected || previousFocus.closest('dialog:not([open])')) return;
        const topModal = modalStack.at(-1);
        if (topModal && !topModal.contains(previousFocus)) return;
        previousFocus.focus({ preventScroll: true });
      });
    };
  }, [open]);
  return ref;
}

function trapTab(event: KeyboardEvent<HTMLDialogElement>) {
  const dialog = event.currentTarget;
  if (event.key !== 'Tab' || modalStack.at(-1) !== dialog) return;
  const elements = [...dialog.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
  // WebKit's default Tab navigation can skip buttons depending on macOS settings.
  // Cycle explicitly so the dialog behaves consistently on both target platforms.
  event.preventDefault();
  if (!elements.length) return;
  const index = elements.indexOf(document.activeElement as HTMLElement);
  const next = index < 0 ? (event.shiftKey ? elements.length - 1 : 0)
    : (index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length;
  elements[next]?.focus();
}

function isBackdropClick(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom;
}

export interface DrawerProps {
  open: boolean;
  /** Requests closure; the owner can keep the drawer open for confirmation. */
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, description, children, footer }: DrawerProps) {
  const ref = useModal(open);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <dialog
      ref={ref}
      className="app-dialog app-drawer"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={trapTab}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onClick={(event) => { if (isBackdropClick(event)) onClose(); }}
    >
      <div className="app-drawer__layout">
        <header className="app-dialog__header">
          <div>
            <h2 id={titleId} className="app-dialog__title">{title}</h2>
            {description && <p id={descriptionId} className="app-dialog__description">{description}</p>}
          </div>
          <button type="button" className="app-dialog__close" aria-label="关闭抽屉" onClick={onClose}>×</button>
        </header>
        <div className="app-drawer__body">{children}</div>
        {footer && <footer className="app-dialog__footer">{footer}</footer>}
      </div>
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function ConfirmDialog({ open, onCancel, onConfirm, title, description, confirmLabel = '确认', cancelLabel = '取消' }: ConfirmDialogProps) {
  const ref = useModal(open);
  const titleId = useId();
  const descriptionId = useId();
  return (
    <dialog
      ref={ref}
      className="app-dialog app-confirm"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={trapTab}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onCancel(); }}
      onClick={(event) => { if (isBackdropClick(event)) onCancel(); }}
    >
      <div className="app-confirm__body">
        <h2 id={titleId} className="app-dialog__title">{title}</h2>
        <p id={descriptionId} className="app-dialog__description">{description}</p>
      </div>
      <footer className="app-dialog__footer">
        <button type="button" className="button button--secondary" autoFocus onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className="button button--primary" onClick={onConfirm}>{confirmLabel}</button>
      </footer>
    </dialog>
  );
}
