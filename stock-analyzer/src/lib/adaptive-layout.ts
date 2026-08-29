export type AdaptiveViewportClass =
  | 'compact'
  | 'phone'
  | 'medium'
  | 'tablet'
  | 'desktop';

export const ADAPTIVE_VIEWPORT_BREAKPOINTS = Object.freeze({
  compactMax: 359,
  phoneMax: 599,
  mediumMax: 899,
  tabletMax: 1199,
  desktopMin: 1200,
});

export function classifyAdaptiveViewport(width: number): AdaptiveViewportClass {
  const normalizedWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  if (normalizedWidth <= ADAPTIVE_VIEWPORT_BREAKPOINTS.compactMax) return 'compact';
  if (normalizedWidth <= ADAPTIVE_VIEWPORT_BREAKPOINTS.phoneMax) return 'phone';
  if (normalizedWidth <= ADAPTIVE_VIEWPORT_BREAKPOINTS.mediumMax) return 'medium';
  if (normalizedWidth <= ADAPTIVE_VIEWPORT_BREAKPOINTS.tabletMax) return 'tablet';
  return 'desktop';
}

export function isDesktopWorkspaceWidth(width: number): boolean {
  return classifyAdaptiveViewport(width) === 'desktop';
}

export function uiBuilderDeviceForWidth(width: number): 'mobile' | 'desktop' {
  // UI Builder snapshots intentionally keep the existing two-value schema.
  // Fold-open and tablet widths stay on the touch/mobile snapshot so they do
  // not jump into the dense desktop composition merely because they cross
  // the legacy 1024px breakpoint.
  return isDesktopWorkspaceWidth(width) ? 'desktop' : 'mobile';
}
