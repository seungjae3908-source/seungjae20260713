import { useState } from 'react';
type Regime = 'up' | 'side' | 'down';
type Snapshot = { symbol: string; score: number; reasons: string[]; manual: boolean };
type Props = {
  candidates: Record<Regime, Snapshot | null>;
  statuses: Record<Regime, string>;
  onStart: (regime: Regime) => void;
  onClose: () => void;
};
const LABEL: Record<Regime, { emoji: string; text: string }> = {
  up:   { emoji: '🟢', text: '상승형' },
  side: { emoji: '🟡', text: '횡보형' },
  down: { emoji: '🔴', text: '하락형' },
};

export function GridBot3WayStartModal({ candidates, statuses, onStart, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="w-full sm:w-96 bg-background rounded-t-xl sm:rounded-lg p-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-bold mb-3">어느 봇을 시작할까요?</h3>
        <div className="space-y-2">
          {(['up','side','down'] as Regime[]).map(k => {
            const c = candidates[k];
            const running = statuses[k] === 'running';
            return (
              <button key={k} disabled={running || !c}
                onClick={() => { onStart(k); onClose(); }}
                className={`w-full text-left p-3 rounded border border-card-border disabled:opacity-40 ${!running && c ? 'hover:bg-accent/20' : ''}`}>
                <div className="flex justify-between items-center mb-1">
                  <span className="font-bold text-sm">{LABEL[k].emoji} {LABEL[k].text}</span>
                  <span className="text-xs">{running ? '● 작동중' : (c ? `🎯 ${c.score}점` : '—')}</span>
                </div>
                {c ? (
                  <>
                    <div className="text-xs font-mono">{c.symbol}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{c.reasons.join(' · ')}</div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground">추천 종목 없음 (자동입력 먼저)</div>
                )}
              </button>
            );
          })}
        </div>
        <button onClick={onClose} className="mt-3 w-full py-2 text-sm rounded bg-gray-700 text-white">취소</button>
      </div>
    </div>
  );
}
