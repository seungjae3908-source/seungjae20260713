from pathlib import Path

root = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (root / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (root / path).write_text(content, encoding="utf-8")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise RuntimeError(f"missing patch anchor: {label}")
    updated = source.replace(old, new, 1)
    if updated == source:
        raise RuntimeError(f"patch did not change source: {label}")
    return updated


page_path = "stock-analyzer/src/pages/stock-info.tsx"
page = read(page_path)
page = replace_once(
    page,
    "import { PriceAlertCard } from '@/components/price-alert-card';",
    "import { PriceAlertCard } from '@/components/price-alert-card';\nimport { StockAnalysisHub } from '@/components/stock-analysis-hub';",
    "analysis hub import",
)
page = replace_once(
    page,
    "\tconst newsRows = groupUnique((news.data?.news ?? news.data?.items ?? []) as AnyObj[], (row) => row.title);\n\tconst disclosureRows = groupUnique(\n\t\t([...(disclosures.data?.disclosures ?? []), ...(disclosures.data?.filings ?? [])]) as AnyObj[],\n\t\t(row) => row.report ?? `${row.form ?? ''}${row.description ?? ''}`,\n\t);",
    "\tconst newsRows = useMemo(\n\t\t() => groupUnique((news.data?.news ?? news.data?.items ?? []) as AnyObj[], (row) => row.title),\n\t\t[news.data],\n\t);\n\tconst disclosureRows = useMemo(\n\t\t() => groupUnique(\n\t\t\t([...(disclosures.data?.disclosures ?? []), ...(disclosures.data?.filings ?? [])]) as AnyObj[],\n\t\t\t(row) => row.report ?? `${row.form ?? ''}${row.description ?? ''}`,\n\t\t),\n\t\t[disclosures.data],\n\t);\n\tconst analysisSpecialEvents = useMemo(\n\t\t() => (specialFeed.data?.items ?? []).filter((item) => item.ticker.toUpperCase() === ticker && item.market === market),\n\t\t[market, specialFeed.data?.items, ticker],\n\t);",
    "memoized analysis data",
)
page = replace_once(
    page,
    "\t\t\t\t\t\t\t</section>\n\n\t\t\t\t\t\t\t<Section title=\"기본정보\" state={queryStateText(quote)} onRetry={() => { void quote.refetch(); }}>",
    "\t\t\t\t\t\t\t</section>\n\n\t\t\t\t\t\t\t<StockAnalysisHub\n\t\t\t\t\t\t\t\tticker={ticker}\n\t\t\t\t\t\t\t\tname={selectedName}\n\t\t\t\t\t\t\t\tmarket={market}\n\t\t\t\t\t\t\t\tcurrency={currency}\n\t\t\t\t\t\t\t\tquote={quote.data}\n\t\t\t\t\t\t\t\tprofile={profile.data}\n\t\t\t\t\t\t\t\tfinancials={financials.data}\n\t\t\t\t\t\t\t\tnews={newsRows}\n\t\t\t\t\t\t\t\tdisclosures={disclosureRows}\n\t\t\t\t\t\t\t\tspecialEvents={analysisSpecialEvents}\n\t\t\t\t\t\t\t\tloading={quote.isLoading || profile.isLoading || financials.isLoading || news.isLoading || disclosures.isLoading}\n\t\t\t\t\t\t\t/>\n\n\t\t\t\t\t\t\t<Section title=\"기본정보\" state={queryStateText(quote)} onRetry={() => { void quote.refetch(); }}>",
    "analysis hub render",
)
write(page_path, page)

component_path = "stock-analyzer/src/components/stock-analysis-hub.tsx"
component = read(component_path)
component = replace_once(
    component,
    "  useEffect(() => {\n    const key = historyKey(market, ticker);",
    "  useEffect(() => {\n    if (loading || !quote || !profile || !financials) return;\n    const key = historyKey(market, ticker);",
    "defer analysis history until core data is ready",
)
component = replace_once(
    component,
    "  }, [analysis, market, ticker]);",
    "  }, [analysis, financials, loading, market, profile, quote, ticker]);",
    "analysis history dependencies",
)
write(component_path, component)

print('[info-analysis-hub] information page connected; query arrays memoized; completed-data revision storage enabled')
