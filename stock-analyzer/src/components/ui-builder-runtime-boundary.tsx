import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  loadActiveUiBuilderLayout,
  type UiBuilderDeviceClass,
  type UiBuilderPageId,
} from '@/lib/ui-builder-full-layout';

type Props = {
  pageId: UiBuilderPageId;
  children: ReactNode;
  className?: string;
};

function useDeviceClass(): UiBuilderDeviceClass {
  const query = '(min-width: 1024px)';
  const [device, setDevice] = useState<UiBuilderDeviceClass>(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches ? 'desktop' : 'mobile',
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setDevice(media.matches ? 'desktop' : 'mobile');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return device;
}

export function UiBuilderRuntimeBoundary({ pageId, children, className }: Props) {
  const deviceClass = useDeviceClass();
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

  const loaded = useMemo(
    () => loadActiveUiBuilderLayout(pageId, deviceClass),
    [pageId, deviceClass, revision],
  );
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
