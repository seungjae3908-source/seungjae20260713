// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, start the user-critical route request and renderer graph first,
// then give both a bounded head start before adding the wider App and runtime
// graphs. Restored-profile bootstrap still begins independently during that
// head start, while React.lazy remains the renderer's canonical render boundary.
const directAiChartColdRoute = window.location.pathname.endsWith('/ai-chart');
const AI_CHART_APP_GRAPH_HEAD_START_MS = 1_500;
const directAiChartRoutePromise = directAiChartColdRoute
	? import('@/pages/ai-chart')
	: null;

if (directAiChartColdRoute) {
	const existingModulePreloads = new Set(
		document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'),
	);
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')) {
		link.setAttribute('fetchpriority', 'high');
	}
	const directAiChartRendererPromise = import('@/components/unified-analysis-chart');
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')) {
		if (!existingModulePreloads.has(link)) link.setAttribute('fetchpriority', 'high');
	}
	void directAiChartRendererPromise.catch(() => undefined);
	void import('@/lib/auth-initial-bootstrap')
		.then(({ primeInitialAuthBootstrap }) => primeInitialAuthBootstrap())
		.catch(() => undefined);
}

let applicationGraphStarted = false;

// A stale cached entry (after a deploy) can fail to import the App graph. Reload
// once (same guard key as lib/chunk-load-recovery) instead of leaving a white page.
function recoverFromEntryChunkFailure() {
	const key = 'sa-chunk-reload-at';
	try {
		const previous = Number(window.sessionStorage.getItem(key));
		if (!Number.isFinite(previous) || Date.now() - previous >= 30_000) {
			window.sessionStorage.setItem(key, String(Date.now()));
			window.location.reload();
			return;
		}
	} catch {
		// Storage blocked: fall through to the static message.
	}
	const root = document.getElementById('root');
	if (root && !root.childElementCount) {
		root.innerHTML = '<div role="alert" style="padding:32px 16px;text-align:center;font-family:sans-serif">'
			+ '<p style="font-weight:800">앱 파일을 불러오지 못했습니다.</p>'
			+ '<p style="font-size:13px;opacity:.75">새 버전으로 업데이트되었거나 네트워크가 불안정합니다.</p>'
			+ '<button type="button" onclick="location.reload()" style="margin-top:12px;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid #888;background:transparent;color:inherit;font-weight:800">다시 시도</button>'
			+ '</div>';
	}
}

function startApplicationGraph() {
	if (applicationGraphStarted) return;
	applicationGraphStarted = true;
	const appModulePromise = import('./App');
	const runtimeModulePromise = import('./app-runtime');

	void Promise.all([appModulePromise, runtimeModulePromise]).then(([{ default: App }, { mountApp }]) => {
		mountApp(App);
	}).catch(recoverFromEntryChunkFailure);
}

if (directAiChartRoutePromise) {
	const fallback = window.setTimeout(startApplicationGraph, AI_CHART_APP_GRAPH_HEAD_START_MS);
	const startAfterRouteSettles = () => {
		window.clearTimeout(fallback);
		startApplicationGraph();
	};
	void directAiChartRoutePromise.then(startAfterRouteSettles, startAfterRouteSettles);
} else {
	startApplicationGraph();
}
