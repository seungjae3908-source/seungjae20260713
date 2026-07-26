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

function staticTitle(summaryInner: string) {
  const withoutExpand = removeExpandLabels(summaryInner)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]+\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutExpand || '상세 내용';
}

function escapeAttribute(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
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
    const title = escapeAttribute(staticTitle(summaryInner));
    const replacement = `<>
      <button
        type="button"
        onClick={(event) => {
          const dialog = event.currentTarget.nextElementSibling as HTMLDialogElement | null;
          dialog?.showModal();
        }}
        className="w-full rounded-2xl border border-card-border bg-card px-4 py-3 text-center shadow-sm"
      >
        <div className="min-w-0 break-keep text-center text-sm font-black leading-5">
          ${launcherInner}
        </div>
      </button>
      <dialog
        aria-label="${title}"
        className="fixed inset-0 z-[120] m-auto flex h-full max-h-none w-full max-w-none items-center justify-center overflow-hidden bg-transparent p-4 backdrop:bg-black/60"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <section className="mx-auto flex max-h-[88dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-card shadow-2xl">
          <header className="grid grid-cols-[40px_1fr_40px] items-center border-b border-card-border px-3 py-3">
            <span aria-hidden="true" />
            <h2 className="break-keep text-center text-base font-black leading-tight">${title}</h2>
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
      if (!source.includes('<details')) return null;
      const code = transformDetails(source);
      return code === source ? null : { code, map: null };
    },
  };
}
