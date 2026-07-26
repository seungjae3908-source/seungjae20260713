import type { Plugin } from 'vite';

function patchChartRelay(source: string): string {
  let code = source;

  code = code.replace(
    `      <div className="flex min-h-[52px] flex-col items-stretch gap-2 border-b border-card-border px-2 py-2 sm:flex-row sm:items-center sm:justify-between">\n        <div className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] gap-1 sm:flex sm:w-auto sm:flex-wrap">`,
    `      <div className="flex min-h-[52px] items-center gap-1 overflow-x-auto border-b border-card-border px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">\n        <div className="flex shrink-0 items-center gap-1">`,
  );

  code = code.replace(
    `className="min-w-0 w-full rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black sm:w-auto"`,
    `className="w-[112px] shrink-0 rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black"`,
  );

  code = code.replace(
    `className="inline-flex min-w-0 items-center justify-center rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black text-primary"`,
    `className="inline-flex shrink-0 items-center justify-center rounded-lg border border-card-border bg-card px-2 py-1 text-[10px] font-black text-primary"`,
  );

  code = code.replace(
    `        </div>\n        <div className="flex w-full items-center justify-end gap-1.5 sm:w-auto">\n          <button\n            type="button"\n            onClick={onOpenSettings}`,
    `        </div>\n        <div className="flex shrink-0 items-center gap-1">\n          <button\n            type="button"\n            onClick={onOpenSettings}`,
  );

  code = code.replace(
    `className="flex h-9 w-9 items-center justify-center rounded-lg border border-card-border bg-card text-primary"`,
    `className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-card-border bg-card text-primary"`,
  );

  code = code.replace(
    `className="flex h-9 items-center gap-1 rounded-lg border border-card-border bg-card px-2 text-[10px] font-black"`,
    `className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-card-border bg-card px-2 text-[10px] font-black"`,
  );

  return code;
}

export function chartRelayMobileControlRowPatch(): Plugin {
  return {
    name: 'chart-relay-mobile-control-row-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/chart-relay.tsx')) return null;
      return { code: patchChartRelay(source), map: null };
    },
  };
}
