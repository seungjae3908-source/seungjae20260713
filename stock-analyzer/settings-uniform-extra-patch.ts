import type { Plugin } from 'vite';

export function settingsUniformExtraPatch(): Plugin {
  return {
    name: 'settings-uniform-extra-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/pages/more.tsx')) {
        const code = source
          .replace(
            `className="w-full rounded-3xl border border-primary/40 bg-primary/10 px-5 py-4 text-center text-base font-black text-primary"`,
            `className="flex h-[64px] w-full items-center justify-center rounded-2xl border border-primary/40 bg-primary/10 px-4 py-2 text-center text-base font-black text-primary"`,
          )
          .replace(
            `className="flex min-h-screen flex-col bg-background"`,
            `className="h-full min-h-0 overflow-y-auto overscroll-contain bg-background"`,
          )
          .replace(
            `className="sticky top-0 z-20 border-b border-card-border bg-background/95 px-5 py-5 backdrop-blur"`,
            `className="border-b border-card-border bg-background px-5 py-5"`,
          )
          .replace(
            `className="flex-1 space-y-5 overflow-y-auto px-5 py-5 pb-28"`,
            `className="space-y-5 px-5 py-5 pb-28"`,
          );
        return code === source ? null : { code, map: null };
      }

      if (normalized.endsWith('/src/components/ai-repair-center.tsx')) {
        const code = source.replace(
          `<details className="group rounded-3xl border border-primary/30 bg-card p-4 text-center shadow-sm">`,
          `<details data-settings-uniform-card className="group rounded-2xl border border-primary/30 bg-card p-3 text-center shadow-sm">`,
        );
        return code === source ? null : { code, map: null };
      }

      return null;
    },
  };
}
