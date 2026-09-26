import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  loadActiveUiBuilderLayout,
  type UiBuilderDeviceClass,
  type UiBuilderPageId,
} from '@/lib/ui-builder-full-layout';
import { safeRuntimeLayoutOrFallback } from '@/lib/ui-builder-runtime-safety';
import { classifyAdaptiveViewport, uiBuilderDeviceForWidth } from '@/lib/adaptive-layout';

type Props = {
  pageId: UiBuilderPageId;
  children: ReactNode;
  className?: string;
};

function currentViewportWidth(): number {
  return typeof window === 'undefined' ? 1200 : window.innerWidth;
}

function useDeviceClass(): { deviceClass: UiBuilderDeviceClass; viewportClass: ReturnType<typeof classifyAdaptiveViewport> } {
  const read = () => {
    const width = currentViewportWidth();
    return {
      deviceClass: uiBuilderDeviceForWidth(width) as UiBuilderDeviceClass,
      viewportClass: classifyAdaptiveViewport(width),
    };
  };
  const [state, setState] = useState(read);

  useEffect(() => {
    const update = () => {
      const next = read();
      setState((previous) => (
        previous.deviceClass === next.deviceClass && previous.viewportClass === next.viewportClass
          ? previous
          : next
      ));
    };
    update();
    window.addEventListener('resize', update, { passive: true });
    window.addEventListener('orientationchange', update, { passive: true });
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return state;
}

export function UiBuilderRuntimeBoundary({ pageId, children, className }: Props) {
  const { deviceClass, viewportClass } = useDeviceClass();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((value) => value + 1);
    window.addEventListener('storage', update);
    window.addEventListener('stock-ui-builder-layout-updated', update as EventListener);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener('stock-ui-builder-layout-updated', update as EventListener);
    };
  }, []);

  const loaded = useMemo(() => {
    const base = loadActiveUiBuilderLayout(pageId, deviceClass);
    if (base.source === 'fallback') return base;
    return safeRuntimeLayoutOrFallback(base.layout, pageId, deviceClass);
  }, [pageId, deviceClass, revision]);

  const visibleBlocks = loaded.layout.blocks
    .filter((block) => !block.visibility.hidden && block.visibility.mode !== 'hidden')
    .filter((block) => block.visibility.mode === 'both' || block.visibility.mode === deviceClass)
    .sort((left, right) => left.layout.order - right.layout.order);

  return (
    <div
      className={className ?? 'h-full min-h-0'}
      data-testid={`ui-builder-runtime-${pageId.toLowerCase().replaceAll('_', '-')}`}
      data-builder-page-id={pageId}
      data-builder-device={deviceClass}
      data-adaptive-viewport={viewportClass}
      data-builder-layout-source={loaded.source}
      data-builder-layout-id={loaded.layout.layoutId}
      data-builder-layout-version={loaded.layout.version}
      data-builder-visible-blocks={visibleBlocks.map((block) => block.type).join(',')}
      data-builder-validation-issues={loaded.issues.map((issue) => issue.code).join(',')}
    >
      {children}
    </div>
  );
}
