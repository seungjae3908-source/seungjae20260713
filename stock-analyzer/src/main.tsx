// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, start the user-critical route request first, then yield one task
// before adding the wider App and runtime graphs. This lets restored-profile
// bootstrap overlap the route request while keeping the chart renderer behind
// the page's React.lazy boundary.
const directAiChartColdRoute = window.location.pathname.endsWith('/ai-chart');

if (directAiChartColdRoute) {
	void import('@/pages/ai-chart').catch(() => undefined);
	for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')) {
		link.setAttribute('fetchpriority', 'high');
	}
}

function startApplicationGraph() {
	const appModulePromise = import('./App');
	const runtimeModulePromise = import('./app-runtime');

	void Promise.all([appModulePromise, runtimeModulePromise]).then(([{ default: App }, { mountApp }]) => {
		mountApp(App);
	});
}

if (directAiChartColdRoute) {
	window.setTimeout(startApplicationGraph, 0);
} else {
	startApplicationGraph();
}
