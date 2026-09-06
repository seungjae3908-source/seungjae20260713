import { useEffect, useState, type ComponentType } from 'react';

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * Lightweight AppShell owner. The actual desktop command bar is an optional
 * chunk so AI Chart and other cold routes do not compete with professional UI
 * decoration during first usable paint.
 */
export function ProfessionalCommandBar() {
  const [Content, setContent] = useState<ComponentType | null>(null);

  useEffect(() => {
    let cancelled = false;
    let idleId: number | null = null;
    let timerId: number | null = null;
    const media = window.matchMedia('(min-width: 1200px)');

    const clearScheduled = () => {
      const idleWindow = window as IdleWindow;
      if (idleId != null && idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(idleId);
      if (timerId != null) window.clearTimeout(timerId);
      idleId = null;
      timerId = null;
    };

    const schedule = () => {
      if (cancelled || Content || !media.matches) return;
      clearScheduled();
      const load = () => {
        if (cancelled || !media.matches) return;
        void import('@/components/professional-command-bar-content').then((module) => {
          if (!cancelled) setContent(() => module.ProfessionalCommandBarContent);
        });
      };
      const idleWindow = window as IdleWindow;
      if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(load, { timeout: 1500 });
      else timerId = window.setTimeout(load, 250);
    };

    const onChange = () => {
      if (media.matches) schedule();
      else clearScheduled();
    };

    schedule();
    media.addEventListener('change', onChange);
    return () => {
      cancelled = true;
      clearScheduled();
      media.removeEventListener('change', onChange);
    };
  }, [Content]);

  return Content ? <Content /> : null;
}
