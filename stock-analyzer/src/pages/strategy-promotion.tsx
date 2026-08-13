import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronUp, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useLocation } from 'wouter';
import { BottomNav } from '@/components/bottom-nav';
import {
  completedPromotionStages,
  fetchStrategyPromotions,
  type PromotionStage,
  type StrategyPromotionItem,
} from '@/lib/strategy-promotion';

const STAGE_LABELS: Record<string, string> = {
  RESEARCH_DESIGN: 'Research design', HISTORICAL_BACKTEST: 'Historical backtest', OUT_OF_SAMPLE: 'Out-of-sample',
  PURGED_WALK_FORWARD: 'Purged walk-forward', COST_STRESS: 'Cost stress', REGIME: 'Regime validation',
  FINAL_HOLDOUT: 'Final holdout', PAPER: 'Paper', SHADOW: 'Shadow', RECOMMENDATION_OUTCOMES: 'Recommendation outcomes',
};

function statusClass(status: PromotionStage['status']) {
  if (status === 'PASS') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500';
  if (status === 'FAIL' || status === 'INVALIDATED') return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (status === 'BLOCKED' || status === 'STALE') return 'border-amber-500/40 bg-amber-500/10 text-amber-500';
  return 'border-card-border bg-background text-muted-foreground';
}

function EvidenceValue({ value }: { value: unknown }) {
  if (value == null) return <span className="text-muted-foreground">Evidence required</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <span className="tabular-nums">{value.toLocaleString()}</span>;
  return <span className="break-all">{String(value)}</span>;
}

