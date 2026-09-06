import { useEffect, useState, type ComponentType } from 'react';

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/**
 * Keep the professional desktop shell out of mobile/tablet and initial route
 * critical paths. In particular, AI Chart cold-route work must not compete with
 * the optional command palette chunk during first usable paint.
 */
export function ProfessionalCommandBarLoader() {
  const [CommandBar, setCommandBar] = useState<ComponentType | null>(null);

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

    const load = () => {
      if (cancelled || CommandBar || !media.matches) return;
      clearScheduled();
      const performImport = () => {
        if (cancelled || !media.matches) return;
        void import('@/components/professional-command-bar').then((module) => {
          if (!cancelled) setCommandBar(() => module.ProfessionalCommandBar);
        });
      };
      const idleWindow = window as IdleWindow;
      if (idleWindow.requestIdleCallback) {
        idleId = idleWindow.requestIdleCallback(performImport, { timeout: 1500 });
      } else {
        timerId = window.setTimeout(performImport, 250);
      }
    };

    const onChange = () => {
      if (media.matches) load();
      else clearScheduled();
    };

    load();
    media.addEventListener('change', onChange);
    return () => {
      cancelled = true;
      clearScheduled();
      media.removeEventListener('change', onChange);
    };
  }, [CommandBar]);

  return CommandBar ? <CommandBar /> : null;
}
