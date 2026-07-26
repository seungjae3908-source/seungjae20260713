import type { Plugin } from 'vite';

function patchDetailContent(source: string): string {
  let code = source;

  code = code.replace(
    `  const bodySummary = firstText(
    item.bodySummary,
    item.contentSummary,
    item.documentSummary,
  );`,
    `  const bodySummary = firstText(
    item.bodySummary,
    item.contentSummary,
    item.documentSummary,
    item.summary,
    item.message,
  );`,
  );

  code = code.replace(
    `  const bodySummary = firstText(
    item.bodySummary,
    item.contentSummary,
    item.articleSummary,
  );`,
    `  const bodySummary = firstText(
    item.bodySummary,
    item.contentSummary,
    item.articleSummary,
    item.summary,
    item.description,
    item.message,
  );`,
  );

  return code;
}

export function detailContentStatusPatch(): Plugin {
  return {
    name: 'detail-content-status-patch',
    enforce: 'pre',
    transform(source, id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('/src/pages/detail.tsx')) return null;
      const code = patchDetailContent(source);
      return code === source ? null : { code, map: null };
    },
  };
}
