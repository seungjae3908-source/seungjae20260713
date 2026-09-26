import type { ReactNode } from 'react';
import {
  scannerSurfacePlan,
  signalScannerLayoutHasUnsupportedRuntimeBlocks,
  validateUiBuilderSignalScannerLayout,
  type UiBuilderLayoutDocument,
  type ScannerRuntimeSurface,
} from '@/lib/ui-builder-layout';

type RuntimeSurface = Exclude<ScannerRuntimeSurface, null>;

type Props = {
  layout: UiBuilderLayoutDocument;
  scanner: ReactNode;
  chart?: ReactNode;
  position?: ReactNode;
  tradeReview?: ReactNode;
  fallback: ReactNode;
};

function surfaceNode(surface: RuntimeSurface, props: Props): ReactNode | undefined {
  if (surface === 'scanner') return props.scanner;
  if (surface === 'chart') return props.chart;
  if (surface === 'position') return props.position;
  return props.tradeReview;
}

export function UiBuilderSignalScannerLayout(props: Props) {
  const validation = validateUiBuilderSignalScannerLayout(props.layout, props.layout.deviceClass);
  const unsupported = signalScannerLayoutHasUnsupportedRuntimeBlocks(props.layout);
  if (!validation.valid || unsupported.length > 0) return <>{props.fallback}</>;

  const plan = scannerSurfacePlan(props.layout);
  if (!plan.length || plan.some((item) => surfaceNode(item.surface, props) == null)) return <>{props.fallback}</>;

  const mobile = props.layout.deviceClass === 'mobile';
  return (
    <div
      data-testid={`ui-builder-signal-scanner-${props.layout.deviceClass}`}
      data-layout-id={props.layout.layoutId}
      data-layout-version={props.layout.version}
      className={mobile
        ? 'h-full min-h-0 overflow-y-auto overscroll-contain bg-background pb-[max(5rem,env(safe-area-inset-bottom))]'
        : 'h-full min-h-0 overflow-hidden bg-background'}
    >
      <div className={mobile ? 'grid min-h-full grid-cols-12 gap-3' : 'grid h-full min-h-0 grid-cols-12 gap-3 p-3'}>
        {plan.map((item) => (
          <section
            key={item.surface}
            data-testid={`ui-builder-surface-${item.surface}`}
            data-builder-blocks={item.blockTypes.join(',')}
            className={mobile ? 'col-span-12 min-w-0' : 'min-h-0 min-w-0 overflow-hidden'}
            style={mobile ? undefined : { gridColumn: `span ${item.colSpan} / span ${item.colSpan}` }}
          >
            {surfaceNode(item.surface, props)}
          </section>
        ))}
      </div>
    </div>
  );
}
