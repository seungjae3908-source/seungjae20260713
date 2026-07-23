import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AppModal({
  open,
  title,
  children,
  onClose,
  footer,
  className,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-4 pb-24 sm:items-center sm:pb-4"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'flex max-h-[78dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-card shadow-2xl',
          className,
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="grid grid-cols-[40px_1fr_40px] items-center border-b border-card-border px-3 py-3">
          <span aria-hidden="true" />
          <h2 className="break-keep text-center text-base font-black leading-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-secondary/70"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-left">{children}</div>
        <footer className="border-t border-card-border p-3">
          {footer ?? (
            <button
              type="button"
              onClick={onClose}
              className="flex w-full items-center justify-center rounded-2xl border border-card-border bg-secondary/70 px-4 py-3 text-sm font-black"
            >
              닫기
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
