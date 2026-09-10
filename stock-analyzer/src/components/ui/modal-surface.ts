import type { CSSProperties } from 'react';

/**
 * Dialogs and bottom sheets must not inherit the app-wide translucent card alpha.
 * This keeps ordinary dashboard cards translucent while elevated overlays use the
 * same theme colors at full opacity so underlying content cannot bleed through.
 */
export const SOLID_MODAL_SURFACE_STYLE = {
  backgroundColor: 'hsl(var(--card))',
  borderColor: 'hsl(var(--card-border))',
  color: 'hsl(var(--card-foreground))',
} satisfies CSSProperties;
