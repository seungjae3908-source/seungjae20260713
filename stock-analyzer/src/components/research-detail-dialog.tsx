import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Native modal keeps keyboard focus and background scrolling inside the current view. */
export function ResearchDetailDialog({ title, children, onClose }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="m-auto max-h-[88dvh] w-[calc(100%_-_1.5rem)] max-w-3xl overflow-y-auto overscroll-contain rounded-2xl border border-border bg-[hsl(var(--background))] p-0 text-foreground shadow-2xl backdrop:bg-black/60"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-[hsl(var(--background))] p-3 sm:px-5">
        <h2 className="min-w-0 text-base font-bold">{title}</h2>
        <button autoFocus type="button" aria-label="닫기" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border"><X className="h-5 w-5" aria-hidden="true" /></button>
      </div>
      <div className="min-w-0 space-y-3 p-3 [overflow-wrap:anywhere] sm:p-5">{children}</div>
    </dialog>, document.body,
  );
}
