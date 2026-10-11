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

function startApplicationGraph() {
	if (applicationGraphStarted) return;
	applicationGraphStarted = true;
	const appModulePromise = import('./App');
	const runtimeModulePromise = import('./app-runtime');

	void Promise.all([appModulePromise, runtimeModulePromise]).then(([{ default: App }, { mountApp }]) => {
		mountApp(App);
	});
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
