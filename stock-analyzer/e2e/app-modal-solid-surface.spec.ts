import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('ordinary cards stay translucent while modal surfaces are fully opaque', () => {
  const settings = source('src/lib/settings.tsx');
  const surface = source('src/components/ui/modal-surface.ts');

  expect(settings).toContain("root.style.setProperty('--card-alpha', '0.72')");
  expect(surface).toContain("backgroundColor: 'hsl(var(--card))'");
  expect(surface).toContain("borderColor: 'hsl(var(--card-border))'");
  expect(surface).toContain("color: 'hsl(var(--card-foreground))'");
});

test('signal explanation modal uses a stronger backdrop and the solid elevated surface', () => {
  const modal = source('src/components/signal-modal.tsx');

  expect(modal).toContain("import { SOLID_MODAL_SURFACE_STYLE } from '@/components/ui/modal-surface'");
  expect(modal).toContain('bg-black/70 backdrop-blur-sm');
  expect(modal).toContain('style={SOLID_MODAL_SURFACE_STYLE}');
  expect(modal).not.toContain('border border-card-border bg-card p-4');
  expect(modal).toContain('max-h-[85vh]');
  expect(modal).toContain('overflow-y-auto');
});

test('trade approval dialog gets the same solid surface without weakening safety controls', () => {
  const dialog = source('src/components/trade-approval-confirmation-dialog.tsx');

  expect(dialog).toContain("import { SOLID_MODAL_SURFACE_STYLE } from '@/components/ui/modal-surface'");
  expect(dialog).toContain('style={SOLID_MODAL_SURFACE_STYLE}');
  expect(dialog).not.toContain('border-card-border bg-card shadow-2xl');
  expect(dialog).toContain('aria-modal="true"');
  expect(dialog).toContain('onKeyDown={onKeyDown}');
  expect(dialog).toContain("document.body.style.overflow = 'hidden'");
  expect(dialog).toContain('window.setInterval(onRevalidate, 5_000)');
  expect(dialog).toContain("if (event.key === 'Escape' && !submitting)");
  expect(dialog).toContain("const liveBlocked = item.accountMode === 'live'");
  expect(dialog).toContain('disabled={!enabled}');
});
