import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useLocation } from 'wouter';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Box,
  ClipboardCopy,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  Layers3,
  Link2,
  Palette,
  PanelBottom,
  Plus,
  RefreshCcw,
  RotateCcw,
  Save,
  Send,
  Settings2,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import {
  UI_API_SOURCES,
  UI_COMPONENT_CATALOG,
  UI_PAGES,
  UI_ROUTE_SOURCES,
  addCatalogSection,
  addCustomUiSection,
  createDefaultUiLayout,
  duplicateUiSection,
  getUiPageDefinition,
  moveUiSection,
  moveUiSectionTo,
  normalizeUiLayout,
  removeUiSection,
  type UiFontSize,
  type UiFontWeight,
  type UiLayout,
  type UiLayoutVersion,
  type UiNodeKind,
  type UiPageKey,
  type UiPopupPosition,
  type UiRadius,
  type UiSection,
  type UiSectionHeight,
  type UiSectionSpacing,
  type UiSectionWidth,
  type UiSourceType,
  type UiTextAlign,
} from '@/lib/ui-layout';
import { cn } from '@/lib/utils';

const DEFAULT_PAGE: UiPageKey = 'home';

const KIND_LABELS: Record<UiNodeKind, string> = {
  section: '기존 화면 영역',
  tab: '탭',
  button: '버튼',
  text: '글씨',
  item: '목록 항목',
  card: '카드',
  popup: '팝업 버튼',
};

const COLOR_PRESETS = [
  '',
  '#2563EB',
  '#16A34A',
  '#DC2626',
  '#9333EA',
  '#EA580C',
  '#0F172A',
  '#FFFFFF',
];

const selectClass =
  'h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold text-foreground [color-scheme:dark]';
const inputClass =
  'h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold text-foreground placeholder:text-muted-foreground';
const labelClass = 'mb-1.5 block text-xs font-black text-muted-foreground';

type ApiBody = {
  layout?: UiLayout;
  draft?: UiLayoutVersion | null;
  published?: UiLayoutVersion | null;
  versions?: UiLayoutVersion[];
  version?: UiLayoutVersion | null;
  error?: string;
};

