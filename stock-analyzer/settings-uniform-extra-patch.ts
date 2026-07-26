import type { Plugin } from 'vite';

export function settingsUniformExtraPatch(): Plugin {
  return {
    name: 'settings-uniform-extra-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];

      if (normalized.endsWith('/src/pages/more.tsx')) {
        const code = source.replace(
          `className="w-full rounded-3xl border border-primary/40 bg-primary/10 px-5 py-4 text-center text-base font-black text-primary"`,
          `className="flex h-[112px] w-full items-center justify-center rounded-3xl border border-primary/40 bg-primary/10 px-5 py-4 text-center text-base font-black text-primary"`,
        );
        return code === source ? null : { code, map: null };
      }

      if (normalized.endsWith('/src/components/ai-repair-center.tsx')) {
        const code = source.replace(
          `<details className="group rounded-3xl border border-primary/30 bg-card p-4 text-center shadow-sm">`,
          `<details data-settings-uniform-card className="group rounded-3xl border border-primary/30 bg-card p-4 text-center shadow-sm">`,
        );
        return code === source ? null : { code, map: null };
      }

      return null;
    },
  };
}
