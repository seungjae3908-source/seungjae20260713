import { X } from 'lucide-react';
import type { AiSignal } from '@/lib/api';
import { cn } from '@/lib/utils';

// Static "what / why" explanation per signal. The live status, reasons, missing
// conditions and action come from the computed signal object.
const INFO: Record<string, { what: string; why: string }> = {
  accumulation: {
    what: '바닥권 매집은 큰 하락 후 저점권에서 세력·기관이 조용히 물량을 모으는 국면입니다.',
    why: '가격이 크게 오르기 전 단계라 매집이 확인되면 낮은 위험으로 선진입할 수 있습니다.',
  },
  breakout_imminent: {
    what: '돌파 임박은 박스권 상단(저항선)에 근접하며 거래량이 늘어 돌파가 가까운 상태입니다.',
    why: '돌파가 성공하면 짧은 시간에 큰 상승이 나올 수 있어 진입 타이밍이 중요합니다.',
  },
  trend_start: {
    what: '추세 시작은 정배열(MA20>MA60) 전환과 함께 상승추세가 막 시작되는 국면입니다.',
    why: '추세 초입에서 진입하면 추세의 몸통을 대부분 취할 수 있습니다.',
  },
  golden_cross: {
    what: '골든크로스는 단기 이동평균(MA20)이 중기(MA60)를 상향 돌파하는 강세 신호입니다.',
    why: '중기 추세 전환의 대표 신호로 거래량이 동반되면 신뢰도가 높습니다.',
  },
  dead_cross: {
    what: '데드크로스는 MA20이 MA60을 하향 돌파하는 약세 신호입니다.',
    why: '중기 하락 전환 가능성을 경고하므로 비중 관리가 필요합니다.',
  },
  overheated: {
    what: '과열은 RSI가 높고 가격이 이동평균에서 크게 벌어진 단기 급등 상태입니다.',
    why: '되돌림(조정) 위험이 커 신규 진입보다 익절 관점이 유리합니다.',
  },
  trend_break: {
    what: '추세 이탈은 지지선(MA60·박스권 하단)을 무너뜨린 상태입니다.',
    why: '추가 하락 위험이 크므로 손절 기준을 지키는 것이 중요합니다.',
  },
  inst_accumulation: {
    what: '기관 매집은 기관 투자자의 순매수가 이어지는 수급 신호입니다.',
    why: '기관 수급 데이터가 제공되지 않아 현재 정확한 판단이 어렵습니다.',
  },
  foreign_accumulation: {
    what: '외국인 매집은 외국인 투자자의 순매수가 이어지는 수급 신호입니다.',
    why: '외국인 수급 데이터가 제공되지 않아 현재 정확한 판단이 어렵습니다.',
  },
  volume_explosion: {
    what: '거래량 폭발은 평균 대비 거래량이 급증한 상태입니다.',
    why: '방향과 위치에 따라 추세 시작이거나 고점 신호일 수 있어 해석이 중요합니다.',
  },
  new_high: {
    what: '신고가는 기간 내 최고가를 경신한 강세 상태입니다.',
    why: '매물 저항이 적어 추가 상승 여력이 있으나 눌림목 진입이 안전합니다.',
  },
  new_low: {
    what: '신저가는 기간 내 최저가를 경신한 약세 상태입니다.',
    why: '하락추세가 이어질 수 있어 섣부른 저점 매수는 위험합니다.',
  },
  pullback: {
    what: '눌림목은 상승추세 중 이동평균 지지선까지 조정받는 국면입니다.',
    why: '추세 유지 시 좋은 재진입 기회가 되지만 지지 이탈은 손절 신호입니다.',
  },
  trend_reversal: {
    what: '추세 전환은 하락추세가 둔화되며 상승으로 방향을 바꾸는 초기 국면입니다.',
    why: '전환 초기에 진입하면 유리하나 확인 전에는 실패 위험도 존재합니다.',
  },
  undervalued: {
    what: '저평가는 PER·PBR 등 밸류에이션이 낮은 상태입니다.',
    why: '실적 개선이 동반되면 중장기 상승 여력이 있습니다.',
  },
  overvalued: {
    what: '고평가는 PER·PBR 등 밸류에이션이 높은 상태입니다.',
    why: '성장성 대비 과도하면 조정 위험이 커집니다.',
  },
  positive_disclosure: {
    what: '호재 공시는 공급계약·자사주·실적개선·배당 등 긍정적 공시입니다.',
    why: '펀더멘털 개선의 근거가 되어 주가에 긍정적으로 작용할 수 있습니다.',
  },
  negative_disclosure: {
    what: '악재 공시는 유상증자·CB/BW·관리종목 등 부정적 공시입니다.',
    why: '지분 희석·재무 악화 위험이 커 비중 축소가 필요할 수 있습니다.',
  },
};

const TONE_CLS = {
  positive: 'text-positive border-positive/30 bg-positive/10',
  negative: 'text-destructive border-destructive/30 bg-destructive/10',
  neutral: 'text-warning border-warning/30 bg-warning/10',
} as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

export function SignalModal({ signal, onClose }: { signal: AiSignal; onClose: () => void }) {
  const info = INFO[signal.key];
  const insufficient = signal.dataQuality === 'insufficient';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-card-border bg-card p-4 sm:rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ai/15 text-xs font-bold text-ai">
              AI
            </span>
            <div>
              <h3 className="break-keep text-base font-bold leading-relaxed">{signal.label}</h3>
              <div className="text-[11px] text-muted-foreground">AI 신호 설명</div>
            </div>
          </div>
          <button onClick={onClose} aria-label="닫기" className="rounded-lg p-1 hover:bg-secondary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <span className={cn('rounded-full border px-2.5 py-1 text-xs font-semibold', signal.active ? TONE_CLS[signal.tone] : 'border-border bg-secondary/50 text-muted-foreground')}>
            {signal.active ? '신호 발생' : '미발생'}
          </span>
          {!insufficient && (
            <>
              <span className="text-xs text-muted-foreground">점수 <b className="text-foreground">{signal.score}</b></span>
              <span className="text-xs text-muted-foreground">신뢰도 <b className="text-foreground">{signal.confidence}%</b></span>
            </>
          )}
          {insufficient && (
            <span className="text-xs font-medium text-warning">데이터 부족으로 신뢰도 낮음</span>
          )}
        </div>

        <div className="space-y-3">
          {info && (
            <>
              <Section title="무엇인가요?">
                <p className="break-keep text-sm leading-relaxed">{info.what}</p>
              </Section>
              <Section title="왜 중요한가요?">
                <p className="break-keep text-sm leading-relaxed text-muted-foreground">{info.why}</p>
              </Section>
            </>
          )}

          {signal.reasons.length > 0 && (
            <Section title="발생 근거">
              <ul className="space-y-1">
                {signal.reasons.map((r, i) => (
                  <li key={i} className="flex gap-1.5 break-keep text-sm leading-relaxed text-positive">
                    <span>✓</span>
                    <span className="text-foreground">{r}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {signal.missing.length > 0 && (
            <Section title="부족한 조건">
              <ul className="space-y-1">
                {signal.missing.map((r, i) => (
                  <li key={i} className="flex gap-1.5 break-keep text-sm leading-relaxed text-muted-foreground">
                    <span>·</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="대응법">
            <p className="break-keep rounded-lg border border-ai/25 bg-ai/5 p-2.5 text-sm leading-relaxed text-foreground">
              {signal.action}
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
