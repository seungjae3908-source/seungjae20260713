import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, CheckCircle2, Eye, FileJson, History, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useLocation } from 'wouter';
import {
  UI_BUILDER_PAGE_IDS,
  UI_BUILDER_PAGE_RUNTIME_OWNER,
  UI_BUILDER_STABLE_SHA,
  UI_BUILDER_STABLE_TREE,
  clearUiBuilderStoredLayout,
  makeFrozenUiBuilderTemplate,
  readUiBuilderStoredLayout,
  writeUiBuilderStoredLayout,
  type UiBuilderDeviceClass,
  type UiBuilderFullLayoutDocument,
  type UiBuilderPageId,
} from '@/lib/ui-builder-full-layout';
import { importUiBuilderLayoutFile } from '@/lib/ui-builder-layout-import';
import { parseAndValidateUiBuilderRuntimeLayout } from '@/lib/ui-builder-runtime-safety';
import {
  activateUiBuilderLayoutVersion,
  readUiBuilderLayoutVersions,
  restoreDefaultUiBuilderLayout,
  rollbackUiBuilderLayoutVersion,
} from '@/lib/ui-builder-layout-versions';

function pretty(value: unknown) { return JSON.stringify(value, null, 2); }

export default function UiBuilderLayoutControlPage() {
  const [, navigate] = useLocation();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [pageId, setPageId] = useState<UiBuilderPageId>('HOME');
  const [device, setDevice] = useState<UiBuilderDeviceClass>('mobile');
  const [text, setText] = useState(() => pretty(makeFrozenUiBuilderTemplate('HOME', 'mobile')));
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);

  const parsed = useMemo(() => parseAndValidateUiBuilderRuntimeLayout(text, pageId, device), [text, pageId, device]);
  const preview = parsed.valid ? parsed.layout : null;
  const versions = useMemo(() => readUiBuilderLayoutVersions(pageId, device), [pageId, device, historyRevision]);

  const switchTarget = (nextPage: UiBuilderPageId, nextDevice: UiBuilderDeviceClass) => {
    setPageId(nextPage);
    setDevice(nextDevice);
    setText(readUiBuilderStoredLayout('draft', nextPage, nextDevice) ?? pretty(makeFrozenUiBuilderTemplate(nextPage, nextDevice)));
    setNotice(''); setError(''); setHistoryRevision((value) => value + 1);
  };

  const run = (label: string, action: (layout: UiBuilderFullLayoutDocument) => UiBuilderFullLayoutDocument | void) => {
    setNotice(''); setError('');
    if (!parsed.valid || !parsed.layout) {
      setError(parsed.issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'));
      return;
    }
    try {
      const result = action(parsed.layout);
      if (result) setText(pretty(result));
      setHistoryRevision((value) => value + 1);
      setNotice(label);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setNotice(''); setError('');
    try {
      const result = await importUiBuilderLayoutFile(file, pageId, device);
      if (!result.valid || !result.layout) throw new Error(result.issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'));
      setText(pretty(result.layout));
      setNotice(`파일 Import 완료: ${file.name}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { event.target.value = ''; }
  };

  const restoreDefault = () => {
    setNotice(''); setError('');
    try {
      const restored = restoreDefaultUiBuilderLayout(pageId, device);
      setText(pretty(restored)); writeUiBuilderStoredLayout('draft', restored);
      setHistoryRevision((value) => value + 1); setNotice('Frozen Builder 기본 Layout 복원 완료');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const rollback = (version: number) => {
    setNotice(''); setError('');
    try {
      const rolled = rollbackUiBuilderLayoutVersion(pageId, device, version);
      setText(pretty(rolled)); writeUiBuilderStoredLayout('draft', rolled);
      setHistoryRevision((value) => value + 1); setNotice(`v${version} 기준 새 published version으로 Rollback 완료`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-background px-4 pb-16 pt-4" data-testid="ui-builder-layout-control">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-start justify-between gap-3 rounded-3xl border border-card-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 items-start gap-3">
            <button type="button" aria-label="뒤로 가기" onClick={() => navigate('/settings')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-card-border"><ArrowLeft className="h-5 w-5" /></button>
            <div className="min-w-0"><h1 className="text-xl font-black">UI Builder Layout 통합</h1><p className="mt-1 break-keep text-xs font-bold leading-5 text-muted-foreground">관리자 전용 · JSON Paste/File Import → 검증 → Draft → Preview → Activate → Version/Rollback. 서버/DB/주문 API는 호출하지 않습니다.</p></div>
          </div>
          <div className="rounded-2xl border border-positive/30 bg-positive/10 px-3 py-2 text-[11px] font-black text-positive"><ShieldCheck className="mr-1 inline h-4 w-4" />READ-ONLY BUILDER CONTRACT</div>
        </header>

        <section className="mt-4 grid gap-3 rounded-3xl border border-card-border bg-card p-4 md:grid-cols-2">
          <label className="text-xs font-black">PageId<select value={pageId} onChange={(e) => switchTarget(e.target.value as UiBuilderPageId, device)} className="mt-2 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm">{UI_BUILDER_PAGE_IDS.map((id) => <option key={id}>{id}</option>)}</select></label>
          <label className="text-xs font-black">Device<select value={device} onChange={(e) => switchTarget(pageId, e.target.value as UiBuilderDeviceClass)} className="mt-2 h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm"><option value="mobile">mobile</option><option value="desktop">desktop</option></select></label>
          <div className="md:col-span-2 rounded-2xl bg-secondary/60 p-3 text-xs"><p><b>Runtime owner:</b> {UI_BUILDER_PAGE_RUNTIME_OWNER[pageId]}</p><p className="mt-1 break-all"><b>Builder SHA:</b> {UI_BUILDER_STABLE_SHA}</p><p className="mt-1 break-all"><b>Tree:</b> {UI_BUILDER_STABLE_TREE}</p></div>
        </section>

        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <section className="rounded-3xl border border-card-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-black"><FileJson className="mr-2 inline h-4 w-4" />Layout JSON</h2><div className="flex items-center gap-2"><button type="button" onClick={() => fileRef.current?.click()} className="rounded-xl border border-card-border bg-background px-3 py-2 text-xs font-black"><Upload className="mr-1 inline h-4 w-4" />파일 Import</button><span data-testid="ui-builder-validation-state" className={`rounded-full px-2 py-1 text-[10px] font-black ${parsed.valid ? 'bg-positive/10 text-positive' : 'bg-destructive/10 text-destructive'}`}>{parsed.valid ? 'VALID' : 'INVALID'}</span></div></div>
            <input ref={fileRef} data-testid="ui-builder-json-file" type="file" accept="application/json,.json" className="hidden" onChange={(event) => void importFile(event)} />
            <textarea aria-label="Layout JSON" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="mt-3 min-h-[520px] w-full resize-y rounded-2xl border border-card-border bg-background p-3 font-mono text-xs leading-5 outline-none focus:border-primary" />
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <button type="button" onClick={() => run('Draft 저장 완료', (layout) => writeUiBuilderStoredLayout('draft', layout))} className="h-11 rounded-xl border border-card-border bg-background text-sm font-black">Draft 저장</button>
              <button type="button" onClick={() => run('Preview 저장 완료', (layout) => writeUiBuilderStoredLayout('preview', layout))} className="h-11 rounded-xl border border-card-border bg-background text-sm font-black"><Eye className="mr-1 inline h-4 w-4" />Preview</button>
              <button type="button" onClick={() => run('Active Layout 적용 및 version 저장 완료', activateUiBuilderLayoutVersion)} className="h-11 rounded-xl bg-primary text-sm font-black text-primary-foreground"><CheckCircle2 className="mr-1 inline h-4 w-4" />Activate</button>
              <button type="button" onClick={() => { clearUiBuilderStoredLayout('active', pageId, device); setNotice('Active Layout 해제 완료 · runtime은 safe fallback 사용'); setError(''); }} className="h-11 rounded-xl border border-destructive/30 text-sm font-black text-destructive"><Trash2 className="mr-1 inline h-4 w-4" />Deactivate</button>
              <button type="button" onClick={restoreDefault} className="h-11 rounded-xl border border-card-border bg-background text-sm font-black"><RotateCcw className="mr-1 inline h-4 w-4" />기본값 복원</button>
            </div>
            {notice && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-positive/10 p-3 text-xs font-bold text-positive">{notice}</p>}
            {error && <p role="alert" className="mt-3 whitespace-pre-wrap rounded-xl bg-destructive/10 p-3 text-xs font-bold text-destructive">{error}</p>}
          </section>

          <div className="space-y-4">
            <section className="rounded-3xl border border-card-border bg-card p-4" data-testid="ui-builder-safe-preview">
              <h2 className="text-sm font-black">Safe Preview</h2><p className="mt-1 break-keep text-xs text-muted-foreground">실제 주문/계좌 호출 없이 Layout 구조만 표시합니다.</p>
              {preview ? <div className="mt-4 grid grid-cols-12 gap-2">{preview.blocks.filter((block) => !block.visibility.hidden && block.visibility.mode !== 'hidden').sort((a,b) => a.layout.order-b.layout.order).map((block) => <div key={block.id} data-builder-preview-block={block.type} className="min-w-0 rounded-2xl border border-card-border bg-background p-3" style={{ gridColumn: `span ${device === 'mobile' ? 12 : block.layout.colSpan} / span ${device === 'mobile' ? 12 : block.layout.colSpan}` }}><p className="truncate text-xs font-black">{block.props.title || block.type}</p><p className="mt-1 text-[10px] text-muted-foreground">{block.type} · order {block.layout.order} · {block.props.density}</p></div>)}</div> : <div className="mt-4 rounded-2xl bg-destructive/10 p-3 text-xs font-bold text-destructive">검증 실패 Layout은 Preview/Activate되지 않습니다.</div>}
            </section>

            <section className="rounded-3xl border border-card-border bg-card p-4" data-testid="ui-builder-version-history">
              <h2 className="text-sm font-black"><History className="mr-2 inline h-4 w-4" />Version History</h2>
              <p className="mt-1 break-keep text-xs text-muted-foreground">Rollback은 과거 record를 수정하지 않고 새 published version을 생성합니다.</p>
              <div className="mt-3 space-y-2">
                {versions.map((record) => <div key={`${record.version}:${record.activatedAt}`} className="flex items-center justify-between gap-3 rounded-2xl border border-card-border bg-background p-3"><div className="min-w-0"><p className="text-xs font-black">v{record.version} · {record.source}</p><p className="mt-1 truncate text-[10px] text-muted-foreground">{record.layout.layoutId}</p></div><button type="button" onClick={() => rollback(record.version)} className="shrink-0 rounded-xl border border-card-border px-3 py-2 text-xs font-black">Rollback</button></div>)}
                {versions.length === 0 && <p className="rounded-2xl bg-secondary/60 p-3 text-xs font-bold text-muted-foreground">아직 활성화된 version이 없습니다.</p>}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
