import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {
  UI_API_SOURCES,
  UI_COMPONENT_CATALOG,
  UI_ROUTE_SOURCES,
  addCatalogSection,
  addCustomUiSection,
  removeUiSection,
  type UiLayout,
  type UiNodeKind,
  type UiSection,
  type UiSourceType,
} from '@/lib/ui-layout';
import { cn } from '@/lib/utils';

const inputClass =
  'h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold text-foreground';
const labelClass = 'mb-1.5 block text-xs font-black text-muted-foreground';

type Props = {
  layout: UiLayout;
  parentId: string;
  onChange: (layout: UiLayout) => void;
  onClose: () => void;
};

export default function UiInternalEditor({ layout, parentId, onChange, onClose }: Props) {
  const [stack, setStack] = useState<string[]>([parentId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const currentParentId = stack[stack.length - 1];
  const currentParent = layout.sections.find((section) => section.id === currentParentId) ?? null;

  useEffect(() => {
    setStack([parentId]);
    setSelectedId(null);
  }, [parentId]);

  const children = useMemo(
    () =>
      layout.sections
        .filter((section) => section.parentId === currentParentId)
        .sort((a, b) => a.order - b.order),
    [currentParentId, layout.sections],
  );

  const selected =
    layout.sections.find((section) => section.id === selectedId) ?? children[0] ?? null;

  useEffect(() => {
    if (!selectedId && children[0]) setSelectedId(children[0].id);
    if (selectedId && !children.some((item) => item.id === selectedId)) {
      setSelectedId(children[0]?.id ?? null);
    }
  }, [children, selectedId]);

  const update = (id: string, patch: Partial<UiSection>) => {
    onChange({
      ...layout,
      sections: layout.sections.map((section) =>
        section.id === id ? { ...section, ...patch } : section,
      ),
    });
  };

  const addCustom = (kind: Exclude<UiNodeKind, 'section'>) => {
    const next = addCustomUiSection(layout, kind, currentParentId);
    const created = next.sections[next.sections.length - 1];
    onChange(next);
    setSelectedId(created.id);
  };

  const directCatalog = UI_COMPONENT_CATALOG[layout.pageKey].filter(
    (definition) => definition.parentComponent === currentParent?.component,
  );
  const hiddenCatalog = directCatalog.filter((definition) => {
    const found = layout.sections.find((section) => section.component === definition.component);
    return !found || !found.visible;
  });

  const hasChildren = (id: string) =>
    layout.sections.some((section) => section.parentId === id);

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <section
        className="flex max-h-[90%] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-card-border p-4">
          <div className="mx-auto flex max-w-md items-center gap-3">
            {stack.length > 1 ? (
              <button
                type="button"
                onClick={() => {
                  setStack((current) => current.slice(0, -1));
                  setSelectedId(null);
                }}
                className="rounded-xl border border-card-border p-2"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-black">{currentParent?.title ?? '내부 항목'}</h2>
              <p className="text-xs font-bold text-muted-foreground">
                글씨·버튼·카테고리를 선택해 수정하거나 숨길 수 있습니다.
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-xl border border-card-border p-2">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-12">
          <div className="mx-auto max-w-md space-y-4">
            <div className="space-y-2">
              {children.length ? (
                children.map((item) => (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(item.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-2xl border bg-card p-3 text-left',
                      selected?.id === item.id
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'border-card-border',
                      !item.visible && 'opacity-45',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-black">
                        {item.title || '이름 없는 내부 항목'}
                      </span>
                      <span className="mt-1 block text-[10px] font-bold text-muted-foreground">
                        {item.custom ? '사용자 추가' : '기존 화면 요소'} · {item.visible ? '표시 중' : '숨김'}
                      </span>
                    </span>
                    {hasChildren(item.id) ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          setStack((current) => [...current, item.id]);
                          setSelectedId(null);
                        }}
                        className="flex items-center gap-1 rounded-xl border border-primary/30 px-2.5 py-2 text-[10px] font-black text-primary"
                      >
                        내부 <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">
                  내부 항목이 없습니다. 아래에서 글씨나 카테고리를 추가하세요.
                </p>
              )}
            </div>

            {selected ? (
              <section className="space-y-3 rounded-3xl border border-card-border bg-card p-4">
                <label>
                  <span className={labelClass}>이름 / 실제 표시 글씨</span>
                  <input
                    value={selected.title ?? ''}
                    onChange={(event) => update(selected.id, { title: event.target.value })}
                    className={inputClass}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => update(selected.id, { visible: !selected.visible })}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-card-border p-3 text-sm font-black"
                >
                  {selected.visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {selected.visible ? '숨기기' : '다시 표시'}
                </button>

                <label>
                  <span className={labelClass}>버튼 연결 종류</span>
                  <select
                    value={selected.sourceType}
                    onChange={(event) =>
                      update(selected.id, {
                        sourceType: event.target.value as UiSourceType,
                        sourceKey: '',
                        sourcePath: '',
                      })
                    }
                    className={inputClass}
                  >
                    <option value="none">기존 동작 유지 / 연결 없음</option>
                    <option value="route">기존 화면으로 이동</option>
                    <option value="api">기존 조회 API</option>
                  </select>
                </label>

                {selected.sourceType === 'route' ? (
                  <label>
                    <span className={labelClass}>연결할 카테고리 화면</span>
                    <select
                      value={selected.sourceKey ?? ''}
                      onChange={(event) => {
                        const found = UI_ROUTE_SOURCES.find((item) => item.key === event.target.value);
                        update(selected.id, {
                          sourceKey: event.target.value,
                          sourcePath: found?.value ?? '',
                        });
                      }}
                      className={inputClass}
                    >
                      <option value="">선택하세요</option>
                      {UI_ROUTE_SOURCES.map((item) => (
                        <option key={item.key} value={item.key}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {selected.sourceType === 'api' ? (
                  <label>
                    <span className={labelClass}>연결할 조회 API</span>
                    <select
                      value={selected.sourceKey ?? ''}
                      onChange={(event) => {
                        const found = UI_API_SOURCES.find((item) => item.key === event.target.value);
                        update(selected.id, {
                          sourceKey: event.target.value,
                          sourcePath: found?.value ?? '',
                        });
                      }}
                      className={inputClass}
                    >
                      <option value="">선택하세요</option>
                      {UI_API_SOURCES.map((item) => (
                        <option key={item.key} value={item.key}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm(`“${selected.title ?? '내부 항목'}”을 삭제할까요?`)) return;
                    onChange(removeUiSection(layout, selected.id));
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-negative/40 bg-negative/10 p-3 text-sm font-black text-negative"
                >
                  <Trash2 className="h-4 w-4" />
                  {selected.custom ? '완전히 삭제' : '기존 화면에서 삭제(숨김)'}
                </button>
              </section>
            ) : null}

            <section className="rounded-3xl border border-card-border bg-card p-4">
              <h3 className="text-sm font-black">이 영역 내부에 추가</h3>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {([
                  ['text', '글씨'],
                  ['button', '버튼'],
                  ['item', '카테고리'],
                ] as const).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => addCustom(kind)}
                    className="flex flex-col items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 p-3 text-xs font-black text-primary"
                  >
                    <Plus className="h-4 w-4" />{label}
                  </button>
                ))}
              </div>

              {hiddenCatalog.length ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-black text-muted-foreground">삭제한 기존 항목 복원</p>
                  {hiddenCatalog.map((definition) => (
                    <button
                      key={definition.component}
                      type="button"
                      onClick={() => {
                        const next = addCatalogSection(layout, definition.component);
                        onChange(next);
                        const restored = next.sections.find((item) => item.component === definition.component);
                        setSelectedId(restored?.id ?? null);
                      }}
                      className="flex w-full items-center justify-between rounded-xl border border-card-border p-3 text-left text-sm font-black"
                    >
                      {definition.label}
                      <RotateCcw className="h-4 w-4 text-primary" />
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
