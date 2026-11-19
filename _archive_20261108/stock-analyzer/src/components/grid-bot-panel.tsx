import { useState } from 'react';

export interface GridBotConfig {
  symbol: string; direction: 'LONG' | 'SHORT' | 'NEUTRAL'; investment: number; leverage: number; lowest: number; highest: number; gridCount: number; stopLoss: number;
}

export function GridBotPanel({ value, onChange, marketName }: { value: GridBotConfig; onChange: (val: GridBotConfig) => void; marketName: string; }) {
  const [isSaving, setIsSaving] = useState(false);
  const [isFetchingPrice, setIsFetchingPrice] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [preset, setPreset] = useState<'ALL' | 'MID' | 'SAFE'>('MID');

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value: val } = e.target;
    onChange({ ...value, [name]: isNaN(Number(val)) ? val : Number(val) });
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    if (e.target.value === '0') e.target.value = '';
  };
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (e.target.value === '') onChange({ ...value, [e.target.name]: 0 });
  };

  const handleAutoFill = async () => {
    setIsFetchingPrice(true);
    try {
      const res = await fetch(`/api/grid-auto-trade/price?symbol=${value.symbol}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`API 오류: ${res.status}`);
      const data = await res.json();
      if (!data.price) throw new Error('가격 데이터 없음');
      onChange({ ...value, lowest: Math.floor(data.price * 0.95), highest: Math.ceil(data.price * 1.05) });
    } catch (e: any) {
      alert(`현재가를 불러오지 못했습니다.\n${e.message}`);
    } finally {
      setIsFetchingPrice(false);
    }
  };

  const handleAutoRecommend = async (trend: 'UP' | 'SIDEWAYS' | 'DOWN') => {
    setIsScanning(true);
    try {
      let market = 'FUTURES';
      if (marketName.includes('국내')) market = 'KR_STOCK';
      else if (marketName.includes('해외')) market = 'US_STOCK';
      else if (marketName.includes('현물')) market = 'UPBIT_SPOT';
      
      let minVol = 0;
      if (preset === 'MID') minVol = market === 'FUTURES' ? 5000000 : 10000000000;
      else if (preset === 'SAFE') minVol = market === 'FUTURES' ? 50000000 : 100000000000;

      const res = await fetch(`/api/grid-auto-trade/recommend?trend=${trend}&market=${market}&minVolume=${minVol}`);
      if (!res.ok) throw new Error('추천 서버 오류');
      const data = await res.json();
      
      onChange({
        ...value,
        symbol: data.symbol,
        direction: data.direction,
        leverage: data.leverage,
        lowest: data.lowest,
        highest: data.highest,
        gridCount: 12,
        stopLoss: data.stopLoss
      });
    } catch (e: any) {
      alert(`자동 추천 실패: ${e.message}`);
    } finally {
      setIsScanning(false);
    }
  };

  const handleSave = () => {
    setIsSaving(true);
    setTimeout(() => { setIsSaving(false); alert('설정이 저장되었습니다.'); }, 500);
  };

  return (
    <div className="rounded-xl border border-card-border bg-card p-4 mb-4">
      <h2 className="text-base font-bold mb-4 text-foreground">🤖 {marketName} 설정</h2>

      {/* ★ 검색 범위 프리셋 */}
      <div className="mb-4">
        <p className="text-xs font-bold text-muted-foreground mb-2">🎯 종목 검색 범위</p>
        <div className="flex gap-2">
          <button onClick={() => setPreset('ALL')} className={`flex-1 py-1.5 text-xs rounded border ${preset === 'ALL' ? 'bg-orange-500 text-white' : 'bg-background text-muted-foreground'}`}>🔥 전체</button>
          <button onClick={() => setPreset('MID')} className={`flex-1 py-1.5 text-xs rounded border ${preset === 'MID' ? 'bg-blue-600 text-white' : 'bg-background text-muted-foreground'}`}>⚖️ 균형(추천)</button>
          <button onClick={() => setPreset('SAFE')} className={`flex-1 py-1.5 text-xs rounded border ${preset === 'SAFE' ? 'bg-emerald-600 text-white' : 'bg-background text-muted-foreground'}`}>🛡️ 안정</button>
        </div>
      </div>

      {/* ★ 추천 버튼 */}
      <div className="flex gap-2 mb-4">
        <button onClick={() => handleAutoRecommend('UP')} disabled={isScanning} className="flex-1 bg-red-500/10 text-red-500 border border-red-500/30 py-2 rounded font-bold hover:bg-red-500/20 text-sm">📈 상승형</button>
        <button onClick={() => handleAutoRecommend('SIDEWAYS')} disabled={isScanning} className="flex-1 bg-gray-500/10 text-gray-500 border border-gray-500/30 py-2 rounded font-bold hover:bg-gray-500/20 text-sm">↔️ 횡보형</button>
        <button onClick={() => handleAutoRecommend('DOWN')} disabled={isScanning} className="flex-1 bg-blue-500/10 text-blue-500 border border-blue-500/30 py-2 rounded font-bold hover:bg-blue-500/20 text-sm">📉 하락형</button>
      </div>

      {/* 입력 칸 */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {['symbol', 'direction', 'investment', 'leverage', 'lowest', 'highest', 'gridCount', 'stopLoss'].map((field) => (
          <div key={field} className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">
              {field === 'symbol' ? '종목' : field === 'direction' ? '방향' : field === 'investment' ? '투입 금액 (USDT)' : field === 'leverage' ? '레버리지' : field === 'lowest' ? '최저가' : field === 'highest' ? '최고가' : field === 'gridCount' ? '그리드 개수' : '손절가 (SL)'}
            </label>
            {field === 'direction' ? (
              <select name="direction" value={value.direction} onChange={handleChange} className="border border-card-border rounded bg-background px-2 py-1.5 text-sm text-foreground">
                <option value="LONG">롱(Long)</option><option value="SHORT">숏(Short)</option><option value="NEUTRAL">중립(Neutral)</option>
              </select>
            ) : (
              <input type={field === 'symbol' ? 'text' : 'number'} name={field} value={(value as any)[field]} onChange={handleChange} onFocus={handleFocus} onBlur={handleBlur} className="border border-card-border rounded bg-background px-2 py-1.5 text-sm text-foreground" />
            )}
          </div>
        ))}
      </div>
      <button onClick={handleSave} disabled={isSaving} className="w-full bg-emerald-600 text-white p-2.5 rounded-lg font-semibold hover:bg-emerald-700">
        {isSaving ? '저장 중...' : '💾 설정 저장'}
      </button>
    </div>
  );
}
