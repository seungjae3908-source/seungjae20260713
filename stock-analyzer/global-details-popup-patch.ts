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

function removeExpandLabels(summaryInner: string) {
  return summaryInner
    .replace(/<span[^>]*>\s*(?:펼치기|접기)\s*<\/span>/g, '')
    .replace(/<span[^>]*className="[^"]*group-open:[^"]*"[^>]*>[\s\S]*?<\/span>/g, '');
}

function stripJsxExpressions(source: string) {
  let result = '';
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  for (const char of source) {
    if (depth === 0) {
      if (char === '{') {
        depth = 1;
        quote = null;
        escaped = false;
      } else {
        result += char;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }

  return result;
}

function staticTitle(summaryInner: string) {
  const withoutExpand = stripJsxExpressions(removeExpandLabels(summaryInner))
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  if (!/[A-Za-z0-9가-힣]/.test(withoutExpand)) return '상세 내용';
  return withoutExpand;
}

function transformDetails(source: string) {
  let code = source;
  let cursor = 0;
  let transformed = 0;

  while (true) {
    const start = code.indexOf('<details', cursor);
    if (start < 0) break;
    const matched = findMatchingDetails(code, start);
    if (!matched) break;

    const openEnd = code.indexOf('>', start);
    const openTag = openEnd >= 0 ? code.slice(start, openEnd + 1) : '';
    const summaryStart = code.indexOf('<summary', openEnd);
    const summaryOpenEnd = code.indexOf('>', summaryStart);
    const summaryEnd = code.indexOf('</summary>', summaryOpenEnd);
    if (
      openEnd < 0 ||
      summaryStart < 0 ||
      summaryOpenEnd < 0 ||
      summaryEnd < 0 ||
      summaryEnd > matched.closeStart
    ) {
      cursor = matched.closeEnd;
      continue;
    }

    const summaryInner = code.slice(summaryOpenEnd + 1, summaryEnd);
    const launcherInner = removeExpandLabels(summaryInner);
    const body = code.slice(summaryEnd + '</summary>'.length, matched.closeStart);
    const titleLiteral = JSON.stringify(staticTitle(summaryInner));
    const launcherClass = openTag.includes('data-settings-uniform-card')
      ? 'flex h-[112px] w-full items-center justify-center rounded-3xl border border-card-border bg-card px-4 py-3 text-center shadow-sm'
      : 'w-full rounded-2xl border border-card-border bg-card px-4 py-3 text-center shadow-sm';
    const replacement = `<>
      <button
        type="button"
        onClick={(event) => {
          const dialog = event.currentTarget.nextElementSibling as HTMLDialogElement | null;
          dialog?.showModal();
        }}
        className="${launcherClass}"
      >
        <div className="min-w-0 break-keep text-center text-sm font-black leading-5">
          ${launcherInner}
        </div>
      </button>
      <dialog
        aria-label={${titleLiteral}}
        className="fixed inset-0 z-[120] m-auto h-full max-h-none w-full max-w-none overflow-hidden bg-transparent p-4 backdrop:bg-black/60"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <section className="absolute left-1/2 top-1/2 flex max-h-[88dvh] w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-card-border bg-card shadow-2xl">
          <header className="grid grid-cols-[40px_1fr_40px] items-center border-b border-card-border px-3 py-3">
            <span aria-hidden="true" />
            <h2 className="break-keep text-center text-base font-black leading-tight">{${titleLiteral}}</h2>
            <button
              type="button"
              aria-label="닫기"
              onClick={(event) => {
                const dialog = event.currentTarget.closest('dialog') as HTMLDialogElement | null;
                dialog?.close();
              }}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-secondary/70 text-xl font-black"
            >
              ×
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4 text-center">
${body}
          </div>
        </section>
      </dialog>
    </>`;

    code = code.slice(0, start) + replacement + code.slice(matched.closeEnd);
    cursor = start + replacement.length;
    transformed += 1;
  }

  return transformed ? code : source;
}

export function globalDetailsPopupPatch(): Plugin {
  return {
    name: 'global-details-popup-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!/\/src\/(?:pages|components)\/.*\.tsx$/.test(normalized)) return null;
      // 종목상세는 detail-section-popup-patch가 개요·AI·재무·공시·뉴스를
      // 이미 전용 Modal로 변환한다. 여기서 다시 <details>를 문자열 변환하면
      // 중첩 JSX가 손상될 수 있으므로 중복 변환하지 않는다.
      if (normalized.endsWith('/src/pages/detail.tsx')) return null;
      if (!source.includes('<details')) return null;
      const code = transformDetails(source);
      return code === source ? null : { code, map: null };
    },
  };
}
