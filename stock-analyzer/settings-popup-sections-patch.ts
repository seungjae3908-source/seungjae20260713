import type { Plugin } from 'vite';

function findMatchingDetails(source: string, start: number) {
  const token = /<details\b|<\/details>/g;
  token.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    if (match[0].startsWith('<details')) depth += 1;
    else depth -= 1;
    if (depth === 0) {
      return { closeStart: match.index, closeEnd: token.lastIndex };
    }
  }
  return null;
}

function plainTitle(summary: string, index: number) {
  const spans = [...summary.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((text) => text !== '펼치기' && text !== '접기');
  return spans[0] || `설정 항목 ${index + 1}`;
}

function escapeJs(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function replaceDetails(source: string) {
  let code = source;
  let cursor = 0;
  let index = 0;

  while (true) {
    const start = code.indexOf('<details', cursor);
    if (start < 0) break;
    const match = findMatchingDetails(code, start);
    if (!match) {
      throw new Error('[settings-popup-sections-patch] details 닫힘 위치를 찾지 못했습니다.');
    }

    const openEnd = code.indexOf('>', start);
    const summaryStart = code.indexOf('<summary', openEnd);
    const summaryOpenEnd = code.indexOf('>', summaryStart);
    const summaryEnd = code.indexOf('</summary>', summaryOpenEnd);
    if (
      openEnd < 0 ||
      summaryStart < 0 ||
      summaryOpenEnd < 0 ||
      summaryEnd < 0 ||
      summaryEnd > match.closeStart
    ) {
      cursor = match.closeEnd;
      continue;
    }

    const summary = code.slice(summaryStart, summaryEnd + '</summary>'.length);
    const title = plainTitle(summary, index);
    const id = `settings-popup-${index}`;
    const body = code.slice(summaryEnd + '</summary>'.length, match.closeStart);
    const replacement = `<>
          <button
            type="button"
            onClick={() => setSettingsPopup('${id}')}
            className="flex h-[112px] w-full items-center justify-center rounded-3xl border border-card-border bg-card/90 px-5 py-4 text-center shadow-lg"
          >
            <span className="block min-w-0 flex-1 break-keep text-center text-base font-black">${title}</span>
          </button>
          <AppModal
            open={settingsPopup === '${id}'}
            onClose={() => setSettingsPopup(null)}
            title="${escapeJs(title)}"
          >
            <div className="space-y-3 overflow-x-hidden text-center">
${body}
            </div>
          </AppModal>
        </>`;

    code = code.slice(0, start) + replacement + code.slice(match.closeEnd);
    cursor = start + replacement.length;
    index += 1;
  }

  return code;
}

function patchSettings(source: string) {
  let code = source;
  if (!code.includes(`import { AppModal } from '@/components/app-modal';`)) {
    code = code.replace(
      `import { BottomNav } from "@/components/bottom-nav";`,
      `import { BottomNav } from "@/components/bottom-nav";\nimport { AppModal } from '@/components/app-modal';`,
    );
  }

  if (!code.includes('const [settingsPopup, setSettingsPopup]')) {
    const stateMarker = `  const [remoteBackupBusy, setRemoteBackupBusy] = useState(false);`;
    if (!code.includes(stateMarker)) {
      throw new Error('[settings-popup-sections-patch] 설정 팝업 상태 삽입 위치를 찾지 못했습니다.');
    }
    code = code.replace(
      stateMarker,
      `${stateMarker}\n  const [settingsPopup, setSettingsPopup] = useState<string | null>(null);`,
    );
  }

  return replaceDetails(code);
}

export function settingsPopupSectionsPatch(): Plugin {
  return {
    name: 'settings-popup-sections-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/more.tsx')) return null;
      return { code: patchSettings(source), map: null };
    },
  };
}
