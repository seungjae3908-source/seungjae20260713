// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, start the user-critical route request first, then give it a bounded
// head start before adding the wider App and runtime graphs. Restored-profile
// bootstrap still begins independently during that head start, while the chart
// renderer remains behind the page's React.lazy boundary.
const directAiChartColdRoute = window.location.pathname.endsWith('/ai-chart');
const AI_CHART_APP_GRAPH_HEAD_START_MS = 750;
const directAiChartRoutePromise = directAiChartColdRoute
	? import('@/pages/ai-chart')
	: null;

if (directAiChartColdRoute) {
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')) {
		link.setAttribute('fetchpriority', 'high');
	}
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
