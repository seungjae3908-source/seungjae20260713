import type { Plugin } from 'vite';

function replaceSectionTags(segment: string): string {
  return segment
    .replace(/<SectionCard\b/g, '<PopupSectionCard')
    .replace(/<\/SectionCard>/g, '</PopupSectionCard>')
    .replace(/<CollapsibleSection\b/g, '<PopupSectionCard')
    .replace(/<\/CollapsibleSection>/g, '</PopupSectionCard>');
}

function replaceFunctionRange(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) return source;
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return source;
  return (
    source.slice(0, start) +
    replaceSectionTags(source.slice(start, end)) +
    source.slice(end)
  );
}

function patchDetail(source: string): string {
  let code = source;

  const insertMarker = `function inferCompanyBusiness(`;
  if (!code.includes('function PopupSectionCard(')) {
    if (!code.includes(insertMarker)) {
      throw new Error('[detail-section-popup-patch] 팝업 섹션 삽입 위치를 찾지 못했습니다.');
    }

    const component = `function PopupSectionCard({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="flex min-h-[72px] w-full flex-col items-center justify-center rounded-2xl border border-card-border bg-card px-4 py-3 text-center shadow-sm"
      >
        <span className="break-keep text-base font-extrabold leading-6">{title}</span>
        {subtitle && (
          <span className="mt-1 break-keep text-[10px] font-bold leading-4 text-muted-foreground">
            {subtitle}
          </span>
        )}
      </button>

      {modalOpen && (
        <Modal title={title} subtitle={subtitle} onClose={() => setModalOpen(false)}>
          {actions && <div className="mb-3 flex items-center justify-center">{actions}</div>}
          <div className="overflow-x-hidden text-center">{children}</div>
        </Modal>
      )}
    </>
  );
}

`;
    code = code.replace(insertMarker, `${component}${insertMarker}`);
  }

  // 개요·AI분석·재무제표·공시·뉴스만 중앙 팝업으로 바꿉니다.
  // ChartTab 범위는 건드리지 않습니다.
  code = replaceFunctionRange(code, 'function OverviewTab(', 'function AiTab(');
  code = replaceFunctionRange(code, 'function AiTab(', 'function technicalSignalFocus(');
  code = replaceFunctionRange(code, 'function FinancialTab(', 'function FilingTab(');
  code = replaceFunctionRange(code, 'function FilingTab(', 'function NewsTab(');
  code = replaceFunctionRange(code, 'function NewsTab(', 'function MiniMetric(');

  return code;
}

export function detailSectionPopupPatch(): Plugin {
  return {
    name: 'detail-section-popup-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/detail.tsx')) return null;
      const code = patchDetail(source);
      return code === source ? null : { code, map: null };
    },
  };
}
