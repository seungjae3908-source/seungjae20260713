import { useEffect, useRef, useState, type ComponentType } from 'react';

type CommandBarContentProps = {
  initialOpen?: boolean;
};

type IdleWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

const AI_CHART_COLD_CRITICAL_WINDOW_MS = 5_500;

function editableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

/**
 * Lightweight AppShell owner. The actual desktop command bar is an optional
 * chunk so AI Chart and other cold routes do not compete with professional UI
 * decoration during first usable paint.
 */
export function ProfessionalCommandBar() {
  const [Content, setContent] = useState<ComponentType<CommandBarContentProps> | null>(null);
  const openOnLoadRef = useRef(false);

  useEffect(() => {
    if (Content) return;

    let cancelled = false;
    let idleId: number | null = null;
    let timerId: number | null = null;
    let loadPromise: Promise<void> | null = null;
    const media = window.matchMedia('(min-width: 1200px)');
    const directAiChartColdDocument = window.location.pathname.endsWith('/ai-chart');

    const clearScheduled = () => {
      const idleWindow = window as IdleWindow;
      if (idleId != null && idleWindow.cancelIdleCallback) idleWindow.cancelIdleCallback(idleId);
      if (timerId != null) window.clearTimeout(timerId);
      idleId = null;
      timerId = null;
    };

    const load = (openOnLoad = false) => {
      if (cancelled || !media.matches) return;
      if (openOnLoad) openOnLoadRef.current = true;
      clearScheduled();
      if (loadPromise) return;
      loadPromise = import('@/components/professional-command-bar-content')
        .then((module) => {
          if (!cancelled) setContent(() => module.ProfessionalCommandBarContent);
        })
        .finally(() => {
          loadPromise = null;
        });
    };

    const scheduleIdle = () => {
      if (cancelled || Content || !media.matches) return;
      clearScheduled();
      const idleWindow = window as IdleWindow;
      if (idleWindow.requestIdleCallback) idleId = idleWindow.requestIdleCallback(() => load(), { timeout: 1_500 });
      else timerId = window.setTimeout(() => load(), 250);
    };

    const schedule = () => {
      if (cancelled || Content || !media.matches) return;
      clearScheduled();
      if (directAiChartColdDocument) {
        timerId = window.setTimeout(scheduleIdle, AI_CHART_COLD_CRITICAL_WINDOW_MS);
        return;
      }
      scheduleIdle();
    };

    const onChange = () => {
      if (media.matches) schedule();
      else clearScheduled();
    };

    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (editableTarget(event.target) || !media.matches) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        load(true);
      }
    };

    schedule();
    media.addEventListener('change', onChange);
    window.addEventListener('keydown', onShortcut);
    return () => {
      cancelled = true;
      clearScheduled();
      media.removeEventListener('change', onChange);
      window.removeEventListener('keydown', onShortcut);
    };
  }, [Content]);

  return Content ? <Content initialOpen={openOnLoadRef.current} /> : null;
}