async function request(
  path: string,
  method = 'GET',
  payload?: unknown,
): Promise<ApiBody> {
  const headers = new Headers();
  if (payload !== undefined) headers.set('Content-Type', 'application/json');

  const response = await authorizedFetch(`/api/admin/ui-layouts${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as ApiBody;
  if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
  return body;
}

function widthClass(width: UiSectionWidth) {
  if (width === 'half') return 'w-1/2';
  if (width === 'third') return 'w-1/3';
  if (width === 'auto') return 'w-auto min-w-28';
  return 'w-full';
}

function heightClass(height: UiSectionHeight) {
  if (height === 'compact') return 'min-h-12';
  if (height === 'normal') return 'min-h-20';
  if (height === 'tall') return 'min-h-32';
  return 'min-h-14';
}

function spacingClass(spacing: UiSectionSpacing) {
  if (spacing === 'none') return 'mt-0';
  if (spacing === 'xs') return 'mt-1';
  if (spacing === 'sm') return 'mt-2';
  if (spacing === 'lg') return 'mt-5';
  if (spacing === 'xl') return 'mt-7';
  return 'mt-3';
}

function alignClass(align: UiTextAlign) {
  if (align === 'left') return 'text-left';
  if (align === 'right') return 'text-right';
  return 'text-center';
}

function fontSizeClass(size: UiFontSize) {
  if (size === 'xs') return 'text-xs';
  if (size === 'sm') return 'text-sm';
  if (size === 'lg') return 'text-lg';
  if (size === 'xl') return 'text-xl';
  if (size === '2xl') return 'text-2xl';
  return 'text-base';
}

function fontWeightClass(weight: UiFontWeight) {
  if (weight === 'normal') return 'font-normal';
  if (weight === 'medium') return 'font-medium';
  if (weight === 'bold') return 'font-bold';
  return 'font-black';
}

function radiusClass(radius: UiRadius) {
  if (radius === 'none') return 'rounded-none';
  if (radius === 'sm') return 'rounded-md';
  if (radius === 'md') return 'rounded-xl';
  if (radius === 'lg') return 'rounded-2xl';
  if (radius === 'full') return 'rounded-full';
  return 'rounded-3xl';
}

function nodePreviewStyle(section: UiSection) {
  return {
    backgroundColor: section.backgroundColor || undefined,
    color: section.textColor || undefined,
    borderColor: section.borderColor || undefined,
    opacity: section.opacity / 100,
    transform: `translate(${section.x}px, ${section.y}px)`,
    zIndex: section.zIndex,
  } as const;
}

function PropertySelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <label>
      <span className={labelClass}>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className={selectClass}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <span className={labelClass}>{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        {COLOR_PRESETS.map((color, index) => (
          <button
            key={`${color}-${index}`}
            type="button"
            onClick={() => onChange(color)}
            aria-label={color || '기본색'}
            className={cn(
              'h-9 w-9 rounded-xl border-2',
              value === color ? 'border-primary ring-2 ring-primary/30' : 'border-card-border',
              !color && 'bg-background',
            )}
            style={{ backgroundColor: color || undefined }}
          >
            {!color ? <RotateCcw className="mx-auto h-4 w-4" /> : null}
          </button>
        ))}
        <input
          type="color"
          value={value || '#2563EB'}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          className="h-9 w-12 cursor-pointer rounded-xl border border-card-border bg-background p-1"
        />
      </div>
    </div>
  );
}

export default function AdminUiBuilderPage() {
  const auth = useAuth();
  const [, navigate] = useLocation();
  const [pageKey, setPageKey] = useState<UiPageKey>(DEFAULT_PAGE);
  const [layout, setLayout] = useState<UiLayout>(() =>
    createDefaultUiLayout(DEFAULT_PAGE),
  );
  const [versions, setVersions] = useState<UiLayoutVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [propertyOpen, setPropertyOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [propertyTab, setPropertyTab] = useState<'basic' | 'font' | 'color' | 'position' | 'source' | 'popup'>('basic');
  const dragIdRef = useRef<string | null>(null);

  const selected = useMemo(
    () => layout.sections.find((section) => section.id === selectedId) ?? null,
    [layout.sections, selectedId],
  );
  const page = getUiPageDefinition(pageKey);
  const catalog = UI_COMPONENT_CATALOG[pageKey];
  const availableCatalog = catalog.filter(
    (definition) =>
      !layout.sections.some((section) => section.component === definition.component),
  );

  const updateSection = (id: string, patch: Partial<UiSection>) => {
    setLayout((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === id ? { ...section, ...patch } : section,
      ),
    }));
  };

  const load = async (targetPage = pageKey) => {
    setLoading(true);
    try {
      const body = await request(`/${targetPage}`);
      const selectedLayout =
        body.draft?.layout ??
        body.published?.layout ??
        body.layout ??
        createDefaultUiLayout(targetPage);
      const normalized = normalizeUiLayout(selectedLayout, targetPage);
      setLayout(normalized);
      setVersions(body.versions ?? []);
      setSelectedVersionId(body.draft?.id ?? body.published?.id ?? null);
      setSelectedId(normalized.sections[0]?.id ?? null);
      setStatus('');
    } catch (error) {
      const fallback = createDefaultUiLayout(targetPage);
      setLayout(fallback);
      setVersions([]);
      setSelectedVersionId(null);
      setSelectedId(fallback.sections[0]?.id ?? null);
      setStatus(`배치를 불러오지 못했습니다. ${error instanceof Error ? error.message : ''}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (auth.isAdmin) void load(pageKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isAdmin, pageKey]);

  const saveDraft = async () => {
    setBusy(true);
    try {
      const body = await request(`/${pageKey}/draft`, 'POST', { layout });
      setVersions(body.versions ?? versions);
      setSelectedVersionId(body.draft?.id ?? body.version?.id ?? selectedVersionId);
      setStatus('초안을 저장했습니다. 아직 일반 화면에는 반영되지 않았습니다.');
    } catch (error) {
      setStatus(`초안 저장 실패: ${error instanceof Error ? error.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      await request(`/${pageKey}/publish`, 'POST', {
        layout,
        versionId: selectedVersionId,
      });
      setStatus('게시 완료. 해당 화면을 새로 열면 적용됩니다.');
      await load(pageKey);
    } catch (error) {
      setStatus(`게시 실패: ${error instanceof Error ? error.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (versionId: string) => {
    setBusy(true);
    try {
      const body = await request(`/${pageKey}/rollback`, 'POST', { versionId });
      setStatus('선택한 버전을 새 초안으로 복원했습니다.');
      const restored = body.draft?.layout ?? body.version?.layout;
      if (restored) setLayout(normalizeUiLayout(restored, pageKey));
      await load(pageKey);
    } catch (error) {
      setStatus(`롤백 실패: ${error instanceof Error ? error.message : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const removeSelected = () => {
    if (!selected) return;
    if (!window.confirm(`“${selected.title ?? '항목'}”을 삭제할까요?`)) return;
    setLayout((current) => removeUiSection(current, selected.id));
    setSelectedId(null);
    setPropertyOpen(false);
  };

  const duplicateSelected = () => {
    if (!selected) return;
    setLayout((current) => duplicateUiSection(current, selected.id));
  };

  const handleDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragId = dragIdRef.current;
    if (!dragId) return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-ui-node-id]');
    const targetId = target?.dataset.uiNodeId;
    if (targetId && targetId !== dragId) {
      setLayout((current) => moveUiSectionTo(current, dragId, targetId));
    }
  };

  const instruction = useMemo(
    () =>
      [
        '기존 주식 앱 관리자 캔버스 UI 편집 작업을 진행한다.',
        `대상 화면: ${page.label} (${pageKey})`,
        '운영 /opt/stock-app 직접 수정 및 실주문·자동매매 변경 금지',
        '기존 컴포넌트·API·라우트만 안전하게 재사용',
        '',
        ...layout.sections.map(
          (section, index) =>
            `${index + 1}. ${section.title ?? section.component} | 종류=${KIND_LABELS[section.kind]} | 표시=${section.visible ? '예' : '아니오'} | 너비=${section.width} | 정렬=${section.align} | 위치=(${section.x},${section.y}) | 소스=${section.sourceType}:${section.sourcePath ?? ''}`,
        ),
      ].join('\n'),
    [layout.sections, page.label, pageKey],
  );

  if (!auth.isAdmin) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <p className="text-center text-base font-black">관리자만 이용할 수 있습니다.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <header className="z-30 shrink-0 border-b border-card-border bg-background/95 px-3 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-md items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-card-border"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-lg font-black">전체 화면 UI 편집</h1>
            <p className="truncate text-[10px] font-bold text-muted-foreground">
              드래그 · 추가 · 삭제 · 글씨 · 색상 · 팝업 · 소스 연결
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load(pageKey)}
            disabled={busy || loading}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border border-card-border disabled:opacity-50"
          >
            <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>

        <div className="mx-auto mt-3 flex max-w-md gap-2 overflow-x-auto pb-1">
          {UI_PAGES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setPageKey(item.key)}
              className={cn(
                'shrink-0 rounded-full border px-3 py-2 text-xs font-black',
                pageKey === item.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-card-border bg-card text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-32 pt-3 touch-pan-y">
        <div className="mx-auto max-w-md space-y-3">
          {status ? (
            <p className="rounded-2xl border border-card-border bg-card p-3 text-xs font-bold leading-5">
              {status}
            </p>
          ) : null}

          <div className="grid grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={busy}
              className="flex flex-col items-center justify-center gap-1 rounded-2xl bg-primary p-2.5 text-[10px] font-black text-primary-foreground disabled:opacity-50"
            >
              <Save className="h-4 w-4" />초안 저장
            </button>
            <button
              type="button"
              onClick={() => void publish()}
              disabled={busy}
              className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-positive/40 bg-positive/10 p-2.5 text-[10px] font-black text-positive disabled:opacity-50"
            >
              <Send className="h-4 w-4" />게시
            </button>
            <button
              type="button"
              onClick={() => {
                const next = createDefaultUiLayout(pageKey);
                setLayout(next);
                setSelectedId(next.sections[0]?.id ?? null);
              }}
              disabled={busy}
              className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-card-border bg-card p-2.5 text-[10px] font-black"
            >
              <RotateCcw className="h-4 w-4" />기본 배치
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-card-border bg-card p-2.5 text-[10px] font-black"
            >
              <Layers3 className="h-4 w-4" />버전·지시문
            </button>
          </div>

          <section className="rounded-[2rem] border border-card-border bg-card p-3 shadow-lg">
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <div>
                <p className="text-sm font-black">{page.label} 미리보기</p>
                <p className="text-[10px] font-bold text-muted-foreground">
                  손잡이를 누른 채 위아래로 끌어 위치를 바꿉니다.
                </p>
              </div>
              <span className="rounded-full bg-secondary px-2.5 py-1 text-[9px] font-black">
                {layout.sections.length}개 항목
              </span>
            </div>

            <div className="mx-auto min-h-[520px] w-full max-w-[350px] overflow-visible rounded-[2rem] border-4 border-foreground/80 bg-background p-3 shadow-inner">
              <div className="mb-3 flex h-5 items-center justify-center">
                <span className="h-1.5 w-20 rounded-full bg-muted" />
              </div>

              <div className="flex flex-col items-center">
                {layout.sections.map((section, index) => (
                  <div
                    key={section.id}
                    data-ui-node-id={section.id}
                    className={cn(
                      'relative transition-all',
                      widthClass(section.width),
                      spacingClass(section.spacing),
                      !section.visible && 'opacity-40',
                    )}
                  >
                    <div
                      onClick={() => setSelectedId(section.id)}
                      className={cn(
                        'relative flex w-full items-center gap-2 border bg-card px-3 py-3 shadow-sm transition',
                        heightClass(section.height),
                        radiusClass(section.radius),
                        alignClass(section.align),
                        selectedId === section.id
                          ? 'border-primary ring-2 ring-primary/30'
                          : 'border-card-border',
                      )}
                      style={nodePreviewStyle(section)}
                    >
                      <button
                        type="button"
                        aria-label="드래그 이동"
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => {
                          dragIdRef.current = section.id;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setSelectedId(section.id);
                        }}
                        onPointerMove={handleDragMove}
                        onPointerUp={(event) => {
                          dragIdRef.current = null;
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                        onPointerCancel={() => {
                          dragIdRef.current = null;
                        }}
                        className="-ml-1 flex h-10 w-8 shrink-0 touch-none items-center justify-center rounded-xl bg-secondary text-muted-foreground"
                      >
                        <GripVertical className="h-5 w-5" />
                      </button>

                      <span className={cn('min-w-0 flex-1', alignClass(section.align))}>
                        <span
                          className={cn(
                            'block break-keep',
                            fontSizeClass(section.fontSize),
                            fontWeightClass(section.fontWeight),
                          )}
                        >
                          {section.title || '이름 없는 항목'}
                        </span>
                        <span className="mt-1 block text-[9px] font-bold opacity-60">
                          {KIND_LABELS[section.kind]}
                          {section.sourceType !== 'none' ? ` · ${section.sourceType === 'route' ? '화면 연결' : section.sourceType === 'api' ? 'API 연결' : '컴포넌트 연결'}` : ''}
                        </span>
                      </span>

                      <span className="flex shrink-0 flex-col gap-1">
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={(event) => {
                            event.stopPropagation();
                            setLayout((current) => moveUiSection(current, section.id, -1));
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-lg border border-card-border disabled:opacity-25"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={index === layout.sections.length - 1}
                          onClick={(event) => {
                            event.stopPropagation();
                            setLayout((current) => moveUiSection(current, section.id, 1));
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-lg border border-card-border disabled:opacity-25"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </span>
                    </div>
                  </div>
                ))}

                {layout.sections.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setAddOpen(true)}
                    className="mt-20 rounded-2xl border border-dashed border-primary px-5 py-4 text-sm font-black text-primary"
                  >
                    항목 추가하기
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </main>

      <div className="absolute inset-x-0 bottom-0 z-40 border-t border-card-border bg-background/95 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        <div className="mx-auto grid max-w-md grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex flex-col items-center justify-center gap-1 rounded-2xl bg-primary px-2 py-2.5 text-[10px] font-black text-primary-foreground"
          >
            <Plus className="h-5 w-5" />추가
          </button>
          <button
            type="button"
            onClick={duplicateSelected}
            disabled={!selected}
            className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-card-border bg-card px-2 py-2.5 text-[10px] font-black disabled:opacity-30"
          >
            <Copy className="h-5 w-5" />복제
          </button>
          <button
            type="button"
            onClick={removeSelected}
            disabled={!selected}
            className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-negative/40 bg-negative/10 px-2 py-2.5 text-[10px] font-black text-negative disabled:opacity-30"
          >
            <Trash2 className="h-5 w-5" />삭제
          </button>
          <button
            type="button"
            onClick={() => selected && setPropertyOpen(true)}
            disabled={!selected}
            className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-primary/40 bg-primary/10 px-2 py-2.5 text-[10px] font-black text-primary disabled:opacity-30"
          >
            <Settings2 className="h-5 w-5" />속성
          </button>
        </div>
      </div>

      {addOpen ? (
        <div className="absolute inset-0 z-50 flex items-end bg-black/60" onClick={() => setAddOpen(false)}>
          <section
            className="max-h-[82%] w-full overflow-y-auto rounded-t-[2rem] border-t border-card-border bg-background p-4 pb-8"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto max-w-md">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-black">항목 추가</h2>
                  <p className="text-xs font-bold text-muted-foreground">
                    기존 기능 또는 새 항목을 선택합니다.
                  </p>
                </div>
                <button type="button" onClick={() => setAddOpen(false)} className="rounded-xl border border-card-border p-2">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <h3 className="mt-5 text-sm font-black">새 항목</h3>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {([
                  ['text', '글씨', Type],
                  ['button', '버튼', Box],
                  ['tab', '탭', PanelBottom],
                  ['item', '목록 항목', Layers3],
                  ['card', '카드', Palette],
                  ['popup', '팝업창', Link2],
                ] as const).map(([kind, label, Icon]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => {
                      const next = addCustomUiSection(layout, kind);
                      const created = next.sections[next.sections.length - 1];
                      setLayout(next);
                      setSelectedId(created.id);
                      setAddOpen(false);
                      setPropertyOpen(true);
                      setPropertyTab(kind === 'popup' ? 'popup' : 'basic');
                    }}
                    className="flex items-center gap-3 rounded-2xl border border-card-border bg-card p-3 text-left"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-secondary text-primary">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-black">{label}</span>
                  </button>
                ))}
              </div>

              <h3 className="mt-5 text-sm font-black">기존 화면 기능 다시 추가</h3>
              <div className="mt-2 space-y-2">
                {availableCatalog.length ? (
                  availableCatalog.map((definition) => (
                    <button
                      key={definition.component}
                      type="button"
                      onClick={() => {
                        const next = addCatalogSection(layout, definition.component);
                        setLayout(next);
                        setSelectedId(definition.component);
                        setAddOpen(false);
                      }}
                      className="flex w-full items-center justify-between rounded-2xl border border-card-border bg-card p-3 text-left"
                    >
                      <span>
                        <span className="block text-sm font-black">{definition.label}</span>
                        <span className="mt-1 block text-xs font-bold text-muted-foreground">{definition.description}</span>
                      </span>
                      <Plus className="h-5 w-5 text-primary" />
                    </button>
                  ))
                ) : (
                  <p className="rounded-2xl bg-secondary p-3 text-center text-xs font-bold text-muted-foreground">
                    이 화면의 기존 항목이 모두 들어 있습니다.
                  </p>
                )}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {propertyOpen && selected ? (
        <div className="absolute inset-0 z-50 flex items-end bg-black/60" onClick={() => setPropertyOpen(false)}>
          <section
            className="flex max-h-[88%] w-full flex-col rounded-t-[2rem] border-t border-card-border bg-background"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="shrink-0 border-b border-card-border p-4">
              <div className="mx-auto flex max-w-md items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-black">{selected.title || '항목 속성'}</h2>
                  <p className="text-xs font-bold text-muted-foreground">{KIND_LABELS[selected.kind]}</p>
                </div>
                <button type="button" onClick={() => setPropertyOpen(false)} className="rounded-xl border border-card-border p-2">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="mx-auto mt-3 flex max-w-md gap-2 overflow-x-auto">
                {([
                  ['basic', '기본'],
                  ['font', '글씨'],
                  ['color', '색상'],
                  ['position', '크기·위치'],
                  ['source', '연결'],
                  ['popup', '팝업'],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setPropertyTab(key)}
                    className={cn(
                      'shrink-0 rounded-full border px-3 py-2 text-xs font-black',
                      propertyTab === key
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-card-border bg-card',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-10">
              <div className="mx-auto max-w-md space-y-4">
                {propertyTab === 'basic' ? (
                  <>
                    <label>
                      <span className={labelClass}>이름 / 표시 글씨</span>
                      <input
                        value={selected.title ?? ''}
                        onChange={(event) => updateSection(selected.id, { title: event.target.value })}
                        className={inputClass}
                        placeholder="항목 이름"
                      />
                    </label>
                    <PropertySelect
                      label="항목 종류"
                      value={selected.kind}
                      options={[
                        { value: 'section', label: '기존 화면 영역' },
                        { value: 'text', label: '글씨' },
                        { value: 'button', label: '버튼' },
                        { value: 'tab', label: '탭' },
                        { value: 'item', label: '목록 항목' },
                        { value: 'card', label: '카드' },
                        { value: 'popup', label: '팝업 버튼' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { kind: value })}
                    />
                    <button
                      type="button"
                      onClick={() => updateSection(selected.id, { visible: !selected.visible })}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border bg-card p-3 text-sm font-black"
                    >
                      {selected.visible ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
                      {selected.visible ? '현재 표시 중 — 눌러서 숨기기' : '현재 숨김 중 — 눌러서 표시하기'}
                    </button>
                  </>
                ) : null}

                {propertyTab === 'font' ? (
                  <>
                    <PropertySelect
                      label="글씨 크기"
                      value={selected.fontSize}
                      options={[
                        { value: 'xs', label: '아주 작게' },
                        { value: 'sm', label: '작게' },
                        { value: 'md', label: '보통' },
                        { value: 'lg', label: '크게' },
                        { value: 'xl', label: '아주 크게' },
                        { value: '2xl', label: '최대' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { fontSize: value })}
                    />
                    <PropertySelect
                      label="글씨 굵기"
                      value={selected.fontWeight}
                      options={[
                        { value: 'normal', label: '보통' },
                        { value: 'medium', label: '중간' },
                        { value: 'bold', label: '굵게' },
                        { value: 'black', label: '매우 굵게' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { fontWeight: value })}
                    />
                    <div>
                      <span className={labelClass}>글씨 정렬</span>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          ['left', '왼쪽', AlignLeft],
                          ['center', '가운데', AlignCenter],
                          ['right', '오른쪽', AlignRight],
                        ] as const).map(([value, label, Icon]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => updateSection(selected.id, { align: value })}
                            className={cn(
                              'flex items-center justify-center gap-1 rounded-xl border p-3 text-xs font-black',
                              selected.align === value
                                ? 'border-primary bg-primary/10 text-primary'
                                : 'border-card-border bg-card',
                            )}
                          >
                            <Icon className="h-4 w-4" />{label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}

                {propertyTab === 'color' ? (
                  <>
                    <ColorControl label="배경 색상" value={selected.backgroundColor} onChange={(value) => updateSection(selected.id, { backgroundColor: value })} />
                    <ColorControl label="글씨 색상" value={selected.textColor} onChange={(value) => updateSection(selected.id, { textColor: value })} />
                    <ColorControl label="테두리 색상" value={selected.borderColor} onChange={(value) => updateSection(selected.id, { borderColor: value })} />
                    <PropertySelect
                      label="투명도"
                      value={String(selected.opacity) as '25' | '50' | '75' | '100'}
                      options={[
                        { value: '25', label: '25%' },
                        { value: '50', label: '50%' },
                        { value: '75', label: '75%' },
                        { value: '100', label: '100%' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { opacity: Number(value) as UiSection['opacity'] })}
                    />
                    <PropertySelect
                      label="모서리 모양"
                      value={selected.radius}
                      options={[
                        { value: 'none', label: '각지게' },
                        { value: 'sm', label: '조금 둥글게' },
                        { value: 'md', label: '보통 둥글게' },
                        { value: 'lg', label: '많이 둥글게' },
                        { value: 'xl', label: '카드형' },
                        { value: 'full', label: '완전히 둥글게' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { radius: value })}
                    />
                  </>
                ) : null}

                {propertyTab === 'position' ? (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <PropertySelect
                        label="너비"
                        value={selected.width}
                        options={[
                          { value: 'full', label: '전체 너비' },
                          { value: 'half', label: '절반' },
                          { value: 'third', label: '3분의 1' },
                          { value: 'auto', label: '내용만큼' },
                        ]}
                        onChange={(value) => updateSection(selected.id, { width: value })}
                      />
                      <PropertySelect
                        label="높이"
                        value={selected.height}
                        options={[
                          { value: 'auto', label: '자동' },
                          { value: 'compact', label: '낮게' },
                          { value: 'normal', label: '보통' },
                          { value: 'tall', label: '높게' },
                        ]}
                        onChange={(value) => updateSection(selected.id, { height: value })}
                      />
                    </div>
                    <PropertySelect
                      label="위쪽 간격"
                      value={selected.spacing}
                      options={[
                        { value: 'none', label: '없음' },
                        { value: 'xs', label: '아주 좁게' },
                        { value: 'sm', label: '좁게' },
                        { value: 'md', label: '보통' },
                        { value: 'lg', label: '넓게' },
                        { value: 'xl', label: '아주 넓게' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { spacing: value })}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <label>
                        <span className={labelClass}>가로 위치</span>
                        <input type="number" min={-240} max={240} value={selected.x} onChange={(event) => updateSection(selected.id, { x: Number(event.target.value) })} className={inputClass} />
                      </label>
                      <label>
                        <span className={labelClass}>세로 위치</span>
                        <input type="number" min={-400} max={400} value={selected.y} onChange={(event) => updateSection(selected.id, { y: Number(event.target.value) })} className={inputClass} />
                      </label>
                    </div>
                    <label>
                      <span className={labelClass}>앞뒤 순서</span>
                      <input type="number" min={0} max={50} value={selected.zIndex} onChange={(event) => updateSection(selected.id, { zIndex: Number(event.target.value) })} className={inputClass} />
                    </label>
                  </>
                ) : null}

                {propertyTab === 'source' ? (
                  <>
                    <PropertySelect
                      label="연결 종류"
                      value={selected.sourceType}
                      options={[
                        { value: 'none', label: '연결하지 않음' },
                        { value: 'route', label: '기존 화면으로 이동' },
                        { value: 'api', label: '기존 API 조회' },
                        { value: 'component', label: '기존 컴포넌트 연결' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { sourceType: value, sourceKey: '', sourcePath: '' })}
                    />
                    {selected.sourceType === 'route' ? (
                      <label>
                        <span className={labelClass}>이동할 기존 화면</span>
                        <select
                          value={selected.sourceKey ?? ''}
                          onChange={(event) => {
                            const found = UI_ROUTE_SOURCES.find((item) => item.key === event.target.value);
                            updateSection(selected.id, { sourceKey: event.target.value, sourcePath: found?.value ?? '' });
                          }}
                          className={selectClass}
                        >
                          <option value="">선택하세요</option>
                          {UI_ROUTE_SOURCES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                        </select>
                      </label>
                    ) : null}
                    {selected.sourceType === 'api' ? (
                      <label>
                        <span className={labelClass}>조회할 기존 API</span>
                        <select
                          value={selected.sourceKey ?? ''}
                          onChange={(event) => {
                            const found = UI_API_SOURCES.find((item) => item.key === event.target.value);
                            updateSection(selected.id, { sourceKey: event.target.value, sourcePath: found?.value ?? '' });
                          }}
                          className={selectClass}
                        >
                          <option value="">선택하세요</option>
                          {UI_API_SOURCES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                        </select>
                      </label>
                    ) : null}
                    {selected.sourceType === 'component' ? (
                      <label>
                        <span className={labelClass}>연결할 기존 컴포넌트</span>
                        <select
                          value={selected.sourceKey ?? ''}
                          onChange={(event) => updateSection(selected.id, { sourceKey: event.target.value, sourcePath: '' })}
                          className={selectClass}
                        >
                          <option value="">선택하세요</option>
                          {catalog.map((item) => <option key={item.component} value={item.component}>{item.label}</option>)}
                        </select>
                      </label>
                    ) : null}
                    {selected.sourceType !== 'none' ? (
                      <p className="rounded-2xl border border-positive/30 bg-positive/10 p-3 text-xs font-bold leading-5 text-positive">
                        서버 명령이나 임의 코드는 실행하지 않고, 등록된 기존 화면·조회 API·컴포넌트만 연결합니다.
                      </p>
                    ) : null}
                  </>
                ) : null}

                {propertyTab === 'popup' ? (
                  <>
                    <p className="rounded-2xl bg-secondary p-3 text-xs font-bold leading-5 text-muted-foreground">
                      항목을 누르면 표시할 팝업창을 설정합니다. 팝업 항목이 아니어도 연결할 수 있습니다.
                    </p>
                    <label>
                      <span className={labelClass}>팝업 제목</span>
                      <input value={selected.popupTitle ?? ''} onChange={(event) => updateSection(selected.id, { popupTitle: event.target.value })} className={inputClass} placeholder="팝업 제목" />
                    </label>
                    <label>
                      <span className={labelClass}>팝업 내용</span>
                      <textarea value={selected.popupContent ?? ''} onChange={(event) => updateSection(selected.id, { popupContent: event.target.value })} className="min-h-32 w-full rounded-xl border border-card-border bg-background p-3 text-sm font-bold text-foreground" placeholder="팝업 내용을 입력하세요." />
                    </label>
                    <PropertySelect
                      label="팝업 위치"
                      value={selected.popupPosition ?? 'center'}
                      options={[
                        { value: 'center', label: '화면 가운데' },
                        { value: 'bottom', label: '화면 아래쪽' },
                        { value: 'top', label: '화면 위쪽' },
                      ]}
                      onChange={(value) => updateSection(selected.id, { popupPosition: value })}
                    />
                    <button
                      type="button"
                      onClick={() => updateSection(selected.id, { kind: 'popup' })}
                      className="w-full rounded-2xl border border-primary/40 bg-primary/10 p-3 text-sm font-black text-primary"
                    >
                      이 항목을 팝업 버튼으로 사용
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="absolute inset-0 z-50 flex items-end bg-black/60" onClick={() => setHistoryOpen(false)}>
          <section className="max-h-[88%] w-full overflow-y-auto rounded-t-[2rem] border-t border-card-border bg-background p-4 pb-10" onClick={(event) => event.stopPropagation()}>
            <div className="mx-auto max-w-md">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-black">서버 버전 · 작업지시문</h2>
                <button type="button" onClick={() => setHistoryOpen(false)} className="rounded-xl border border-card-border p-2"><X className="h-5 w-5" /></button>
              </div>
              <div className="mt-4 space-y-2">
                {versions.length ? versions.map((version) => (
                  <div key={version.id} className="flex items-center gap-2 rounded-2xl border border-card-border bg-card p-3">
                    <button
                      type="button"
                      onClick={() => {
                        const next = normalizeUiLayout(version.layout, pageKey);
                        setLayout(next);
                        setSelectedVersionId(version.id);
                        setSelectedId(next.sections[0]?.id ?? null);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block text-sm font-black">버전 {version.version}</span>
                      <span className="text-xs font-bold text-muted-foreground">{version.status === 'published' ? '게시됨' : version.status === 'draft' ? '초안' : '보관됨'}</span>
                    </button>
                    <button type="button" onClick={() => void rollback(version.id)} disabled={busy} className="rounded-xl border border-primary/40 px-3 py-2 text-xs font-black text-primary">복원</button>
                  </div>
                )) : <p className="rounded-2xl bg-secondary p-3 text-center text-xs font-bold text-muted-foreground">저장된 버전이 없습니다.</p>}
              </div>

              <label className="mt-5 block">
                <span className={labelClass}>ChatGPT 작업지시문</span>
                <textarea readOnly value={instruction} className="min-h-56 w-full rounded-2xl border border-card-border bg-card p-3 text-xs font-semibold text-foreground" />
              </label>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(instruction).then(() => setStatus('작업지시문을 복사했습니다.'))}
                className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-sm font-black text-primary"
              >
                <ClipboardCopy className="h-4 w-4" />작업지시문 복사
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
