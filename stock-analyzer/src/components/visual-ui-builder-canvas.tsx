import { useMemo, useState } from 'react';
import { Eye, EyeOff, GripVertical, Layers3, PanelRight, Smartphone } from 'lucide-react';
import type { UiLayout, UiSection } from '@/lib/ui-layout';
import { cn } from '@/lib/utils';

type Props = {
  layout: UiLayout;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (layout: UiLayout) => void;
};

function sortSections(layout: UiLayout) {
  return [...layout.sections]
    .filter((section) => !section.parentId)
    .sort((a, b) => a.order - b.order);
}

function patchSection(layout: UiLayout, id: string, patch: Partial<UiSection>): UiLayout {
  return {
    ...layout,
    sections: layout.sections.map((section) =>
      section.id === id ? { ...section, ...patch } : section,
    ),
  };
}

export default function VisualUiBuilderCanvas({
  layout,
  selectedId,
  onSelect,
  onChange,
}: Props) {
  const [showLayers, setShowLayers] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const sections = useMemo(() => sortSections(layout), [layout]);
  const selected = layout.sections.find((section) => section.id === selectedId) ?? null;

  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-card-border bg-[#0b0d12] shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4" />
          <div>
            <p className="text-sm font-black">실제 화면 캔버스</p>
            <p className="text-[10px] font-bold text-white/50">요소를 눌러 전체 UI를 수정합니다.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowLayers((value) => !value)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-xl border border-white/10',
              showLayers && 'bg-white text-black',
            )}
            aria-label="레이어 패널"
          >
            <Layers3 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setShowInspector((value) => !value)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-xl border border-white/10',
              showInspector && 'bg-white text-black',
            )}
            aria-label="속성 패널"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="relative min-h-[640px] bg-[radial-gradient(circle_at_top,_rgba(37,99,235,0.18),_transparent_36%)] p-4">
        <div className="mx-auto w-full max-w-[390px] overflow-hidden rounded-[2.5rem] border-[5px] border-white/90 bg-background shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
          <div className="flex h-8 items-center justify-center bg-background">
            <span className="h-1.5 w-24 rounded-full bg-foreground/20" />
          </div>
          <div className="min-h-[560px] space-y-2 p-3">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => onSelect(section.id)}
                className={cn(
                  'relative flex w-full items-center gap-3 border bg-card p-3 text-left transition',
                  section.radius === 'none' && 'rounded-none',
                  section.radius === 'sm' && 'rounded-md',
                  section.radius === 'md' && 'rounded-xl',
                  section.radius === 'lg' && 'rounded-2xl',
                  section.radius === 'xl' && 'rounded-3xl',
                  section.radius === 'full' && 'rounded-full',
                  selectedId === section.id
                    ? 'border-primary ring-2 ring-primary/40'
                    : 'border-card-border',
                  !section.visible && 'opacity-35',
                )}
                style={{
                  backgroundColor: section.backgroundColor || undefined,
                  color: section.textColor || undefined,
                  borderColor: section.borderColor || undefined,
                  opacity: section.opacity / 100,
                  transform: `translate(${section.x}px, ${section.y}px)`,
                  zIndex: section.zIndex,
                }}
              >
                <GripVertical className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-black">
                    {section.title || section.component}
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] font-bold text-muted-foreground">
                    {section.component}
                  </span>
                </span>
                <span className="rounded-lg border border-card-border px-2 py-1 text-[9px] font-black">
                  {section.width}
                </span>
              </button>
            ))}
          </div>
        </div>

        {showLayers ? (
          <aside className="absolute inset-y-4 left-4 z-20 w-56 overflow-y-auto rounded-2xl border border-white/10 bg-black/90 p-3 text-white shadow-2xl">
            <p className="mb-3 text-xs font-black">레이어</p>
            <div className="space-y-1.5">
              {sections.map((section) => (
                <div
                  key={section.id}
                  className={cn(
                    'flex items-center gap-2 rounded-xl border border-white/10 px-2 py-2',
                    selectedId === section.id && 'bg-white text-black',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(section.id)}
                    className="min-w-0 flex-1 truncate text-left text-[11px] font-black"
                  >
                    {section.title || section.component}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onChange(patchSection(layout, section.id, { visible: !section.visible }))
                    }
                    aria-label={section.visible ? '숨기기' : '표시'}
                  >
                    {section.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </button>
                </div>
              ))}
            </div>
          </aside>
        ) : null}

        {showInspector && selected ? (
          <aside className="absolute inset-y-4 right-4 z-20 w-64 overflow-y-auto rounded-2xl border border-white/10 bg-black/90 p-3 text-white shadow-2xl">
            <p className="text-xs font-black">선택 요소</p>
            <p className="mt-1 truncate text-sm font-black text-primary">{selected.title}</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <label className="text-[10px] font-black text-white/60">
                X
                <input
                  type="number"
                  value={selected.x}
                  onChange={(event) =>
                    onChange(patchSection(layout, selected.id, { x: Number(event.target.value) }))
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/10 px-2 text-white"
                />
              </label>
              <label className="text-[10px] font-black text-white/60">
                Y
                <input
                  type="number"
                  value={selected.y}
                  onChange={(event) =>
                    onChange(patchSection(layout, selected.id, { y: Number(event.target.value) }))
                  }
                  className="mt-1 h-10 w-full rounded-xl border border-white/10 bg-white/10 px-2 text-white"
                />
              </label>
              <label className="col-span-2 text-[10px] font-black text-white/60">
                투명도
                <input
                  type="range"
                  min={25}
                  max={100}
                  step={25}
                  value={selected.opacity}
                  onChange={(event) => {
                    const raw = Number(event.target.value);
                    const opacity = Math.min(
                      100,
                      Math.max(25, Math.round(raw / 25) * 25),
                    ) as UiSection['opacity'];

                    onChange(
                      patchSection(layout, selected.id, { opacity }),
                    );
                  }}
                  className="mt-2 w-full"
                />
              </label>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
