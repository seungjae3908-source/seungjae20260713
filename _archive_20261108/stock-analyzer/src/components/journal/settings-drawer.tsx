import { X } from 'lucide-react';
import { JournalPeriodPresets, type PeriodPreset } from './period-presets';
import type { JournalMarket } from './market-select-modal';

type Props = {
  open: boolean;
  onClose: () => void;
  period: PeriodPreset | null;
  onPeriod: (p: PeriodPreset) => void;
  customStart: string;
  customEnd: string;
  onCustomRange: (s: string, e: string) => void;
  autoMarkets: JournalMarket[];
  manualMarkets: JournalMarket[];
  onOpenAuto: () => void;
  onOpenManual: () => void;
  onExport: () => void;
};

export function JournalSettingsDrawer(p: Props) {
  if (!p.open) return null;
  return (
    <div className="fixed inset-0 z-40" onClick={p.onClose}>
      <div
        className="absolute right-0 top-0 h-full w-96 overflow-y-auto bg-white p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">환경설정</h2>
          <button onClick={p.onClose}><X className="h-5 w-5" /></button>
        </div>

        <section className="mb-6">
          <h3 className="mb-2 text-sm font-medium text-gray-700">조회 기간</h3>
          <JournalPeriodPresets value={p.period} onChange={p.onPeriod} />
          <div className="mt-2 flex gap-2">
            <input
              type="date"
              value={p.customStart}
              onChange={e => p.onCustomRange(e.target.value, p.customEnd)}
              className="flex-1 rounded border px-2 py-1 text-sm"
            />
            <input
              type="date"
              value={p.customEnd}
              onChange={e => p.onCustomRange(p.customStart, e.target.value)}
              className="flex-1 rounded border px-2 py-1 text-sm"
            />
          </div>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 text-sm font-medium text-gray-700">거래 구분</h3>
          <button
            onClick={p.onOpenAuto}
            className="mb-2 w-full rounded border px-3 py-2 text-left text-sm"
          >
            자동매매 ({p.autoMarkets.length}개 시장)
          </button>
          <button
            onClick={p.onOpenManual}
            className="w-full rounded border px-3 py-2 text-left text-sm"
          >
            수동매매 ({p.manualMarkets.length}개 시장)
          </button>
        </section>

        <section>
          <button
            onClick={p.onExport}
            className="w-full rounded bg-green-600 px-3 py-2 text-sm text-white"
          >
            엑셀 다운로드
          </button>
        </section>
      </div>
    </div>
  );
}
