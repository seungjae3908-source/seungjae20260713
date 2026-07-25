import type { Plugin } from 'vite';

function replaceOnce(
  source: string,
  search: string,
  replacement: string,
  label: string,
): string {
  if (source.includes(replacement)) return source;
  if (!source.includes(search)) {
    throw new Error(`[signal-scan-plan-patch] ${label} 위치를 찾지 못했습니다.`);
  }
  return source.replace(search, replacement);
}

function patchSignalScan(source: string): string {
  let code = source;

  code = replaceOnce(
    code,
    `  support: number | null;\n  resistance: number | null;`,
    `  support: number | null;\n  resistance: number | null;\n  target: number | null;\n  stop: number | null;`,
    'candidate target stop type',
  );

  code = replaceOnce(
    code,
    `    support: toNum(raw.support),\n    resistance: toNum(raw.resistance),`,
    `    support: toNum(raw.support),\n    resistance: toNum(raw.resistance),\n    target: toNum(raw.target ?? raw.targetPrice ?? raw.aiTarget ?? raw.resistance),\n    stop: toNum(raw.stop ?? raw.stopPrice ?? raw.aiStop ?? raw.support),`,
    'candidate target stop normalization',
  );

  code = replaceOnce(
    code,
    `                      {candidate.verdict && (\n                        <p className="mt-0.5 line-clamp-1 text-[10px] font-bold text-muted-foreground">\n                          {candidate.verdict}\n                        </p>\n                      )}`,
    `                      {candidate.verdict && (\n                        <p className="mt-0.5 line-clamp-1 text-[10px] font-bold text-muted-foreground">\n                          {candidate.verdict}\n                        </p>\n                      )}\n\n                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] font-black">\n                        <span className="text-orange-500">\n                          목표 {candidate.target != null\n                            ? formatAppPrice(candidate.target, candidate.currency)\n                            : '데이터 없음'}\n                        </span>\n                        <span className="text-cyan-500">\n                          손절 {candidate.stop != null\n                            ? formatAppPrice(candidate.stop, candidate.currency)\n                            : '데이터 없음'}\n                        </span>\n                      </div>`,
    'candidate card target stop',
  );

  code = replaceOnce(
    code,
    `          <DetailField\n            label="저항선"\n            value={\n              candidate.resistance != null\n                ? formatAppPrice(\n                    candidate.resistance,\n                    candidate.currency,\n                  )\n                : '데이터 없음'\n            }\n          />`,
    `          <DetailField\n            label="저항선"\n            value={\n              candidate.resistance != null\n                ? formatAppPrice(\n                    candidate.resistance,\n                    candidate.currency,\n                  )\n                : '데이터 없음'\n            }\n          />\n\n          <DetailField\n            label="차트 목표가"\n            value={\n              candidate.target != null\n                ? formatAppPrice(candidate.target, candidate.currency)\n                : '데이터 없음'\n            }\n          />\n\n          <DetailField\n            label="차트 손절가"\n            value={\n              candidate.stop != null\n                ? formatAppPrice(candidate.stop, candidate.currency)\n                : '데이터 없음'\n            }\n          />`,
    'candidate modal target stop',
  );

  code = code.replace(
    'className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-3 sm:items-center"',
    'className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-3"',
  );

  return code;
}

export function signalScanPlanPatch(): Plugin {
  return {
    name: 'signal-scan-plan-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/signal-scan.tsx')) return null;
      return {
        code: patchSignalScan(source),
        map: null,
      };
    },
  };
}
