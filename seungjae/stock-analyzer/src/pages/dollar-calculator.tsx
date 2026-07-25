import { useMemo, useState } from 'react';
import { ArrowLeft, Calculator } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';

const num = (v: string) => Number(v.replace(/,/g, ''));
export default function DollarCalculatorPage() {
  const [, navigate] = useLocation();
  const [usd, setUsd] = useState('100');
  const [rate, setRate] = useState('1350');
  const [fee, setFee] = useState('0.25');
  const result = useMemo(() => {
    const u=num(usd), r=num(rate), f=num(fee);
    if (![u,r,f].every(Number.isFinite) || u<0 || r<=0 || f<0) return null;
    const base=u*r, feeAmount=base*(f/100);
    return { base, feeAmount, total:base+feeAmount };
  }, [usd,rate,fee]);
  return <div className="h-full overflow-y-auto bg-background"><div className="mx-auto max-w-md px-4 pb-28 pt-4">
    <header className="grid grid-cols-[40px_1fr_40px] items-center"><button onClick={()=>navigate('/more')} className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border"><ArrowLeft className="h-4 w-4"/></button><div className="text-center"><h1 className="text-lg font-black">달러 계산기</h1><p className="text-[11px] font-bold text-muted-foreground">환율 · 환전 수수료 포함</p></div><Calculator className="h-5 w-5"/></header>
    <section className="mt-5 space-y-4 rounded-3xl border border-card-border bg-card p-4">
      <Field label="달러 금액 (USD)" value={usd} set={setUsd}/><Field label="적용 환율 (원/USD)" value={rate} set={setRate}/><Field label="환전 수수료 (%)" value={fee} set={setFee}/>
      <div className="rounded-2xl bg-secondary p-4 text-sm font-bold"><Row label="환산 원화" value={result?`${Math.round(result.base).toLocaleString()}원`:'산출 불가'}/><Row label="수수료" value={result?`${Math.round(result.feeAmount).toLocaleString()}원`:'산출 불가'}/><div className="mt-3 border-t border-card-border pt-3"><Row label="총 필요 금액" value={result?`${Math.round(result.total).toLocaleString()}원`:'산출 불가'} strong/></div></div>
      <p className="text-[11px] font-bold leading-5 text-muted-foreground">표시 결과는 사용자가 입력한 환율 기준의 참고값이며 실제 카드사·은행·거래소 수수료와 다를 수 있습니다.</p>
    </section></div><BottomNav/></div>;
}
function Field({label,value,set}:{label:string;value:string;set:(v:string)=>void}){return <label className="block"><span className="mb-1.5 block text-xs font-black">{label}</span><input inputMode="decimal" value={value} onChange={e=>set(e.target.value)} className="w-full rounded-2xl border border-card-border bg-background px-4 py-3 text-right text-lg font-black outline-none"/></label>}
function Row({label,value,strong=false}:{label:string;value:string;strong?:boolean}){return <div className="flex items-center justify-between py-1"><span className="text-muted-foreground">{label}</span><span className={strong?'text-base font-black text-primary':'font-black'}>{value}</span></div>}
