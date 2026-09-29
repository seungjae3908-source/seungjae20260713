// Keep the HTML entry intentionally dependency-free. On a direct AI Chart
// document, start the user-critical route preloads first, promote those exact
// modulepreload links, then yield one task before adding the much larger App and
// runtime preload graphs. This gives the cold route a real network scheduling
// head start without delaying any non-AI-Chart document.
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