function StageTimeline({ stages }: { stages: PromotionStage[] }) {
  return (
    <ol className="mt-4 space-y-2" aria-label="Promotion evidence timeline">
      {stages.map((stage, index) => (
        <li key={stage.stage} className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] gap-2">
          <div className="flex flex-col items-center">
            <span className={`mt-1 h-3 w-3 rounded-full border ${statusClass(stage.status)}`} />
            {index < stages.length - 1 ? <span className="min-h-5 w-px flex-1 bg-border" aria-hidden="true" /> : null}
          </div>
          <div className="min-w-0 rounded-xl border border-card-border bg-background/60 p-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h4 className="break-keep text-xs font-black">{STAGE_LABELS[stage.stage] ?? stage.stage}</h4>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${statusClass(stage.status)}`}>{stage.status}</span>
            </div>
            <dl className="mt-2 grid min-w-0 grid-cols-1 gap-1 text-[10px] text-muted-foreground sm:grid-cols-2">
              <div className="min-w-0"><dt className="font-bold text-foreground">Source</dt><dd className="truncate">{stage.source}</dd></div>
              <div><dt className="font-bold text-foreground">Data quality</dt><dd>{stage.dataQuality}</dd></div>
              <div><dt className="font-bold text-foreground">Samples / trades</dt><dd><EvidenceValue value={stage.sampleCount ?? stage.sampleSize ?? stage.tradeCount} /></dd></div>
              <div className="min-w-0"><dt className="font-bold text-foreground">Gate</dt><dd className="break-all">{stage.gateResult}: {stage.gate}</dd></div>
            </dl>
            {stage.failureReason ? <p className="mt-2 break-all text-[10px] font-bold text-amber-500">{stage.failureReason}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StrategyCard({ item }: { item: StrategyPromotionItem }) {
  const [expanded, setExpanded] = useState(false);
  const completed = completedPromotionStages(item);
  return (
    <article data-testid="strategy-promotion-card" className="min-w-0 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-black text-primary">{item.identity.market} Â· {item.identity.direction}</p>
          <h3 className="mt-1 break-all text-sm font-black">{item.identity.strategyId}</h3>
          <p className="mt-1 text-[10px] text-muted-foreground">{item.identity.strategyHorizon} Â· {item.identity.timeframe} Â· {item.identity.strategyVersion}</p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-black ${item.promotionEligible ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500' : 'border-card-border bg-background text-muted-foreground'}`}>{item.promotionState}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" aria-label={`${completed} of ${item.stages.length} promotion stages passed`}>
        <div className="h-full bg-primary" style={{ width: `${completed / item.stages.length * 100}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{completed}/{item.stages.length} gates passed</span><span>Drift: {item.drift.classification ?? item.drift.status}</span><span>Kill: {item.killState}</span>
      </div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="mt-3 flex min-h-11 w-full items-center justify-between rounded-xl border border-card-border px-3 text-xs font-black">
        Evidence and timeline {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {expanded ? (
        <div>
          <dl className="mt-3 grid min-w-0 grid-cols-1 gap-2 rounded-xl bg-background p-3 text-[10px] sm:grid-cols-2">
            <div className="min-w-0"><dt className="font-bold text-muted-foreground">Parameter hash</dt><dd className="truncate font-mono">{item.identity.parameterHash}</dd></div>
            <div className="min-w-0"><dt className="font-bold text-muted-foreground">Research SHA</dt><dd className="truncate font-mono">{item.identity.researchCodeSha}</dd></div>
            <div><dt className="font-bold text-muted-foreground">Cost policy</dt><dd className="break-all">{item.identity.costPolicyVersion}</dd></div>
            <div><dt className="font-bold text-muted-foreground">Risk policy</dt><dd className="break-all">{item.identity.riskPolicyVersion}</dd></div>
          </dl>
          <StageTimeline stages={item.stages} />
          {item.blockers.length ? <p className="mt-3 break-all text-[10px] text-muted-foreground">Blockers: {item.blockers.join(' Â· ')}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

export default function StrategyPromotionPage() {
  const [, navigate] = useLocation();
  const query = useQuery({ queryKey: ['strategy-promotion', 'all'], queryFn: ({ signal }) => fetchStrategyPromotions(signal), staleTime: 60_000 });
  const items = query.data?.items ?? [];
  return (
    <main className="h-full overflow-y-auto overscroll-contain bg-background pb-24" data-testid="strategy-promotion-page">
      <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-5">
        <header className="rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 items-start gap-3">
            <button type="button" aria-label="Back to scanner" onClick={() => navigate('/scanner')} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border"><ArrowLeft className="h-4 w-4" /></button>
            <div className="min-w-0 flex-1"><p className="text-[10px] font-black text-primary">Evidence-only governance Â· no execution authority</p><h1 className="mt-1 text-xl font-black">Strategy Promotion Center</h1><p className="mt-1 break-keep text-xs leading-5 text-muted-foreground">Research, backtest, paper, shadow and recommendation evidence are linked to an exact strategy identity. Missing or stale evidence fails closed.</p></div>
            <button type="button" aria-label="Refresh promotion evidence" onClick={() => void query.refetch()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-card-border"><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></button>
          </div>
        </header>

        {query.data ? <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6" aria-label="Promotion summary">
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Strategies</p><strong className="text-xl">{items.length}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Candidates</p><strong data-testid="promotion-candidate-count" className="text-xl">{query.data.promotionCandidates}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Shadow validated</p><strong className="text-xl">{query.data.counts.SHADOW_VALIDATED}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Research hold</p><strong className="text-xl">{query.data.counts.RESEARCH_HOLD}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Suspended</p><strong className="text-xl">{query.data.counts.SUSPENDED}</strong></div>
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="text-[10px] text-muted-foreground">Killed</p><strong className="text-xl">{query.data.counts.KILLED}</strong></div>
        </section> : null}

        {query.data ? <section className="grid grid-cols-2 gap-2" aria-label="Execution safety summary">
          <div className="rounded-2xl border border-card-border bg-card p-3"><p className="t÷n<¶‰žËkºwµçe7FvTWf–FVæ6R“¢&ööÆVâ°¢–b‡7FvRç7FGW2ÓÒu52rÇÂ7FvRæÖWG&–72’&WGW&âfÇ6S°¢&WGW&â4õ5Eõ5E$U55ôÕTÅD•Ä”U%2æWfW'’‚†×VÇF—Æ–W"’Óâ7FvRæÖWG&–73òå¶6÷7EòG¶×VÇF—Æ–W'×†ÒÓÓÒG'VR“°§Ð ¦gVæ7F–öâ&öÖ÷F–öå7FFR‡7FvW3¢&VFöæÇ’&öÖ÷F–öå7FvTWf–FVæ6UµÒÂG&–gC¢G&–gE7FFRÂ¶–ÆÅ7FFS¢¶–ÆÅ7FFR“¢&öÖ÷F–öå7FFR°¢–b†¶–ÆÅ7FFRÓÓÒt´”ÄÄTBr’&WGW&ât´”ÄÄTBs°¢–b†¶–ÆÅ7FFRÓÓÒu5U5TäEõ$T4ôÔÔTäDTBrÇÂG&–gBæ6Æ76–f–6F–öâÓÓÒtDTu$DTBrÇÂG&–gBæ6Æ76–f–6F–öâÓÓÒt5$•D”4Âr’&WGW&âu5U5TäDTBs°¢6öç7B'•7FvRÒ7FvTÖ‡7FvW2“°¢6öç7B&W6V&6‚Ò$U4T$4…ôtDU2æÖ‚†¶W’’Óâ'•7FvRævWB†¶W’’“°¢–b‡&W6V&6‚ç6öÖR‚‡7FvR’Óâ7FvRç7FGW2ÓÓÒt$Äô4´TBrÇÂ7FvRç7FGW2ÓÓÒt”ådÄ”DDTBr’’&WGW&ât$Äô4´TEôDDs°¢–b‡&W6V&6‚ç6öÖR‚‡7FvR’Óâ²td”ÂrÂt”å5Tdd”4”TåEõ4ÕÄRrÂu5DÄRuÒæ–æ6ÇVFW2‡7FvRç7FGW2’’’&WGW&âu$U4T$4…ô„ôÄBs°¢–b‚&W6V&6‚æWfW'’‚‡7FvR’Óâ7FvRç7FGW2ÓÓÒu52r’ÇÂ6÷7E7G&W746ö×ÆWFR†'•7FvRævWB‚t4õ5Eõ5E$U52r’’’&WGW&âu$U4T$4‚s° ¢6öç7BW"Ò'•7FvRævWB‚uU"r’°¢6öç7B6†F÷rÒ'•7FvRævWB‚u4„Dõrr’°¢6öç7B÷WF6öÖW2Ò'•7FvRævWB‚u$T4ôÔÔTäDD”ôåôõUD4ôÔU2r’°¢–b‡W"ç7FGW2ÓÒu52r’&WGW&âW"ç7FGW2ÓÓÒtäõEõ5D%DTBrÇÂW"ç7FGW2ÓÓÒu%Tää”ärròuU%ô4äD”DDRr¢u$U4T$4…ô„ôÄBs°¢–b‡6†F÷rç7FGW2ÓÓÒt$Äô4´TBrÇÂ6†F÷rç7FGW2ÓÓÒtd”ÂrÇÂ6†F÷rç7FGW2ÓÓÒt”å5Tdd”4”TåEõ4ÕÄRrÇÂ6†F÷rç7FGW2ÓÓÒu5DÄRrÇÂ6†F÷rç7FGW2ÓÓÒt”ådÄ”DDTBr’&WGW&âuU%õdÄ”DDTBs°¢–b‡6†F÷rç7FGW2ÓÒu52r’&WGW&âu4„Dõuô4äD”DDRs°¢–b†÷WF6öÖW2ç7FGW2ÓÒu52r’&WGW&âu4„DõuõdÄ”DDTBs°¢&WGW&âu$ôÔõD”ôåô4äD”DDRs°§Ð ¦W‡÷'BgVæ7F–öâ6Æ76–g•&öÖ÷F–öäG&–gB‡7FvW3¢&VFöæÇ’&öÖ÷F–öå7FvTWf–FVæ6UµÒ“¢G&–gE7FFR°¢6öç7B'•7FvRÒ7FvTÖ‡7FvW2“°¢6öç7B&6VÆ–æRÒ'•7FvRævWB‚t„•5Dõ$”4Åô$4µDU5Br“°¢6öç7Bö'6W'fVBÒ'•7FvRævWB‚u$T4ôÔÔTäDD”ôåôõUD4ôÔU2r“°¢6öç7B&6VÆ–æU6×ÆW2Ò&6VÆ–æSòç6×ÆT6÷VçBóò&6VÆ–æSòç6×ÆU6—¦Róò&6VÆ–æSòçG&FT6÷VçBóòçVÆÃ°¢6öç7Bö'6W'fVE6×ÆW2Òö'6W'fVCòç6×ÆT6÷VçBóòö'6W'fVCòç6×ÆU6—¦Róòö'6W'fVCòçG&FT6÷VçBóòçVÆÃ°¢6öç7B&6VÆ–æT†—E&FRÒG—Vöb&6VÆ–æSòæÖWG&–73òæ†—E&FRÓÓÒvçVÖ&W"rò&6VÆ–æRæÖWG&–72æ†—E&FR¢çVÆÃ°¢6öç7Bö'6W'fVD†—E&FRÒG—Vöbö'6W'fVCòæÖWG&–73òæ†—E&FRÓÓÒvçVÖ&W"ròö'6W'fVBæÖWG&–72æ†—E&FR¢çVÆÃ°¢6öç7B&6VÆ–æTWbÒG—Vöb&6VÆ–æSòæÖWG&–73òæW‡V7FVEfÇVRÓÓÒvçVÖ&W"rò&6VÆ–æRæÖWG&–72æW‡V7FVEfÇVR¢çVÆÃ°¢6öç7Bö'6W'fVDWbÒG—Vöbö'6W'fVCòæÖWG&–73òæW‡V7FVEfÇVRÓÓÒvçVÖ&W"ròö'6W'fVBæÖWG&–72æW‡V7FVEfÇVR¢çVÆÃ°¢–b†&6VÆ–æU6×ÆW2ÓÒçVÆÂÇÂö'6W'fVE6×ÆW2ÓÒçVÆÂÇÂö'6W'fVE6×ÆW2Â5E$DTu•õ$ôÔõD”ôåõôÄ”5’æÖ–æ–×VÔö'6W'fVD÷WF6öÖU6×ÆW2ÇÂ&6VÆ–æT†—E&FRÓÒçVÆÂÇÂö'6W'fVD†—E&FRÓÒçVÆÂÇÂ&6VÆ–æTWbÓÒçVÆÂÇÂö'6W'fVDWbÓÒçVÆÂ’°¢&WGW&â°¢6Æ76–f–6F–öã¢çVÆÂÀ¢7FGW3¢t”å5Tdd”4”TåEõ4ÕÄRrÀ¢&V6öã¢tÄ”ä´TEô$4TÄ”äUôäEôEôÄT5Eó3ôô%4U%dTEôõUD4ôÔU5õ$UT•$TBrÀ¢&6VÆ–æU6×ÆU6—¦S¢&6VÆ–æU6×ÆW2À¢ö'6W'fVE6×ÆU6—¦S¢ö'6W'fVE6×ÆW2À¢†—E&FTv¢çVÆÂÀ¢W‡V7FVEfÇVTv¢çVÆÂÀ¢WFõ&öÖ÷F–öäÆÆ÷vVC¢fÇ6RÀ¢Ó°¢Ð¢6öç7B†—E&FTvÒö'6W'fVD†—E&FRÒ&6VÆ–æT†—E&FS°¢6öç7BW‡V7FVEfÇVTvÒö'6W'fVDWbÒ&6VÆ–æTWc°¢6öç7B6Æ76–f–6F–öã¢G&–gD6Æ76–f–6F–öâÒ†—E&FTvÃÒÓã"ÇÂW‡V7FVEfÇVTvÂÓ¢òt5$•D”4Âp¢¢†—E&FTvÃÒÓã"ÇÂW‡V7FVEfÇVTvÂÓãP¢òtDTu$DTBp¢¢†—E&FTvÃÒÓãRÇÂW‡V7FVEfÇVTvÂ ¢òutD4‚p¢¢t„TÅD…’s°¢&WGW&â°¢6Æ76–f–6F–öâÀ¢7FGW3¢tÔT5U$TBrÀ¢&V6öã¢t$4µDU5EõDõõ$T4ôÔÔTäDD”ôåôõUD4ôÔUô4ôÕ$•4ôârÀ¢&6VÆ–æU6×ÆU6—¦S¢&6VÆ–æU6×ÆW2À¢ö'6W'fVE6×ÆU6—¦S¢ö'6W'fVE6×ÆW2À¢†—E&FTvÀ¢W‡V7FVEfÇVTvÀ¢WFõ&öÖ÷F–öäÆÆ÷vVC¢fÇ6RÀ¢Ó°§Ð ¦gVæ7F–öâ6÷W&6U&Vv—7G'’‚“¢&VFöæÇ’&öÖ÷F–öäWf–FVæ6U6÷W&6UµÒ°¢&WGW&âö&¦V7Bæg&VW¦R…°¢²–C¢t4äôä”4Åõ44ääU%õ$ôd”ÄRrÂ÷væW#¢w66ææW"×7G&FVw’×&öf–ÆRç6W'f–6RçG2rÂ7FGW3¢td”Ä$ÄRrÂW6S¢v–Ö×WF&ÆR7G&FVw’–FVçF—G’æB&W6V&6‚FW6–vârÂW†V7WF–öäWF†÷&—G“¢täôäRrÒÀ¢²–C¢t$4µDU5EôTät”äRrÂ÷væW#¢v&6·FW7BÖVæv–æRç6W'f–6RçG2rÂ7FGW3¢td”Ä$ÄRrÂW6S¢v†—7F÷&–6ÂÂ6÷7BÖv&RæB&Vv–ÖRWf–FVæ6RgFW"W†7B–FVçF—G’Æ–æ¶vRrÂW†V7WF–öäWF†÷&—G“¢täôäRrÒÀ¢²–C¢u$TD”5D”ôåôÄ"rÂ÷væW#¢vÖ&¶WB×&VF–7F–öâÖÆ"rÂ7FGW3¢uTäÄ”ä´TBrÂW6S¢wW&vVBvÆ²Öf÷'v&BæBf–æÂÖ†öÆF÷WB'F–f7G2&WV—&R&ÖWFW"Ö†6‚Æ–æ¶vRrÂW†V7WF–öäWF†÷&—G“¢täôäRrÒÀ¢²–C¢uU%ô¤õU$äÂrÂ÷væW#¢wW"Ö¦÷W&æÂrÂ7FGW3¢td”Ä$ÄRrÂW6S¢wW"Wf–FVæ6RgFW"7G&FVw’–FVçF—G’Æ–æ¶vRrÂW†V7WF–öäWF†÷&—G“¢täôäRrÒÀ¢²–C¢u4”täÅõU$dõ$Ôä4RrÂ÷væW#¢w6–væÂ×W&f÷&Öæ6RÖÆV&æ–ærç6W'f–6RçG2rÂ7FGW3¢td”Ä$ÄRrÂW6S¢w6†F÷ræB&V6öÖÖVæFF–öâ÷WF6öÖW2gFW"7G&FVw’–FVçF—G’Æ–æ¶vRrÂW†V7WF–öäWF†÷&—G“¢täôäRrÒÀ¢²–C¢u$ôd•Eôd•%5Eõ44ääU"rÂ÷væW#¢u"3#6ÆVâ×÷'B6æF–FFRrÂ7FGW3¢täõEôôåôÔ”ârÂW6S¢vgWGW&R66ææW"Wf–FVæ6R6÷W&6S²æòWf–FVæ6R66WFVBVçF–Â6ÆVâ×÷'BæBW†7BÖ†VBvFW272rÂW†V7WF–öäWF†÷&—G“¢täôäRrÒÀ¢Ò“°§Ð ¦gVæ7F–öâ7FFT6÷VçG2†—FV×3¢&VFöæÇ’7G&FVw•&öÖ÷F–öå&V6÷&EµÒ“¢&V6÷&CÅ&öÖ÷F–öå7FFRÂçVÖ&W#â°¢6öç7B6÷VçG3¢&V6÷&CÅ&öÖ÷F–öå7FFRÂçVÖ&W#âÒ°¢$U4T$4ƒ¢Â$Äô4´TEôDD¢Â$U4T$4…ô„ôÄC¢ÂU%ô4äD”DDS¢ÂU%õdÄ”DDTC¢À¢4„Dõuô4äD”DDS¢Â4„DõuõdÄ”DDTC¢Â$ôÔõD”ôåô4äD”DDS¢Â5U5TäDTC¢Â´”ÄÄTC¢À¢Ó°¢f÷"†6öç7B—FVÒöb—FV×2’6÷VçG5¶—FVÒç&öÖ÷F–öå7FFUÒ³Ò°¢&WGW&â6÷VçG3°§Ð ¦W‡÷'B6Æ727G&FVw•&öÖ÷F–öå6W'f–6R°¢&—fFR&VFöæÇ’6÷W&6U6†¢7G&–æs°¢&—fFR&VFöæÇ’æ÷s¢‚’ÓâFFS°¢&—fFR&VFöæÇ’Wf–FVæ6S¢7G&FVw•&öÖ÷F–öå6W'f–6T÷F–öç5²vWf–FVæ6RuÓ°¢&—fFR&VFöæÇ’¶–ÆÅ7FFW3¢7G&FVw•&öÖ÷F–öå6W'f–6T÷F–öç5²v¶–ÆÅ7FFW2uÓ° ¢6öç7G'V7F÷"†÷F–öç3¢7G&FVw•&öÖ÷F–öå6W'f–6T÷F–öç2Ò·Ò’°¢F†—2ç6÷W&6U6†Ò7G&–ær†÷F–öç2ç6÷W&6U6†óò&ö6W72æVçbäDUÄõ•õ4„óò&ö6W72æVçbät•D…T%õ4„óòrr’çG&–Ò‚“°¢F†—2ææ÷rÒ÷F–öç2ææ÷róò‚‚’ÓâæWrFFR‚’“°¢F†—2æWf–FVæ6RÒ÷F–öç2æWf–FVæ6Róò·Ó°¢F†—2æ¶–ÆÅ7FFW2Ò÷F–öç2æ¶–ÆÅ7FFW2óò·Ó°¢Ð ¢Æ—7B†f–ÇFW'3¢²Ö&¶WCó¢7G&–æs²7G&FVw”†÷&—¦öãó¢7G&–æs²F—&V7F–öãó¢7G&–æs²7FGW3ó¢7G&–ærÒÒ·Ò“¢7G&FVw•&öÖ÷F–öäÆ—7B°¢6öç7BvVæW&FVDBÒF†—2ææ÷r‚’çFô•4õ7G&–ær‚“°¢6öç7B—FV×2ÒÆ—7E66ææW%7G&FVw•&öf–ÆW2‚’æfÆDÖ‚‡&öf–ÆR’ÓâF—&V7F–öç2‡&öf–ÆRæÖ&¶WB’æÖ‚†F—&V7F–öâ’Óâ°¢6öç7B—FVÔ–FVçF—G’Ò–FVçF—G’‡&öf–ÆRÂF—&V7F–öâÂF†—2ç6÷W&6U6†ÇÂuTäd”Ä$ÄRr“°¢6öç7B÷fW'&–FW2ÒæWrÖ‚‡F†—2æWf–FVæ6Sòå¶—FVÔ–FVçF—G’ç7G&FVw”–EÒóòµÒ’æÖ‚†—FVÒ’Óâ¶—FVÒç7FvRÂ—FVÕÒ’“°¢6öç7B7FvW2Ò5DtUôõ$DU"æÖ‚‡7FvR’ÓâÖW&vTWf–FVæ6R€¢7FvRÓÓÒu$U4T$4…ôDU4”târò&W6V&6…7FvR‡&öf–ÆRÂF†—2ç6÷W&6U6†ÂvVæW&FVDB’¢V×G•7FvR‡7FvRÂvVæW&FVDB’À¢÷fW'&–FW2ævWB‡7FvR’À¢vVæW&FVDBÀ¢F†—2ç6÷W&6U6†À¢’“°¢6öç7BG&–gBÒ6Æ76–g•&öÖ÷F–öäG&–gB‡7FvW2“°¢6öç7B¶–ÆÅ7FFRÒF†—2æ¶–ÆÅ7FFW3òå¶—FVÔ–FVçF—G’ç7G&FVw”–EÒóòtäôäRs°¢6öç7B7W'&VçE7FFRÒ&öÖ÷F–öå7FFR‡7FvW2ÂG&–gBÂ¶–ÆÅ7FFR“°¢6öç7B&Æö6¶W'2Ò7FvW2æÖ†&Æö6¶–æu&V6öâ’æf–ÇFW"‚†—FVÒ“¢—FVÒ—27G&–ærÓâ&ööÆVâ†—FVÒ’“°¢–b†'”6÷7E7G&W74æVVG4FWF–Ç2‡7FvW2’’&Æö6¶W'2çW6‚‚t4õ5Eõ5E$U55ó…óó#U…óóU…ó%…õ$UT•$TBr“°¢&WGW&âö&¦V7Bæg&VW¦R‡°¢–FVçF—G“¢—FVÔ–FVçF—G’À¢&öÖ÷F–öå7FFS¢7W'&VçE7FFRÀ¢7FvW3¢ö&¦V7Bæg&VW¦R‡7FvW2’À¢G&–gBÀ¢¶–ÆÅ7FFRÀ¢&Æö6¶W'3¢ö&¦V7Bæg&VW¦R†&Æö6¶W'2’À¢&öÖ÷F–öäVÆ–v–&ÆS¢7W'&VçE7FFRÓÓÒu$ôÔõD”ôåô4äD”DDRrÀ¢W†V7WF–öäWF†÷&—G“¢5E$DTu•õ$ôÔõD”ôåôU„T5UD”ôåôUD„õ$•E’À¢Æ—fUG&F–ætWF†÷&—G“¢fÇ6R26öç7BÀ¢&—fFUG&F–æt”6÷VçC¢26öç7BÀ¢Ò“°¢Ò’’æf–ÇFW"‚†—FVÒ’Óâ‚f–ÇFW'2æÖ&¶WBÇÂ—FVÒæ–FVçF—G’æÖ&¶WBÓÓÒf–ÇFW'2æÖ&¶WB¢bb‚f–ÇFW'2ç7G&FVw”†÷&—¦öâÇÂ—FVÒæ–FVçF—G’ç7G&FVw”†÷&—¦öâÓÓÒf–ÇFW'2ç7G&FVw”†÷&—¦öâ¢bb‚f–ÇFW'2æF—&V7F–öâÇÂ—FVÒæ–FVçF—G’æF—&V7F–öâÓÓÒf–ÇFW'2æF—&V7F–öâ¢bb‚f–ÇFW'2ç7FGW2ÇÂ—FVÒç&öÖ÷F–öå7FFRÓÓÒf–ÇFW'2ç7FGW2’“°¢6öç7B6÷VçG2Ò7FFT6÷VçG2†—FV×2“°¢&WGW&â°¢vVæW&FVDBÀ¢6÷W&6U6†¢F†—2ç6÷W&6U6†ÇÂuTäd”Ä$ÄRrÀ¢öÆ–7•fW'6–öã¢5E$DTu•õ$ôÔõD”ôåõôÄ”5’çfW'6–öâÀ¢—FV×2À¢6÷VçG2À¢Wf–FVæ6U6÷W&6W3¢6÷W&6U&Vv—7G'’‚’À¢&öÖ÷F–öä6æF–FFW3¢6÷VçG2å$ôÔõD”ôåô4äD”DDRÀ¢W†V7WF–öäWF†÷&—G“¢5E$DTu•õ$ôÔõD”ôåôU„T5UD”ôåôUD„õ$•E’À¢Æ—fUG&F–ætWF†÷&—G“¢fÇ6RÀ¢&—fFUG&F–æt”6÷VçC¢À¢Ó°¢Ð ¢vWB‡7G&FVw”–C¢7G&–ær“¢7G&FVw•&öÖ÷F–öå&V6÷&BÂçVÆÂ°¢&WGW&âF†—2æÆ—7B‚’æ—FV×2æf–æB‚†—FVÒ’Óâ—FVÒæ–FVçF—G’ç7G&FVw”–BÓÓÒ7G&FVw”–B’óòçVÆÃ°¢Ð ¢†—7F÷'’‡7G&FVw”–C¢7G&–ær’°¢6öç7B&V6÷&BÒF†—2ævWB‡7G&FVw”–B“°¢–b‚&V6÷&B’&WGW&âçVÆÃ°¢6öç7BWfVçG3¢'&“Ç°¢C¢7G&–æs°¢G—S¢u5DtUôUdÅTDTBrÂu$ôÔõD”ôåõ5DDUôUdÅTDTBs°¢7FvS¢&öÖ÷F–öå7FvT¶W’Âu$ôÔõD”ôâs°¢7FGW3¢&öÖ÷F–öå7FvU7FGW2Â&öÖ÷F–öå7FFS°¢6÷W&6S¢7G&–æs°¢6÷W&6U6†¢7G&–ærÂçVÆÃ°¢ÓâÒ&V6÷&Bç7FvW0¢æf–ÇFW"‚‡7FvR’Óâ7FvRç7FGW2ÓÒtäõEõ5D%DTBr¢æÖ‚‡7FvR’Óâ‡²C¢7FvRçfÆ–FFVDBóò7FvRæö'6W'fVDBÂG—S¢u5DtUôUdÅTDTBrÂ7FvS¢7FvRç7FvRÂ7FGW3¢7FvRç7FGW2Â6÷W&6S¢7FvRç6÷W&6RÂ6÷W&6U6†¢7FvRç6÷W&6U6†Ò’“°¢WfVçG2çW6‚‡²C¢F†—2ææ÷r‚’çFô•4õ7G&–ær‚’ÂG—S¢u$ôÔõD”ôåõ5DDUôUdÅTDTBrÂ7FvS¢u$ôÔõD”ôârÂ7FGW3¢&V6÷&Bç&öÖ÷F–öå7FFRÂ6÷W&6S¢w7G&FVw’×&öÖ÷F–öâç6W'f–6RçG2rÂ6÷W&6U6†¢dÄ”Eõ4„çFW7B‡F†—2ç6÷W&6U6†’òF†—2ç6÷W&6U6†¢çVÆÂÒ“°¢&WGW&â²7G&FVw”–BÂWfVçG2ÂW†V7WF–öäWF†÷&—G“¢5E$DTu•õ$ôÔõD”ôåôU„T5UD”ôåôUD„õ$•E’Ó°¢Ð ¢Wf–FVæ6Tf÷"‡7G&FVw”–C¢7G&–ær’°¢6öç7B&V6÷&BÒF†—2ævWB‡7G&FVw”–B“°¢–b‚&V6÷&B’&WGW&âçVÆÃ°¢&WGW&â°¢7G&FVw”–BÀ¢&ÖWFW$†6ƒ¢&V6÷&Bæ–FVçF—G’ç&ÖWFW$†6‚À¢7FvW3¢&V6÷&Bç7FvW2À¢6÷W&6W3¢6÷W&6U&Vv—7G'’‚’À¢W†7D–FVçF—G•&WV—&VC¢G'VRÀ¢–çfVçFVDÖWG&–74ÆÆ÷vVC¢fÇ6RÀ¢W†V7WF–öäWF†÷&—G“¢5E$DTu•õ$ôÔõD”ôåôU„T5UD”ôåôUD„õ$•E’À¢Ó°¢Ð§Ð ¦gVæ7F–öâ'”6÷7E7G&W74æVVG4FWF–Ç2‡7FvW3¢&VFöæÇ’&öÖ÷F–öå7FvTWf–FVæ6UµÒ’°¢6öç7B6÷7BÒ7FvW2æf–æB‚‡7FvR’Óâ7FvRç7FvRÓÓÒt4õ5Eõ5E$U52r“°¢&WGW&â6÷7Còç7FGW2ÓÓÒu52rbb6÷7E7G&W746ö×ÆWFR†6÷7B“°§Ð ¦W‡÷'BgVæ7F–öâ7&VFTFVfVÇE7G&FVw•&öÖ÷F–öå6W'f–6R‚’°¢&WGW&âæWr7G&FVw•&öÖ÷F–öå6W'f–6R‚“°§Ð